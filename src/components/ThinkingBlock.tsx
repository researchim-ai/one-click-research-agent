import { useState, useEffect, useRef, memo } from 'react'

interface Props {
  content: string
  live?: boolean
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, live }: Props) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-expand while live, collapse when thinking finishes
  const expanded = manualToggle ?? !!live

  // Auto-scroll to bottom while live and expanded
  useEffect(() => {
    if (live && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [content, live, expanded])

  // Reset manual override when live state changes (thinking ends → auto-collapse)
  useEffect(() => {
    if (!live) setManualToggle(null)
  }, [live])

  const lines = content.split('\n')
  const preview = lines.slice(0, 2).join('\n')
  const isLong = lines.length > 2

  return (
    <div className="my-2 rounded-lg overflow-hidden">
      <button
        onClick={() => setManualToggle((prev) => prev === null ? !expanded : !prev)}
        className="flex items-center gap-2 px-3 py-1.5 w-full text-left cursor-pointer hover:bg-zinc-800/30 rounded-lg transition-colors"
      >
        <span className="text-[10px] text-zinc-600">{expanded ? '▼' : '▶'}</span>
        <span className="text-[11px] text-zinc-500 font-medium tracking-wide uppercase">
          {live ? 'размышляет' : 'размышления'}
        </span>
        {live && (
          <span className="flex items-center gap-1 ml-1">
            <span className="w-1 h-1 rounded-full bg-blue-400 animate-[pulse-dot_1s_0s_infinite]" />
            <span className="w-1 h-1 rounded-full bg-blue-400 animate-[pulse-dot_1s_0.2s_infinite]" />
            <span className="w-1 h-1 rounded-full bg-blue-400 animate-[pulse-dot_1s_0.4s_infinite]" />
          </span>
        )}
        {!expanded && !live && isLong && (
          <span className="text-[10px] text-zinc-600 ml-auto">{lines.length} строк</span>
        )}
      </button>

      {expanded ? (
        <div
          ref={scrollRef}
          className="px-3 pb-2.5 border-l-2 border-zinc-800 ml-2.5 max-h-[200px] overflow-y-auto"
        >
          <div className="thinking-text">{content}{live ? '▍' : ''}</div>
        </div>
      ) : (
        <div className="px-3 pb-1.5 border-l-2 border-zinc-800 ml-2.5">
          <div className="thinking-text line-clamp-2 opacity-60">{preview}{isLong ? '…' : ''}</div>
        </div>
      )}
    </div>
  )
})
