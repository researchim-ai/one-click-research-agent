import { useState, useEffect, useCallback } from 'react'

interface TitleBarProps {
  children?: React.ReactNode
}

export function TitleBar({ children }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.api.winIsMaximized().then(setMaximized)
  }, [])

  const handleMaximize = useCallback(() => {
    window.api.winMaximize()
    setMaximized((v) => !v)
  }, [])

  return (
    <div
      className="h-9 bg-[#0d1117] border-b border-zinc-800/60 flex items-center px-3 shrink-0 gap-3 select-none"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {children}

      {/* Window controls */}
      <div className="flex items-center gap-0.5 ml-auto" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={() => window.api.winMinimize()}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-zinc-700/60 text-zinc-500 hover:text-zinc-200 cursor-pointer transition-colors"
          title="Свернуть"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><rect width="10" height="1" /></svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-zinc-700/60 text-zinc-500 hover:text-zinc-200 cursor-pointer transition-colors"
          title={maximized ? 'Восстановить' : 'Развернуть'}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2.5" y="0.5" width="7" height="7" rx="0.5" />
              <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" />
            </svg>
          ) : (
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="8" height="8" rx="0.5" />
            </svg>
          )}
        </button>
        <button
          onClick={() => window.api.winClose()}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-red-600/80 text-zinc-500 hover:text-white cursor-pointer transition-colors"
          title="Закрыть"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>
    </div>
  )
}
