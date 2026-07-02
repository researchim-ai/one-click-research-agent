import * as fs from 'fs'
import * as path from 'path'
import { corpusStats } from './corpus'
import { evidenceStats } from './evidence'
import { parsePlan, planProgress } from './planner'
import { readQualityGateSnapshot, isQualityGateSnapshotFresh, type GateResult } from './quality-gates'
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
  /**
   * The screening contract captured from the latest screen_corpus call. Once set,
   * build_corpus re-applies it automatically to any freshly gathered raw items so the
   * corpus can never accumulate an unscreened backlog (the root cause of search loops).
   */
  screenParams?: {
    question: string
    subQuestions?: string[]
    yearFrom?: number
    yearTo?: number
    maxSelected?: number
    minSelected?: number
    strictDateRange?: boolean
    researchKind?: string
  }
  lastTool?: string
  lastGateFailures?: Array<{ gate: string; blockers: string[]; repairTools: string[] }>
  allowedActions: string[]
  /** How many quality-gate runs each gate has failed in (for the escape valve). */
  gateAttempts?: Record<string, number>
  /**
   * Cumulative number of successful search-tool calls across the WHOLE run (persisted so it
   * survives the multiple runAgent invocations a managed run goes through: plan checkpoint,
   * auto-continue, gate-repair passes). Used to redirect the model away from exhausted broad
   * discovery toward targeted queries / synthesis once it has searched a lot.
   */
  searchCallsTotal?: number
  /** Highest budget milestone (floor(searchCallsTotal / cap)) already nudged, so each
   * milestone nudges exactly once even across invocations. */
  searchNudgeMilestone?: number
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
  'noise_ratio',
])
// NOTE: topical_precision is deliberately NOT structural. It measures whether the selected
// sources are actually on-topic — a content-quality signal, not a limitation of what's
// retrievable. Downgrading it let off-topic papers into the final report. It is instead
// made genuinely passable: the floor-promotion shares the gate threshold
// (MIN_SELECTABLE_TOPICAL_PRECISION) and manual rejections are now sticky, so re-screening
// or rejecting the flagged items always clears it.

/** A structural gate is downgraded once it has failed in this many quality-gate runs. */
export const GATE_DOWNGRADE_AFTER_ATTEMPTS = 3

const ALLOWED_ACTIONS: Record<ResearchWorkflowState, string[]> = {
  INIT: ['plan_research'],
  PLANNED: ['search_arxiv', 'search_openalex', 'search_huggingface_papers', 'search_web', 'build_corpus', 'screen_corpus', 'assign_corpus_to_plan'],
  // screen_corpus FIRST: right after build_corpus the corpus may hold unscreened raw
  // items; screening (not reading raw noise) is the correct next step.
  CORPUS_READY: ['screen_corpus', 'read_full_text_batch', 'read_corpus_item', 'full_text_status', 'queue_full_text', 'assign_corpus_to_plan'],
  // READING must allow evidence extraction: otherwise the run cannot bootstrap from
  // READING to EVIDENCE (EVIDENCE is only inferred once evidence exists, but the tools
  // that create evidence were not listed here — a deadlock that made the model deliberate
  // in circles after finishing its reads).
  READING: ['read_full_text_batch', 'read_corpus_item', 'full_text_status', 'assign_corpus_to_plan', 'extract_evidence_batch', 'extract_evidence_from_corpus_item', 'record_evidence', 'run_quality_gates'],
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
      // screen_corpus / build_corpus first: an unscreened corpus is the usual cause, and
      // screening the sources already gathered is far cheaper than searching for more.
      return ['screen_corpus', 'build_corpus', 'read_full_text_batch', 'search_openalex', 'search_arxiv', 'run_quality_gates']
    case 'topical_precision':
      // The blocker lists the exact off-topic IDs. Reject them (sticky) or re-screen to
      // demote them — both now permanently clear the gate.
      return ['reject_corpus_items', 'screen_corpus', 'run_quality_gates']
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

/**
 * Pure budget-milestone decision for the per-run search cap. Given the new cumulative
 * search count and the highest milestone already nudged, returns the current milestone and
 * whether a fresh nudge should fire (each milestone fires at most once, up to maxNudges).
 * Extracted so the crossing logic is unit-testable independently of runAgent.
 */
export function nextSearchBudgetNudge(
  total: number,
  prevMilestone: number,
  cap = 45,
  maxNudges = 4,
): { milestone: number; shouldNudge: boolean } {
  const safeCap = Math.max(1, cap)
  const milestone = Math.floor(Math.max(0, total) / safeCap)
  const shouldNudge = milestone > Math.max(0, prevMilestone) && milestone <= maxNudges
  return { milestone, shouldNudge }
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

  // Only trust gate results that are newer than the current corpus/evidence. A stale
  // snapshot (gates run earlier at a smaller corpus) must not pin the run to
  // GATES_FAILED while the agent is still legitimately gathering/extracting.
  const gates = isQualityGateSnapshotFresh(workspace, outputDir) ? readQualityGateSnapshot(workspace, outputDir) : null
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
    screenParams: patch.screenParams ?? prev?.screenParams,
    lastTool: patch.lastTool ?? prev?.lastTool,
    lastGateFailures,
    allowedActions: allowedActionsForState(inferredState, lastGateFailures),
    gateAttempts: patch.gateAttempts ?? prev?.gateAttempts,
    downgradedGates: patch.downgradedGates ?? prev?.downgradedGates,
    searchCallsTotal: patch.searchCallsTotal ?? prev?.searchCallsTotal,
    searchNudgeMilestone: patch.searchNudgeMilestone ?? prev?.searchNudgeMilestone,
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

/**
 * Recovery tools surfaced when a run cannot gather enough usable data. These let
 * the agent escape the READING/CORPUS dead-end (where only reading tools are
 * allowed) by re-screening, re-searching, or proceeding to an honest report.
 */
export const DATA_STALL_RECOVERY_ACTIONS = [
  'screen_corpus', 'build_corpus', 'search_web', 'search_openalex', 'search_arxiv',
  'assign_corpus_to_plan', 'record_evidence', 'run_quality_gates', 'generate_evidence_report',
]

export interface DataStallInfo {
  stalled: boolean
  reason: string
  recoveryActions: string[]
}

/**
 * Detect a data-gathering stall: the run is past planning but cannot accumulate
 * usable read sources because reads keep failing or screening over-filtered the
 * corpus to almost nothing. This is the "system can't get data from sources"
 * situation — without an escape the agent loops on failing reads forever.
 *
 * Deliberately conservative so it does NOT fire on a healthy READING phase that
 * simply has unread-but-not-failed items pending.
 */
export function detectDataGatheringStall(args: {
  state: ResearchWorkflowState
  reportExists: boolean
  totalCorpus: number
  selected: number
  selectedRead: number
  failedReads: number
  evidenceTotal: number
  target: number
}): DataStallInfo {
  const { state, reportExists, totalCorpus, selected, selectedRead, failedReads, evidenceTotal, target } = args
  const inGathering = state === 'CORPUS_READY' || state === 'READING' || state === 'EVIDENCE'
  if (reportExists || !inGathering) return { stalled: false, reason: '', recoveryActions: [] }

  const need = Math.max(1, Math.min(3, target || 3))
  const lowYield = selectedRead < need && evidenceTotal < need
  // Two independent stall signals: lots of failed reads, or a collapsed/over-filtered selection.
  const manyFailures = failedReads >= 3
  const collapsedSelection = selected <= 2 && selectedRead <= 1
  if (!lowYield || !(manyFailures || collapsedSelection)) return { stalled: false, reason: '', recoveryActions: [] }

  const reasonParts: string[] = []
  reasonParts.push(`only ${selectedRead} usable source(s) read (target ${target || need}), ${evidenceTotal} evidence claim(s)`) 
  if (manyFailures) reasonParts.push(`${failedReads} source read(s) failed`)
  if (collapsedSelection) reasonParts.push(`only ${selected} item(s) selected out of ${totalCorpus} discovered`)
  return { stalled: true, reason: reasonParts.join('; '), recoveryActions: DATA_STALL_RECOVERY_ACTIONS }
}

/**
 * Strong, kind-aware recovery directive shown when a data-gathering stall is
 * detected. Tells the agent to stop hammering failing fetches and either recover
 * (re-screen / re-search / snippet-evidence for general) or finish honestly.
 */
export function formatDataStallDirective(reason: string, researchKind?: string): string {
  const general = String(researchKind || 'academic') === 'general'
  const lines = [
    `⚠️ DATA-GATHERING STALL: ${reason}.`,
    'Do NOT keep calling read_corpus_item / read_full_text_batch on URLs that already failed with network/HTTP errors — one retry max, then mark them unavailable and move on. Repeating failing fetches will not change the result.',
    'Recover in this order:',
    '1. RE-SCREEN: call screen_corpus with a higher `max_selected` (and the run\'s `min_selected`) to pull more candidates from the items already discovered — your selected set is too small / over-filtered.',
    general
      ? '2. RE-SEARCH the web with different / broader phrasings (search_web, or smart_search), then build_corpus + screen_corpus to add fresh, reachable sources.'
      : '2. RE-SEARCH with different phrasings and other indexes (search_openalex, search_arxiv, search_web), then build_corpus + screen_corpus to add fresh sources.',
    general
      ? '3. If full pages will not fetch, you MAY record evidence grounded in the search-result snippet + source URL (note it is snippet-based) instead of full text — do not block the whole run on unfetchable pages.'
      : '3. For sources whose full text is unavailable, mark them unavailable and prefer other selected sources; do not fabricate quotes.',
    '4. If after TWO honest recovery rounds you still cannot reach the target, STOP gathering: call run_quality_gates (unmet structural gaps downgrade to documented limitations after repeated attempts) and then generate_evidence_report to produce an HONEST report that explicitly states the data-availability limitation. Do not loop.',
  ]
  return lines.join('\n')
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
