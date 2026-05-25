import * as fs from 'fs'
import * as path from 'path'
import { loadCorpus, corpusStats } from './corpus'
import { evidenceStats, loadEvidence, verifyClaims } from './evidence'
import { getSourceTracker } from './sources'
import { parsePlan, planProgress } from './planner'

export interface GateResult {
  gate: string
  passed: boolean
  score?: number
  blockers: string[]
  warnings: string[]
}

function qualityPath(workspace: string): string {
  return path.join(workspace, '.research', 'quality-gates.json')
}

function pass(gate: string, score: number, warnings: string[] = []): GateResult {
  return { gate, passed: true, score, blockers: [], warnings }
}

function fail(gate: string, blockers: string[], score = 0, warnings: string[] = []): GateResult {
  return { gate, passed: false, score, blockers, warnings }
}

export function runQualityGates(workspace: string, sessionId?: string, opts?: { minSources?: number; minEvidence?: number; requirePlanCompletion?: boolean }): { results: GateResult[]; summary: string } {
  const minSources = Math.max(1, Number(opts?.minSources) || 5)
  const minEvidence = Math.max(0, Number(opts?.minEvidence) || 3)
  const results: GateResult[] = []

  const tracker = sessionId ? getSourceTracker(sessionId) : null
  const sourceCount = tracker?.count() ?? 0
  const corpus = corpusStats(workspace)
  const totalSources = Math.max(sourceCount, corpus.total)
  results.push(totalSources >= minSources
    ? pass('source_coverage', Math.min(100, Math.round(totalSources / minSources * 100)))
    : fail('source_coverage', [`Only ${totalSources} source(s); target is at least ${minSources}.`], Math.round(totalSources / minSources * 100)))

  const eStats = evidenceStats(workspace)
  results.push(eStats.total >= minEvidence
    ? pass('evidence_coverage', Math.min(100, Math.round(eStats.supported / Math.max(1, eStats.total) * 100)), eStats.needsReview ? [`${eStats.needsReview} claim(s) still need review.`] : [])
    : fail('evidence_coverage', [`Only ${eStats.total} evidence claim(s); target is at least ${minEvidence}.`], Math.round(eStats.total / Math.max(1, minEvidence) * 100)))

  const claims = loadEvidence(workspace)
  const unresolved = claims.filter((claim) => claim.sourceIdxs.length === 0 || claim.status !== 'supported')
  results.push(unresolved.length === 0
    ? pass('claim_support', 100)
    : fail('claim_support', unresolved.slice(0, 5).map((c) => `${c.id}: ${c.status}; sources=${c.sourceIdxs.length}`), Math.max(0, 100 - unresolved.length * 20)))

  const plan = parsePlan(workspace)
  const progress = planProgress(plan)
  if (plan.length > 0 || opts?.requirePlanCompletion) {
    results.push(progress.pct >= 80
      ? pass('plan_progress', progress.pct)
      : fail('plan_progress', [`Plan is ${progress.pct}% complete (${progress.done}/${progress.total}).`], progress.pct))
  }

  const entries = loadCorpus(workspace)
  const currentYear = new Date().getFullYear()
  const fresh = entries.filter((e) => e.year && e.year >= currentYear - 1).length
  if (entries.length > 0) {
    results.push(fresh > 0
      ? pass('recency', Math.min(100, Math.round(fresh / entries.length * 100)), [`${fresh}/${entries.length} corpus item(s) are from ${currentYear - 1}+.`])
      : fail('recency', ['No recent corpus item found from the last two years.'], 0))
  }

  const passed = results.filter((r) => r.passed).length
  const summary = `Quality gates: ${passed}/${results.length} passed.`
  try {
    fs.mkdirSync(path.dirname(qualityPath(workspace)), { recursive: true })
    fs.writeFileSync(qualityPath(workspace), JSON.stringify({ summary, results, at: Date.now() }, null, 2), 'utf-8')
  } catch {}
  return { results, summary }
}

export function formatGateReport(workspace: string, sessionId?: string): string {
  const { results, summary } = runQualityGates(workspace, sessionId)
  const lines = [`# Research Quality Gates`, '', summary, '']
  for (const r of results) {
    lines.push(`## ${r.passed ? 'PASS' : 'FAIL'} ${r.gate}${r.score !== undefined ? ` (${r.score}%)` : ''}`)
    for (const b of r.blockers) lines.push(`- Blocker: ${b}`)
    for (const w of r.warnings) lines.push(`- Warning: ${w}`)
    if (r.blockers.length === 0 && r.warnings.length === 0) lines.push('- No issues.')
    lines.push('')
  }
  if (loadEvidence(workspace).length > 0) {
    lines.push('---', '', verifyClaims(workspace, sessionId))
  }
  return lines.join('\n')
}
