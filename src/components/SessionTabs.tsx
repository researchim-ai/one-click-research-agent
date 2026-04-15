import { useRef, useState, useEffect, useCallback } from 'react'
import type { SessionInfo } from '../../electron/agent'

interface Props {
  sessions: SessionInfo[]
  activeSessionId: string | null
  busy: boolean
  onNew: () => void
  onSwitch: (id: string) => void
  onDelete: (id: string) => void
  onCollapse: () => void
  appLanguage?: 'ru' | 'en'
}

export function SessionTabs({
  sessions,
  activeSessionId,
  busy,
  onNew,
  onSwitch,
  onDelete,
  onCollapse,
  appLanguage = 'ru',
}: Props) {
  const L = appLanguage === 'ru'
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    const close = () => setContextMenu(null)
    if (contextMenu) {
      window.addEventListener('click', close)
      return () => window.removeEventListener('click', close)
    }
  }, [contextMenu])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY
    }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    setContextMenu({ id, x: e.clientX, y: e.clientY })
  }, [])

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="flex items-center bg-[#0d1117] border-b border-zinc-800/60 shrink-0 min-h-[33px]">
      {/* Scrollable tabs */}
      <div
        ref={scrollRef}
        onWheel={handleWheel}
        className="flex-1 flex items-center overflow-x-auto scrollbar-none gap-0"
      >
        {sorted.map((s) => {
          const isActive = s.id === activeSessionId
          const isHovered = s.id === hoveredId
          return (
            <button
              key={s.id}
              onClick={() => onSwitch(s.id)}
              onContextMenu={(e) => handleContextMenu(e, s.id)}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
              disabled={busy && !isActive}
              className={`
                group relative flex items-center gap-1.5 px-3 py-1.5
                text-[11px] whitespace-nowrap shrink-0 border-r border-zinc-800/40
                transition-colors cursor-pointer
                ${isActive
                  ? 'bg-zinc-900/80 text-zinc-200 border-b-2 border-b-blue-500'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
                }
                ${busy && !isActive ? 'opacity-40 cursor-not-allowed' : ''}
              `}
            >
              <span className="max-w-[120px] truncate">{s.title || (L ? 'Новый чат' : 'New chat')}</span>
              {s.messageCount > 0 && (
                <span className="text-[9px] text-zinc-600">{s.messageCount}</span>
              )}

              {/* Close button */}
              {(isHovered || isActive) && sessions.length > 1 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!busy) onDelete(s.id)
                  }}
                  className="w-4 h-4 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 text-[9px] transition-colors"
                >
                  ✕
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 px-1.5 shrink-0">
        <button
          onClick={onNew}
          disabled={busy}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer text-sm transition-colors"
          title={L ? 'Новая сессия' : 'New session'}
        >
          +
        </button>
        <button
          onClick={onCollapse}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 cursor-pointer text-xs transition-colors"
          title={L ? 'Свернуть чат' : 'Collapse chat'}
        >
          ▶
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[100] bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { onDelete(contextMenu.id); setContextMenu(null) }}
            disabled={sessions.length <= 1}
            className="w-full px-3 py-1.5 text-left text-[12px] text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            {L ? 'Удалить сессию' : 'Delete session'}
          </button>
        </div>
      )}
    </div>
  )
}
