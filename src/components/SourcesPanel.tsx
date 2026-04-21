import { useEffect, useState, useCallback } from 'react'

interface SourceItem {
  id: number
  title: string
  url: string
  author?: string
  date?: string
  snippet?: string
  toolName: string
  addedAt: number
  health?: {
    status: 'live' | 'archived' | 'dead' | 'unknown'
    httpStatus?: number
    archivedUrl?: string
    checkedAt: number
  }
  archivedUrl?: string
}

interface Props {
  sessionId: string | null
  workspace: string
  appLanguage?: 'ru' | 'en'
  externalLinksEnabled?: boolean
  onOpenExternalLink?: (url: string) => void
  highlightCitationToken?: { n: number; token: number } | null
}

export function SourcesPanel({ sessionId, appLanguage = 'ru', externalLinksEnabled = true, onOpenExternalLink, highlightCitationToken }: Props) {
  const L = appLanguage === 'ru'
  const [sources, setSources] = useState<SourceItem[]>([])
  const [collapsed, setCollapsed] = useState(true)
  const [q, setQ] = useState('')
  const [flashId, setFlashId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId || !window.api?.getSessionSources) {
      setSources([])
      return
    }
    try {
      const rows = await window.api.getSessionSources(sessionId)
      setSources(rows as SourceItem[])
    } catch {
      setSources([])
    }
  }, [sessionId])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 4000)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (!highlightCitationToken) return
    setCollapsed(false)
    setFlashId(highlightCitationToken.n)
    const el = document.getElementById(`source-row-${highlightCitationToken.n}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const t = window.setTimeout(() => setFlashId(null), 1600)
    return () => window.clearTimeout(t)
  }, [highlightCitationToken])

  const filtered = q.trim()
    ? sources.filter((s) => (s.title + ' ' + (s.author || '') + ' ' + s.url).toLowerCase().includes(q.toLowerCase()))
    : sources

  if (sources.length === 0) return null

  const badge = (h: SourceItem['health']) => {
    if (!h) return null
    const map = {
      live: { txt: L ? 'live' : 'live', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
      archived: { txt: L ? 'архив' : 'archived', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
      dead: { txt: L ? 'недоступен' : 'dead', cls: 'bg-red-500/10 text-red-300 border-red-500/30' },
      unknown: { txt: '?', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30' },
    } as const
    const c = map[h.status]
    return <span className={`px-1 py-px rounded text-[9px] border ${c.cls}`}>{c.txt}</span>
  }

  return (
    <div className="border-t border-zinc-800/60 bg-[#0a0e14]">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60 transition-colors cursor-pointer"
      >
        <span className="text-[9px]">{collapsed ? '▸' : '▾'}</span>
        <span>📚 {L ? 'Источники' : 'Sources'}</span>
        <span className="ml-1 px-1.5 py-px rounded bg-zinc-800 text-zinc-300 text-[10px] font-mono">{sources.length}</span>
        <span className="ml-auto text-[10px] text-zinc-600">
          {L ? 'Цитаты [n] в ответах' : 'Citations [n] in answers'}
        </span>
      </button>
      {!collapsed && (
        <div className="max-h-[260px] overflow-y-auto border-t border-zinc-800/40 px-2 py-2 space-y-1.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={L ? 'Поиск по источникам…' : 'Filter sources…'}
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/40"
          />
          {filtered.map((s) => (
            <div
              key={s.id}
              id={`source-row-${s.id}`}
              className={`rounded border px-2 py-1.5 transition-colors ${
                flashId === s.id
                  ? 'border-blue-500/60 bg-blue-500/10'
                  : 'border-zinc-800/80 bg-zinc-900/40'
              }`}
            >
              <div className="flex items-start gap-1.5">
                <span className="text-[10px] font-mono text-blue-400/80 shrink-0">[{s.id}]</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {externalLinksEnabled && s.url && /^https?:/i.test(s.url) ? (
                      <button
                        onClick={() => onOpenExternalLink?.(s.url)}
                        className="text-[11.5px] text-blue-300 hover:text-blue-200 underline decoration-dotted text-left truncate max-w-full"
                        title={s.url}
                      >
                        {s.title || s.url}
                      </button>
                    ) : (
                      <span className="text-[11.5px] text-zinc-200 truncate">{s.title || s.url}</span>
                    )}
                    {badge(s.health)}
                    {s.health?.status === 'archived' && s.health.archivedUrl && externalLinksEnabled && (
                      <button
                        onClick={() => onOpenExternalLink?.(s.health!.archivedUrl!)}
                        className="text-[10px] text-amber-300 hover:text-amber-200 underline decoration-dotted"
                        title={s.health.archivedUrl}
                      >
                        {L ? 'копия' : 'cached'}
                      </button>
                    )}
                  </div>
                  {(s.author || s.date) && (
                    <div className="text-[10px] text-zinc-500 mt-0.5 truncate">
                      {s.author || ''}{s.author && s.date ? ' · ' : ''}{s.date || ''}
                    </div>
                  )}
                  {s.snippet && (
                    <div className="text-[10.5px] text-zinc-400 mt-0.5 line-clamp-2">{s.snippet}</div>
                  )}
                  <div className="text-[9.5px] text-zinc-600 mt-0.5 font-mono">
                    {s.toolName}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-[11px] text-zinc-600 text-center py-2">
              {L ? 'Нет совпадений' : 'No matches'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
