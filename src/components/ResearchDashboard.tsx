import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ResearchProfile } from '../../research-profiles'

interface DashboardData {
  profile: ResearchProfile
  plan: { total: number; done: number; pct: number }
  corpus: { total: number; primary: number; queuedFullText: number; read: number; withDoi: number; withArxiv: number }
  evidence: { total: number; supported: number; contested: number; unsupported: number; needsReview: number }
  ideas: number
  index: { chunks: number; docs: number; hasVectors: boolean }
}

interface Props {
  workspace: string
  appLanguage?: 'ru' | 'en'
  onOpenSettings?: () => void
}

export function ResearchDashboard({ workspace, appLanguage = 'ru', onOpenSettings }: Props) {
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
    const id = window.setInterval(refresh, 5000)
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

  return (
    <div className="flex-1 overflow-y-auto bg-[#0b0f15] p-6">
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">{L ? 'Активный Research Profile' : 'Active Research Profile'}</div>
              <h2 className="text-xl font-semibold text-zinc-100 mt-1">{data.profile.label}</h2>
              <p className="text-sm text-zinc-400 mt-2 max-w-2xl">{data.profile.description}</p>
            </div>
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
          <div className="mt-4 flex flex-wrap gap-2">
            {data.profile.sourceConnectors.slice(0, 8).map((c) => (
              <span key={c.id} className={`px-2 py-1 rounded-lg text-[11px] border ${
                c.status === 'available' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/5' : 'border-zinc-700 text-zinc-400 bg-zinc-900/70'
              }`}>
                {c.label} · {c.status}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric label={L ? 'План' : 'Plan'} value={`${data.plan.done}/${data.plan.total}`} hint={`${data.plan.pct}%`} />
          <Metric label={L ? 'Корпус' : 'Corpus'} value={String(data.corpus.total)} hint={`${data.corpus.primary} primary`} />
          <Metric label="Evidence" value={String(data.evidence.total)} hint={`${data.evidence.supported} supported`} />
          <Metric label={L ? 'Идеи' : 'Ideas'} value={String(data.ideas)} hint={L ? 'Idea Scout' : 'Idea Scout'} />
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          <Panel title={L ? 'Рекомендуемый workflow' : 'Recommended workflow'}>
            <ol className="space-y-2">
              {data.profile.defaultWorkflow.map((step, idx) => (
                <li key={`${step}-${idx}`} className="flex gap-2 text-sm text-zinc-300">
                  <span className="text-zinc-600 font-mono">{idx + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel title={L ? 'Quality Signals' : 'Quality Signals'}>
            <div className="space-y-2 text-sm">
              <Signal label={L ? 'Full-text queue' : 'Full-text queue'} value={data.corpus.queuedFullText} />
              <Signal label={L ? 'Read items' : 'Read items'} value={data.corpus.read} />
              <Signal label={L ? 'Claims needing review' : 'Claims needing review'} value={data.evidence.needsReview + data.evidence.unsupported + data.evidence.contested} />
              <Signal label={L ? 'Knowledge chunks' : 'Knowledge chunks'} value={data.index.chunks} />
            </div>
          </Panel>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="text-xs text-zinc-500">
            {L
              ? 'Чтобы наполнить dashboard, попроси агента: build_corpus, record_evidence, run_quality_gates или scout_ideas в ходе исследования.'
              : 'Ask the agent to use build_corpus, record_evidence, run_quality_gates or scout_ideas during research to populate this dashboard.'}
          </div>
        </div>
      </div>
    </div>
  )
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

function Signal({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-400">{label}</span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  )
}
