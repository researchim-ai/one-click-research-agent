import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ResearchProfile } from '../../research-profiles'

interface RunInfo {
  outputDir: string
  reportPath: string
  reportReady: boolean
  topic: string | null
  state: string
  lastTool: string | null
  updatedAt: number
  downgradedGates: string[]
  gates: Array<{ gate: string; score: number; downgraded: boolean; failing: boolean }>
}

interface DashboardData {
  profile: ResearchProfile
  run: RunInfo | null
  plan: { total: number; done: number; pct: number }
  corpus: { total: number; primary: number; selected: number; rejected: number; needsReview: number; queuedFullText: number; read: number; failed: number; withDoi: number; withArxiv: number; selectedRead: number; highPriority: number; highPriorityRead: number }
  evidence: { total: number; supported: number; contested: number; unsupported: number; needsReview: number; withCorpus?: number; withQuotes?: number }
  quality?: { blockers: string[] }
  ideas: number
  index: { chunks: number; docs: number; hasVectors: boolean }
}

interface Props {
  workspace: string
  appLanguage?: 'ru' | 'en'
  onOpenSettings?: () => void
  onNewResearch?: () => void
  onOpenReport?: (absPath: string) => void
}

// Compact phase track. Each managed run advances through these phases; the current one is
// derived from the FSM state so the user sees where the run actually is right now.
const PHASES = ['PLANNED', 'CORPUS_READY', 'READING', 'EVIDENCE', 'GATES', 'REPORT_READY'] as const
const PHASE_LABELS: Record<string, { ru: string; en: string }> = {
  PLANNED: { ru: 'План', en: 'Plan' },
  CORPUS_READY: { ru: 'Корпус', en: 'Corpus' },
  READING: { ru: 'Чтение', en: 'Reading' },
  EVIDENCE: { ru: 'Доказательства', en: 'Evidence' },
  GATES: { ru: 'Проверки', en: 'Gates' },
  REPORT_READY: { ru: 'Отчёт', en: 'Report' },
}

function phaseIndex(state: string): number {
  switch (state) {
    case 'INIT': return -1
    case 'PLANNED': return 0
    case 'CORPUS_READY': return 1
    case 'READING': return 2
    case 'EVIDENCE': return 3
    case 'GATES_PENDING':
    case 'GATES_FAILED':
    case 'GATES_PASSED': return 4
    case 'REPORT_READY': return 5
    default: return -1
  }
}

export function ResearchDashboard({ workspace, appLanguage = 'ru', onOpenSettings, onNewResearch, onOpenReport }: Props) {
  const L = appLanguage === 'ru'
  const [data, setData] = useState<DashboardData | null>(null)

  const refresh = useCallback(async () => {
    if (!workspace || !window.api?.getResearchDashboard) return
    try {
      setData(await window.api.getResearchDashboard(workspace))
    } catch {
      setData(null)
    }
  }, [workspace])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 4000)
    return () => window.clearInterval(id)
  }, [refresh])

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600">
        <div className="text-center">
          <div className="text-sm">{L ? 'Выбери файл слева или начни исследование в чате' : 'Select a file or start research in chat'}</div>
        </div>
      </div>
    )
  }

  const run = data.run
  const curPhase = run ? phaseIndex(run.state) : -1
  const blocked = run?.state === 'BLOCKED'
  const reportReady = Boolean(run?.reportReady) || run?.state === 'REPORT_READY'
  const failingGates = (run?.gates ?? []).filter((g) => g.failing && !g.downgraded)
  const downgraded = run?.downgradedGates ?? []

  return (
    <div className="flex-1 overflow-y-auto bg-[#0b0f15] p-6">
      <div className="max-w-4xl mx-auto space-y-5">
        {/* Header: active run + profile */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">
                {run ? (L ? 'Текущее исследование' : 'Current research') : (L ? 'Активный Research Profile' : 'Active Research Profile')}
              </div>
              {run ? (
                <>
                  <h2 className="text-xl font-semibold text-zinc-100 mt-1 truncate" title={run.topic ?? undefined}>
                    {run.topic || (L ? 'Без названия' : 'Untitled')}
                  </h2>
                  <p className="text-xs text-zinc-500 mt-1.5">
                    <span className="text-zinc-400">{data.profile.label}</span>
                    {run.lastTool ? <> · {L ? 'последнее действие' : 'last action'}: <span className="font-mono text-zinc-400">{run.lastTool}</span></> : null}
                    {run.updatedAt ? <> · {relativeTime(run.updatedAt, L)}</> : null}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-xl font-semibold text-zinc-100 mt-1">{data.profile.label}</h2>
                  <p className="text-sm text-zinc-400 mt-2 max-w-2xl">{data.profile.description}</p>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {reportReady && run && onOpenReport && (
                <button
                  type="button"
                  onClick={() => onOpenReport(run.reportPath)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white hover:bg-emerald-500 cursor-pointer"
                >
                  {L ? 'Открыть отчёт' : 'Open report'}
                </button>
              )}
              {onNewResearch && (
                <button
                  type="button"
                  onClick={onNewResearch}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 cursor-pointer"
                >
                  {L ? 'Начать исследование' : 'New Research'}
                </button>
              )}
              {onOpenSettings && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="px-3 py-1.5 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                >
                  {L ? 'Сменить профиль' : 'Change profile'}
                </button>
              )}
            </div>
          </div>

          {/* Phase track */}
          {run && (
            <div className="mt-5 flex items-center gap-1.5">
              {PHASES.map((ph, i) => {
                const done = curPhase > i || reportReady
                const active = curPhase === i && !reportReady
                return (
                  <div key={ph} className="flex items-center gap-1.5 flex-1 last:flex-none">
                    <div className="flex flex-col items-center gap-1 min-w-0">
                      <div className={`w-full h-1.5 rounded-full ${done ? 'bg-emerald-500/70' : active ? (blocked ? 'bg-red-500/70' : 'bg-blue-500 animate-pulse') : 'bg-zinc-800'}`} />
                      <span className={`text-[10px] whitespace-nowrap ${active ? 'text-blue-300' : done ? 'text-emerald-400/80' : 'text-zinc-600'}`}>
                        {L ? PHASE_LABELS[ph].ru : PHASE_LABELS[ph].en}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Live metrics from the active run */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric label={L ? 'План' : 'Plan'} value={`${data.plan.done}/${data.plan.total}`} hint={`${data.plan.pct}%`} />
          <Metric label={L ? 'Корпус (отобрано)' : 'Corpus (selected)'} value={`${data.corpus.selected}/${data.corpus.total}`} hint={`${data.corpus.primary} primary`} />
          <Metric label={L ? 'Прочитано' : 'Read'} value={`${data.corpus.selectedRead}/${data.corpus.selected}`} hint={data.corpus.failed ? `${data.corpus.failed} ${L ? 'ошибок' : 'failed'}` : (L ? 'полный текст' : 'full text')} />
          <Metric label={L ? 'Доказательства' : 'Evidence'} value={`${data.evidence.supported}/${data.evidence.total}`} hint={L ? 'подтверждено' : 'supported'} />
        </div>

        {/* Quality gates status */}
        {run && run.gates.length > 0 && (
          <Panel title={L ? 'Проверки качества (quality gates)' : 'Quality gates'}>
            <div className="flex flex-wrap gap-2">
              {run.gates.map((g) => {
                const cls = g.downgraded
                  ? 'border-amber-500/30 text-amber-300 bg-amber-500/5'
                  : g.failing
                    ? 'border-red-500/30 text-red-300 bg-red-500/5'
                    : 'border-emerald-500/30 text-emerald-300 bg-emerald-500/5'
                const mark = g.downgraded ? '▼' : g.failing ? '✗' : '✓'
                return (
                  <span key={g.gate} className={`px-2 py-1 rounded-lg text-[11px] border ${cls}`} title={g.downgraded ? (L ? 'понижен до предупреждения' : 'downgraded to a warning') : undefined}>
                    {mark} {g.gate} · {Math.round(g.score)}
                  </span>
                )
              })}
            </div>
            {downgraded.length > 0 && (
              <p className="text-[11px] text-amber-200/70 mt-3">
                {L
                  ? '▼ — проверка понижена до предупреждения (недостаточно источников по теме за период — задокументировано как ограничение).'
                  : '▼ — gate downgraded to a warning (not enough in-scope sources for the period — recorded as a documented limitation).'}
              </p>
            )}
          </Panel>
        )}

        {/* Quality blockers */}
        {data.quality?.blockers?.length ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="text-sm font-medium text-amber-200 mb-2">{L ? 'Что мешает финалу' : 'Quality blockers'}</div>
            <ul className="space-y-1 text-sm text-amber-100/80">
              {data.quality.blockers.map((b, i) => <li key={`${b}-${i}`}>- {b}</li>)}
            </ul>
          </div>
        ) : null}

        {/* Empty state hint */}
        {!run && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
            <div className="text-xs text-zinc-500">
              {L
                ? 'Пока нет запущенных исследований. Нажми «Начать исследование» — здесь появится живой прогресс: фаза, план, корпус, чтение, доказательства и проверки качества.'
                : 'No research runs yet. Click “New Research” — live progress will appear here: phase, plan, corpus, reading, evidence and quality gates.'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function relativeTime(ts: number, ru: boolean): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return ru ? 'только что' : 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return ru ? `${m} мин назад` : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return ru ? `${h} ч назад` : `${h}h ago`
  const d = Math.floor(h / 24)
  return ru ? `${d} дн назад` : `${d}d ago`
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold text-zinc-100 mt-1">{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{hint}</div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="text-sm font-medium text-zinc-200 mb-3">{title}</div>
      {children}
    </div>
  )
}
