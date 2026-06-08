import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ResearchProfile } from '../../research-profiles'

interface DashboardData {
  profile: ResearchProfile
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
}

export function ResearchDashboard({ workspace, appLanguage = 'ru', onOpenSettings, onNewResearch }: Props) {
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
            <div className="flex items-center gap-2 shrink-0">
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
          <Metric label={L ? 'Корпус' : 'Corpus'} value={`${data.corpus.selected}/${data.corpus.total}`} hint={`${data.corpus.primary} primary`} />
          <Metric label={L ? 'Full text' : 'Full text'} value={`${data.corpus.selectedRead}/${data.corpus.selected}`} hint={`${data.corpus.failed} failed`} />
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
              <Signal label={L ? 'Selected read' : 'Selected read'} value={data.corpus.selectedRead} />
              <Signal label={L ? 'High-priority read' : 'High-priority read'} value={data.corpus.highPriorityRead} />
              <Signal label={L ? 'Corpus-linked claims' : 'Corpus-linked claims'} value={data.evidence.withCorpus ?? 0} />
              <Signal label={L ? 'Claims needing review' : 'Claims needing review'} value={data.evidence.needsReview + data.evidence.unsupported + data.evidence.contested} />
              <Signal label={L ? 'Knowledge chunks' : 'Knowledge chunks'} value={data.index.chunks} />
            </div>
          </Panel>
        </div>

        {data.quality?.blockers?.length ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="text-sm font-medium text-amber-200 mb-2">{L ? 'Quality blockers' : 'Quality blockers'}</div>
            <ul className="space-y-1 text-sm text-amber-100/80">
              {data.quality.blockers.map((b, i) => <li key={`${b}-${i}`}>- {b}</li>)}
            </ul>
            <div className="mt-3 text-xs text-amber-200/70">
              {L
                ? 'Продолжи чтение selected corpus и извлечение evidence перед финальным отчётом.'
                : 'Continue reading selected corpus and extracting evidence before final report.'}
            </div>
          </div>
        ) : null}

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="text-xs text-zinc-500">
            {L
              ? 'Нажми “Начать исследование”, чтобы запустить управляемый research-run с checkpoint’ами для правок. Dashboard будет наполняться через build_corpus, record_evidence, run_quality_gates и scout_ideas.'
              : 'Click “New Research” to start a managed research run with editable checkpoints. The dashboard will populate via build_corpus, record_evidence, run_quality_gates and scout_ideas.'}
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
