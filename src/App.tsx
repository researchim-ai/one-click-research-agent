import { useAgent } from './hooks/useAgent'
import { useEditor } from './hooks/useEditor'
import { useResizable } from './hooks/useResizable'
import { Sidebar } from './components/Sidebar'
import { EditorTabs } from './components/EditorTabs'
import { CodeEditor } from './components/CodeEditor'
import { Chat, type CodeReference } from './components/Chat'
import { Terminal } from './components/Terminal'
import { SetupWizard } from './components/SetupWizard'
import { StatusBar } from './components/StatusBar'
import { SessionTabs } from './components/SessionTabs'
import { SettingsPanel } from './components/SettingsPanel'
import { SourcesPanel } from './components/SourcesPanel'
import { ResearchArtifacts } from './components/ResearchArtifacts'
import { TitleBar } from './components/TitleBar'
import { DiffViewer } from './components/DiffViewer'
import { useState, useEffect, useCallback, useRef } from 'react'
import { normalizeExternalHttpUrl } from './utils/external-links'

export function App() {
  const {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace, contextUsage, tokensPerSecond,
    sendMessage, resetChat, pollStatus, respondApproval, cancel,
    sessions, activeSessionId,
    newSession, switchToSession, removeSession,
  } = useAgent()

  const {
    openFiles, activeFile, activeFilePath,
    openFile, closeFile, closeAll, closeOthers, refreshFile, updateFileContent, setActiveFilePath,
  } = useEditor()

  const [setupDone, setSetupDone] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [codeRefs, setCodeRefs] = useState<CodeReference[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [diffView, setDiffView] = useState<{ filePath: string; original: string; modified: string } | null>(null)
  const [externalLinksEnabled, setExternalLinksEnabled] = useState(true)
  const [appLanguage, setAppLanguage] = useState<'ru' | 'en'>('ru')
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null)
  const [citationHighlight, setCitationHighlight] = useState<{ n: number; token: number } | null>(null)
  const handleCitationClick = useCallback((n: number) => {
    setCitationHighlight({ n, token: Date.now() })
  }, [])
  const [breadcrumbExpandTo, setBreadcrumbExpandTo] = useState<string | null>(null)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([])
  const fileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setBreadcrumbExpandTo(null)
  }, [activeFilePath])

  useEffect(() => {
    if (!fileMenuOpen || !window.api?.getRecentWorkspaces) return
    window.api.getRecentWorkspaces().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]))
  }, [fileMenuOpen])

  useEffect(() => {
    if (!window.api?.getConfig) return
    window.api.getConfig()
      .then((cfg) => {
        setExternalLinksEnabled(cfg.externalLinksEnabled ?? true)
        setAppLanguage(cfg.appLanguage ?? 'ru')
      })
      .catch(() => setExternalLinksEnabled(true))
  }, [settingsOpen])

  useEffect(() => {
    if (!fileMenuOpen) return
    const onOutside = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) setFileMenuOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [fileMenuOpen])

  const handleOpenDiff = useCallback(async (filePath: string) => {
    if (!workspace || !window.api?.getGitFileAtHead || !window.api?.readFileContent) return
    const sep = workspace.includes('\\') ? '\\' : '/'
    const rel = filePath.startsWith(workspace)
      ? filePath.slice(workspace.length).replace(/^[/\\]+/, '').replace(/[/\\]+/g, '/')
      : filePath
    try {
      const [original, fileData] = await Promise.all([
        window.api.getGitFileAtHead(workspace, rel),
        window.api.readFileContent(filePath),
      ])
      setDiffView({
        filePath,
        original: original ?? '',
        modified: fileData?.content ?? '',
      })
    } catch {
      setDiffView(null)
    }
  }, [workspace])

  const addCodeRef = useCallback((ref: CodeReference) => {
    setCodeRefs((prev) => {
      const key = `${ref.filePath}:${ref.startLine}:${ref.endLine}`
      if (prev.some((r) => `${r.filePath}:${r.startLine}:${r.endLine}` === key)) return prev
      return [...prev, ref]
    })
  }, [])

  const removeCodeRef = useCallback((index: number) => {
    setCodeRefs((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const sidebar = useResizable({
    direction: 'left',
    initialSize: 240,
    minSize: 160,
    maxSize: 480,
    collapsedSize: 0,
    collapseThreshold: 100,
  })

  const chat = useResizable({
    direction: 'right',
    initialSize: 420,
    minSize: 280,
    maxSize: 800,
    collapsedSize: 40,
    collapseThreshold: 180,
  })

  const onBottomDragStart = useCallback(() => {
    setTerminalOpen(true)
  }, [])

  const openTerminalRef = useRef(() => {
    bottomPanel.setCollapsed(false)
    setTerminalOpen(true)
  })
  openTerminalRef.current = () => {
    bottomPanel.setCollapsed(false)
    setTerminalOpen(true)
  }
  const onOpenTerminalAt = useCallback((_dir: string) => {
    openTerminalRef.current()
  }, [])

  const bottomPanel = useResizable({
    direction: 'down',
    initialSize: 250,
    minSize: 120,
    maxSize: 600,
    collapsedSize: 0,
    collapseThreshold: 80,
    onDragStart: onBottomDragStart,
  })

  const serverOnline = status?.serverRunning === true && status?.serverHealth?.status === 'ok'
  const showSetup = !setupDone && !serverOnline

  const handleSetupComplete = () => {
    setSetupDone(true)
    pollStatus()
  }

  const requestOpenExternalLink = useCallback((rawUrl: string) => {
    const safeUrl = normalizeExternalHttpUrl(rawUrl)
    if (!safeUrl || !externalLinksEnabled) return
    setPendingExternalUrl(safeUrl)
  }, [externalLinksEnabled])

  const confirmOpenExternalLink = useCallback(async () => {
    if (!pendingExternalUrl || !window.api?.openExternalUrl) return
    try {
      await window.api.openExternalUrl(pendingExternalUrl)
    } catch (e: any) {
      alert((appLanguage === 'ru' ? 'Не удалось открыть ссылку: ' : 'Failed to open link: ') + (e?.message ?? e))
    } finally {
      setPendingExternalUrl(null)
    }
  }, [pendingExternalUrl])

  const toggleTerminal = () => {
    if (!terminalOpen || bottomPanel.collapsed) {
      bottomPanel.setCollapsed(false)
      setTerminalOpen(true)
    } else {
      bottomPanel.setCollapsed(true)
      setTerminalOpen(false)
    }
  }

  const closeTerminal = () => {
    bottomPanel.setCollapsed(true)
    setTerminalOpen(false)
  }

  const showTerminal = terminalOpen && !bottomPanel.collapsed

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const refreshFileRef = useRef(refreshFile)
  refreshFileRef.current = refreshFile
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  useEffect(() => {
    if (!window.api?.onWorkspaceFilesChanged) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = window.api.onWorkspaceFilesChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        openFilesRef.current.forEach((f) => refreshFileRef.current(f.path))
      }, 600)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!window.api?.onMenuAction) return
    const unsub = window.api.onMenuAction((action, payload) => {
      switch (action) {
        case 'open-recent':
          if (typeof payload === 'string' && payload.trim()) {
            setWorkspace(payload.trim())
          }
          break
        case 'new-chat':
          newSession()
          break
        case 'reset-context':
          resetChat()
          break
        case 'settings-model':
          setSettingsTab('model')
          setSettingsOpen(true)
          break
        case 'settings-tools':
          setSettingsTab('tools')
          setSettingsOpen(true)
          break
        case 'settings-prompts':
          setSettingsTab('prompts')
          setSettingsOpen(true)
          break
        case 'defaults-reset':
          setSettingsOpen(false)
          break
        case 'toggle-terminal':
          toggleTerminal()
          break
        case 'toggle-sidebar':
          sidebar.setCollapsed(!sidebar.collapsed)
          break
      }
    })
    return unsub
  })

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-50">
      {/* Title bar with window controls */}
      {showSetup ? (
        <TitleBar>
          <span className="text-[11px] font-semibold text-zinc-500 tracking-wide">
            ⚡ One-Click Research Agent
          </span>
        </TitleBar>
      ) : (
        <TitleBar>
          <span className="text-[11px] font-semibold text-zinc-500 tracking-wide">
            ⚡ One-Click Research Agent
          </span>
          <div className="relative flex items-center gap-1" ref={fileMenuRef} style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button
              type="button"
              onClick={() => setFileMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 cursor-pointer transition-colors"
              title={appLanguage === 'ru' ? 'Файл' : 'File'}
            >
              {appLanguage === 'ru' ? 'Файл' : 'File'}
            </button>
            {fileMenuOpen && (
              <div className="absolute left-0 top-full mt-0.5 z-50 min-w-[200px] py-1 bg-zinc-900 border border-zinc-700 rounded-md shadow-lg">
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700/80 cursor-pointer"
                  onClick={async () => {
                    setFileMenuOpen(false)
                    const dir = await window.api?.pickDirectory()
                    if (dir?.trim()) setWorkspace(dir.trim())
                  }}
                >
                  {appLanguage === 'ru' ? 'Открыть папку…' : 'Open folder…'}
                </button>
                <div className="border-t border-zinc-700/80 my-1" />
                <div className="px-2 py-0.5 text-[10px] text-zinc-500 uppercase tracking-wider">{appLanguage === 'ru' ? 'Недавние' : 'Recent'}</div>
                {recentWorkspaces.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-zinc-500">{appLanguage === 'ru' ? 'Нет недавних проектов' : 'No recent projects'}</div>
                ) : (
                  recentWorkspaces.map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700/80 cursor-pointer truncate"
                      title={dir}
                      onClick={() => {
                        setFileMenuOpen(false)
                        setWorkspace(dir)
                      }}
                    >
                      {dir.split(/[/\\]/).filter(Boolean).pop() || dir}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => { setSettingsTab('model'); setSettingsOpen(true) }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 cursor-pointer transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as any}
            title={appLanguage === 'ru' ? 'Настройки (модель, контекст, инструменты)' : 'Settings (model, context, tools)'}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {appLanguage === 'ru' ? 'Настройки' : 'Settings'}
          </button>
        </TitleBar>
      )}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} />
      {pendingExternalUrl && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setPendingExternalUrl(null)} />
          <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
            <div className="px-5 py-4 border-b border-zinc-800">
              <div className="text-base font-semibold text-zinc-100">{appLanguage === 'ru' ? 'Открыть внешнюю ссылку?' : 'Open external link?'}</div>
              <div className="text-sm text-zinc-500 mt-1">
                {appLanguage === 'ru' ? 'Ссылка будет открыта в браузере вне приложения.' : 'The link will be opened in your browser outside the app.'}
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 break-all">
                {pendingExternalUrl}
              </div>
            </div>
            <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingExternalUrl(null)}
                className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
              >
                {appLanguage === 'ru' ? 'Отмена' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={confirmOpenExternalLink}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors"
              >
                {appLanguage === 'ru' ? 'Открыть' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        {sidebar.collapsed ? (
          <button
            onClick={() => sidebar.setCollapsed(false)}
            className="w-10 bg-[#0d1117] border-r border-zinc-800/60 flex flex-col items-center pt-3 gap-2 shrink-0 cursor-pointer hover:bg-zinc-900/50 transition-colors"
            title={appLanguage === 'ru' ? 'Развернуть панель' : 'Expand panel'}
          >
            <span className="text-sm">⚡</span>
            <span className="text-[10px] text-zinc-600 [writing-mode:vertical-lr] rotate-180">{appLanguage === 'ru' ? 'Файлы' : 'Files'}</span>
          </button>
        ) : (
          <div style={{ width: sidebar.size }} className="shrink-0 flex flex-col overflow-hidden">
            <Sidebar
              workspace={workspace}
              onWorkspaceChange={setWorkspace}
              onFileClick={openFile}
              serverOnline={serverOnline}
              onReset={resetChat}
              onOpenTerminalAt={onOpenTerminalAt}
              onOpenDiff={handleOpenDiff}
              expandToPath={breadcrumbExpandTo ?? activeFilePath ?? null}
              activeFilePath={activeFilePath}
              appLanguage={appLanguage}
            />
          </div>
        )}

        <div className="resize-handle" onMouseDown={sidebar.onMouseDown} />

        {showSetup ? (
          <main className="flex-1 flex flex-col overflow-hidden">
            <SetupWizard
              status={status}
              downloadProgress={downloadProgress}
              buildStatus={buildStatus}
              onComplete={handleSetupComplete}
              appLanguage={appLanguage}
              onLanguageChange={setAppLanguage}
            />
          </main>
        ) : (
          <>
            {/* Center: editor + bottom terminal */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Editor */}
              <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
                {diffView ? (
                  <DiffViewer
                    filePath={diffView.filePath}
                    original={diffView.original}
                    modified={diffView.modified}
                    onClose={() => setDiffView(null)}
                    appLanguage={appLanguage}
                  />
                ) : (
                  <>
                    <EditorTabs
                      files={openFiles}
                      activeFilePath={activeFilePath}
                      workspace={workspace}
                      onSelect={setActiveFilePath}
                      onClose={closeFile}
                      onCloseAll={closeAll}
                      onCloseOthers={closeOthers}
                      appLanguage={appLanguage}
                    />
                    {activeFile ? (
                      <CodeEditor
                        file={activeFile}
                        workspace={workspace}
                        onAttachCode={addCodeRef}
                        onOpenFile={openFile}
                        onContentChange={(content) => updateFileContent(activeFile.path, content)}
                        onAfterSave={() => refreshFile(activeFile.path)}
                        onBreadcrumbClick={(dirPath) => setBreadcrumbExpandTo(dirPath)}
                        appLanguage={appLanguage}
                      />
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-zinc-600">
                        <div className="text-center">
                          <div className="text-4xl mb-3 opacity-30">⚡</div>
                          <p className="text-sm">{appLanguage === 'ru' ? 'Выбери файл слева' : 'Select a file on the left'}</p>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Resize handle — always between editor and terminal area */}
              <div className="resize-handle-h" onMouseDown={bottomPanel.onMouseDown} />

              {/* Bottom panel: terminal */}
              {showTerminal && (
                <div
                  style={{ height: bottomPanel.size }}
                  className="shrink-0 flex flex-col overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 py-1 bg-[#0d1117] border-b border-zinc-800/40 shrink-0">
                    <span className="text-[11px] text-zinc-400 font-semibold">{appLanguage === 'ru' ? 'Терминал' : 'Terminal'}</span>
                    <button
                      onClick={closeTerminal}
                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[10px]"
                      title={appLanguage === 'ru' ? 'Закрыть терминал' : 'Close terminal'}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <Terminal workspace={workspace} visible={showTerminal} />
                  </div>
                </div>
              )}
            </div>

            <div className="resize-handle" onMouseDown={chat.onMouseDown} />

            {/* Chat panel */}
            {chat.collapsed ? (
              <button
                onClick={() => chat.setCollapsed(false)}
                className="w-10 bg-[#0d1117] border-l border-zinc-800/60 flex flex-col items-center pt-3 gap-2 shrink-0 cursor-pointer hover:bg-zinc-900/50 transition-colors"
                title={appLanguage === 'ru' ? 'Развернуть чат' : 'Expand chat'}
              >
                <span className="text-sm">💬</span>
                <span className="text-[10px] text-zinc-600 [writing-mode:vertical-lr] rotate-180">{appLanguage === 'ru' ? 'Агент' : 'Agent'}</span>
              </button>
            ) : (
              <div
                style={{ width: chat.size }}
                className="border-l border-zinc-800/60 flex flex-col shrink-0 overflow-hidden panel-contain"
              >
                <SessionTabs
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  busy={busy}
                  onNew={newSession}
                  onSwitch={switchToSession}
                  onDelete={removeSession}
                  appLanguage={appLanguage}
                  onCollapse={() => chat.setCollapsed(true)}
                />
                <Chat
                  messages={messages}
                  busy={busy}
                  workspace={workspace}
                  onSend={sendMessage}
                  onCancel={cancel}
                  onApproval={(id, approved) => respondApproval(id, approved)}
                  codeRefs={codeRefs}
                  onRemoveCodeRef={removeCodeRef}
                  contextUsage={contextUsage}
                  externalLinksEnabled={externalLinksEnabled}
                  onOpenExternalLink={requestOpenExternalLink}
                  appLanguage={appLanguage}
                  onCitationClick={handleCitationClick}
                />
                <ResearchArtifacts
                  workspace={workspace}
                  appLanguage={appLanguage}
                  onOpenFile={openFile}
                />
                <SourcesPanel
                  sessionId={activeSessionId}
                  workspace={workspace}
                  appLanguage={appLanguage}
                  externalLinksEnabled={externalLinksEnabled}
                  onOpenExternalLink={requestOpenExternalLink}
                  highlightCitationToken={citationHighlight}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center shrink-0">
        <div className="flex-1">
          <StatusBar status={status} tokensPerSecond={tokensPerSecond} />
        </div>
        {!showSetup && (
          <button
            onClick={toggleTerminal}
            className={`px-3 h-6 text-[10px] border-t border-zinc-800/60 flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 ${
              showTerminal
                ? 'bg-zinc-800/60 text-zinc-300'
                : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300'
            }`}
            title={appLanguage === 'ru' ? 'Ctrl+` — Терминал' : 'Ctrl+` — Terminal'}
          >
            <span className="text-[9px]">▸</span>
            {appLanguage === 'ru' ? 'Терминал' : 'Terminal'}
          </button>
        )}
      </div>
    </div>
  )
}
