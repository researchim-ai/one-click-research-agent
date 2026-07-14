import { describe, it, expect } from 'vitest'
import {
  allowedActionsForState,
  repairToolsForGate,
  repairActionsForGateResults,
  formatWorkflowGuidance,
  computeGateEscapeValve,
  detectDataGatheringStall,
  formatDataStallDirective,
  nextSearchBudgetNudge,
  registerResearchSearch,
  researchSearchSignature,
  GATE_DOWNGRADE_AFTER_ATTEMPTS,
  GATE_HARD_STOP_AFTER_ATTEMPTS,
  type ResearchRunSpec,
} from '../electron/research-workflow'
import type { GateResult } from '../electron/quality-gates'

const gate = (g: string, passed: boolean, blockers: string[] = [], score = 0): GateResult => ({ gate: g, passed, blockers, warnings: [], score })

describe('persistent research search dedup', () => {
  it('normalizes insignificant query whitespace and case', () => {
    const a = researchSearchSignature('search_openalex', { query: '  RLHF   DPO ', year_from: 2024, year_to: 2026 })
    const b = researchSearchSignature('search_openalex', { query: 'rlhf dpo', year_from: 2024, year_to: 2026 })
    expect(a).toBe(b)
  })

  it('recognizes the same query after state is restored by a later runAgent invocation', () => {
    const first = registerResearchSearch([], 0, 'search_openalex', {
      query: 'RLHF DPO preference alignment',
      year_from: 2024,
      year_to: 2026,
    })
    expect(first.duplicate).toBe(false)

    // Simulate persisted run.json fields loaded by a new invocation.
    const resumed = registerResearchSearch(first.signatures, first.duplicateHits, 'search_openalex', {
      query: 'rlhf   dpo preference alignment',
      year_from: 2024,
      year_to: 2026,
    })
    expect(resumed.duplicate).toBe(true)
    expect(resumed.duplicateHits).toBe(1)
  })

  it('resets the duplicate streak when a genuinely new query is issued', () => {
    const resumed = registerResearchSearch(['search_openalex|old|||||'], 5, 'search_openalex', { query: 'new' })
    expect(resumed.duplicate).toBe(false)
    expect(resumed.duplicateHits).toBe(0)
  })
})

describe('allowedActionsForState', () => {
  it('returns the static allowed list for non-gate states', () => {
    expect(allowedActionsForState('INIT')).toEqual(['plan_research'])
    expect(allowedActionsForState('GATES_PASSED')).toEqual(['generate_evidence_report'])
  })

  it('narrows to repair tools when gates failed', () => {
    const failures = [{ repairTools: ['search_openalex', 'run_quality_gates'] }]
    expect(allowedActionsForState('GATES_FAILED', failures)).toEqual(['search_openalex', 'run_quality_gates'])
  })

  it('falls back to the full GATES_FAILED list when no failures provided', () => {
    expect(allowedActionsForState('GATES_FAILED', [])).toContain('run_quality_gates')
  })

  it('CORPUS_READY allows screen_corpus so the model screens before reading raw noise', () => {
    expect(allowedActionsForState('CORPUS_READY')).toContain('screen_corpus')
  })

  it('READING allows evidence extraction so the run can bootstrap into EVIDENCE', () => {
    const reading = allowedActionsForState('READING')
    expect(reading).toContain('extract_evidence_from_corpus_item')
    expect(reading).toContain('record_evidence')
  })
})

describe('repairToolsForGate', () => {
  it('routes citation gate to quote repair', () => {
    expect(repairToolsForGate('report_citation_coverage')).toEqual([
      'repair_evidence_quotes',
      'verify_claims',
      'run_quality_gates',
    ])
  })

  it('routes survey coverage to search/build/screen', () => {
    expect(repairToolsForGate('review_source_coverage')).toContain('search_openalex')
  })

  it('always ends repair routes with run_quality_gates', () => {
    for (const gate of ['report_citation_coverage', 'full_text_coverage', 'evidence_coverage', 'plan_progress']) {
      expect(repairToolsForGate(gate).at(-1)).toBe('run_quality_gates')
    }
  })
})

describe('repairActionsForGateResults', () => {
  it('keeps only failed gates and attaches repair tools', () => {
    const results: GateResult[] = [
      { gate: 'source_coverage', passed: true, blockers: [], details: '' } as GateResult,
      { gate: 'review_source_coverage', passed: false, blockers: ['need surveys'], details: '' } as GateResult,
    ]
    const actions = repairActionsForGateResults(results)
    expect(actions).toHaveLength(1)
    expect(actions[0].gate).toBe('review_source_coverage')
    expect(actions[0].repairTools).toContain('search_arxiv')
  })
})

describe('computeGateEscapeValve', () => {
  it('increments attempts but does not downgrade below threshold', () => {
    const raw = [gate('review_source_coverage', false, ['need surveys']), gate('source_coverage', true)]
    const { results, attempts, downgraded } = computeGateEscapeValve(raw, {})
    expect(attempts.review_source_coverage).toBe(1)
    expect(downgraded).toEqual([])
    expect(results.find((r) => r.gate === 'review_source_coverage')!.passed).toBe(false)
  })

  it('downgrades a non-search structural gate to a warning once attempts reach the threshold', () => {
    // plan_section_coverage is structural but not "gather more sources" recoverable, so it
    // downgrades on stall alone (no search-effort requirement).
    const raw = [gate('plan_section_coverage', false, ['section 3 has no evidence'])]
    const prior = { plan_section_coverage: GATE_DOWNGRADE_AFTER_ATTEMPTS - 1 }
    const { results, downgraded } = computeGateEscapeValve(raw, prior)
    expect(downgraded).toEqual(['plan_section_coverage'])
    const r = results.find((x) => x.gate === 'plan_section_coverage')!
    expect(r.passed).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/limitation of the available sources/i)
  })

  it('downgrades selected_corpus_minimum after stalling AND genuinely searching more (49/50 is then a real limitation)', () => {
    const raw = [gate('selected_corpus_minimum', false, ['Only 49 selected corpus item(s); target is at least 50.'], 98)]
    const prior = { selected_corpus_minimum: GATE_DOWNGRADE_AFTER_ATTEMPTS - 1 }
    const priorScores = { selected_corpus_minimum: 98 }
    // Gate started stalling at 10 search calls; the agent has since run 3 more (13) → genuine effort.
    const { downgraded, results } = computeGateEscapeValve(raw, prior, priorScores, {
      searchCalls: 13,
      priorSearchBaseline: { selected_corpus_minimum: 10 },
    })
    expect(downgraded).toEqual(['selected_corpus_minimum'])
    expect(results[0].passed).toBe(true)
  })

  it('does NOT downgrade selected_corpus_minimum on stall alone — it must go search more first', () => {
    const raw = [gate('selected_corpus_minimum', false, ['Only 49 selected'], 98)]
    const prior = { selected_corpus_minimum: GATE_DOWNGRADE_AFTER_ATTEMPTS + 1 }
    const priorScores = { selected_corpus_minimum: 98 }
    // No new searches since the gate started failing (baseline == current) → keep insisting on search.
    const { downgraded } = computeGateEscapeValve(raw, prior, priorScores, {
      searchCalls: 10,
      priorSearchBaseline: { selected_corpus_minimum: 10 },
    })
    expect(downgraded).toEqual([])
  })

  it('hard-stop still terminates a search-recoverable gate even if the agent never searched', () => {
    const raw = [gate('selected_corpus_minimum', false, ['Only 49 selected'], 98)]
    const prior = { selected_corpus_minimum: GATE_HARD_STOP_AFTER_ATTEMPTS - 1 }
    const priorScores = { selected_corpus_minimum: 98 }
    const { downgraded } = computeGateEscapeValve(raw, prior, priorScores, {
      searchCalls: 10,
      priorSearchBaseline: { selected_corpus_minimum: 10 },
    })
    expect(downgraded).toEqual(['selected_corpus_minimum'])
  })

  it('does NOT downgrade while the gate score is still improving (forward progress resets the stall)', () => {
    const raw = [gate('selected_corpus_minimum', false, ['Only 49 selected'], 98)]
    const prior = { selected_corpus_minimum: GATE_DOWNGRADE_AFTER_ATTEMPTS + 5 }
    const priorScores = { selected_corpus_minimum: 90 } // improved 90 -> 98
    const { downgraded, attempts } = computeGateEscapeValve(raw, prior, priorScores)
    expect(downgraded).toEqual([])
    expect(attempts.selected_corpus_minimum).toBe(0)
  })

  it('hard-stop net downgrades any stalled non-integrity gate to guarantee termination', () => {
    const raw = [gate('evidence_coverage', false, ['too few claims'], 40)]
    const prior = { evidence_coverage: GATE_HARD_STOP_AFTER_ATTEMPTS - 1 }
    const priorScores = { evidence_coverage: 40 } // stalled at 40
    const { downgraded } = computeGateEscapeValve(raw, prior, priorScores)
    expect(downgraded).toEqual(['evidence_coverage'])
  })

  it('never downgrades an integrity gate even past the hard stop — a dishonest report is worse than a loop', () => {
    for (const g of ['topical_precision', 'claim_support', 'report_citation_coverage', 'evidence_to_corpus_linkage']) {
      const raw = [gate(g, false, ['integrity violation'], 10)]
      const prior = { [g]: GATE_HARD_STOP_AFTER_ATTEMPTS + 20 }
      const priorScores = { [g]: 10 }
      const { downgraded, results } = computeGateEscapeValve(raw, prior, priorScores)
      expect(downgraded).toEqual([])
      expect(results[0].passed).toBe(false)
    }
  })

  it('leaves passing gates untouched and clears their stall counter', () => {
    const raw = [gate('recency', true, [], 100)]
    const { attempts, downgraded } = computeGateEscapeValve(raw, { recency: 2 })
    expect(attempts.recency).toBeUndefined()
    expect(downgraded).toEqual([])
  })
})

describe('nextSearchBudgetNudge', () => {
  it('does not nudge below the first milestone', () => {
    expect(nextSearchBudgetNudge(44, 0, 45).shouldNudge).toBe(false)
  })

  it('nudges exactly once when a new milestone is crossed', () => {
    const r = nextSearchBudgetNudge(45, 0, 45)
    expect(r.milestone).toBe(1)
    expect(r.shouldNudge).toBe(true)
    // Same milestone already recorded (e.g. next invocation) → no repeat nudge.
    expect(nextSearchBudgetNudge(60, 1, 45).shouldNudge).toBe(false)
  })

  it('fires again at the next milestone (persisted across invocations)', () => {
    expect(nextSearchBudgetNudge(90, 1, 45).shouldNudge).toBe(true)
    expect(nextSearchBudgetNudge(90, 1, 45).milestone).toBe(2)
  })

  it('stops nudging past the max-nudges cap', () => {
    expect(nextSearchBudgetNudge(45 * 5, 4, 45, 4).shouldNudge).toBe(false)
  })
})

describe('formatWorkflowGuidance', () => {
  it('renders state, allowed tools, and repair routes', () => {
    const spec: ResearchRunSpec = {
      id: 'r',
      workflowId: 'managed-deep-v1',
      outputDir: '.research/x',
      state: 'GATES_FAILED',
      allowedActions: ['repair_evidence_quotes', 'run_quality_gates'],
      lastGateFailures: [
        { gate: 'report_citation_coverage', blockers: ['low'], repairTools: ['repair_evidence_quotes', 'run_quality_gates'] },
      ],
      createdAt: 0,
      updatedAt: 0,
      transitions: [],
    }
    const text = formatWorkflowGuidance(spec)
    expect(text).toContain('State: GATES_FAILED')
    expect(text).toContain('repair_evidence_quotes')
    expect(text).toContain('report_citation_coverage')
  })
})

describe('detectDataGatheringStall', () => {
  const base = {
    state: 'READING' as const,
    reportExists: false,
    totalCorpus: 100,
    selected: 1,
    selectedRead: 0,
    failedReads: 0,
    evidenceTotal: 0,
    target: 50,
  }

  it('fires when reads keep failing and almost nothing is usable', () => {
    const r = detectDataGatheringStall({ ...base, failedReads: 8, selected: 12 })
    expect(r.stalled).toBe(true)
    expect(r.recoveryActions).toContain('screen_corpus')
    expect(r.recoveryActions).toContain('generate_evidence_report')
  })

  it('fires when screening collapsed the corpus to a couple of items', () => {
    const r = detectDataGatheringStall({ ...base, selected: 1, selectedRead: 1, failedReads: 0 })
    expect(r.stalled).toBe(true)
  })

  it('does NOT fire on a healthy READING phase with unread-but-not-failed items', () => {
    const r = detectDataGatheringStall({
      ...base, selected: 20, selectedRead: 4, failedReads: 0, evidenceTotal: 4, target: 50,
    })
    expect(r.stalled).toBe(false)
  })

  it('does NOT fire once the report exists', () => {
    const r = detectDataGatheringStall({ ...base, reportExists: true, failedReads: 9 })
    expect(r.stalled).toBe(false)
  })

  it('directive is kind-aware (general allows snippet-based evidence)', () => {
    const general = formatDataStallDirective('x', 'general')
    expect(general).toMatch(/snippet/i)
    const academic = formatDataStallDirective('x', 'academic')
    expect(academic).toMatch(/unavailable/i)
    expect(academic).not.toMatch(/snippet-based/i)
  })
})
