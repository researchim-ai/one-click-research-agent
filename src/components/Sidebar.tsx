import { useState, useEffect, useCallback, useRef, useMemo, memo, type KeyboardEvent, type MouseEvent } from 'react'
import type { FileTreeEntry } from '../../electron/types'
import { ContextMenu, type MenuItem } from './ContextMenu'

/** Returns parent directory paths (ancestors) of the given path, for expanding tree. */
function getParentPaths(filePath: string): string[] {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const parts = filePath.split(sep)
  if (parts.length <= 1) return []
  const dirParts = parts.slice(0, -1)
  if (dirParts.length === 0) return []
  if (parts[0] === '') {
    return [sep, ...Array.from({ length: dirParts.length - 1 }, (_, i) => sep + dirParts.slice(1, i + 2).join(sep))]
  }
  return dirParts.map((_, i) => dirParts.slice(0, i + 1).join(sep))
}

interface Props {
  workspace: string
  onWorkspaceChange: (ws: string) => void
  onFileClick: (filePath: string) => void
  serverOnline: boolean
  onReset: () => void
  onOpenTerminalAt?: (dir: string) => void
  onAttachToChat?: (filePath: string) => void
  onOpenDiff?: (filePath: string) => void
  expandToPath?: string | null
  activeFilePath?: string | null
  appLanguage?: 'ru' | 'en'
}

interface CtxMenuState {
  x: number
  y: number
  entry: FileTreeEntry
}

function FileIcon({ name, isDir }: { name: string; isDir: boolean }) {
  if (isDir) return <span className="text-blue-400 text-[11px]">📁</span>
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️', json: '📋',
    py: '🐍', rs: '🦀', go: '🔵', java: '☕', rb: '💎',
    md: '📝', txt: '📄', yml: '⚙️', yaml: '⚙️', toml: '⚙️',
    html: '🌐', css: '🎨', scss: '🎨', svg: '🖼️', png: '🖼️',
    sh: '🐚', bash: '🐚', dockerfile: '🐳',
    lock: '🔒', gitignore: '👁️',
    c: '🇨', cpp: '⊕', h: '🇭', hpp: '⊕',
    swift: '🧡', kt: '🟣', dart: '🎯', vue: '💚', svelte: '🔥',
  }
  return <span className="text-[11px] opacity-70">{icons[ext] ?? '📄'}</span>
}

function InlineInput({
  onSubmit, onCancel, placeholder, depth, defaultValue,
}: {
  onSubmit: (name: string) => void
  onCancel: () => void
  placeholder: string
  depth: number
  defaultValue?: string
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    if (defaultValue) ref.current?.select()
  }, [defaultValue])

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const val = ref.current?.value.trim()
      if (val) onSubmit(val)
      else onCancel()
    }
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="flex items-center gap-1.5 py-[2px] px-2" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
      <input
        ref={ref}
        type="text"
        defaultValue={defaultValue}
        placeholder={placeholder}
        onKeyDown={handleKey}
        onBlur={onCancel}
        className="flex-1 bg-zinc-800 border border-blue-500/60 rounded px-1.5 py-0.5 text-xs text-zinc-100 outline-none placeholder-zinc-600 min-w-0"
      />
    </div>
  )
}

function gitStatusLabel(xy: string): { label: string; className: string } {
  const x = xy[0] ?? ''
  const y = xy[1] ?? ''
  if (x === '?' || y === '?') return { label: 'U', className: 'text-amber-400' }
  if (x === 'A' || y === 'A') return { label: 'A', className: 'text-emerald-400' }
  if (x === 'D' || y === 'D') return { label: 'D', className: 'text-red-400' }
  if (x === 'M' || y === 'M' || x === 'm' || y === 'm') return { label: 'M', className: 'text-orange-400' }
  if (x === 'U' || y === 'U') return { label: 'U', className: 'text-purple-400' }
  return { label: xy.slice(0, 1) || ' ', className: 'text-zinc-500' }
}

function TreeNode({
  entry, depth, onFileClick, onRefresh, onContextMenu,
  renamingPath, ctxCreateAt, onRenameSubmit, onRenameCancel,
  onCtxCreateSubmit, onCtxCreateCancel,
  gitStatusByPath,
  expandedPaths,
  setExpandedPaths,
  activeFilePath,
  L,
}: {
  entry: FileTreeEntry
  depth: number
  onFileClick: (path: string) => void
  onRefresh: () => void
  onContextMenu: (e: MouseEvent, entry: FileTreeEntry) => void
  renamingPath: string | null
  ctxCreateAt: { dirPath: string; type: 'file' | 'dir' } | null
  onRenameSubmit: (newName: string) => void
  onRenameCancel: () => void
  onCtxCreateSubmit: (name: string) => void
  onCtxCreateCancel: () => void
  gitStatusByPath?: Map<string, string>
  expandedPaths: Set<string>
  setExpandedPaths: (fn: (prev: Set<string>) => Set<string>) => void
  activeFilePath?: string | null
  L: boolean
}) {
  const isExpanded = expandedPaths.has(entry.path)
  const setExpanded = (exp: boolean) => setExpandedPaths((prev) => {
    const next = new Set(prev)
    if (exp) next.add(entry.path)
    else next.delete(entry.path)
    return next
  })
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null)

  const isRenaming = renamingPath === entry.path
  const isCtxCreateTarget = ctxCreateAt?.dirPath === entry.path
  const isActive = activeFilePath != null && entry.path === activeFilePath

  useEffect(() => {
    if (isCtxCreateTarget) setExpanded(true)
  }, [isCtxCreateTarget, entry.path])

  const handleCreate = async (name: string) => {
    const sep = entry.path.includes('\\') ? '\\' : '/'
    const fullPath = entry.path + sep + name
    try {
      if (creating === 'dir') {
        await window.api.createDirectory(fullPath)
      } else {
        await window.api.createFile(fullPath)
        onFileClick(fullPath)
      }
    } catch (e) {
      console.error('Create failed:', e)
    }
    setCreating(null)
    onRefresh()
  }

  const handleCtx = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, entry)
  }

  if (isRenaming) {
    return (
      <InlineInput
        depth={depth}
        placeholder={L ? 'новое имя…' : 'new name…'}
        defaultValue={entry.name}
        onSubmit={onRenameSubmit}
        onCancel={onRenameCancel}
      />
    )
  }

  const fileGitStatus = gitStatusByPath?.get(entry.path)
  const statusBadge = fileGitStatus ? gitStatusLabel(fileGitStatus) : null

  if (!entry.isDir) {
    return (
      <button
        onClick={() => onFileClick(entry.path)}
        onContextMenu={handleCtx}
        className={`w-full flex items-center gap-1.5 py-[3px] px-2 rounded text-xs cursor-pointer select-none text-left group ${isActive ? 'bg-blue-500/20 text-zinc-100' : 'hover:bg-zinc-800/60'}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <FileIcon name={entry.name} isDir={false} />
        <span className="truncate text-zinc-300 flex-1 min-w-0">{entry.name}</span>
        {statusBadge && (
          <span className={`shrink-0 text-[10px] font-semibold ${statusBadge.className}`} title={fileGitStatus}>
            {statusBadge.label}
          </span>
        )}
      </button>
    )
  }

  return (
    <div>
      <div
        onContextMenu={handleCtx}
        className="w-full flex items-center gap-1.5 py-[3px] px-2 hover:bg-zinc-800/60 rounded text-xs select-none group"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <button
          onClick={() => setExpanded(!isExpanded)}
          className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer text-left"
        >
          <span className="text-zinc-500 text-[10px] w-3 text-center">{isExpanded ? '▼' : '▶'}</span>
          <FileIcon name={entry.name} isDir={true} />
          <span className="truncate text-zinc-200 font-medium">{entry.name}</span>
        </button>
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setCreating('file') }}
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[10px]"
            title={L ? 'Новый файл' : 'New file'}
          >+</button>
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setCreating('dir') }}
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[9px]"
            title={L ? 'Новая папка' : 'New folder'}
          >📁</button>
        </div>
      </div>
      {isExpanded && (
        <>
          {isCtxCreateTarget && (
            <InlineInput
              depth={depth + 1}
              placeholder={ctxCreateAt.type === 'dir' ? (L ? 'имя папки…' : 'folder name…') : (L ? 'имя файла…' : 'file name…')}
              onSubmit={onCtxCreateSubmit}
              onCancel={onCtxCreateCancel}
            />
          )}
          {creating && (
            <InlineInput
              depth={depth + 1}
              placeholder={creating === 'dir' ? (L ? 'имя папки…' : 'folder name…') : (L ? 'имя файла…' : 'file name…')}
              onSubmit={handleCreate}
              onCancel={() => setCreating(null)}
            />
          )}
          {entry.children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onRefresh={onRefresh}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              ctxCreateAt={ctxCreateAt}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onCtxCreateSubmit={onCtxCreateSubmit}
              onCtxCreateCancel={onCtxCreateCancel}
              gitStatusByPath={gitStatusByPath}
              expandedPaths={expandedPaths}
              setExpandedPaths={setExpandedPaths}
              activeFilePath={activeFilePath}
              L={L}
            />
          ))}
        </>
      )}
    </div>
  )
}

export const Sidebar = memo(function Sidebar({ workspace, onWorkspaceChange, onFileClick, serverOnline, onReset, onOpenTerminalAt, onAttachToChat, onOpenDiff, expandToPath, activeFilePath, appLanguage = 'ru' }: Props) {
  const L = appLanguage === 'ru'
  const [tree, setTree] = useState<FileTreeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [creatingRoot, setCreatingRoot] = useState<'file' | 'dir' | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renamingOrigName, setRenamingOrigName] = useState<string>('')
  const [ctxCreateAt, setCtxCreateAt] = useState<{ dirPath: string; type: 'file' | 'dir' } | null>(null)
  const [gitStatus, setGitStatus] = useState<import('../../electron/git').GitStatus | null>(null)
  const [gitNumstat, setGitNumstat] = useState<import('../../electron/git').GitNumstatEntry[]>([])
  const [sourceControlOpen, setSourceControlOpen] = useState(true)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!expandToPath) return
    const parents = getParentPaths(expandToPath)
    if (parents.length === 0) return
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      parents.forEach((p) => next.add(p))
      return next
    })
  }, [expandToPath])

  const loadTree = useCallback(async () => {
    if (!workspace) { setTree([]); return }
    setLoading(true)
    try {
      const files = await window.api.listFiles(workspace)
      setTree(files)
    } catch {
      setTree([])
    }
    setLoading(false)
  }, [workspace])

  useEffect(() => { loadTree() }, [loadTree])

  const loadTreeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadTreeRef = useRef(loadTree)
  loadTreeRef.current = loadTree
  const debouncedLoadTree = useCallback(() => {
    if (loadTreeTimerRef.current) clearTimeout(loadTreeTimerRef.current)
    loadTreeTimerRef.current = setTimeout(() => {
      loadTreeTimerRef.current = null
      loadTreeRef.current()
    }, 500)
  }, [])

  useEffect(() => {
    if (!window.api?.onWorkspaceFilesChanged || !workspace) return
    const unsub = window.api.onWorkspaceFilesChanged(debouncedLoadTree)
    return () => {
      unsub()
      if (loadTreeTimerRef.current) {
        clearTimeout(loadTreeTimerRef.current)
        loadTreeTimerRef.current = null
      }
    }
  }, [workspace, debouncedLoadTree])

  const loadGitStatus = useCallback(async () => {
    if (!workspace || !window.api?.getGitStatus) return
    try {
      const [status, numstat] = await Promise.all([
        window.api.getGitStatus(workspace),
        window.api.getGitNumstat?.(workspace) ?? Promise.resolve([]),
      ])
      setGitStatus(status)
      setGitNumstat(Array.isArray(numstat) ? numstat : [])
    } catch {
      setGitStatus(null)
      setGitNumstat([])
    }
  }, [workspace])

  useEffect(() => {
    loadGitStatus()
  }, [loadGitStatus])

  const gitStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!window.api?.onWorkspaceFilesChanged || !workspace) return
    const unsub = window.api.onWorkspaceFilesChanged(() => {
      if (gitStatusTimerRef.current) clearTimeout(gitStatusTimerRef.current)
      gitStatusTimerRef.current = setTimeout(() => {
        gitStatusTimerRef.current = null
        loadGitStatus()
      }, 600)
    })
    return () => {
      unsub()
      if (gitStatusTimerRef.current) clearTimeout(gitStatusTimerRef.current)
    }
  }, [workspace, loadGitStatus])

  const gitStatusByPath = useMemo(() => {
    if (!workspace || !gitStatus?.isRepo || !gitStatus.files.length) return undefined
    const sep = workspace.includes('\\') ? '\\' : '/'
    const map = new Map<string, string>()
    for (const f of gitStatus.files) {
      const full = (workspace + sep + f.path).replace(/[/\\]+/g, sep)
      map.set(full, f.status)
    }
    return map
  }, [workspace, gitStatus])

  const numstatByPath = useMemo(() => {
    const map = new Map<string, { added: number; deleted: number }>()
    for (const n of gitNumstat) {
      map.set(n.path, { added: n.added, deleted: n.deleted })
    }
    return map
  }, [gitNumstat])

  const handlePickDir = async () => {
    const dir = await window.api.pickDirectory()
    if (dir) onWorkspaceChange(dir)
  }

  const handleCreateRoot = async (name: string) => {
    const sep = workspace.includes('\\') ? '\\' : '/'
    const fullPath = workspace + sep + name
    try {
      if (creatingRoot === 'dir') {
        await window.api.createDirectory(fullPath)
      } else {
        await window.api.createFile(fullPath)
        onFileClick(fullPath)
      }
    } catch (e) {
      console.error('Create failed:', e)
    }
    setCreatingRoot(null)
    loadTree()
  }

  const handleRenameSubmit = async (newName: string) => {
    if (!renamingPath) return
    const sep = renamingPath.includes('\\') ? '\\' : '/'
    const parts = renamingPath.split(sep)
    parts[parts.length - 1] = newName
    const newPath = parts.join(sep)
    try {
      await window.api.renameFile(renamingPath, newPath)
    } catch (e) {
      console.error('Rename failed:', e)
    }
    setRenamingPath(null)
    loadTree()
  }

  const handleCtxCreateSubmit = async (name: string) => {
    if (!ctxCreateAt) return
    const sep = ctxCreateAt.dirPath.includes('\\') ? '\\' : '/'
    const fullPath = ctxCreateAt.dirPath + sep + name
    try {
      if (ctxCreateAt.type === 'dir') {
        await window.api.createDirectory(fullPath)
      } else {
        await window.api.createFile(fullPath)
        onFileClick(fullPath)
      }
    } catch (e) {
      console.error('Create failed:', e)
    }
    setCtxCreateAt(null)
    loadTree()
  }

  const handleDelete = async (entry: FileTreeEntry) => {
    const label = entry.isDir ? (L ? 'папку' : 'folder') : (L ? 'файл' : 'file')
    if (!confirm(`${L ? 'Удалить' : 'Delete'} ${label} "${entry.name}"?`)) return
    try {
      await window.api.deletePath(entry.path)
    } catch (e) {
      console.error('Delete failed:', e)
    }
    loadTree()
  }

  const handleContextMenu = (e: MouseEvent, entry: FileTreeEntry) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const relPath = (fullPath: string) => {
    if (fullPath.startsWith(workspace)) {
      const rel = fullPath.slice(workspace.length).replace(/^[\\/]/, '')
      return rel || fullPath
    }
    return fullPath
  }

  const buildMenuItems = (entry: FileTreeEntry): MenuItem[] => {
    const items: MenuItem[] = []

    if (!entry.isDir) {
      items.push({
        label: L ? 'Открыть' : 'Open',
        icon: '📄',
        action: () => onFileClick(entry.path),
      })
      if (onAttachToChat) {
        items.push({
          label: L ? 'Прикрепить к чату (@)' : 'Attach to chat (@)',
          icon: '💬',
          action: () => onAttachToChat(entry.path),
        })
      }
      items.push({ label: '', separator: true, action: () => {} })
    }

    if (entry.isDir) {
      items.push({
        label: L ? 'Новый файл…' : 'New file…',
        icon: '+',
        action: () => setCtxCreateAt({ dirPath: entry.path, type: 'file' }),
      })
      items.push({
        label: L ? 'Новая папка…' : 'New folder…',
        icon: '📁',
        action: () => setCtxCreateAt({ dirPath: entry.path, type: 'dir' }),
      })
      if (onOpenTerminalAt) {
        items.push({
          label: L ? 'Открыть терминал здесь' : 'Open terminal here',
          icon: '▸',
          action: () => onOpenTerminalAt(entry.path),
        })
      }
      items.push({ label: '', separator: true, action: () => {} })
    }

    items.push({
      label: L ? 'Копировать путь' : 'Copy path',
      icon: '📋',
      action: () => window.api.copyToClipboard(entry.path),
    })
    items.push({
      label: L ? 'Копировать относительный путь' : 'Copy relative path',
      icon: '📋',
      action: () => window.api.copyToClipboard(relPath(entry.path)),
    })
    items.push({
      label: L ? 'Показать в проводнике' : 'Reveal in explorer',
      icon: '📂',
      action: () => window.api.revealInExplorer(entry.path),
    })

    items.push({ label: '', separator: true, action: () => {} })

    items.push({
      label: L ? 'Переименовать' : 'Rename',
      icon: '✏️',
      shortcut: 'F2',
      action: () => {
        setRenamingPath(entry.path)
        setRenamingOrigName(entry.name)
      },
    })
    items.push({
      label: L ? 'Удалить' : 'Delete',
      icon: '🗑️',
      danger: true,
      shortcut: 'Del',
      action: () => handleDelete(entry),
    })

    return items
  }

  const dirName = workspace ? workspace.split(/[\\/]/).pop() || workspace : null

  return (
    <aside className="h-full bg-[#0d1117] border-r border-zinc-800/60 flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2">
        <button
          onClick={handlePickDir}
          className="flex-1 flex items-center gap-2 min-w-0 hover:text-blue-400 transition-colors cursor-pointer"
          title={workspace || (L ? 'Открыть проект' : 'Open project')}
        >
          <span className="text-sm">⚡</span>
          {dirName ? (
            <span className="text-[12px] font-semibold truncate">{dirName}</span>
          ) : (
            <span className="text-[12px] text-zinc-500">{L ? 'Открыть проект…' : 'Open project…'}</span>
          )}
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          {workspace && (
            <>
              <button onClick={() => setCreatingRoot('file')} title={L ? 'Новый файл' : 'New file'}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[12px]">+</button>
              <button onClick={() => setCreatingRoot('dir')} title={L ? 'Новая папка' : 'New folder'}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[10px]">📁</button>
            </>
          )}
          <button onClick={onReset} title={L ? 'Новый чат' : 'New chat'}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[10px]">✦</button>
          <button onClick={() => { loadTree(); loadGitStatus() }} title={L ? 'Обновить' : 'Refresh'}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[11px]">↻</button>
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!workspace && (
          <div className="px-4 py-8 text-center">
            <button onClick={handlePickDir} className="text-sm text-blue-400 hover:text-blue-300 transition-colors cursor-pointer">{L ? '📂 Открыть проект' : '📂 Open project'}</button>
            <p className="text-[10px] text-zinc-600 mt-2">{L ? 'Выбери директорию' : 'Choose a directory'}</p>
          </div>
        )}
        {workspace && loading && <div className="px-4 py-4 text-xs text-zinc-500">{L ? 'Загрузка…' : 'Loading…'}</div>}
        {workspace && !loading && tree.length === 0 && !creatingRoot && <div className="px-4 py-4 text-xs text-zinc-500">{L ? 'Пусто' : 'Empty'}</div>}
        {creatingRoot && (
          <InlineInput depth={0} placeholder={creatingRoot === 'dir' ? (L ? 'имя папки…' : 'folder name…') : (L ? 'имя файла…' : 'file name…')} onSubmit={handleCreateRoot} onCancel={() => setCreatingRoot(null)} />
        )}
        {ctxCreateAt?.dirPath === workspace && (
          <InlineInput
            depth={0}
            placeholder={ctxCreateAt.type === 'dir' ? (L ? 'имя папки…' : 'folder name…') : (L ? 'имя файла…' : 'file name…')}
            onSubmit={handleCtxCreateSubmit}
            onCancel={() => setCtxCreateAt(null)}
          />
        )}
        {tree.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            onFileClick={onFileClick}
            onRefresh={loadTree}
            onContextMenu={handleContextMenu}
            renamingPath={renamingPath}
            ctxCreateAt={ctxCreateAt}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={() => setRenamingPath(null)}
            onCtxCreateSubmit={handleCtxCreateSubmit}
            onCtxCreateCancel={() => setCtxCreateAt(null)}
            gitStatusByPath={gitStatusByPath}
            expandedPaths={expandedPaths}
            setExpandedPaths={setExpandedPaths}
            activeFilePath={activeFilePath}
            L={L}
          />
        ))}
      </div>

      {/* Source Control */}
      {workspace && (
        <div className="border-t border-zinc-800/60 shrink-0">
          <button
            onClick={() => setSourceControlOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 transition-colors"
          >
            <span className="text-zinc-500">{sourceControlOpen ? '▼' : '▶'}</span>
            <span className="font-medium">Source Control</span>
            {gitStatus?.isRepo && gitStatus.files.length > 0 && (
              <span className="ml-auto text-zinc-500 tabular-nums">{gitStatus.files.length}</span>
            )}
          </button>
          {sourceControlOpen && (
            <div className="px-2 pb-2 max-h-40 overflow-y-auto">
              {!gitStatus && <div className="text-[10px] text-zinc-600 py-1">{L ? 'Проверка git…' : 'Checking git…'}</div>}
              {gitStatus && !gitStatus.isRepo && (
                <div className="text-[10px] text-zinc-600 py-1">{L ? 'Не репозиторий git' : 'Not a git repository'}</div>
              )}
              {gitStatus?.isRepo && (
                <>
                  {gitStatus.branch && (
                    <div className="text-[10px] text-zinc-500 py-0.5 flex items-center gap-1">
                      <span className="text-blue-400">◇</span> {gitStatus.branch}
                    </div>
                  )}
                  {gitStatus.files.length === 0 && (
                    <div className="text-[10px] text-zinc-600 py-1">{L ? 'Нет изменений' : 'No changes'}</div>
                  )}
                  {gitStatus.files.length > 0 && (
                    <div className="space-y-0.5">
                      {gitStatus.files.slice(0, 50).map((f) => {
                        const badge = gitStatusLabel(f.status)
                        const stats = numstatByPath.get(f.path)
                        const sep = workspace.includes('\\') ? '\\' : '/'
                        const fullPath = (workspace + sep + f.path).replace(/[/\\]+/g, sep)
                        return (
                          <div
                            key={f.path}
                            className="flex items-center gap-1 py-0.5 px-1 rounded text-[10px] hover:bg-zinc-800/50 group"
                            title={f.path}
                          >
                            <div
                              className="flex items-center gap-1 min-w-0 flex-1 cursor-pointer truncate"
                              onClick={() => onFileClick(fullPath)}
                            >
                              <span className={`shrink-0 font-semibold w-3 ${badge.className}`}>{badge.label}</span>
                              <span className="truncate text-zinc-400">{f.path}</span>
                            </div>
                            {(stats?.added !== undefined || stats?.deleted !== undefined) && (
                              <span className="shrink-0 text-emerald-400/90 tabular-nums">
                                +{stats?.added ?? 0}
                              </span>
                            )}
                            {(stats?.added !== undefined || stats?.deleted !== undefined) && (
                              <span className="shrink-0 text-red-400/90 tabular-nums">
                                -{stats?.deleted ?? 0}
                              </span>
                            )}
                            {onOpenDiff && (
                              <button
                                type="button"
                                className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-blue-400 cursor-pointer"
                                title={L ? 'Показать diff' : 'Show diff'}
                                onClick={(e) => { e.stopPropagation(); onOpenDiff(fullPath) }}
                              >
                                ⇔
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {gitStatus.files.length > 50 && (
                        <div className="text-[10px] text-zinc-600 py-0.5">+{gitStatus.files.length - 50} {L ? 'ещё' : 'more'}</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Status */}
      <div className="px-3 py-1.5 border-t border-zinc-800/60 flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serverOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="text-[10px] text-zinc-500 truncate">{serverOnline ? (L ? 'Онлайн' : 'Online') : (L ? 'Оффлайн' : 'Offline')}</span>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems(ctxMenu.entry)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  )
})
