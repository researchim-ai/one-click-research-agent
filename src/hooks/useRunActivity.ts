import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, AgentActivityPhase } from '../../electron/types'

export type RunStepStatus = 'running' | 'ok' | 'failed' | 'degraded' | 'info'

export interface RunStep {
  id: string
  kind: 'tool' | 'note'
  name: string
  status: RunStepStatus
  startedAt: number
  endedAt?: number
  /** Short human detail — an error snippet for failures, first result line otherwise. */
  detail?: string
}

export interface ToolStat {
  name: string
  total: number
  failed: number
  degraded: number
}

const MAX_STEPS = 400

const FAILED_RE = /^error\b|\bhttp\s*(?:4|5)\d\d\b|\b(?:429|500|503|502|403|404|401)\b|\bfailed\b|\btimed out\b|could not|no-op:/i
const DEGRADED_RE = /no .*found|no change|already|cached|downgrad|limitation|unavailable|throttl|rate.?limit|skipp?ed|duplicate/i

function classifyResult(result: string): { status: RunStepStatus; detail: string } {
  const text = String(result ?? '').trim()
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (FAILED_RE.test(text)) return { status: 'failed', detail: firstLine.slice(0, 200) }
  if (DEGRADED_RE.test(firstLine)) return { status: 'degraded', detail: firstLine.slice(0, 200) }
  return { status: 'ok', detail: firstLine.slice(0, 160) }
}

/** Only surface runtime-guard / forced-action status lines as timeline notes. */
function isNoteworthyStatus(content: string): boolean {
  return /^[⛔⚠️⏳📝✅]|Runtime|guard|принудительно|зациклил|повтор/i.test(content)
}

/**
 * Accumulates a live, generic timeline of agent activity (tool calls + their outcomes,
 * phase, runtime-guard notes) from the agent-event stream. Works for ANY run, not just
 * research; the research FSM/gate overlay is fetched separately via getRunGraph.
 */
export function useRunActivity() {
  const [steps, setSteps] = useState<RunStep[]>([])
  const [currentPhase, setCurrentPhase] = useState<AgentActivityPhase | null>(null)
  const [activityLabel, setActivityLabel] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const idRef = useRef(0)
  const nextId = () => `s${++idRef.current}`

  const clear = useCallback(() => {
    setSteps([])
    setCurrentPhase(null)
    setActivityLabel(null)
    setRunning(false)
  }, [])

  useEffect(() => {
    if (!window.api?.onAgentEvent) return
    const off = window.api.onAgentEvent((ev: AgentEvent) => {
      switch (ev.type) {
        case 'tool_call': {
          const name = ev.name ?? 'tool'
          setRunning(true)
          setSteps((prev) => {
            const next = prev.length >= MAX_STEPS ? prev.slice(prev.length - MAX_STEPS + 1) : [...prev]
            next.push({ id: nextId(), kind: 'tool', name, status: 'running', startedAt: Date.now() })
            return next
          })
          break
        }
        case 'tool_result': {
          const name = ev.name ?? ''
          const { status, detail } = classifyResult(ev.result ?? '')
          setSteps((prev) => {
            const next = [...prev]
            // Close the most recent running step (prefer a name match).
            let idx = -1
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].status === 'running' && (!name || next[i].name === name)) { idx = i; break }
            }
            if (idx === -1) {
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].status === 'running') { idx = i; break }
              }
            }
            if (idx >= 0) next[idx] = { ...next[idx], status, detail, endedAt: Date.now() }
            return next
          })
          break
        }
        case 'agent_activity': {
          if (ev.activity) {
            setCurrentPhase(ev.activity.phase)
            setActivityLabel(ev.activity.label ?? null)
            if (ev.activity.phase === 'done') setRunning(false)
          }
          break
        }
        case 'status': {
          const content = String(ev.content ?? '')
          if (content && isNoteworthyStatus(content)) {
            setSteps((prev) => {
              const next = prev.length >= MAX_STEPS ? prev.slice(prev.length - MAX_STEPS + 1) : [...prev]
              next.push({ id: nextId(), kind: 'note', name: content.slice(0, 160), status: 'info', startedAt: Date.now(), endedAt: Date.now() })
              return next
            })
          }
          break
        }
        case 'response': {
          if (ev.done) { setRunning(false); setCurrentPhase(null) }
          break
        }
        case 'error': {
          setRunning(false)
          break
        }
      }
    })
    return off
  }, [])

  const failedCount = useMemo(() => steps.filter((s) => s.status === 'failed').length, [steps])

  const toolStats = useMemo<ToolStat[]>(() => {
    const map = new Map<string, ToolStat>()
    for (const s of steps) {
      if (s.kind !== 'tool') continue
      const stat = map.get(s.name) ?? { name: s.name, total: 0, failed: 0, degraded: 0 }
      stat.total++
      if (s.status === 'failed') stat.failed++
      else if (s.status === 'degraded') stat.degraded++
      map.set(s.name, stat)
    }
    return [...map.values()].sort((a, b) => b.failed - a.failed || b.total - a.total)
  }, [steps])

  return { steps, currentPhase, activityLabel, running, failedCount, toolStats, clear }
}
