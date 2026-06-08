import { describe, it, expect } from 'vitest'
import {
  allowedActionsForState,
  repairToolsForGate,
  repairActionsForGateResults,
  formatWorkflowGuidance,
  computeGateEscapeValve,
  GATE_DOWNGRADE_AFTER_ATTEMPTS,
  type ResearchRunSpec,
} from '../electron/research-workflow'
import type { GateResult } from '../electron/quality-gates'

const gate = (g: string, passed: boolean, blockers: string[] = []): GateResult => ({ gate: g, passed, blockers, warnings: [] })

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

  it('downgrades a structural gate to a warning once attempts reach the threshold', () => {
    const raw = [gate('review_source_coverage', false, ['only 1 survey'])]
    const prior = { review_source_coverage: GATE_DOWNGRADE_AFTER_ATTEMPTS - 1 }
    const { results, downgraded } = computeGateEscapeValve(raw, prior)
    expect(downgraded).toEqual(['review_source_coverage'])
    const r = results.find((x) => x.gate === 'review_source_coverage')!
    expect(r.passed).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/structural limitation/i)
  })

  it('never downgrades a non-structural gate (model can still fix it)', () => {
    const raw = [gate('evidence_coverage', false, ['too few claims'])]
    const prior = { evidence_coverage: 99 }
    const { results, downgraded } = computeGateEscapeValve(raw, prior)
    expect(downgraded).toEqual([])
    expect(results[0].passed).toBe(false)
  })

  it('leaves passing gates untouched and does not count them', () => {
    const raw = [gate('recency', true)]
    const { attempts, downgraded } = computeGateEscapeValve(raw, {})
    expect(attempts.recency).toBeUndefined()
    expect(downgraded).toEqual([])
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
