import { useEffect, useState, useCallback } from 'react'

interface PlanItem {
  text: string
  done: boolean
  line: number
}

interface Artifact {
  relPath: string
  size: number
  mtime: number
  kind: string
}

interface Props {
  workspace: string
  appLanguage?: 'ru' | 'en'
  onOpenFile?: (absPath: string) => void
}

const KIND_ICON: Record<string, string> = {
  markdown: '📝',
  pdf: '📕',
  docx: '📘',
  bibtex: '📗',
  image: '🖼',
  html: '🌐',
  other: '📄',
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function ResearchArtifacts({ workspace, appLanguage = 'ru', onOpenFile }: Props) {
  const L = appLanguage === 'ru'
  const [items, setItems] = useState<Artifact[]>([])
  const [plan, setPlan] = useState<PlanItem[]>([])
  const [progress, setProgress] = useState<{ total: number; done: number; pct: number }>({ total: 0, done: 0, pct: 0 })
  const [collapsed, setCollapsed] = useState(true)

  const refresh = useCallback(async () => {
    if (!workspace || !window.api) return
    try {
      const [arts, planData] = await Promise.all([
        window.api.listResearchArtifacts(workspace).catch(() => []),
        window.api.getResearchPlan(workspace).catch(() => ({ items: [], progress: { total: 0, done: 0, pct: 0 } })),
      ])
      setItems(arts || [])
      setPlan(planData.items || [])
      setProgress(planData.progress || { total: 0, done: 0, pct: 0 })
    } catch {
      setItems([])
      setPlan([])
    }
  }, [workspace])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [refresh])

  const handleOpen = (relPath: string) => {
    if (!workspace || !onOpenFile) return
    const sep = workspace.includes('\\') ? '\\' : '/'
    const abs = `${workspace}${sep}${relPath.replace(/\//g, sep)}`
    onOpenFile(abs)
  }

  if (items.length === 0 && plan.length === 0) return null

  const bibtex = items.find((i) => i.kind === 'bibtex')
  const reports = items.filter((i) => i.relPath.includes('report') && (i.kind === 'markdown' || i.kind === 'pdf' || i.kind === 'docx'))
  const others = items.filter((i) => i !== bibtex && !reports.includes(i))

  return (
    <div className="border-t border-zinc-800/60 bg-[#0a0e14]">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60 transition-colors cursor-pointer"
      >
        <span className="text-[9px]">{collapsed ? '▸' : '▾'}</span>
        <span>🗂 {L ? 'Артефакты исследования' : 'Research artifacts'}</span>
        {items.length > 0 && (
          <span className="ml-1 px-1.5 py-px rounded bg-zinc-800 text-zinc-300 text-[10px] font-mono">{items.length}</span>
        )}
        {progress.total > 0 && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px]">
            <span className="w-20 h-1 bg-zinc-800 rounded-full overflow-hidden">
              <span
                className={`h-full block ${progress.pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                style={{ width: `${progress.pct}%` }}
              />
            </span>
            <span className="font-mono text-zinc-400">{progress.done}/{progress.total}</span>
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="max-h-[300px] overflow-y-auto border-t border-zinc-800/40 px-2 py-2 space-y-2">
          {plan.length > 0 && (
            <div className="rounded border border-zinc-800 bg-zinc-900/30 p-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                {L ? 'План' : 'Plan'} · .research/plan.md
              </div>
              <div className="space-y-0.5">
                {plan.map((p, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span className={p.done ? 'text-emerald-400' : 'text-zinc-600'}>{p.done ? '✓' : '◯'}</span>
                    <span className={p.done ? 'text-zinc-500 line-through' : 'text-zinc-300'}>{p.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {reports.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 px-1">
                {L ? 'Отчёты' : 'Reports'}
              </div>
              {reports.map((r) => (
                <ArtifactRow key={r.relPath} item={r} onOpen={handleOpen} />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 px-1">
                {L ? 'Файлы' : 'Files'}
              </div>
              {others.map((r) => (
                <ArtifactRow key={r.relPath} item={r} onOpen={handleOpen} />
              ))}
            </div>
          )}
          {bibtex && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 px-1">BibTeX</div>
              <ArtifactRow item={bibtex} onOpen={handleOpen} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ArtifactRow({ item, onOpen }: { item: Artifact; onOpen: (rel: string) => void }) {
  return (
    <button
      onClick={() => onOpen(item.relPath)}
      className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-zinc-800/60 cursor-pointer text-left"
    >
      <span className="text-[12px]">{KIND_ICON[item.kind] ?? '📄'}</span>
      <span className="flex-1 min-w-0 text-[11px] text-zinc-300 truncate font-mono">{item.relPath}</span>
      <span className="text-[10px] text-zinc-600 shrink-0 font-mono tabular-nums">{fmtSize(item.size)}</span>
    </button>
  )
}
