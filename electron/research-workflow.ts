import * as fs from 'fs'
import * as path from 'path'
import { corpusStats } from './corpus'
import { evidenceStats } from './evidence'
import { parsePlan, planProgress } from './planner'
import { readQualityGateSnapshot, type GateResult } from './quality-gates'
import { resolveResearchDir } from '../research-paths'

export type ResearchWorkflowState =
  | 'INIT'
  | 'PLANNED'
  | 'CORPUS_READY'
  | 'READING'
  | 'EVIDENCE'
  | 'GATES_PENDING'
  | 'GATES_FAILED'
  | 'GATES_PASSED'
  | 'REPORT_READY'
  | 'BLOCKED'

export interface ResearchRunSpec {
  id: string
  workflowId: 'managed-deep-v1'
  outputDir: string
  state: ResearchWorkflowState
  topic?: string
  thresholds?: Record<string, number | boolean | string>
  lastTool?: string
  lastGateFailures?: Array<{ gate: string; blockers: string[]; repairTools: string[] }>
  allowedActions: string[]
  /** How many quality-gate runs each gate has failed in (for the escape valve). */
  gateAttempts?: Record<string, number>
  /** Structural gates downgraded from blocker to warning after exhausting honest repair attempts. */
  downgradedGates?: string[]
  createdAt: number
  updatedAt: number
  transitions: Array<{ at: number; from: ResearchWorkflowState; to: ResearchWorkflowState; event: string; tool?: string }>
}

const WORKFLOW_ID: ResearchRunSpec['workflowId'] = 'managed-deep-v1'

/**
 * Gates whose satisfaction depends on what actually exists (available surveys,
 * recent papers, retrievable full text) rather than on more model effort. After
 * enough honest repair attempts these are downgraded to warnings so a run can
 * finish with a documented limitation instead of looping forever.
 */
export const STRUCTURAL_GATES = new Set([
  'review_source_coverage',
  'recency',
  'full_text_coverage',
  'high_priority_availability',
  'unread_top_sources',
  'topical_precision',
  'noise_ratio',
])

/** A structural gate is downgraded once it has failed in this many quality-gate runs. */
export const GATE_DOWNGRADE_AFTER_ATTEMPTS = 3

const ALLOWED_ACTIONS: Record<ResearchWorkflowState, string[]> = {
  INIT: ['plan_research'],
  PLANNED: ['search_arxiv', 'search_openalex', 'search_huggingface_papers', 'search_web', 'build_corpus', 'screen_corpus', 'assign_corpus_to_plan'],
  CORPUS_READY: ['queue_full_text', 'read_full_text_batch', 'read_corpus_item', 'full_text_status', 'assign_corpus_to_plan'],
  READING: ['read_full_text_batch', 'read_corpus_item', 'full_text_status', 'extract_evidence_batch'],
  EVIDENCE: ['record_evidence', 'extract_evidence_from_corpus_item', 'repair_evidence_quotes', 'verify_claims', 'audit_research_run', 'run_quality_gates'],
  GATES_PENDING: ['run_quality_gates', 'audit_research_run'],
  GATES_FAILED: ['search_openalex', 'search_arxiv', 'repair_evidence_quotes', 'read_full_text_batch', 'read_corpus_item', 'screen_corpus', 'build_corpus', 'assign_corpus_to_plan', 'record_evidence', 'verify_claims', 'update_plan_status', 'run_quality_gates'],
  GATES_PASSED: ['generate_evidence_report'],
  REPORT_READY: ['generate_evidence_report', 'export_report', 'scout_ideas', 'prioritize_ideas', 'save_idea'],
  BLOCKED: ['gate_report', 'list_evidence', 'list_selected_corpus', 'full_text_status', 'verify_claims'],
}

function runSpecPath(workspace: string, outputDir: string): string {
  return path.join(resolveResearchDir(workspace, outputDir), 'run.json')
}

function runIdFromDir(outputDir: string): string {
  return outputDir.replace(/^\.research\//, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 120) || 'research-run'
}

export function repairToolsForGate(gate: string): string[] {
  switch (gate) {
    case 'report_citation_coverage':
      return ['repair_evidence_quotes', 'verify_claims', 'run_quality_gates']
    case 'full_text_coverage':
    case 'unread_top_sources':
    case 'high_priority_availability':
      return ['full_text_status', 'read_full_text_batch', 'read_corpus_item', 'run_quality_gates']
    case 'selected_corpus_minimum':
    case 'review_source_coverage':
      return ['search_openalex', 'search_arxiv', 'build_corpus', 'screen_corpus', 'read_full_text_batch', 'run_quality_gates']
    case 'topical_precision':
    case 'noise_ratio':
    case 'date_range_compliance':
    case 'recency':
      return ['build_corpus', 'screen_corpus', 'run_quality_gates']
    case 'evidence_coverage':
    case 'claim_support':
    case 'evidence_to_corpus_linkage':
      return ['list_evidence', 'extract_evidence_batch', 'record_evidence', 'verify_claims', 'run_quality_gates']
    case 'plan_section_coverage':
      return ['list_selected_corpus', 'assign_corpus_to_plan', 'extract_evidence_batch', 'record_evidence', 'verify_claims', 'run_quality_gates']
    case 'plan_progress':
      return ['update_plan_status', 'run_quality_gates']
    case 'final_report_structure':
      return ['generate_evidence_report']
    default:
      return ['gate_report', 'verify_claims', 'run_quality_gates']
  }
}

export function repairActionsForGateResults(results: GateResult[]): Array<{ gate: string; blockers: string[]; repairTools: string[] }> {
  return results
    .filter((result) => !result.passed)
    .map((result) => ({
      gate: result.gate,
      blockers: result.blockers,
      repairTools: repairToolsForGate(result.gate),
    }))
}

export function allowedActionsForState(state: ResearchWorkflowState, failures: Array<{ repairTools: string[] }> = []): string[] {
  if (state !== 'GATES_FAILED' || failures.length === 0) return ALLOWED_ACTIONS[state] ?? []
  return [...new Set(failures.flatMap((failure) => failure.repairTools))]
}

export function inferResearchWorkflowState(workspace: string, outputDir: string): ResearchWorkflowState {
  const abs = resolveResearchDir(workspace, outputDir)
  if (fs.existsSync(path.join(abs, 'report.md'))) return 'REPORT_READY'

  const gates = readQualityGateSnapshot(workspace, outputDir)
  if (gates?.allPassed) return 'GATES_PASSED'
  if (gates && gates.failed.length > 0) return gates.failed.every((r) => r.gate === 'final_report_structure') ? 'GATES_PASSED' : 'GATES_FAILED'

  const evidence = evidenceStats(workspace, outputDir)
  if (evidence.total > 0) return 'EVIDENCE'

  const corpus = corpusStats(workspace, outputDir)
  if (corpus.selectedRead > 0) return 'READING'
  if (corpus.selected > 0 || corpus.total > 0) return 'CORPUS_READY'

  const progress = planProgress(parsePlan(workspace, outputDir))
  if (progress.total > 0) return 'PLANNED'
  return 'INIT'
}

export function readResearchRunSpec(workspace: string, outputDir: string): ResearchRunSpec | null {
  const p = runSpecPath(workspace, outputDir)
  if (!fs.existsSync(p)) return null
  try {
    const spec = JSON.parse(fs.readFileSync(p, 'utf-8')) as ResearchRunSpec
    if (!spec?.outputDir || !spec?.state) return null
    return spec
  } catch {
    return null
  }
}

export function ensureResearchRunSpec(workspace: string, outputDir: string, patch: Partial<ResearchRunSpec> = {}): ResearchRunSpec {
  const prev = readResearchRunSpec(workspace, outputDir)
  const inferredState = patch.state ?? prev?.state ?? inferResearchWorkflowState(workspace, outputDir)
  const rawFailures = patch.lastGateFailures ?? prev?.lastGateFailures ?? []
  const lastGateFailures = rawFailures.map((failure) => ({
    ...failure,
    repairTools: repairToolsForGate(failure.gate),
  }))
  const next: ResearchRunSpec = {
    id: patch.id ?? prev?.id ?? runIdFromDir(outputDir),
    workflowId: WORKFLOW_ID,
    outputDir: patch.outputDir ?? prev?.outputDir ?? outputDir,
    state: inferredState,
    topic: patch.topic ?? prev?.topic,
    thresholds: patch.thresholds ?? prev?.thresholds,
    lastTool: patch.lastTool ?? prev?.lastTool,
    lastGateFailures,
    allowedActions: allowedActionsForState(inferredState, lastGateFailures),
    gateAttempts: patch.gateAttempts ?? prev?.gateAttempts,
    downgradedGates: patch.downgradedGates ?? prev?.downgradedGates,
    createdAt: prev?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    transitions: patch.transitions ?? prev?.transitions ?? [],
  }
  const p = runSpecPath(workspace, outputDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  return next
}

export function updateResearchWorkflowAfterTool(
  workspace: string,
  outputDir: string,
  toolName: string,
  opts: { gateResults?: GateResult[] } = {},
): ResearchRunSpec {
  const prev = ensureResearchRunSpec(workspace, outputDir)
  let nextState = inferResearchWorkflowState(workspace, outputDir)
  let lastGateFailures = prev.lastGateFailures ?? []

  if (opts.gateResults) {
    lastGateFailures = repairActionsForGateResults(opts.gateResults)
    if (lastGateFailures.length === 0) {
      nextState = fs.existsSync(path.join(resolveResearchDir(workspace, outputDir), 'report.md')) ? 'REPORT_READY' : 'GATES_PASSED'
    }
    else if (lastGateFailures.every((failure) => failure.gate === 'final_report_structure')) nextState = 'GATES_PASSED'
    else nextState = 'GATES_FAILED'
  } else if (toolName === 'generate_evidence_report') {
    nextState = 'REPORT_READY'
    lastGateFailures = []
  }

  const transitions = prev.transitions ?? []
  const transition = prev.state === nextState
    ? transitions
    : [...transitions.slice(-49), { at: Date.now(), from: prev.state, to: nextState, event: 'tool_result', tool: toolName }]

  return ensureResearchRunSpec(workspace, outputDir, {
    state: nextState,
    lastTool: toolName,
    lastGateFailures,
    transitions: transition,
  })
}

/**
 * Pure escape-valve computation. Given the raw gate results and the prior
 * per-gate failure counts, returns updated attempt counts, the set of gates to
 * downgrade, and a new results array where downgraded structural gates are
 * flipped from blocker to passing-with-warning (documented limitation).
 */
export function computeGateEscapeValve(
  rawResults: GateResult[],
  priorAttempts: Record<string, number> = {},
): { results: GateResult[]; attempts: Record<string, number>; downgraded: string[] } {
  const attempts: Record<string, number> = { ...priorAttempts }
  for (const r of rawResults) {
    if (!r.passed && STRUCTURAL_GATES.has(r.gate)) {
      attempts[r.gate] = (attempts[r.gate] ?? 0) + 1
    }
  }

  const downgraded = rawResults
    .filter((r) => !r.passed && STRUCTURAL_GATES.has(r.gate) && (attempts[r.gate] ?? 0) >= GATE_DOWNGRADE_AFTER_ATTEMPTS)
    .map((r) => r.gate)
  const downgradeSet = new Set(downgraded)

  const results = rawResults.map((r) => {
    if (!downgradeSet.has(r.gate)) return r
    const limitation = `Downgraded to warning after ${attempts[r.gate]} unsuccessful repair attempts — treated as a structural limitation of the available sources. ${r.blockers.join(' ')}`.trim()
    return { ...r, passed: true, blockers: [], warnings: [...r.warnings, limitation] }
  })

  return { results, attempts, downgraded }
}

/**
 * Apply the escape valve to the latest gate run, persisting attempt counts and
 * downgraded gates into run.json. Returns the (possibly downgraded) results so
 * the caller can rewrite quality-gates.json and let the run proceed to report.
 */
export function applyGateEscapeValve(
  workspace: string,
  outputDir: string,
  rawResults: GateResult[],
): { results: GateResult[]; downgraded: string[] } {
  const prev = ensureResearchRunSpec(workspace, outputDir)
  const { results, attempts, downgraded } = computeGateEscapeValve(rawResults, prev.gateAttempts ?? {})
  ensureResearchRunSpec(workspace, outputDir, { gateAttempts: attempts, downgradedGates: downgraded })
  return { results, downgraded }
}

export function formatWorkflowGuidance(spec: ResearchRunSpec): string {
  const failures = spec.lastGateFailures ?? []
  const lines = [
    `Workflow: ${spec.workflowId}`,
    `State: ${spec.state}`,
    `Allowed next tools: ${spec.allowedActions.join(', ') || 'none'}`,
  ]
  if (failures.length) {
    lines.push('Gate repair routes:')
    for (const failure of failures.slice(0, 6)) {
      lines.push(`- ${failure.gate}: ${failure.repairTools.join(' -> ')}`)
    }
  }
  return lines.join('\n')
}
