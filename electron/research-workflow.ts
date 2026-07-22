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
    /** Day-precise lower/upper bound (YYYY-MM-DD). Enforced ahead of yearFrom/yearTo so
     * sub-year windows ("last 3 months") are honored instead of being floored to a year. */
    fromDate?: string
    toDate?: string
    maxSelected?: number
    minSelected?: number
    strictDateRange?: boolean
    researchKind?: string
  }
  lastTool?: string
  lastGateFailures?: Array<{ gate: string; blockers: string[]; repairTools: string[] }>
  allowedActions: string[]
  /** How many consecutive quality-gate runs each gate has stalled in (no score gain). */
  gateAttempts?: Record<string, number>
  /** Last score per gate, so the escape valve can tell stagnation from forward progress. */
  gateScores?: Record<string, number>
  /** searchCallsTotal captured when a search-recoverable gate started failing, so the escape
   * valve can require genuine extra searching (not just re-screening) before downgrading. */
  gateSearchBaseline?: Record<string, number>
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
  /**
   * Normalized search tool+query signatures already executed in this managed run.
   * Persisted because one run spans multiple runAgent invocations; an in-memory Set
   * resets at every checkpoint/auto-continue and otherwise lets the same batch run again.
   */
  searchSignatures?: string[]
  /** Consecutive duplicate searches since the last genuinely new query. */
  duplicateSearchHits?: number
  /** searchCallsTotal captured after the latest successful corpus build. */
  searchCallsAtLastBuild?: number
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
  // Coverage/quantity gates that depend on how many on-topic sources actually exist.
  // When screening a fully-searched corpus keeps yielding the same count (e.g. 49/50),
  // more screening cannot conjure a 50th relevant paper — it is a source-availability
  // limitation, not a lack of model effort. Without this, an unreachable minimum makes
  // screen_corpus → run_quality_gates loop forever (the root cause of stalled runs).
  'selected_corpus_minimum',
  'plan_section_coverage',
  // Self-reported plan completion. Checkboxes are now auto-reconciled from real evidence
  // coverage (see reconcilePlanFromEvidence), so a lingering shortfall means some subtopic
  // genuinely lacks enough sources — an availability limitation, not lack of effort. Downgrade
  // it like the other coverage gates instead of blocking the report on a self-report proxy.
  'plan_progress',
])

// NOTE: topical_precision is deliberately NOT structural. It measures whether the selected
// sources are actually on-topic — a content-quality signal, not a limitation of what's
// retrievable. Downgrading it let off-topic papers into the final report. It is instead
// made genuinely passable: the floor-promotion shares the gate threshold
// (MIN_SELECTABLE_TOPICAL_PRECISION) and manual rejections are now sticky, so re-screening
// or rejecting the flagged items always clears it.

/**
 * Integrity gates must NEVER be auto-downgraded: silently passing them would produce a
 * dishonest report (off-topic sources, unsupported/uncited claims, fabricated links, or
 * out-of-period sources presented as in-period). These loops are instead broken by making
 * the gate genuinely satisfiable, not by waving it through. Everything NOT in this set is a
 * coverage/quantity signal that is honest to downgrade into a documented limitation.
 */
export const INTEGRITY_GATES = new Set([
  'topical_precision',
  'claim_support',
  'evidence_to_corpus_linkage',
  'report_citation_coverage',
  'date_range_compliance',
])

/**
 * Coverage gates whose shortfall is fixable by gathering MORE sources — i.e. the agent
 * should go search again with different queries / a shifted date window before the run
 * gives up. These are NOT downgraded on stall alone: the escape valve additionally requires
 * that the agent has actually run more searches since the gate started failing (see
 * REQUIRED_DIVERSIFY_SEARCHES). This is what forces "iди добери ещё статей" instead of
 * settling for 49/50 after only re-screening the same corpus in place.
 */
export const SEARCH_RECOVERABLE_GATES = new Set([
  'selected_corpus_minimum',
  'review_source_coverage',
  'recency',
])

/** New search calls required since a search-recoverable gate started failing before it may
 * be downgraded via the structural path (the hard-stop net still guarantees termination). */
export const REQUIRED_DIVERSIFY_SEARCHES = 2

/** A structural gate is downgraded once it has stalled (no score gain) in this many runs. */
export const GATE_DOWNGRADE_AFTER_ATTEMPTS = 3

/**
 * Universal termination safety net: ANY non-integrity gate that has stalled (no score gain)
 * for this many consecutive quality-gate runs is downgraded, even if it was never explicitly
 * classified as structural. This guarantees the run always terminates instead of looping,
 * regardless of which coverage gate gets stuck, without relying on a hand-maintained allowlist.
 */
export const GATE_HARD_STOP_AFTER_ATTEMPTS = 6

export function researchSearchSignature(name: string, args: Record<string, any> = {}): string {
  const q = String(args.query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return [
    name,
    q,
    args.year_from ?? '',
    args.year_to ?? '',
    args.from_date ?? '',
    args.to_date ?? '',
    args.sort_by ?? '',
  ].join('|')
}

export function registerResearchSearch(
  priorSignatures: string[] = [],
  priorDuplicateHits = 0,
  name: string,
  args: Record<string, any> = {},
): { duplicate: boolean; signatures: string[]; duplicateHits: number; signature: string } {
  const signature = researchSearchSignature(name, args)
  const seen = new Set(priorSignatures)
  if (seen.has(signature)) {
    return {
      duplicate: true,
      signatures: [...seen].slice(-512),
      duplicateHits: Math.max(0, priorDuplicateHits) + 1,
      signature,
    }
  }
  seen.add(signature)
  return {
    duplicate: false,
    signatures: [...seen].slice(-512),
    duplicateHits: 0,
    signature,
  }
}

const ALLOWED_ACTIONS: Record<ResearchWorkflowState, string[]> = {
  INIT: ['plan_research'],
  PLANNED: ['search_arxiv', 'search_openalex', 'search_huggingface_papers', 'search_web', 'build_corpus', 'screen_corpus', 'assign_corpus_to_plan'],
  // screen_corpus FIRST: right after build_corpus the corpus may hold unscreened raw
  // items; screening (not reading raw noise) is the correct next step.
  // Search remains available here because screening can legitimately collapse the selected
  // set to zero. Persistent search-signature dedup prevents re-running exhausted batches,
  // while fresh targeted queries are the only valid recovery in that case.
  CORPUS_READY: ['screen_corpus', 'search_arxiv', 'search_openalex', 'search_huggingface_papers', 'search_web', 'build_corpus', 'read_full_text_batch', 'read_corpus_item', 'full_text_status', 'queue_full_text', 'assign_corpus_to_plan'],
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
      // screen_corpus first when there is still an unscreened backlog (cheap, local); but
      // keep the full search/gather toolset available so that once screening is exhausted the
      // agent can go find MORE with different queries and a shifted date window. The
      // context-aware blocker message decides which of these to lead with.
      return ['screen_corpus', 'build_corpus', 'search_openalex', 'search_arxiv', 'search_web', 'read_full_text_batch', 'run_quality_gates']
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
    gateScores: patch.gateScores ?? prev?.gateScores,
    gateSearchBaseline: patch.gateSearchBaseline ?? prev?.gateSearchBaseline,
    downgradedGates: patch.downgradedGates ?? prev?.downgradedGates,
    searchCallsTotal: patch.searchCallsTotal ?? prev?.searchCallsTotal,
    searchNudgeMilestone: patch.searchNudgeMilestone ?? prev?.searchNudgeMilestone,
    searchSignatures: patch.searchSignatures ?? prev?.searchSignatures,
    duplicateSearchHits: patch.duplicateSearchHits ?? prev?.duplicateSearchHits,
    searchCallsAtLastBuild: patch.searchCallsAtLastBuild ?? prev?.searchCallsAtLastBuild,
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
    // Only advance to REPORT_READY if report.md was actually written. A blocked
    // generate call (gates failing) returns an error and writes nothing — it must
    // NOT fake completion, otherwise the run terminates with no report on disk.
    if (fs.existsSync(path.join(resolveResearchDir(workspace, outputDir), 'report.md'))) {
      nextState = 'REPORT_READY'
      lastGateFailures = []
    }
    // else: keep the inferred state + existing failures so the run keeps repairing.
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
 * Pure escape-valve computation. This is the run's termination guarantee: it turns a gate
 * that can no longer be improved into a documented limitation so the run finishes with an
 * honest report instead of looping `screen_corpus → run_quality_gates` forever.
 *
 * It is PROGRESS-AWARE, not just attempt-counting: a failing gate's stall counter only
 * advances when its score did NOT improve since the previous run. If the agent is still
 * making headway (e.g. selected 45 → 47 → 49) the counter resets and it keeps working
 * toward the real target. Because gate scores are bounded (0–100), once no further progress
 * is possible the counter necessarily climbs to the threshold and the gate is released.
 *
 * A gate is downgraded when it has stalled for enough runs AND it is not an integrity gate:
 *   - structural (source-availability) gates: after GATE_DOWNGRADE_AFTER_ATTEMPTS stalls
 *   - any other non-integrity gate: after GATE_HARD_STOP_AFTER_ATTEMPTS stalls (safety net)
 * Integrity gates are never auto-downgraded — those loops are broken by making them
 * genuinely satisfiable, never by waving through a dishonest report.
 */
export function computeGateEscapeValve(
  rawResults: GateResult[],
  priorAttempts: Record<string, number> = {},
  priorScores: Record<string, number> = {},
  opts: { searchCalls?: number; priorSearchBaseline?: Record<string, number> } = {},
): {
  results: GateResult[]
  attempts: Record<string, number>
  downgraded: string[]
  scores: Record<string, number>
  searchBaseline: Record<string, number>
} {
  const searchCalls = Math.max(0, Number(opts.searchCalls) || 0)
  const attempts: Record<string, number> = { ...priorAttempts }
  const scores: Record<string, number> = {}
  const searchBaseline: Record<string, number> = { ...(opts.priorSearchBaseline ?? {}) }
  for (const r of rawResults) {
    const score = typeof r.score === 'number' ? r.score : 0
    scores[r.gate] = score
    if (r.passed) {
      // A passing gate is no longer stalling; clear its counters so a later regression
      // gets the full budget again rather than tripping the escape valve immediately.
      delete attempts[r.gate]
      delete searchBaseline[r.gate]
      continue
    }
    const prevScore = priorScores[r.gate]
    const improved = typeof prevScore === 'number' && score > prevScore
    if (improved) {
      // Forward progress → reset the stall and re-baseline search effort.
      attempts[r.gate] = 0
      delete searchBaseline[r.gate]
    } else {
      attempts[r.gate] = (attempts[r.gate] ?? 0) + 1
      // Remember how much searching had been done when this gate first started stalling,
      // so we can require genuine additional discovery before giving up on it.
      if (SEARCH_RECOVERABLE_GATES.has(r.gate) && searchBaseline[r.gate] === undefined) {
        searchBaseline[r.gate] = searchCalls
      }
    }
  }

  const downgraded = rawResults
    .filter((r) => {
      if (r.passed || INTEGRITY_GATES.has(r.gate)) return false
      const stalls = attempts[r.gate] ?? 0
      // Universal termination net: unconditional once a gate has stalled long enough.
      if (stalls >= GATE_HARD_STOP_AFTER_ATTEMPTS) return true
      if (!STRUCTURAL_GATES.has(r.gate) || stalls < GATE_DOWNGRADE_AFTER_ATTEMPTS) return false
      // A shortfall that could be closed by finding MORE sources must not be waved through
      // until the agent has actually gone and searched again (different queries / shifted
      // date window), not merely re-screened the same corpus in place.
      if (SEARCH_RECOVERABLE_GATES.has(r.gate)) {
        const searchedSince = searchCalls - (searchBaseline[r.gate] ?? searchCalls)
        return searchedSince >= REQUIRED_DIVERSIFY_SEARCHES
      }
      return true
    })
    .map((r) => r.gate)
  const downgradeSet = new Set(downgraded)

  const results = rawResults.map((r) => {
    if (!downgradeSet.has(r.gate)) return r
    const limitation = `Downgraded to warning after ${attempts[r.gate]} repair attempts with no further progress — treated as a limitation of the available sources. ${r.blockers.join(' ')}`.trim()
    return { ...r, passed: true, blockers: [], warnings: [...r.warnings, limitation] }
  })

  return { results, attempts, downgraded, scores, searchBaseline }
}

/**
 * Apply the escape valve to the latest gate run, persisting attempt counts, per-gate scores
 * and downgraded gates into run.json. Returns the (possibly downgraded) results so the caller
 * can rewrite quality-gates.json and let the run proceed to report.
 */
export function applyGateEscapeValve(
  workspace: string,
  outputDir: string,
  rawResults: GateResult[],
): { results: GateResult[]; downgraded: string[] } {
  const prev = ensureResearchRunSpec(workspace, outputDir)
  const { results, attempts, downgraded, scores, searchBaseline } = computeGateEscapeValve(
    rawResults,
    prev.gateAttempts ?? {},
    prev.gateScores ?? {},
    { searchCalls: Number(prev.searchCallsTotal) || 0, priorSearchBaseline: prev.gateSearchBaseline ?? {} },
  )
  ensureResearchRunSpec(workspace, outputDir, {
    gateAttempts: attempts,
    gateScores: scores,
    gateSearchBaseline: searchBaseline,
    downgradedGates: downgraded,
  })
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
