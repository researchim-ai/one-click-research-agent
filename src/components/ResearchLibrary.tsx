import { useCallback, useEffect, useMemo, useState } from 'react'

interface ResearchRun {
  outputDir: string
  dirName: string
  topic: string
  createdAt: number
  mtime: number
  hasReport: boolean
  reportPath: string
  reportSize: number
  reportMtime: number
  corpusTotal: number
  corpusSelected: number
  evidenceTotal: number
  planTotal: number
  planDone: number
  blockers: number
}

interface Props {
  open: boolean
  workspace: string
  appLanguage?: 'ru' | 'en'
  onClose: () => void
  onOpenReport: (absPath: string) => void
  onNewResearch: () => void
}

function formatDate(ts: number, ru: boolean): string {
  if (!ts) return ru ? 'дата неизвестна' : 'unknown date'
  try {
    return new Date(ts).toLocaleString(ru ? 'ru-RU' : 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return new Date(ts).toISOString() }
}

export function ResearchLibrary({ open, workspace, appLanguage = 'ru', onClose, onOpenReport, onNewResearch }: Props) {
  const L = appLanguage === 'ru'
  const [runs, setRuns] = useState<ResearchRun[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspace || !window.api?.listResearchRuns) { setRuns([]); return }
    setLoading(true)
    try {
      setRuns(await window.api.listResearchRuns(workspace))
    } catch {
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    if (open) {
      setQuery('')
      setConfirmDelete(null)
      refresh()
    }
  }, [open, refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return runs
    return runs.filter((r) => r.topic.toLowerCase().includes(q) || r.dirName.toLowerCase().includes(q))
  }, [runs, query])

  const sep = workspace.includes('\\') ? '\\' : '/'
  const runDirAbs = (r: ResearchRun) => `${workspace}${sep}${r.outputDir.replace(/\//g, sep)}`

  const handleOpenReport = useCallback((r: ResearchRun) => {
    if (!r.hasReport) return
    onOpenReport(r.reportPath)
    onClose()
  }, [onOpenReport, onClose])

  const handleDelete = useCallback(async (r: ResearchRun) => {
    if (!window.api?.deleteResearchRun) return
    setDeleting(r.outputDir)
    try {
      const res = await window.api.deleteResearchRun(workspace, r.outputDir)
      if (res?.ok) {
        setRuns((prev) => prev.filter((x) => x.outputDir !== r.outputDir))
      } else {
        alert((L ? 'Не удалось удалить: ' : 'Failed to delete: ') + (res?.error ?? 'unknown'))
      }
    } catch (e: any) {
      alert((L ? 'Не удалось удалить: ' : 'Failed to delete: ') + (e?.message ?? e))
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }, [workspace, L])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-4xl max-h-[88vh] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between gap-4 shrink-0">
          <div>
            <div className="text-base font-semibold text-zinc-100">{L ? 'Мои исследования' : 'Research Library'}</div>
            <div className="text-sm text-zinc-500 mt-1">
              {L
                ? 'Все проведённые research-раны. Открой отчёт, покажи в проводнике или удали с диска.'
                : 'All past research runs. Open the report, reveal in explorer, or delete from disk.'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-5 py-3 border-b border-zinc-800/70 flex items-center gap-3 shrink-0">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={L ? 'Поиск по теме…' : 'Search by topic…'}
            className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 outline-none"
          />
          <button
            type="button"
            onClick={refresh}
            className="px-3 py-2 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 cursor-pointer"
            title={L ? 'Обновить' : 'Refresh'}
          >
            {L ? 'Обновить' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => { onClose(); onNewResearch() }}
            className="px-3 py-2 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 cursor-pointer"
          >
            {L ? '+ Новое' : '+ New'}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-center text-sm text-zinc-500 py-12">{L ? 'Загрузка…' : 'Loading…'}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-sm text-zinc-500 py-12">
              {runs.length === 0
                ? (L ? 'Пока нет ни одного исследования. Нажми «Новое», чтобы начать.' : 'No research runs yet. Click “New” to start.')
                : (L ? 'Ничего не найдено по запросу.' : 'No runs match your search.')}
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((r) => (
                <div
                  key={r.outputDir}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 hover:border-zinc-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-zinc-100 truncate">{r.topic}</h3>
                        {r.hasReport ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 shrink-0">
                            {L ? 'отчёт готов' : 'report ready'}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md text-[10px] border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0">
                            {L ? 'без отчёта' : 'no report'}
                          </span>
                        )}
                        {r.blockers > 0 && (
                          <span className="px-2 py-0.5 rounded-md text-[10px] border border-rose-500/30 bg-rose-500/10 text-rose-300 shrink-0">
                            {r.blockers} {L ? 'блокеров' : 'blockers'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-1 truncate" title={r.dirName}>
                        {formatDate(r.createdAt, L)} · <span className="font-mono">{r.dirName}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-zinc-400">
                        <span>{L ? 'Корпус' : 'Corpus'}: <span className="text-zinc-200 font-mono">{r.corpusSelected}/{r.corpusTotal}</span></span>
                        <span>Evidence: <span className="text-zinc-200 font-mono">{r.evidenceTotal}</span></span>
                        <span>{L ? 'План' : 'Plan'}: <span className="text-zinc-200 font-mono">{r.planDone}/{r.planTotal}</span></span>
                        {r.hasReport && <span>{L ? 'Отчёт' : 'Report'}: <span className="text-zinc-200 font-mono">{Math.max(1, Math.round(r.reportSize / 1024))} KB</span></span>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={() => handleOpenReport(r)}
                      disabled={!r.hasReport}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title={r.hasReport ? '' : (L ? 'Отчёт ещё не сгенерирован' : 'Report not generated yet')}
                    >
                      {L ? 'Открыть отчёт' : 'Open report'}
                    </button>
                    <button
                      type="button"
                      onClick={() => window.api?.revealInExplorer?.(r.hasReport ? r.reportPath : runDirAbs(r)).catch(() => {})}
                      className="px-3 py-1.5 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                    >
                      {L ? 'В проводнике' : 'Reveal'}
                    </button>
                    <div className="flex-1" />
                    {confirmDelete === r.outputDir ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-rose-300">{L ? 'Удалить с диска?' : 'Delete from disk?'}</span>
                        <button
                          type="button"
                          onClick={() => handleDelete(r)}
                          disabled={deleting === r.outputDir}
                          className="px-3 py-1.5 rounded-lg bg-rose-600 text-xs text-white hover:bg-rose-500 disabled:opacity-50 cursor-pointer"
                        >
                          {deleting === r.outputDir ? (L ? 'Удаляю…' : 'Deleting…') : (L ? 'Да, удалить' : 'Yes, delete')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                          className="px-3 py-1.5 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                        >
                          {L ? 'Отмена' : 'Cancel'}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(r.outputDir)}
                        className="px-3 py-1.5 rounded-lg border border-rose-500/30 text-xs text-rose-300 hover:bg-rose-500/10 cursor-pointer"
                      >
                        {L ? 'Удалить' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 text-[11px] text-zinc-500 shrink-0">
          {L
            ? `Всего ранов: ${runs.length}. Удаление стирает всю папку рана (отчёт, корпус, evidence, full-text) без возможности восстановления.`
            : `Total runs: ${runs.length}. Deleting removes the entire run folder (report, corpus, evidence, full-text) permanently.`}
        </div>
      </div>
    </div>
  )
}
