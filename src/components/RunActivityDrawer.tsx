import { useCallback, useEffect, useState } from 'react'
import type { RunStep, ToolStat } from '../hooks/useRunActivity'
import type { AgentActivityPhase } from '../../electron/types'

interface Props {
  open: boolean
  onClose: () => void
  workspace: string
  appLanguage?: 'ru' | 'en'
  steps: RunStep[]
  currentPhase: AgentActivityPhase | null
  activityLabel: string | null
  running: boolean
  failedCount: number
  toolStats: ToolStat[]
}

// Canonical managed-research FSM order for the phase strip.
const FSM_ORDER = ['PLANNED', 'CORPUS_READY', 'READING', 'EVIDENCE', 'GATES_PENDING', 'GATES_PASSED', 'REPORT_READY'] as const

const STATE_LABELS: Record<string, { ru: string; en: string }> = {
  INIT: { ru: 'Старт', en: 'Init' },
  PLANNED: { ru: 'План', en: 'Plan' },
  CORPUS_READY: { ru: 'Корпус', en: 'Corpus' },
  READING: { ru: 'Чтение', en: 'Reading' },
  EVIDENCE: { ru: 'Доказательства', en: 'Evidence' },
  GATES_PENDING: { ru: 'Гейты', en: 'Gates' },
  GATES_FAILED: { ru: 'Гейты ✗', en: 'Gates ✗' },
  GATES_PASSED: { ru: 'Гейты ✓', en: 'Gates ✓' },
  REPORT_READY: { ru: 'Отчёт', en: 'Report' },
  BLOCKED: { ru: 'Блокировано', en: 'Blocked' },
}

const PHASE_LABELS: Record<AgentActivityPhase, { ru: string; en: string }> = {
  starting: { ru: 'Запуск', en: 'Starting' },
  session_save: { ru: 'Сохранение сессии', en: 'Saving session' },
  session_load: { ru: 'Загрузка сессии', en: 'Loading session' },
  resume_checkpoint: { ru: 'Возобновление', en: 'Resuming' },
  context_compress: { ru: 'Сжатие контекста', en: 'Compressing context' },
  llm_queue: { ru: 'Очередь модели', en: 'Model queue' },
  llm_generate: { ru: 'Генерация', en: 'Generating' },
  tool_exec: { ru: 'Инструмент', en: 'Tool' },
  done: { ru: 'Готово', en: 'Done' },
}

function fmtDuration(step: RunStep): string {
  if (step.endedAt == null) return ''
  const ms = Math.max(0, step.endedAt - step.startedAt)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const STATUS_DOT: Record<RunStep['status'], string> = {
  running: 'bg-blue-400 animate-pulse',
  ok: 'bg-emerald-500',
  failed: 'bg-red-500',
  degraded: 'bg-amber-500',
  info: 'bg-zinc-500',
}

export function RunActivityDrawer({ open, onClose, workspace, appLanguage = 'ru', steps, currentPhase, activityLabel, running, failedCount, toolStats }: Props) {
  const L = appLanguage === 'ru'
  const [graph, setGraph] = useState<RunGraphData | null>(null)

  const refresh = useCallback(async () => {
    if (!workspace || !window.api?.getRunGraph) return
    try { setGraph(await window.api.getRunGraph(workspace)) } catch { /* keep last */ }
  }, [workspace])

  useEffect(() => {
    if (!open) return
    refresh()
    const id = window.setInterval(refresh, 3000)
    return () => window.clearInterval(id)
  }, [open, refresh])

  const label = (s: string) => (STATE_LABELS[s] ? (L ? STATE_LABELS[s].ru : STATE_LABELS[s].en) : s)

  const reached = new Set<string>()
  if (graph) {
    for (const t of graph.transitions) { if (t.to) reached.add(t.to); if (t.from) reached.add(t.from) }
    reached.add(graph.state)
  }
  const isFailed = graph?.state === 'GATES_FAILED'
  const isBlocked = graph?.state === 'BLOCKED'
  const failingGates = (graph?.gates ?? []).filter((g) => g.failing || g.downgraded)

  return (
    <>
      {open && <div className="fixed inset-0 z-[190] bg-black/40" onClick={onClose} />}
      <div
        className={`fixed top-0 right-0 z-[200] h-full w-[380px] max-w-[92vw] bg-[#0b0f15] border-l border-zinc-800 shadow-2xl flex flex-col transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${running ? 'bg-blue-400 animate-pulse' : 'bg-zinc-600'}`} />
            <span className="text-sm font-semibold text-zinc-100">{L ? 'Ход выполнения' : 'Run activity'}</span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 cursor-pointer text-xs"
            title={L ? 'Закрыть' : 'Close'}
          >✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Current phase / live activity */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">{L ? 'Сейчас' : 'Now'}</div>
            <div className="text-[13px] text-zinc-200">
              {running
                ? (activityLabel || (currentPhase ? (L ? PHASE_LABELS[currentPhase].ru : PHASE_LABELS[currentPhase].en) : (L ? 'Работает…' : 'Working…')))
                : (L ? 'Ожидание / простой' : 'Idle')}
            </div>
            {graph?.lastTool && (
              <div className="text-[11px] text-zinc-500 mt-0.5 font-mono">{L ? 'Последний инструмент' : 'Last tool'}: {graph.lastTool}</div>
            )}
          </div>

          {/* Research phase graph (only for managed runs) */}
          {graph && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{L ? 'Фаза исследования' : 'Research phase'}</div>
              <div className="flex flex-wrap gap-1.5">
                {FSM_ORDER.map((st) => {
                  const isGates = st === 'GATES_PENDING'
                  const current = graph.state === st || (isGates && (isFailed))
                  const done = reached.has(st) && !current
                  const chipLabel = isGates && isFailed ? label('GATES_FAILED') : label(st)
                  return (
                    <span
                      key={st}
                      className={`px-2 py-0.5 rounded text-[11px] border ${
                        current
                          ? (isFailed && isGates ? 'bg-red-500/15 border-red-500/40 text-red-300' : 'bg-blue-500/15 border-blue-500/40 text-blue-200')
                          : done
                            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300/80'
                            : 'bg-zinc-800/40 border-zinc-700/50 text-zinc-500'
                      }`}
                    >
                      {done ? '✓ ' : ''}{chipLabel}
                    </span>
                  )
                })}
                {isBlocked && (
                  <span className="px-2 py-0.5 rounded text-[11px] border bg-red-500/15 border-red-500/40 text-red-300">{label('BLOCKED')}</span>
                )}
              </div>
              {graph.topic && <div className="text-[11px] text-zinc-500 mt-2 line-clamp-2">{graph.topic}</div>}
            </div>
          )}

          {/* Gate health */}
          {graph && failingGates.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{L ? 'Проблемные гейты' : 'Gate issues'}</div>
              <div className="space-y-1">
                {failingGates.map((g) => (
                  <div key={g.gate} className="flex items-center justify-between gap-2 text-[11px] rounded bg-zinc-900/60 border border-zinc-800 px-2 py-1">
                    <span className="font-mono text-zinc-300 truncate">{g.gate}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="text-zinc-500">{g.score}%</span>
                      {g.attempts > 0 && <span className="text-amber-400/80" title={L ? 'попыток чинить' : 'repair attempts'}>×{g.attempts}</span>}
                      {g.downgraded
                        ? <span className="px-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">{L ? 'лимит' : 'limit'}</span>
                        : <span className="px-1 rounded bg-red-500/15 text-red-300 border border-red-500/30">{L ? 'падает' : 'fail'}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Failed tools summary */}
          {toolStats.some((t) => t.failed > 0) && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                {L ? 'Упавшие инструменты' : 'Failed tools'} <span className="text-red-400">({failedCount})</span>
              </div>
              <div className="space-y-1">
                {toolStats.filter((t) => t.failed > 0).map((t) => (
                  <div key={t.name} className="flex items-center justify-between gap-2 text-[11px] rounded bg-zinc-900/60 border border-zinc-800 px-2 py-1">
                    <span className="font-mono text-zinc-300 truncate">{t.name}</span>
                    <span className="shrink-0 text-zinc-500">
                      <span className="text-red-400">{t.failed}</span> / {t.total}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timeline */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{L ? 'Таймлайн' : 'Timeline'}</div>
            {steps.length === 0 ? (
              <div className="text-[12px] text-zinc-600">{L ? 'Пока нет действий. Запусти агента или исследование.' : 'No activity yet. Run the agent or a research.'}</div>
            ) : (
              <div className="space-y-0.5">
                {[...steps].reverse().slice(0, 120).map((s) => (
                  <div key={s.id} className="flex items-start gap-2 text-[11px] py-0.5">
                    <span className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`truncate ${s.kind === 'note' ? 'text-zinc-400' : 'font-mono text-zinc-200'}`}>{s.name}</span>
                        {s.kind === 'tool' && <span className="text-zinc-600 shrink-0">{fmtDuration(s)}</span>}
                      </div>
                      {s.detail && s.status !== 'ok' && (
                        <div className={`truncate ${s.status === 'failed' ? 'text-red-400/80' : 'text-amber-400/70'}`}>{s.detail}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
