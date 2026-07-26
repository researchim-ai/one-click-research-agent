import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, globalShortcut } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Worker } from 'worker_threads'
import type { FileTreeEntry } from './types'

const SESSION_WRITE_YIELD_EVERY = 12 // yield to event loop every N messages (avoids "app not responding" with huge context)

nativeTheme.themeSource = 'dark'

// Safety net: a late async callback (download/build progress, worker event, watcher) can try
// to send to the window right as it is being destroyed on quit, throwing
// "Object has been destroyed". That is harmless during teardown but Electron's default
// handler pops a scary "A JavaScript error occurred in the main process" dialog. Swallow
// exactly that benign case; anything else is logged and re-surfaced so real bugs stay visible.
process.on('uncaughtException', (err) => {
  const msg = String(err?.message || err)
  if (/Object has been destroyed|Render frame was disposed|WebContents.*destroyed/i.test(msg)) {
    console.warn('[main] ignored teardown error:', msg)
    return
  }
  console.error('[main] uncaughtException:', err)
})

function isRunningAsLinuxAppImage(): boolean {
  if (process.platform !== 'linux') return false
  return !!process.env.APPIMAGE || !!process.env.APPDIR || /\.AppImage$/i.test(process.argv[0] ?? '')
}

// Force dark GTK theme for native menu bar on Linux
if (process.platform === 'linux') {
  process.env.GTK_THEME = 'Adwaita:dark'
  app.commandLine.appendSwitch('force-dark-mode')
  // AppImage is mounted via FUSE, so Chromium's bundled `chrome-sandbox`
  // cannot be owned by root with mode 4755. Disable only the legacy setuid
  // helper for AppImage builds; Chromium can still use the normal Linux
  // namespace sandbox where the kernel allows it. Full `--no-sandbox` is
  // injected before process start by the AppImage launcher wrapper
  // (build/afterPack.cjs) and handled by the explicit block below.
  if (isRunningAsLinuxAppImage()) {
    app.commandLine.appendSwitch('disable-setuid-sandbox')
  }
}
// Force dark title bar on Windows
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force-dark-mode')
}

// Disable Chromium GPU compositing/acceleration for the whole app. We ship a plain
// (non-3D, non-video) research UI that gains nothing from GPU rendering, but we run a
// local llama.cpp inference server on the very same machine — often on the same card
// that also drives the display. When Electron's GPU process and llama.cpp both hammer
// that GPU, the NVIDIA driver can trip its display watchdog and log
// "nvidia-modeset: Error while waiting for GPU progress" (a TDR-style hang). Freeing the
// GPU from UI compositing removes that contention and keeps all VRAM/compute for the model.
// Must be called before app is ready.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu-compositing')

if (process.env.ELECTRON_NO_SANDBOX || process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}
import { detect, evaluateVariants, loadModelArch, getArch, applyGpuPreferences, MODEL_FAMILIES } from './resources'
import * as modelManager from './model-manager'
import * as serverManager from './server-manager'
import * as config from './config'
import { getBuiltinToolDefinitions } from './tools'
import { ensureWebSearchBackend, getWebSearchStatus } from './searxng'
import { getSourceTracker } from './sources'
import * as embed from './embed'
import * as planner from './planner'
import * as knowledgeIndex from './knowledge-index'
import { corpusStats, getCorpusSelection, setCorpusItemIncluded } from './corpus'
import { evidenceStats } from './evidence'
import { readResearchRunSpec } from './research-workflow'
import { loadIdeas } from './idea-scout'
import { getResearchProfileByPresetId, RESEARCH_PROFILES } from '../research-profiles'
import { parseInferredResearchPatch, buildResearchIntakeRequestBody } from './research-intake-parse'
import {
  runAgent, resetAgent, setWorkspace, cancelAgent,
  createSession, switchSession, listSessions, deleteSession,
  renameSession, getActiveSessionId, initSessions,
  saveUiMessages, getUiMessages,
  getActiveSession, getSessionPathForWorker, saveSession as persistSession, isCancelRequested,
  updateSessionFromWorker,
  type SessionInfo, type AgentBridge,
} from './agent'
import {
  listPrompts, savePromptOverride, resetAllPromptOverrides, seedUserPromptsDir,
  migrateLegacyPromptConfig, userPromptsDir,
} from './prompts'
import * as terminalManager from './terminal-manager'
import * as tsService from './ts-service'
import * as pyResolve from './py-resolve'
import * as git from './git'
import * as recentWorkspaces from './recent-workspaces'
import type { ToolInfo, AgentActivity } from './types'
import { isResearchResumeMessage, compactSessionForWorkerResume } from './research-resume'

// The agent watchdog is an INACTIVITY timeout, not a total-runtime cap. A deep
// research run legitimately takes much longer than any fixed budget, so killing it
// on wall-clock time aborts healthy runs mid-flight (the user sees a spurious "stopped
// by user"). Instead we re-arm this timer on every message from the worker (token
// streaming, tool calls/results, status, session updates). It only fires when the
// worker has been genuinely silent — e.g. the inference server or a network fetch hung.
const AGENT_INACTIVITY_TIMEOUT_MS = 8 * 60 * 1000
let agentWatchdogTimer: NodeJS.Timeout | null = null

function clearAgentWatchdog(): void {
  if (agentWatchdogTimer) {
    clearTimeout(agentWatchdogTimer)
    agentWatchdogTimer = null
  }
}

function armAgentWatchdog(): void {
  clearAgentWatchdog()
  agentWatchdogTimer = setTimeout(() => {
    agentWatchdogTimer = null
    if (!pendingSendResolve) return
    agentRunInFlight = false
    agentWorker?.postMessage({ type: 'cancel' })
    const minutes = Math.round(AGENT_INACTIVITY_TIMEOUT_MS / 60000)
    pendingSendResolve(`Error: Агент не присылал прогресс более ${minutes} минут — вероятно, inference-сервер или сетевой запрос завис. Нажмите «Стоп», проверьте сервер/поиск и отправьте «продолжай».`)
    pendingSendResolve = null
  }, AGENT_INACTIVITY_TIMEOUT_MS)
}

function emitAgentActivity(activity: AgentActivity): void {
  try { mainWindow?.webContents.send('agent-event', { type: 'agent_activity', activity }) } catch {}
}

let mainWindow: BrowserWindow | null = null
let agentWorker: Worker | null = null
let pendingSendResolve: ((result: string) => void) | null = null
let agentRunInFlight = false

const WORKSPACE_CHANGED_DEBOUNCE_MS = 1200
let workspaceChangedTimer: ReturnType<typeof setTimeout> | null = null

async function inferResearchRequest(payload: any): Promise<{ patch?: Record<string, any>; error?: string }> {
  const message = String(payload?.message ?? '').trim()
  if (!message) return { patch: {} }
  if (!serverManager.isRunning()) return { error: 'llama-server is not running' }
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : []
  const draft = payload?.draft ?? {}
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 30000)
  try {
    const res = await fetch(`${serverManager.llamaApiUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(buildResearchIntakeRequestBody({
        message,
        draft,
        appLanguage: (payload?.appLanguage ?? config.get('appLanguage')) as 'ru' | 'en',
        profiles,
        currentDate: new Date().toISOString().slice(0, 10),
      })),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const data = await res.json()
    const msg = data?.choices?.[0]?.message ?? {}
    // Prefer the visible content; fall back to reasoning_content in case the model
    // emitted the JSON there (some thinking templates do this).
    const content = String(msg?.content ?? '') || String(msg?.reasoning_content ?? '')
    // The intake model is the ONLY classifier — no regex/keyword heuristics. It fills
    // researchKind (academic vs general) along with the other parameters; if it omits
    // the field, applyResearchIntakePatch falls back to a safe default (general).
    return parseInferredResearchPatch(content)
  } catch (e: any) {
    return { error: String(e?.message || e) }
  } finally {
    clearTimeout(timeout)
  }
}

function scheduleWorkspaceChangedNotify(): void {
  if (workspaceChangedTimer) clearTimeout(workspaceChangedTimer)
  workspaceChangedTimer = setTimeout(() => {
    workspaceChangedTimer = null
    try { mainWindow?.webContents.send('workspace-files-changed') } catch {}
  }, WORKSPACE_CHANGED_DEBOUNCE_MS)
}

function packagedAgentWorkerPath(): string {
  if (!app.isPackaged) return path.join(__dirname, 'agent-worker.js')
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'agent-worker.js')
}

function rejectPendingAgentRun(message: string): void {
  agentRunInFlight = false
  clearAgentWatchdog()
  if (pendingSendResolve) {
    pendingSendResolve(`Error: ${message}`)
    pendingSendResolve = null
  }
}

function getAgentWorker(): Worker {
  if (!agentWorker) {
    const workerPath = packagedAgentWorkerPath()
    const worker = new Worker(workerPath, { stdout: true, stderr: true })
    agentWorker = worker
    worker.stdout?.on('data', (chunk) => {
      console.log(`[agent-worker] ${String(chunk).trimEnd()}`)
    })
    worker.stderr?.on('data', (chunk) => {
      console.error(`[agent-worker] ${String(chunk).trimEnd()}`)
    })
    worker.on('message', (msg: any) => {
      // Any message from the worker is proof of progress — re-arm the inactivity watchdog.
      if (pendingSendResolve) armAgentWatchdog()
      if (msg.type === 'emit' && mainWindow) {
        try { mainWindow.webContents.send('agent-event', msg.event) } catch {}
      } else if (msg.type === 'approval' && mainWindow) {
        const handler = (_: any, responseId: string, approved: boolean) => {
          if (responseId === msg.approvalId) {
            ipcMain.removeListener('command-approval-response', handler)
            agentWorker?.postMessage({ type: 'approval-result', approvalId: msg.approvalId, approved })
          }
        }
        ipcMain.on('command-approval-response', handler)
        try { mainWindow.webContents.send('agent-event', { type: 'command_approval', name: msg.name, args: msg.args, approvalId: msg.approvalId }) } catch {}
      } else if (msg.type === 'workspace-changed' && mainWindow) {
        scheduleWorkspaceChangedNotify()
      } else if (msg.type === 'session-update') {
        updateSessionFromWorker(msg.session)
      } else if (msg.type === 'query-ctx') {
        serverManager.queryActualCtxSize().then(() => {
          agentWorker?.postMessage({ type: 'query-ctx-result', id: msg.id, ctxSize: serverManager.getCtxSize() })
        }).catch(() => {
          agentWorker?.postMessage({ type: 'query-ctx-result', id: msg.id, ctxSize: serverManager.getCtxSize() })
        })
      } else if (msg.type === 'done') {
        agentRunInFlight = false
        clearAgentWatchdog()
        if (msg.session) updateSessionFromWorker(msg.session, true)
        if (pendingSendResolve) {
          pendingSendResolve(msg.result ?? '')
          pendingSendResolve = null
        }
      }
    })
    worker.on('error', (err) => {
      if (agentWorker === worker) agentWorker = null
      rejectPendingAgentRun(`Agent worker failed: ${err.message}`)
    })
    worker.on('exit', (code) => {
      if (agentWorker === worker) agentWorker = null
      if (code !== 0) {
        rejectPendingAgentRun(`Agent worker exited unexpectedly (code ${code}).`)
      }
    })
  }
  return agentWorker
}

function createMainBridge(win: BrowserWindow): AgentBridge {
  return {
    emit(e) {
      try { win.webContents.send('agent-event', e) } catch {}
    },
    requestApproval(name: string, args: Record<string, any>) {
      return new Promise((resolve) => {
        const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const handler = (_: any, responseId: string, approved: boolean) => {
          if (responseId === id) {
            ipcMain.removeListener('command-approval-response', handler)
            resolve(approved)
          }
        }
        ipcMain.on('command-approval-response', handler)
        try { win.webContents.send('agent-event', { type: 'command_approval', name, args, approvalId: id }) } catch {}
      })
    },
    getConfig() { return config.load() },
    getSession() { return getActiveSession('') },
    saveSession(s) { persistSession(s) },
    getApiUrl() { return serverManager.llamaApiUrl() },
    getCtxSize() { return serverManager.getCtxSize() },
    setCtxSize(n) { serverManager.setCtxSize(n) },
    async queryActualCtxSize() { await serverManager.queryActualCtxSize() },
    isCancelRequested() { return isCancelRequested() },
    notifyWorkspaceChanged() { scheduleWorkspaceChangedNotify() },
  }
}

/**
 * Send an IPC event to the renderer only when the window (and its webContents) is still
 * alive. A `mainWindow?.` null-check is NOT enough: after the window closes, `mainWindow`
 * still points at a *destroyed* BrowserWindow, and touching `.webContents.send` on it throws
 * "Object has been destroyed" — which surfaced as an uncaught-exception dialog on quit.
 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try { win.webContents.send(channel, ...args) } catch {}
}

function sendMenuAction(action: string, payload?: unknown) {
  if (payload !== undefined) {
    sendToRenderer('menu-action', action, payload)
  } else {
    sendToRenderer('menu-action', action)
  }
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const, label: 'О программе' },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: 'Выход' },
      ],
    }] : []),
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Открыть папку…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              title: 'Выберите папку проекта',
              properties: ['openDirectory'],
            })
            if (!result.canceled && result.filePaths[0]) {
              const dir = result.filePaths[0]
              recentWorkspaces.addRecentWorkspace(dir)
              sendMenuAction('open-recent', dir)
              buildAppMenu()
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Недавние',
          submenu: recentWorkspaces.getRecentWorkspaces().length === 0
            ? [{ label: '(нет недавних проектов)', enabled: false }]
            : recentWorkspaces.getRecentWorkspaces().map((dir) => ({
                label: path.basename(dir) || dir,
                click: () => {
                  recentWorkspaces.addRecentWorkspace(dir)
                  sendMenuAction('open-recent', dir)
                  buildAppMenu()
                },
              })),
        },
      ],
    },
    {
      label: 'Агент',
      submenu: [
        { label: 'Новый чат', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
        { type: 'separator' },
        { label: 'Остановить запрос', accelerator: 'Escape', click: () => cancelAgent() },
        { label: 'Сброс контекста', accelerator: 'CmdOrCtrl+Shift+Delete', click: () => sendMenuAction('reset-context') },
        { type: 'separator' },
        ...(!isMac ? [
          { role: 'quit' as const, label: 'Выход', accelerator: 'CmdOrCtrl+Q' },
        ] : []),
      ],
    },
    {
      label: 'Настройки',
      submenu: [
        { label: 'Модель и контекст…', click: () => sendMenuAction('settings-model') },
        { label: 'Инструменты…', click: () => sendMenuAction('settings-tools') },
        { label: 'Промпты агента…', click: () => sendMenuAction('settings-prompts') },
        { type: 'separator' },
        {
          label: 'Сбросить всё по умолчанию',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow!, {
              type: 'warning',
              buttons: ['Отмена', 'Сбросить'],
              defaultId: 0,
              cancelId: 0,
              title: 'Сброс настроек',
              message: 'Все настройки будут сброшены к значениям по умолчанию: квантизация, контекст, промпты, пользовательские инструменты.',
            })
            if (result.response === 1) {
              config.resetToDefaults()
              sendMenuAction('defaults-reset')
            }
          },
        },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Терминал', accelerator: 'Ctrl+`', click: () => sendMenuAction('toggle-terminal') },
        { label: 'Боковая панель', accelerator: 'CmdOrCtrl+B', click: () => sendMenuAction('toggle-sidebar') },
        { type: 'separator' },
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Сбросить масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полноэкранный режим' },
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        {
          label: 'GitHub репозиторий',
          click: () => shell.openExternal('https://github.com'),
        },
        { type: 'separator' },
        ...(!isMac ? [
          { role: 'about' as const, label: 'О программе' },
        ] : []),
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow() {
  buildAppMenu()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'One-Click Research Agent',
    backgroundColor: '#09090b',
    darkTheme: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Drop the reference as soon as the window is gone so every `mainWindow?.` guard across
  // the main process actually short-circuits (otherwise it stays a destroyed object and any
  // late send throws "Object has been destroyed"). Applies to BOTH dev and packaged builds.
  mainWindow.on('closed', () => {
    globalShortcut.unregister('F12')
    globalShortcut.unregister('CommandOrControl+Shift+I')
    mainWindow = null
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.once('did-finish-load', () => {
      globalShortcut.register('F12', () => mainWindow?.webContents.toggleDevTools())
      globalShortcut.register('CommandOrControl+Shift+I', () => mainWindow?.webContents.toggleDevTools())
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  // Tell the prompt registry where the shipped default prompts live. In dev they
  // sit next to the repo (dist-electron/../prompts); packaged they are copied via
  // electron-builder `extraResources` to <resources>/prompts. Exporting it on the
  // env means the agent worker thread inherits the same path (it has no
  // process.resourcesPath of its own).
  if (!process.env.OCA_PROMPTS_DIR) {
    process.env.OCA_PROMPTS_DIR = app.isPackaged
      ? path.join(process.resourcesPath, 'prompts')
      : path.join(__dirname, '..', 'prompts')
  }
  initSessions()
  // One-time migration of the legacy single-string prompt overrides (config.json)
  // into the file-based prompt registry, then clear the old config fields.
  try {
    migrateLegacyPromptConfig(
      () => ({ systemPrompt: config.get('systemPrompt'), summarizePrompt: config.get('summarizePrompt') }),
      (cleared) => config.save(cleared),
    )
  } catch {}
  registerIpcHandlers()
  createWindow()
  // Pre-create agent worker so first send-message doesn't block on Worker load
  setImmediate(() => { try { getAgentWorker() } catch {} })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  terminalManager.killAll()
  serverManager.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  serverManager.stop()
})

function registerIpcHandlers() {
  ipcMain.handle('detect-resources', () => detect())

  ipcMain.handle('get-model-variants', (_e, override?: Pick<config.AppConfig, 'gpuMode' | 'gpuIndex'>) => {
    const modelPath = modelManager.getModelPath()
    if (modelPath) loadModelArch(modelPath)
    const cfg = config.load()
    return evaluateVariants(applyGpuPreferences(
      detect(),
      override?.gpuMode ?? cfg.gpuMode,
      override?.gpuIndex ?? cfg.gpuIndex,
    ))
  })

  ipcMain.handle('get-model-families', () => MODEL_FAMILIES)

  ipcMain.handle(
    'get-web-search-status',
    (_e, override?: Pick<config.AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>) =>
      getWebSearchStatus({
        webSearchProvider: override?.webSearchProvider ?? config.load().webSearchProvider,
        searxngBaseUrl: override?.searxngBaseUrl ?? config.load().searxngBaseUrl,
      }),
  )
  ipcMain.handle(
    'ensure-web-search',
    (_e, override?: Pick<config.AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>) =>
      ensureWebSearchBackend({
        webSearchProvider: override?.webSearchProvider ?? config.load().webSearchProvider,
        searxngBaseUrl: override?.searxngBaseUrl ?? config.load().searxngBaseUrl,
      }),
  )

  ipcMain.handle('select-model-variant', (_e, quant: string) => {
    modelManager.setSelectedQuant(quant)
  })

  ipcMain.handle('get-config', () => config.load())

  ipcMain.handle('save-config', (_e, partial: Partial<config.AppConfig>) => {
    const saved = config.save(partial)
    // Apply the GPU keep-warm toggle live so the user doesn't have to restart the server.
    if (Object.prototype.hasOwnProperty.call(partial, 'gpuKeepWarm') && serverManager.isRunning()) {
      if (saved.gpuKeepWarm) serverManager.startKeepWarm()
      else serverManager.stopKeepWarm()
    }
    return saved
  })

  ipcMain.handle('get-tools', (): ToolInfo[] => {
    const builtins: ToolInfo[] = getBuiltinToolDefinitions(config.load()).map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      builtin: true,
      enabled: true,
    }))
    const custom: ToolInfo[] = config.get('customTools').map((ct) => ({
      name: ct.name,
      description: ct.description,
      builtin: false,
      enabled: ct.enabled,
      id: ct.id,
      command: ct.command,
      parameters: ct.parameters,
    }))
    return [...builtins, ...custom]
  })

  ipcMain.handle('save-custom-tool', (_e, tool: config.CustomTool) => {
    const tools = config.get('customTools')
    const idx = tools.findIndex((t) => t.id === tool.id)
    if (idx >= 0) tools[idx] = tool
    else tools.push(tool)
    config.set('customTools', tools)
    return tools
  })

  ipcMain.handle('delete-custom-tool', (_e, toolId: string) => {
    const tools = config.get('customTools').filter((t) => t.id !== toolId)
    config.set('customTools', tools)
    return tools
  })

  // Prompt registry: every LLM prompt is a file under `prompts/` with optional
  // user overrides in `~/.one-click-agent/prompts/`.
  ipcMain.handle('list-prompts', () => listPrompts())

  ipcMain.handle('save-prompt', (_e, { id, text }: { id: string; text: string | null }) => {
    savePromptOverride(id, text)
    return listPrompts()
  })

  ipcMain.handle('reset-prompt', (_e, { id }: { id: string }) => {
    savePromptOverride(id, null)
    return listPrompts()
  })

  ipcMain.handle('reset-all-prompts', () => {
    resetAllPromptOverrides()
    return listPrompts()
  })

  ipcMain.handle('open-prompts-dir', async () => {
    const dir = seedUserPromptsDir()
    await shell.openPath(dir)
    return dir
  })

  ipcMain.handle('reset-all-defaults', () => {
    config.resetToDefaults()
  })

  ipcMain.handle('restart-server', async (_e) => {
    serverManager.stop()
    await new Promise((r) => setTimeout(r, 2000))
    if (!serverManager.isReady()) throw new Error('llama-server не установлен')
    let modelPath = modelManager.getModelPath()
    if (!modelPath) {
      // No file on disk for the currently selected variant — e.g. the user
      // just switched model family in Settings. Download it before restarting
      // so switching "just works" without a separate step.
      if (!mainWindow) throw new Error('No window')
      console.log(`[restart-server] Model not found for quant=${modelManager.getSelectedQuant()}, downloading…`)
      modelPath = await modelManager.download(mainWindow)
    }
    loadModelArch(modelPath)
    const ctxSize = config.get('ctxSize')
    console.log(`[restart-server] Requested ctx=${ctxSize}, quant=${modelManager.getSelectedQuant()}, modelPath=${modelPath}`)
    serverManager.start(modelPath, mainWindow ?? undefined, undefined, modelManager.getSelectedQuant(), ctxSize)
    await serverManager.waitReady(300, mainWindow ?? undefined)
    const actualCtx = serverManager.getCtxSize()
    console.log(`[restart-server] Server ready, actual ctx=${actualCtx}`)
    return { requestedCtx: ctxSize, actualCtx }
  })

  // Bring the llama-server up with the currently selected model + ctx. Shared by the
  // update flow and any future restart path. Returns whether it actually started.
  const bootServer = async (): Promise<boolean> => {
    let modelPath = modelManager.getModelPath()
    if (!modelPath) return false
    loadModelArch(modelPath)
    const ctxSize = config.get('ctxSize')
    serverManager.start(modelPath, mainWindow ?? undefined, undefined, modelManager.getSelectedQuant(), ctxSize)
    await serverManager.waitReady(300, mainWindow ?? undefined)
    return true
  }

  ipcMain.handle('get-llama-info', async (_e, checkLatest?: boolean) => {
    const info = serverManager.getInstalledInfo()
    const latestTag = checkLatest ? await serverManager.getLatestReleaseTag() : null
    return {
      ...info,
      latestTag,
      updateAvailable: Boolean(checkLatest && latestTag && info.tag && latestTag !== info.tag),
    }
  })

  // Update llama.cpp to the newest release, then automatically restart the server so the
  // app is immediately ready to work on the fresh build. The old binary stays in place if
  // the download fails, and we bring the server back up either way.
  ipcMain.handle('update-llama', async () => {
    if (!mainWindow) throw new Error('No window')
    const wasRunning = serverManager.isRunning()
    // Stop first: on Windows the running llama-server.exe is locked and cannot be overwritten.
    serverManager.stop()
    await new Promise((r) => setTimeout(r, 1500))
    let result: { previousTag: string | null; tag: string | null; updated: boolean }
    try {
      result = await serverManager.updateBinary(mainWindow)
    } catch (e) {
      // Update failed — restore the previous server so the app stays usable, then surface the error.
      try { await bootServer() } catch {}
      throw e
    }
    let restarted = false
    try {
      restarted = await bootServer()
      console.log(`[update-llama] ${result.previousTag ?? '—'} → ${result.tag ?? '—'}, restarted=${restarted}`)
    } catch (e) {
      console.error('[update-llama] restart after update failed:', e)
    }
    return { ...result, restarted, wasRunning }
  })

  // Window control handlers (frameless window)
  ipcMain.on('win-minimize', () => mainWindow?.minimize())
  ipcMain.on('win-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('win-close', () => mainWindow?.close())
  ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle('get-status', async () => {
    const running = serverManager.isRunning()
    return {
      serverRunning: running,
      modelDownloaded: modelManager.isDownloaded(),
      modelPath: modelManager.getModelPath(),
      llamaReady: serverManager.isReady(),
      serverHealth: running ? await serverManager.health() : { status: 'stopped' },
    }
  })

  ipcMain.handle('download-model', async () => {
    if (!mainWindow) throw new Error('No window')
    return modelManager.download(mainWindow)
  })

  ipcMain.handle('ensure-llama', async () => {
    if (!mainWindow) throw new Error('No window')
    await serverManager.ensureBinary(mainWindow)
  })

  ipcMain.handle('start-server', async () => {
    const modelPath = modelManager.getModelPath()
    if (!modelPath) throw new Error('Модель не скачана')
    if (!serverManager.isReady()) throw new Error('llama-server не установлен')
    loadModelArch(modelPath)
    const ctxSize = config.get('ctxSize')
    serverManager.start(modelPath, mainWindow ?? undefined, undefined, modelManager.getSelectedQuant(), ctxSize)
    await serverManager.waitReady(300, mainWindow ?? undefined)
  })

  ipcMain.handle('stop-server', () => {
    serverManager.stop()
  })

  ipcMain.handle('auto-setup', async () => {
    if (!mainWindow) throw new Error('No window')

    if (!serverManager.isReady()) {
      await serverManager.ensureBinary(mainWindow)
    }

    let modelPath = modelManager.getModelPath()
    if (!modelPath) {
      modelPath = await modelManager.download(mainWindow)
    }

    if (!serverManager.isRunning()) {
      loadModelArch(modelPath)
      const ctxSize = config.get('ctxSize')
      const quant = modelManager.getSelectedQuant()
      console.log(`[auto-setup] Starting server: quant=${quant}, ctx=${ctxSize}`)
      serverManager.start(modelPath, mainWindow ?? undefined, undefined, quant, ctxSize)
      await serverManager.waitReady(300, mainWindow ?? undefined)
      console.log(`[auto-setup] Server ready, actual ctx=${serverManager.getCtxSize()}`)
    } else {
      console.log(`[auto-setup] Server already running, ctx=${serverManager.getCtxSize()}`)
    }
  })

  ipcMain.handle('send-message', async (_e, msg: string, workspace: string) => {
    if (!mainWindow) throw new Error('No window')
    if (agentRunInFlight || pendingSendResolve) {
      return 'Error: Агент ещё выполняет предыдущий запрос. Дождитесь завершения или нажмите «Стоп».'
    }
    return new Promise<string>((resolve) => {
      armAgentWatchdog()

      pendingSendResolve = (result: string) => {
        agentRunInFlight = false
        clearAgentWatchdog()
        resolve(result)
        pendingSendResolve = null
      }

      const resume = isResearchResumeMessage(msg)
      emitAgentActivity({
        phase: resume ? 'resume_checkpoint' : 'starting',
        label: resume ? 'Продолжаю research run…' : 'Запускаю агента…',
      })

      setImmediate(async () => {
        try {
          const sessionRaw = getActiveSession(workspace)
          const session = resume ? compactSessionForWorkerResume(sessionRaw) : sessionRaw
          const msgCount = session.messages.length
          emitAgentActivity({
            phase: 'session_save',
            label: resume ? 'Подготавливаю продолжение (артефакты на диске)' : 'Сохраняю сессию для worker…',
            detail: resume ? undefined : `${msgCount} сообщений`,
          })
          const configVal = config.load()
          const apiUrl = serverManager.llamaApiUrl()
          const ctxSize = serverManager.getCtxSize() || 32768
          const sessionPath = getSessionPathForWorker(workspace, session.id)
          fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
          const stream = fs.createWriteStream(sessionPath, { encoding: 'utf-8' })
          const write = (s: string) => stream.write(s)
          write('{"id":')
          write(JSON.stringify(session.id))
          write(',"title":')
          write(JSON.stringify(session.title))
          write(',"messages":[')
          for (let i = 0; i < session.messages.length; i++) {
            write((i ? ',' : '') + JSON.stringify(session.messages[i]))
            if (i > 0 && i % SESSION_WRITE_YIELD_EVERY === 0) {
              await new Promise<void>(r => setImmediate(r))
              if (!resume && msgCount > SESSION_WRITE_YIELD_EVERY) {
                emitAgentActivity({
                  phase: 'session_save',
                  label: 'Сохраняю сессию для worker…',
                  detail: `${Math.min(i, msgCount)}/${msgCount} сообщений`,
                })
              }
            }
          }
          write('],"uiMessages":')
          write(JSON.stringify(session.uiMessages || []))
          write(',"projectContextAdded":')
          write(String(session.projectContextAdded))
          write(',"createdAt":')
          write(String(session.createdAt))
          write(',"updatedAt":')
          write(String(session.updatedAt))
          write(',"workspaceKey":')
          write(JSON.stringify(session.workspaceKey ?? ''))
          write('}')
          await new Promise<void>((res, rej) => { stream.once('finish', res); stream.once('error', rej); stream.end() })
          emitAgentActivity({ phase: 'starting', label: 'Worker запущен — передаю управление агенту…' })
          agentRunInFlight = true
          getAgentWorker().postMessage({
            type: 'run',
            payload: { message: msg, workspace, config: configVal, apiUrl, ctxSize, sessionPath },
          })
        } catch (error: any) {
          rejectPendingAgentRun(`Не удалось запустить agent worker: ${error?.message ?? error}`)
        }
      })
    })
  })

  ipcMain.handle('cancel-agent', () => {
    cancelAgent()
    agentRunInFlight = false
    clearAgentWatchdog()
    if (agentWorker && pendingSendResolve) agentWorker.postMessage({ type: 'cancel' })
  })

  ipcMain.handle('reset-agent', (_e, workspace: string) => resetAgent(workspace))

  // Research / sources / plan / knowledge-index IPC
  ipcMain.handle('get-session-sources', (_e, sessionId: string) => {
    if (!sessionId) return []
    try { return getSourceTracker(sessionId).exportForIpc() } catch { return [] }
  })

  ipcMain.handle('get-research-plan', (_e, workspace: string) => {
    if (!workspace) return { items: [], progress: { total: 0, done: 0, pct: 0 } }
    try {
      const items = planner.parsePlan(workspace)
      return { items, progress: planner.planProgress(items) }
    } catch { return { items: [], progress: { total: 0, done: 0, pct: 0 } } }
  })

  ipcMain.handle('get-research-profiles', () => RESEARCH_PROFILES)

  ipcMain.handle('infer-research-request', async (_e, payload: any) => inferResearchRequest(payload))

  // Most-recently-updated managed run directory (".research/<ts>_<slug>"), or null.
  const findLatestRunDir = (ws: string): string | null => {
    const root = path.join(ws, '.research')
    if (!fs.existsSync(root)) return null
    const RUN_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/
    let best: { name: string; mtime: number } | null = null
    let names: string[] = []
    try { names = fs.readdirSync(root) } catch { return null }
    for (const name of names) {
      if (!RUN_RE.test(name)) continue
      try {
        const st = fs.statSync(path.join(root, name, 'run.json'))
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { name, mtime: st.mtimeMs }
      } catch {}
    }
    return best ? `.research/${best.name}` : null
  }

  ipcMain.handle('get-research-dashboard', (_e, workspace: string) => {
    const profile = getResearchProfileByPresetId(config.get('selectedPreset'))
    const emptyCorpus = { total: 0, primary: 0, selected: 0, rejected: 0, needsReview: 0, queuedFullText: 0, read: 0, failed: 0, withDoi: 0, withArxiv: 0, selectedRead: 0, highPriority: 0, highPriorityRead: 0 }
    const base: any = {
      profile,
      run: null,
      plan: { total: 0, done: 0, pct: 0 },
      corpus: emptyCorpus,
      evidence: { total: 0, supported: 0, contested: 0, unsupported: 0, needsReview: 0 },
      quality: { blockers: [] as string[] },
      ideas: 0,
      index: { chunks: 0, docs: 0, hasVectors: false },
    }
    if (!workspace) return base

    // Read blockers from a specific run/root quality-gates.json (dir = folder containing it).
    const qualityFrom = (dir: string) => {
      try {
        const p = path.join(dir, 'quality-gates.json')
        if (!fs.existsSync(p)) return [] as string[]
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return (data.results || []).filter((r: any) => !r.passed)
          .flatMap((r: any) => (r.blockers || []).map((b: string) => `${r.gate}: ${b}`)).slice(0, 8)
      } catch { return [] as string[] }
    }

    try { base.ideas = loadIdeas(workspace).length } catch {}
    try { base.index = knowledgeIndex.indexStats(workspace) } catch {}

    // Dashboard now reflects the ACTIVE (latest) managed run's per-run directory, where
    // artifacts actually live — the old code read the shared .research root, which managed
    // runs never write to, so every metric was permanently 0.
    const outputDir = findLatestRunDir(workspace)
    try {
      const items = planner.parsePlan(workspace, outputDir ?? undefined)
      base.plan = planner.planProgress(items)
      base.corpus = corpusStats(workspace, outputDir ?? undefined)
      base.evidence = evidenceStats(workspace, outputDir ?? undefined)
      if (outputDir) {
        const runDir = path.join(workspace, outputDir)
        base.quality = { blockers: qualityFrom(runDir) }
        let spec: any = null
        try { spec = readResearchRunSpec(workspace, outputDir) } catch {}
        if (spec) {
          const gateScores = spec.gateScores ?? {}
          base.run = {
            outputDir,
            reportPath: path.join(runDir, 'report.md'),
            reportReady: fs.existsSync(path.join(runDir, 'report.md')),
            topic: spec.topic ?? (() => { try { return planner.planQuestion(workspace, outputDir) } catch { return null } })(),
            state: spec.state,
            lastTool: spec.lastTool ?? null,
            updatedAt: spec.updatedAt,
            downgradedGates: spec.downgradedGates ?? [],
            gates: Object.keys(gateScores).map((gate) => ({
              gate,
              score: gateScores[gate],
              downgraded: (spec.downgradedGates ?? []).includes(gate),
              failing: (spec.lastGateFailures ?? []).some((f: any) => f.gate === gate),
            })),
          }
        }
      } else {
        base.quality = { blockers: qualityFrom(path.join(workspace, '.research')) }
      }
    } catch {}
    return base
  })

  // Non-blocking source review: toggle a single source in/out of the selected set.
  // The agent run is NOT paused — this just flips screeningStatus in corpus.jsonl.
  ipcMain.handle('research-set-source-included', (_e, workspace: string, outputDir: string, id: string, included: boolean) => {
    if (!workspace || !id) return { ok: false, selected: 0 }
    try {
      return setCorpusItemIncluded(workspace, id, !!included, outputDir || undefined)
    } catch {
      return { ok: false, selected: 0 }
    }
  })

  ipcMain.handle('research-get-source-selection', (_e, workspace: string, outputDir: string) => {
    if (!workspace) return []
    try {
      return getCorpusSelection(workspace, outputDir || undefined)
    } catch {
      return []
    }
  })

  ipcMain.handle('list-research-artifacts', (_e, workspace: string) => {
    if (!workspace) return []
    const root = path.join(workspace, '.research')
    if (!fs.existsSync(root)) return []
    const out: Array<{ relPath: string; size: number; mtime: number; kind: string }> = []
    const walk = (dir: string) => {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else {
          try {
            const st = fs.statSync(full)
            const ext = path.extname(e.name).toLowerCase()
            const kind = ext === '.md' ? 'markdown'
              : ext === '.pdf' ? 'pdf'
              : ext === '.docx' ? 'docx'
              : ext === '.bib' ? 'bibtex'
              : ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' ? 'image'
              : ext === '.html' || ext === '.htm' ? 'html'
              : 'other'
            out.push({ relPath: path.relative(workspace, full), size: st.size, mtime: st.mtimeMs, kind })
          } catch {}
        }
      }
    }
    walk(root)
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  })

  // Research Library: list every past run directory under {workspace}/.research with
  // lightweight metadata so the UI can browse, open the report, and delete runs.
  ipcMain.handle('list-research-runs', (_e, workspace: string) => {
    if (!workspace) return []
    const root = path.join(workspace, '.research')
    if (!fs.existsSync(root)) return []
    const RUN_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_/
    let names: string[]
    try { names = fs.readdirSync(root) } catch { return [] }
    const countLines = (dir: string, file: string, filter?: (line: string) => boolean): number => {
      try {
        const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter((l) => l.trim())
        return filter ? lines.filter(filter).length : lines.length
      } catch { return 0 }
    }
    const runs: Array<Record<string, any>> = []
    for (const name of names) {
      const m = name.match(RUN_RE)
      if (!m) continue
      const dir = path.join(root, name)
      let stat: fs.Stats
      try { stat = fs.statSync(dir); if (!stat.isDirectory()) continue } catch { continue }
      const outputDir = `.research/${name}`
      const createdAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()

      let topic: string | null = null
      try { topic = planner.planQuestion(workspace, outputDir) } catch {}

      const reportPath = path.join(dir, 'report.md')
      let hasReport = false, reportSize = 0, reportMtime = 0
      try { const rs = fs.statSync(reportPath); hasReport = rs.isFile() && rs.size > 0; reportSize = rs.size; reportMtime = rs.mtimeMs } catch {}

      let planTotal = 0, planDone = 0
      try { const pr = planner.planProgress(planner.parsePlan(workspace, outputDir)); planTotal = pr.total; planDone = pr.done } catch {}

      let blockers = 0
      try {
        const q = JSON.parse(fs.readFileSync(path.join(dir, 'quality-gates.json'), 'utf-8'))
        blockers = (q.results || []).filter((r: any) => !r.passed).length
      } catch {}

      runs.push({
        outputDir,
        dirName: name,
        topic: (topic && topic.trim()) || name.replace(RUN_RE, '').replace(/[-_]+/g, ' ').trim() || name,
        createdAt,
        mtime: stat.mtimeMs,
        hasReport,
        reportPath,
        reportSize,
        reportMtime,
        corpusTotal: countLines(dir, 'corpus.jsonl'),
        corpusSelected: countLines(dir, 'corpus.jsonl', (l) => l.includes('"screeningStatus":"selected"')),
        evidenceTotal: countLines(dir, 'evidence.jsonl'),
        planTotal,
        planDone,
        blockers,
      })
    }
    runs.sort((a, b) => b.createdAt - a.createdAt || b.mtime - a.mtime)
    return runs
  })

  // Compact "run graph" snapshot for the activity drawer: the FSM state + transition history
  // + gate health for a managed research run. With no explicit outputDir, picks the most
  // recently updated run that has a run.json. Returns null for non-research sessions (the
  // drawer then shows only the live tool timeline it accumulates from agent events).
  ipcMain.handle('get-run-graph', (_e, workspace: string, outputDir?: string) => {
    if (!workspace) return null
    const root = path.join(workspace, '.research')
    if (!fs.existsSync(root)) return null
    let targetOutputDir = outputDir && String(outputDir).trim() ? String(outputDir).trim() : findLatestRunDir(workspace)
    if (!targetOutputDir) return null
    let spec
    try { spec = readResearchRunSpec(workspace, targetOutputDir) } catch { spec = null }
    if (!spec) return null
    let topic: string | null = spec.topic ?? null
    try { if (!topic) topic = planner.planQuestion(workspace, targetOutputDir) } catch {}
    const gateScores = spec.gateScores ?? {}
    const gates = Object.keys(gateScores).map((gate) => ({
      gate,
      score: gateScores[gate],
      attempts: spec.gateAttempts?.[gate] ?? 0,
      downgraded: (spec.downgradedGates ?? []).includes(gate),
      failing: (spec.lastGateFailures ?? []).some((f) => f.gate === gate),
    }))
    return {
      id: spec.id,
      outputDir: targetOutputDir,
      topic,
      state: spec.state,
      lastTool: spec.lastTool ?? null,
      updatedAt: spec.updatedAt,
      transitions: (spec.transitions ?? []).slice(-40),
      gateFailures: spec.lastGateFailures ?? [],
      gates,
      downgradedGates: spec.downgradedGates ?? [],
    }
  })

  // Delete a research run directory (and all its artifacts) from disk. Hardened: only a
  // well-formed run dir strictly inside {workspace}/.research can be removed.
  ipcMain.handle('delete-research-run', (_e, workspace: string, outputDir: string) => {
    if (!workspace || !outputDir) return { ok: false, error: 'missing args' }
    const root = path.resolve(workspace, '.research')
    const dirName = String(outputDir).replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/.test(dirName)) return { ok: false, error: 'not a research run dir' }
    const target = path.resolve(root, dirName)
    const rel = path.relative(root, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'path escapes research root' }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('embed-status', () => ({
    isRunning: embed.isRunning(),
    modelDownloaded: embed.isDefaultModelDownloaded(),
    modelPath: embed.getActiveModelPath(),
    defaultModelPath: embed.getDefaultEmbedModelPath(),
    apiUrl: embed.embedApiUrl(),
  }))

  ipcMain.handle('embed-download-model', async (ev) => {
    try {
      const target = await embed.downloadDefaultModel((pct) => {
        try { ev.sender.send('embed-download-progress', pct) } catch {}
      })
      return { ok: true, path: target }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('embed-start', async (_e, modelPath?: string) => {
    try { await embed.startEmbedServer(modelPath || undefined); return { ok: true } }
    catch (e: any) { return { ok: false, error: String(e?.message || e), log: embed.getLastLog() } }
  })

  ipcMain.handle('embed-stop', () => {
    embed.stopEmbedServer()
    return { ok: true }
  })

  ipcMain.handle('knowledge-index-stats', (_e, workspace: string) => {
    if (!workspace) return { chunks: 0, docs: 0, hasVectors: false }
    try { return knowledgeIndex.indexStats(workspace) } catch { return { chunks: 0, docs: 0, hasVectors: false } }
  })

  ipcMain.handle('knowledge-index-rebuild', async (ev, workspace: string) => {
    if (!workspace) return { ok: false, error: 'no workspace' }
    try {
      const count = await knowledgeIndex.rebuildIndex(workspace, (done, total) => {
        try { ev.sender.send('knowledge-index-progress', { done, total }) } catch {}
      })
      return { ok: true, chunks: count }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
  ipcMain.handle('set-workspace', (_e, ws: string) => {
    setWorkspace(ws)
    recentWorkspaces.addRecentWorkspace(ws)
    buildAppMenu()
  })

  // Session management (all workspace-scoped)
  ipcMain.handle('create-session', (_e, workspace: string) => createSession(workspace))
  ipcMain.handle('switch-session', (_e, workspace: string, id: string) => switchSession(workspace, id))
  ipcMain.handle('list-sessions', (_e, workspace: string) => listSessions(workspace))
  ipcMain.handle('delete-session', (_e, workspace: string, id: string) => deleteSession(workspace, id))
  ipcMain.handle('rename-session', (_e, workspace: string, id: string, title: string) => renameSession(workspace, id, title))
  ipcMain.handle('get-active-session-id', (_e, workspace: string) => getActiveSessionId(workspace))
  ipcMain.handle('save-ui-messages', (_e, workspace: string, id: string, msgs: any[]) => saveUiMessages(workspace, id, msgs))
  ipcMain.handle('get-ui-messages', (_e, workspace: string, id: string) => getUiMessages(workspace, id))

  ipcMain.handle('get-recent-workspaces', () => recentWorkspaces.getRecentWorkspaces())

  ipcMain.handle('pick-directory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Выбери рабочую директорию проекта',
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  const IGNORED = new Set([
    'node_modules', '.git', '__pycache__', '.next', '.nuxt',
    'dist', 'build', '.cache', '.venv', 'venv', 'env',
    '.tox', 'coverage', '.nyc_output', '.turbo', 'target',
    'dist-electron', '.one-click-agent',
  ])

  async function readTree(dir: string, depth: number): Promise<FileTreeEntry[]> {
    if (depth <= 0) return []
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const filtered = entries
      .filter((e) => !IGNORED.has(e.name) && (!e.name.startsWith('.') || e.name === '.research'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    const out: FileTreeEntry[] = []
    for (const e of filtered) {
      const fullPath = path.join(dir, e.name)
      if (e.isDirectory()) {
        out.push({ name: e.name, path: fullPath, isDir: true, children: await readTree(fullPath, depth - 1) })
      } else {
        out.push({ name: e.name, path: fullPath, isDir: false })
      }
    }
    return out
  }

  ipcMain.handle('list-files', async (_e, workspace: string, dirPath?: string) => {
    const target = dirPath ?? workspace
    if (!target) return []
    return readTree(target, 4)
  })

  ipcMain.handle('git-status', (_e, workspace: string) => git.getStatus(workspace))
  ipcMain.handle('git-numstat', (_e, workspace: string) => git.getNumstat(workspace))
  ipcMain.handle('git-file-at-head', (_e, workspace: string, relativePath: string) => git.getFileContentAtHead(workspace, relativePath))

  ipcMain.handle('read-file-content', async (_e, filePath: string) => {
    try {
      const [content, stat] = await Promise.all([
        fs.promises.readFile(filePath, 'utf-8'),
        fs.promises.stat(filePath),
      ])
      return { content, size: stat.size, lines: content.split('\n').length }
    } catch (e: any) {
      throw new Error(`Cannot read file: ${e.message}`)
    }
  })

  ipcMain.handle('write-file', async (_e, filePath: string, content: string) => {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    await fs.promises.writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('ts-get-definition', (_e, workspacePath: string, filePath: string, fileContent: string, line: number, column: number) => {
    return tsService.getDefinition(workspacePath, filePath, fileContent, line, column)
  })
  ipcMain.handle('ts-get-hover', (_e, workspacePath: string, filePath: string, fileContent: string, line: number, column: number) => {
    return tsService.getHover(workspacePath, filePath, fileContent, line, column)
  })
  ipcMain.handle('ts-get-completions', (_e, workspacePath: string, filePath: string, fileContent: string, line: number, column: number) => {
    return tsService.getCompletions(workspacePath, filePath, fileContent, line, column)
  })
  ipcMain.handle('ts-get-diagnostics', (_e, workspacePath: string, filePath: string, fileContent?: string) => {
    return tsService.getDiagnostics(workspacePath, filePath, fileContent)
  })
  ipcMain.handle('py-resolve-module', (_e, workspacePath: string, moduleName: string) => {
    return pyResolve.resolvePythonModule(workspacePath, moduleName)
  })

  // File creation
  ipcMain.handle('create-file', (_e, filePath: string) => {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf-8')
    }
  })

  ipcMain.handle('create-directory', (_e, dirPath: string) => {
    fs.mkdirSync(dirPath, { recursive: true })
  })

  // File operations
  ipcMain.handle('rename-file', (_e, oldPath: string, newPath: string) => {
    const dir = path.dirname(newPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.renameSync(oldPath, newPath)
  })

  ipcMain.handle('delete-path', (_e, targetPath: string) => {
    const stat = fs.statSync(targetPath)
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(targetPath)
    }
  })

  ipcMain.handle('copy-to-clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('open-external-url', async (_e, rawUrl: string) => {
    const url = String(rawUrl ?? '').trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Некорректный URL')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Разрешены только http/https ссылки')
    }
    await shell.openExternal(parsed.toString())
  })

  ipcMain.handle('reveal-in-explorer', (_e, targetPath: string) => {
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('open-in-terminal-path', (_e, dirPath: string) => {
    if (!mainWindow) throw new Error('No window')
    return terminalManager.create(dirPath, mainWindow)
  })

  // Terminal IPC
  ipcMain.handle('terminal-create', (_e, cwd: string) => {
    if (!mainWindow) throw new Error('No window')
    return terminalManager.create(cwd, mainWindow)
  })

  ipcMain.on('terminal-input', (_e, id: string, data: string) => {
    terminalManager.write(id, data)
  })

  ipcMain.on('terminal-resize', (_e, id: string, cols: number, rows: number) => {
    terminalManager.resize(id, cols, rows)
  })

  ipcMain.on('terminal-kill', (_e, id: string) => {
    terminalManager.kill(id)
  })
}
