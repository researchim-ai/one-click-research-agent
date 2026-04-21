import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AppStatus, DownloadProgress, SystemResources } from './types'

contextBridge.exposeInMainWorld('api', {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('get-status'),
  detectResources: (): Promise<SystemResources> => ipcRenderer.invoke('detect-resources'),
  getModelVariants: (override?: { gpuMode?: import('./types').GpuMode; gpuIndex?: number | null }): Promise<any[]> =>
    ipcRenderer.invoke('get-model-variants', override),
  getWebSearchStatus: (
    override?: Pick<import('./config').AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>
  ): Promise<import('./types').WebSearchStatus> => ipcRenderer.invoke('get-web-search-status', override),
  ensureWebSearch: (
    override?: Pick<import('./config').AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>
  ): Promise<import('./types').WebSearchStatus> => ipcRenderer.invoke('ensure-web-search', override),
  selectModelVariant: (quant: string): Promise<void> => ipcRenderer.invoke('select-model-variant', quant),
  getConfig: (): Promise<any> => ipcRenderer.invoke('get-config'),
  saveConfig: (partial: any): Promise<any> => ipcRenderer.invoke('save-config', partial),
  getTools: (): Promise<any[]> => ipcRenderer.invoke('get-tools'),
  saveCustomTool: (tool: any): Promise<any[]> => ipcRenderer.invoke('save-custom-tool', tool),
  deleteCustomTool: (toolId: string): Promise<any[]> => ipcRenderer.invoke('delete-custom-tool', toolId),
  getPrompts: (): Promise<any> => ipcRenderer.invoke('get-prompts'),
  savePrompts: (prompts: any): Promise<void> => ipcRenderer.invoke('save-prompts', prompts),
  resetAllDefaults: (): Promise<void> => ipcRenderer.invoke('reset-all-defaults'),
  restartServer: (): Promise<{ requestedCtx: number; actualCtx: number } | void> => ipcRenderer.invoke('restart-server'),
  autoSetup: (): Promise<void> => ipcRenderer.invoke('auto-setup'),
  downloadModel: (): Promise<string> => ipcRenderer.invoke('download-model'),
  ensureLlama: (): Promise<void> => ipcRenderer.invoke('ensure-llama'),
  startServer: (): Promise<void> => ipcRenderer.invoke('start-server'),
  stopServer: (): Promise<void> => ipcRenderer.invoke('stop-server'),
  sendMessage: (msg: string, workspace: string): Promise<string> =>
    ipcRenderer.invoke('send-message', msg, workspace),
  resetAgent: (workspace: string): Promise<void> => ipcRenderer.invoke('reset-agent', workspace),
  cancelAgent: (): Promise<void> => ipcRenderer.invoke('cancel-agent'),
  setWorkspace: (ws: string): Promise<void> => ipcRenderer.invoke('set-workspace', ws),
  getRecentWorkspaces: (): Promise<string[]> => ipcRenderer.invoke('get-recent-workspaces'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),
  listFiles: (workspace: string, dirPath?: string): Promise<import('./types').FileTreeEntry[]> =>
    ipcRenderer.invoke('list-files', workspace, dirPath),
  getGitStatus: (workspace: string): Promise<import('./git').GitStatus> =>
    ipcRenderer.invoke('git-status', workspace),
  getGitNumstat: (workspace: string): Promise<import('./git').GitNumstatEntry[]> =>
    ipcRenderer.invoke('git-numstat', workspace),
  getGitFileAtHead: (workspace: string, relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('git-file-at-head', workspace, relativePath),
  readFileContent: (filePath: string): Promise<{ content: string; size: number; lines: number }> =>
    ipcRenderer.invoke('read-file-content', filePath),
  writeFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('write-file', filePath, content),
  tsGetDefinition: (workspacePath: string, filePath: string, fileContent: string, line: number, column: number) =>
    ipcRenderer.invoke('ts-get-definition', workspacePath, filePath, fileContent, line, column),
  tsGetHover: (workspacePath: string, filePath: string, fileContent: string, line: number, column: number) =>
    ipcRenderer.invoke('ts-get-hover', workspacePath, filePath, fileContent, line, column),
  tsGetCompletions: (workspacePath: string, filePath: string, fileContent: string, line: number, column: number) =>
    ipcRenderer.invoke('ts-get-completions', workspacePath, filePath, fileContent, line, column),
  tsGetDiagnostics: (workspacePath: string, filePath: string, fileContent?: string) =>
    ipcRenderer.invoke('ts-get-diagnostics', workspacePath, filePath, fileContent),
  pyResolveModule: (workspacePath: string, moduleName: string) =>
    ipcRenderer.invoke('py-resolve-module', workspacePath, moduleName),

  onAgentEvent: (cb: (event: AgentEvent) => void) => {
    const listener = (_: any, data: AgentEvent) => cb(data)
    ipcRenderer.on('agent-event', listener)
    return () => { ipcRenderer.removeListener('agent-event', listener) }
  },
  onDownloadProgress: (cb: (progress: DownloadProgress) => void) => {
    const listener = (_: any, data: DownloadProgress) => cb(data)
    ipcRenderer.on('download-progress', listener)
    return () => { ipcRenderer.removeListener('download-progress', listener) }
  },
  onBuildStatus: (cb: (status: string) => void) => {
    const listener = (_: any, data: string) => cb(data)
    ipcRenderer.on('build-status', listener)
    return () => { ipcRenderer.removeListener('build-status', listener) }
  },
  onMenuAction: (cb: (action: string, payload?: unknown) => void) => {
    const listener = (_: any, action: string, payload?: unknown) => cb(action, payload)
    ipcRenderer.on('menu-action', listener)
    return () => { ipcRenderer.removeListener('menu-action', listener) }
  },
  onWorkspaceFilesChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('workspace-files-changed', listener)
    return () => { ipcRenderer.removeListener('workspace-files-changed', listener) }
  },
  respondApproval: (approvalId: string, approved: boolean) => {
    ipcRenderer.send('command-approval-response', approvalId, approved)
  },

  // Session management (workspace-scoped)
  createSession: (workspace: string): Promise<string> => ipcRenderer.invoke('create-session', workspace),
  switchSession: (workspace: string, id: string): Promise<boolean> => ipcRenderer.invoke('switch-session', workspace, id),
  listSessions: (workspace: string): Promise<any[]> => ipcRenderer.invoke('list-sessions', workspace),
  deleteSession: (workspace: string, id: string): Promise<void> => ipcRenderer.invoke('delete-session', workspace, id),
  renameSession: (workspace: string, id: string, title: string): Promise<void> => ipcRenderer.invoke('rename-session', workspace, id, title),
  getActiveSessionId: (workspace: string): Promise<string | null> => ipcRenderer.invoke('get-active-session-id', workspace),
  saveUiMessages: (workspace: string, id: string, msgs: any[]): Promise<void> => ipcRenderer.invoke('save-ui-messages', workspace, id, msgs),
  getUiMessages: (workspace: string, id: string): Promise<any[]> => ipcRenderer.invoke('get-ui-messages', workspace, id),

  // File operations
  createFile: (filePath: string): Promise<void> => ipcRenderer.invoke('create-file', filePath),
  createDirectory: (dirPath: string): Promise<void> => ipcRenderer.invoke('create-directory', dirPath),
  renameFile: (oldPath: string, newPath: string): Promise<void> => ipcRenderer.invoke('rename-file', oldPath, newPath),
  deletePath: (targetPath: string): Promise<void> => ipcRenderer.invoke('delete-path', targetPath),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('copy-to-clipboard', text),
  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('open-external-url', url),
  revealInExplorer: (targetPath: string): Promise<void> => ipcRenderer.invoke('reveal-in-explorer', targetPath),
  openInTerminalPath: (dirPath: string): Promise<string> => ipcRenderer.invoke('open-in-terminal-path', dirPath),

  // Window controls (frameless)
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('win-is-maximized'),

  // Research features: sources / plan / artifacts / embeddings / knowledge index
  getSessionSources: (sessionId: string): Promise<any[]> => ipcRenderer.invoke('get-session-sources', sessionId),
  getResearchPlan: (workspace: string): Promise<any> => ipcRenderer.invoke('get-research-plan', workspace),
  listResearchArtifacts: (workspace: string): Promise<Array<{ relPath: string; size: number; mtime: number; kind: string }>> =>
    ipcRenderer.invoke('list-research-artifacts', workspace),
  embedStatus: (): Promise<{ isRunning: boolean; modelDownloaded: boolean; modelPath: string | null; defaultModelPath: string; apiUrl: string }> =>
    ipcRenderer.invoke('embed-status'),
  embedDownloadModel: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('embed-download-model'),
  embedStart: (modelPath?: string): Promise<{ ok: boolean; error?: string; log?: string }> =>
    ipcRenderer.invoke('embed-start', modelPath),
  embedStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('embed-stop'),
  onEmbedDownloadProgress: (cb: (pct: number) => void) => {
    const listener = (_: any, pct: number) => cb(pct)
    ipcRenderer.on('embed-download-progress', listener)
    return () => { ipcRenderer.removeListener('embed-download-progress', listener) }
  },
  knowledgeIndexStats: (workspace: string): Promise<{ chunks: number; docs: number; hasVectors: boolean }> =>
    ipcRenderer.invoke('knowledge-index-stats', workspace),
  knowledgeIndexRebuild: (workspace: string): Promise<{ ok: boolean; chunks?: number; error?: string }> =>
    ipcRenderer.invoke('knowledge-index-rebuild', workspace),
  onKnowledgeIndexProgress: (cb: (progress: { done: number; total: number }) => void) => {
    const listener = (_: any, p: { done: number; total: number }) => cb(p)
    ipcRenderer.on('knowledge-index-progress', listener)
    return () => { ipcRenderer.removeListener('knowledge-index-progress', listener) }
  },

  // Terminal
  terminalCreate: (cwd: string): Promise<string> => ipcRenderer.invoke('terminal-create', cwd),
  terminalInput: (id: string, data: string) => ipcRenderer.send('terminal-input', id, data),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal-resize', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.send('terminal-kill', id),
  onTerminalData: (cb: (id: string, data: string) => void) => {
    const listener = (_: any, id: string, data: string) => cb(id, data)
    ipcRenderer.on('terminal-data', listener)
    return () => { ipcRenderer.removeListener('terminal-data', listener) }
  },
  onTerminalExit: (cb: (id: string, exitCode: number) => void) => {
    const listener = (_: any, id: string, exitCode: number) => cb(id, exitCode)
    ipcRenderer.on('terminal-exit', listener)
    return () => { ipcRenderer.removeListener('terminal-exit', listener) }
  },
})
