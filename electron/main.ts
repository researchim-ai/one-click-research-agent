import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, globalShortcut } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Worker } from 'worker_threads'
import type { FileTreeEntry } from './types'

const SESSION_WRITE_YIELD_EVERY = 12 // yield to event loop every N messages (avoids "app not responding" with huge context)

nativeTheme.themeSource = 'dark'

// Force dark GTK theme for native menu bar on Linux
if (process.platform === 'linux') {
  process.env.GTK_THEME = 'Adwaita:dark'
  app.commandLine.appendSwitch('force-dark-mode')
}
// Force dark title bar on Windows
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force-dark-mode')
}

if (process.env.ELECTRON_NO_SANDBOX || process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.disableHardwareAcceleration()
}
import { detect, evaluateVariants, loadModelArch, getArch } from './resources'
import * as modelManager from './model-manager'
import * as serverManager from './server-manager'
import * as config from './config'
import { TOOL_DEFINITIONS } from './tools'
import {
  runAgent, resetAgent, setWorkspace, cancelAgent,
  createSession, switchSession, listSessions, deleteSession,
  renameSession, getActiveSessionId, initSessions,
  saveUiMessages, getUiMessages,
  getActiveSession, getSessionPathForWorker, saveSession as persistSession, isCancelRequested,
  updateSessionFromWorker,
  DEFAULT_SYSTEM_PROMPT, DEFAULT_SUMMARIZE_PROMPT,
  type SessionInfo, type AgentBridge,
} from './agent'
import * as terminalManager from './terminal-manager'
import * as tsService from './ts-service'
import * as pyResolve from './py-resolve'
import * as git from './git'
import * as recentWorkspaces from './recent-workspaces'
import type { ToolInfo } from './types'

let mainWindow: BrowserWindow | null = null
let agentWorker: Worker | null = null
let pendingSendResolve: ((result: string) => void) | null = null

const WORKSPACE_CHANGED_DEBOUNCE_MS = 1200
let workspaceChangedTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWorkspaceChangedNotify(): void {
  if (workspaceChangedTimer) clearTimeout(workspaceChangedTimer)
  workspaceChangedTimer = setTimeout(() => {
    workspaceChangedTimer = null
    try { mainWindow?.webContents.send('workspace-files-changed') } catch {}
  }, WORKSPACE_CHANGED_DEBOUNCE_MS)
}

function getAgentWorker(): Worker {
  if (!agentWorker) {
    const workerPath = path.join(__dirname, 'agent-worker.js')
    agentWorker = new Worker(workerPath, { stdout: true, stderr: true })
    agentWorker.on('message', (msg: any) => {
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
        if (msg.session) updateSessionFromWorker(msg.session, true)
        if (pendingSendResolve) {
          pendingSendResolve(msg.result ?? '')
          pendingSendResolve = null
        }
      }
    })
    agentWorker.on('error', (err) => {
      if (pendingSendResolve) {
        pendingSendResolve(`Error: ${err.message}`)
        pendingSendResolve = null
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

function sendMenuAction(action: string, payload?: unknown) {
  if (payload !== undefined) {
    mainWindow?.webContents.send('menu-action', action, payload)
  } else {
    mainWindow?.webContents.send('menu-action', action)
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.once('did-finish-load', () => {
      globalShortcut.register('F12', () => mainWindow?.webContents.toggleDevTools())
      globalShortcut.register('CommandOrControl+Shift+I', () => mainWindow?.webContents.toggleDevTools())
    })
    mainWindow.on('closed', () => {
      globalShortcut.unregister('F12')
      globalShortcut.unregister('CommandOrControl+Shift+I')
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initSessions()
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

  ipcMain.handle('get-model-variants', () => {
    const modelPath = modelManager.getModelPath()
    if (modelPath) loadModelArch(modelPath)
    return evaluateVariants(detect())
  })

  ipcMain.handle('select-model-variant', (_e, quant: string) => {
    modelManager.setSelectedQuant(quant)
  })

  ipcMain.handle('get-config', () => config.load())

  ipcMain.handle('save-config', (_e, partial: Partial<config.AppConfig>) => {
    return config.save(partial)
  })

  ipcMain.handle('get-tools', (): ToolInfo[] => {
    const builtins: ToolInfo[] = TOOL_DEFINITIONS.map((t: any) => ({
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

  ipcMain.handle('get-prompts', () => ({
    systemPrompt: config.get('systemPrompt'),
    summarizePrompt: config.get('summarizePrompt'),
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    defaultSummarizePrompt: DEFAULT_SUMMARIZE_PROMPT,
  }))

  ipcMain.handle('save-prompts', (_e, prompts: { systemPrompt?: string | null; summarizePrompt?: string | null }) => {
    if (prompts.systemPrompt !== undefined) config.set('systemPrompt', prompts.systemPrompt)
    if (prompts.summarizePrompt !== undefined) config.set('summarizePrompt', prompts.summarizePrompt)
  })

  ipcMain.handle('reset-all-defaults', () => {
    config.resetToDefaults()
  })

  ipcMain.handle('restart-server', async (_e) => {
    serverManager.stop()
    await new Promise((r) => setTimeout(r, 2000))
    const modelPath = modelManager.getModelPath()
    if (!modelPath) throw new Error('Модель не скачана')
    if (!serverManager.isReady()) throw new Error('llama-server не установлен')
    loadModelArch(modelPath)
    const ctxSize = config.get('ctxSize')
    console.log(`[restart-server] Requested ctx=${ctxSize}, quant=${modelManager.getSelectedQuant()}`)
    serverManager.start(modelPath, mainWindow ?? undefined, undefined, modelManager.getSelectedQuant(), ctxSize)
    await serverManager.waitReady(300, mainWindow ?? undefined)
    const actualCtx = serverManager.getCtxSize()
    console.log(`[restart-server] Server ready, actual ctx=${actualCtx}`)
    return { requestedCtx: ctxSize, actualCtx }
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
    return new Promise<string>((resolve) => {
      pendingSendResolve = resolve
      setImmediate(async () => {
        const session = getActiveSession(workspace)
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
          if (i > 0 && i % SESSION_WRITE_YIELD_EVERY === 0) await new Promise<void>(r => setImmediate(r))
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
        getAgentWorker().postMessage({
          type: 'run',
          payload: { message: msg, workspace, config: configVal, apiUrl, ctxSize, sessionPath },
        })
      })
    })
  })

  ipcMain.handle('cancel-agent', () => {
    cancelAgent()
    if (agentWorker && pendingSendResolve) agentWorker.postMessage({ type: 'cancel' })
  })

  ipcMain.handle('reset-agent', (_e, workspace: string) => resetAgent(workspace))
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
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
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
