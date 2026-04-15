import { useState, memo, type MouseEvent } from 'react'
import type { OpenFile } from '../hooks/useEditor'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface Props {
  files: OpenFile[]
  activeFilePath: string | null
  workspace: string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onCloseAll?: () => void
  onCloseOthers?: (keepPath: string) => void
  appLanguage?: 'ru' | 'en'
}

const EXT_COLORS: Record<string, string> = {
  typescript: 'text-blue-400',
  javascript: 'text-yellow-400',
  python: 'text-green-400',
  rust: 'text-orange-400',
  go: 'text-cyan-400',
  java: 'text-red-400',
  ruby: 'text-red-400',
  c: 'text-blue-300',
  cpp: 'text-blue-300',
  css: 'text-pink-400',
  scss: 'text-pink-400',
  html: 'text-orange-300',
  xml: 'text-orange-300',
  json: 'text-yellow-300',
  yaml: 'text-purple-400',
  markdown: 'text-zinc-400',
  bash: 'text-green-300',
  sql: 'text-blue-300',
  dockerfile: 'text-cyan-300',
}

function LangDot({ language }: { language: string }) {
  const color = EXT_COLORS[language] ?? 'text-zinc-500'
  return <span className={`text-[8px] ${color}`}>●</span>
}

export const EditorTabs = memo(function EditorTabs({ files, activeFilePath, workspace, onSelect, onClose, onCloseAll, onCloseOthers, appLanguage = 'ru' }: Props) {
  const L = appLanguage === 'ru'
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: OpenFile } | null>(null)

  if (files.length === 0) return null

  const relPath = (fullPath: string) => {
    if (fullPath.startsWith(workspace)) {
      const rel = fullPath.slice(workspace.length).replace(/^[\\/]/, '')
      return rel || fullPath
    }
    return fullPath
  }

  const handleContextMenu = (e: MouseEvent, file: OpenFile) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, file })
  }

  const buildMenu = (file: OpenFile): MenuItem[] => {
    const items: MenuItem[] = [
      { label: L ? 'Закрыть' : 'Close', icon: '×', shortcut: 'Ctrl+W', action: () => onClose(file.path) },
    ]
    if (onCloseOthers) {
      items.push({ label: L ? 'Закрыть остальные' : 'Close others', icon: '⊘', action: () => onCloseOthers(file.path) })
    }
    if (onCloseAll) {
      items.push({ label: L ? 'Закрыть все' : 'Close all', icon: '⊗', action: () => onCloseAll() })
    }
    items.push({ label: '', separator: true, action: () => {} })
    items.push({ label: L ? 'Копировать путь' : 'Copy path', icon: '📋', action: () => window.api.copyToClipboard(file.path) })
    items.push({ label: L ? 'Копировать относительный путь' : 'Copy relative path', icon: '📋', action: () => window.api.copyToClipboard(relPath(file.path)) })
    items.push({ label: L ? 'Показать в проводнике' : 'Show in explorer', icon: '📂', action: () => window.api.revealInExplorer(file.path) })
    return items
  }

  return (
    <>
      <div className="flex items-stretch bg-[#0d1117] border-b border-zinc-800/60 overflow-x-auto shrink-0">
        {files.map((file) => {
          const active = file.path === activeFilePath
          return (
            <div
              key={file.path}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-zinc-800/40 transition-colors shrink-0 ${
                active
                  ? 'bg-[#0d1117] text-zinc-200 border-t-2 border-t-blue-500'
                  : 'bg-[#0d1117] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50 border-t-2 border-t-transparent'
              }`}
              onClick={() => onSelect(file.path)}
              onContextMenu={(e) => handleContextMenu(e, file)}
            >
              <LangDot language={file.language} />
              <span className="truncate max-w-[140px]">{file.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(file.path) }}
                className={`w-4 h-4 flex items-center justify-center rounded-sm text-[10px] transition-colors cursor-pointer ${
                  active
                    ? 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700'
                    : 'text-transparent group-hover:text-zinc-600 hover:!text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenu(ctxMenu.file)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  )
})
