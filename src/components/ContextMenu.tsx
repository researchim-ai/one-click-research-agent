import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  icon?: string
  shortcut?: string
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  action: () => void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handle)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handle)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Adjust position to keep menu within viewport
  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      ref.current.style.left = `${x - rect.width}px`
    }
    if (rect.bottom > window.innerHeight) {
      ref.current.style.top = `${y - rect.height}px`
    }
  }, [x, y])

  return (
    <div
      ref={ref}
      className="fixed z-[999] bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-2xl py-1 min-w-[200px] animate-[fadeIn_0.1s]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} className="my-1 border-t border-zinc-800/60" />
        }
        return (
          <button
            key={i}
            onClick={() => { item.action(); onClose() }}
            disabled={item.disabled}
            className={`w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2.5 cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default ${
              item.danger
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-zinc-300 hover:bg-zinc-800/80'
            }`}
          >
            {item.icon && <span className="w-4 text-center text-[11px] opacity-60">{item.icon}</span>}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="text-[10px] text-zinc-600 ml-4">{item.shortcut}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
