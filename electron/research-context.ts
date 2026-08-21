/**
 * Research-aware context policy.
 *
 * Architecture:
 * - **Persistent layer** (.research/ on disk): corpus, evidence, plan, gates — full fidelity.
 * - **Working layer** (GPU prompt): system + research working set + recent turns only.
 *
 * LLM chat summarization (tier3) is replaced by structured disk snapshots for research runs —
 * higher quality because data comes from authoritative artifacts, not lossy paraphrase.
 */

import * as fs from 'fs'
import * as path from 'path'
import { corpusStats, loadCorpus } from './corpus'
import { evidenceStats, loadEvidence } from './evidence'
import { parsePlan, planProgress, type PlanItem } from './planner'
import { latestQualityGateFailure, readQualityGateSnapshot } from './quality-gates'
import {
  extractResearchOutputDirFromMessages,
  extractResearchOutputDirFromText,
  findLatestResearchRunDir,
  isCompactResumeMessage,
  isResearchResumeMessage,
} from './research-resume'
import { ensureResearchRunSpec, formatWorkflowGuidance, detectDataGatheringStall, formatDataStallDirective } from './research-workflow'
import { resolveResearchDir } from '../research-paths'
import { normalizeAllowedSearchTools, filterToolNamesByPolicy, searchSourceLabel } from '../search-sources'

export type ResearchContextMode = 'off' | 'active' | 'resume'

export const RESEARCH_CONTEXT_TOOLS = new Set([
  'plan_research',
  'build_corpus',
  'screen_corpus',
  'list_corpus',
  'list_selected_corpus',
  'assign_corpus_to_plan',
  'queue_full_text',
  'read_full_text_batch',
  'read_corpus_item',
  'full_text_status',
  'record_evidence',
  'list_evidence',
  'extract_evidence_from_corpus_item',
  'repair_evidence_quotes',
  'verify_claims',
  'run_quality_gates',
  'gate_report',
  'generate_evidence_report',
  'audit_research_run',
  'search_arxiv',
  'search_openalex',
  'search_huggingface_papers',
  'search_web',
])

const RESEARCH_STATE_MARKER = '\n\n## Research state (authoritative — reload detail via tools)\n'
const RUN_STATE_FILE = 'run-state.json'

export interface ResearchRunState {
  outputDir: string
  phase: 'started' | 'planning' | 'corpus' | 'evidence' | 'gates_failed' | 'gates_passed' | 'report_generated' | 'blocked'
  topic?: string
  lastTool?: string
  gatesPassed?: number
  gatesTotal?: number
  updatedAt: number
}

export function resolveResearchContextMode(opts: {
  userMessage: string
  presetId?: string
  outputDir?: string | null
}): ResearchContextMode {
  if (isResearchResumeMessage(opts.userMessage)) return 'resume'
  // Managed deep-research turns on ONLY when a concrete run directory is in play (kickoff from the
  // New Research dialog, an explicit `.research/` reference, or an active session's history). A
  // globally-saved `deep-research` preset must NOT flip unrelated chats into a managed run — that
  // (together with the run-dir fallback) is what hijacked plain requests like "напиши проект по RL".
  if (opts.outputDir) return 'active'
  return 'off'
}

export function resolveResearchOutputDir(
  workspace: string,
  messages: Array<{ role?: string; content?: string }>,
  currentMessage?: string,
): string | null {
  // Explicit, session-scoped signals only: a run dir named in THIS turn (the New Research kickoff
  // message, or a pasted `.research/...` path) or in a USER-authored message of this session.
  //
  // Crucially we scan ONLY user-role messages. Scanning every role also matched `.research/...`
  // paths that the model itself produced in tool calls/results, which silently promoted an
  // ordinary chat (e.g. "build an MCTS AlphaZero") into the guarded deep-research workflow the
  // moment the model called build_corpus/search with an output_dir. Managed mode must reflect the
  // user's explicit intent, never the model's spontaneous tool use.
  const userMessages = messages.filter((m) => m.role === 'user')
  const explicit = extractResearchOutputDirFromText(currentMessage ?? '')
    || extractResearchOutputDirFromMessages(userMessages)
  if (explicit) return explicit
  // The workspace-global "last run" pointers (run-state.json / newest .research dir) are NOT
  // session-scoped. Using them unconditionally made every brand-new, unrelated chat (e.g.
  // "напиши проект по RL") silently inherit the previous deep-research run and try to "finish" it.
  // Only consult them when the user EXPLICITLY asks to continue/resume research.
  if (isResearchResumeMessage(currentMessage ?? '')) {
    return readResearchRunState(workspace)?.outputDir || findLatestResearchRunDir(workspace)
  }
  return null
}

function runStatePath(workspace: string): string {
  return path.join(workspace, '.research', RUN_STATE_FILE)
}

export function readResearchRunState(workspace: string): ResearchRunState | null {
  const p = runStatePath(workspace)
  if (!fs.existsSync(p)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as ResearchRunState
    if (!raw?.outputDir) return null
    return raw
  } catch {
    return null
  }
}

export function updateResearchRunState(workspace: string, patch: Partial<ResearchRunState> & { outputDir: string }): ResearchRunState {
  const prev = readResearchRunState(workspace)
  // IMPORTANT: this function tracks only the coarse UI "phase" in run-state.json. It must
  // NOT write the authoritative workflow `state` into the run spec. That state is owned
  // exclusively by updateResearchWorkflowAfterTool (which infers it from disk). The old
  // phase→state mapping here was lossy — e.g. every corpus-phase tool (screen_corpus,
  // read_full_text_batch, assign_corpus_to_plan…) forced state back to CORPUS_READY,
  // clobbering EVIDENCE/GATES_FAILED and making the "Research state" tail contradict its own
  // blockers/hints (allowed tools without run_quality_gates while gates were failing).
  ensureResearchRunSpec(workspace, patch.outputDir, {
    topic: patch.topic,
    lastTool: patch.lastTool,
  })
  const next: ResearchRunState = {
    outputDir: patch.outputDir,
    phase: patch.phase ?? prev?.phase ?? 'started',
    topic: patch.topic ?? prev?.topic,
    lastTool: patch.lastTool ?? prev?.lastTool,
    gatesPassed: patch.gatesPassed ?? prev?.gatesPassed,
    gatesTotal: patch.gatesTotal ?? prev?.gatesTotal,
    updatedAt: Date.now(),
  }
  const p = runStatePath(workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  return next
}

function flattenPlan(items: PlanItem[]): PlanItem[] {
  const out: PlanItem[] = []
  const walk = (list: PlanItem[]) => {
    for (const item of list) {
      out.push(item)
      if (item.children.length) walk(item.children)
    }
  }
  walk(items)
  return out
}

function pendingPlanItems(plan: PlanItem[], limit = 6): PlanItem[] {
  return flattenPlan(plan).filter((p) => !p.done).slice(0, limit)
}

function recommendNextSteps(
  workspace: string,
  outputDir: string,
  stats: ReturnType<typeof corpusStats>,
  evidence: ReturnType<typeof evidenceStats>,
  blockers: string | null,
  reportExists: boolean,
): string[] {
  const steps: string[] = []
  const selected = loadCorpus(workspace, outputDir).filter((e) => e.screeningStatus === 'selected')
  const failedSelected = selected.filter((e) => e.readStatus === 'failed')
  const unreadSelected = selected.filter((e) => e.readStatus !== 'read' && e.status !== 'read' && e.readStatus !== 'failed')
  if (failedSelected.length > 0) {
    steps.push(`Treat ${failedSelected.length} failed full-text read(s) as unavailable after one concrete retry/status check; do not keep retrying non-retriable HTTP failures.`)
  }
  if (unreadSelected.length > 0) {
    steps.push(`Read ${unreadSelected.length} selected corpus item(s) still pending — read_full_text_batch or read_corpus_item.`)
  }
  if (stats.selectedReviewLike < 2 && stats.selected > 5) {
    steps.push('Ensure at least 2 review/survey papers in selected corpus (screen_corpus / build_corpus).')
  }
  if (evidence.needsReview > 0 || evidence.contested > 0) {
    steps.push(`Review ${evidence.needsReview + evidence.contested} evidence claim(s) — verify_claims, then fix or downgrade.`)
  }
  const gateSnap = readQualityGateSnapshot(workspace, outputDir)
  const onlyReportStructureFailed = Boolean(
    gateSnap && gateSnap.failed.length > 0 && gateSnap.failed.every((r) => r.gate === 'final_report_structure'),
  )

  if (onlyReportStructureFailed) {
    steps.push('Regenerate report.md with generate_evidence_report; data gates are ready but final_report_structure failed.')
  } else if (blockers) {
    if (/quote|citation|цит/i.test(blockers)) {
      steps.push('Repair missing evidence quotes/citation coverage with repair_evidence_quotes, then verify_claims and run_quality_gates again.')
    } else {
      steps.push('Fix quality gate blockers, then run_quality_gates again.')
    }
  } else if (!reportExists && evidence.supported >= 3) {
    steps.push('Quality gates may be ready — run_quality_gates, then generate_evidence_report.')
  } else if (!reportExists) {
    steps.push('Continue record_evidence for open plan items, then run_quality_gates.')
  } else {
    steps.push('Verify report.md quality; regenerate via generate_evidence_report if gates pass.')
  }
  return steps.slice(0, 5)
}

/** Structured snapshot from .research/ — injected into system prompt instead of LLM chat summary. */
/**
 * The single most important thing to do next, as one imperative sentence. Elevated to the
 * top of the research-state block so the model never has to infer it from many sections.
 * Priority order mirrors the workflow: finish if done → fix gate blockers → read pending →
 * extract from what read → run gates → recover from a data stall → build/search.
 */
export function primaryNextAction(a: {
  state: string
  reportExists: boolean
  blockers: string | null
  selectedRead: number
  unreadSelected: number
  failedSelected: number
  evidenceSupported: number
  stalled: boolean
  researchKind: string
  corpusTotal: number
  gatheredSources: number
}): string {
  const failedNote = a.failedSelected > 0
    ? ` The ${a.failedSelected} source(s) that failed to fetch are UNAVAILABLE — do not retry them.`
    : ''
  if (a.reportExists && !a.blockers) {
    return 'The run is complete — report.md exists and gates are satisfied. Give the user a short final summary and stop; do not call more tools.'
  }
  if (a.blockers) {
    if (/quote|citation|цит/i.test(a.blockers)) {
      return 'Repair missing evidence quotes/citations with repair_evidence_quotes, then run_quality_gates once.'
    }
    if (/evidence row|needs selected\+read|per section|plan item|only \d+\/|Q\d+:/i.test(a.blockers)) {
      return 'Some plan subtopics are short on evidence. The blocker below lists EACH short subtopic with the exact source IDs to use — go through them ALL: for each, call extract_evidence_from_corpus_item on the already-read source(s) named for it (read them first if it says "not read"). Extract the missing claim(s) for every listed subtopic, not just one, then run_quality_gates once. If a subtopic genuinely has no source that supports it, do NOT pad or fake it, and never call update_plan_status to satisfy this gate — just run_quality_gates and it will be downgraded to a documented limitation.'
    }
    return 'Fix the failing quality-gate blocker(s) listed below with the recommended repair tool, then run_quality_gates once.'
  }
  // Discovery not yet folded into a corpus.
  if (a.corpusTotal === 0 && a.gatheredSources > 0) {
    return 'Call build_corpus now to turn the sources you already gathered into the corpus, then screen_corpus. Do not search again.'
  }
  if (a.corpusTotal === 0) {
    return 'Run one focused search for the topic, then build_corpus + screen_corpus.'
  }
  if (a.unreadSelected > 0) {
    return `Read the ${a.unreadSelected} selected source(s) not yet read: call read_full_text_batch now.${failedNote}`
  }
  // Everything selected is read-or-failed. Move forward from what actually read.
  if (a.selectedRead > 0 && a.evidenceSupported < 3) {
    return `Extract evidence for the open plan items from the ${a.selectedRead} source(s) that read successfully: extract_evidence_from_corpus_item / record_evidence.${failedNote}`
  }
  if (a.evidenceSupported >= 1 && a.unreadSelected === 0) {
    return 'Call run_quality_gates once now — it auto-generates report.md when gates pass. Do not gather more first.'
  }
  if (a.stalled) {
    return a.researchKind === 'general'
      ? `Too few reachable sources read. Run ONE new web search (search_web) with different phrasing for reachable pages, then build_corpus + screen_corpus. If you already retried, extract snippet-based evidence from what you have and call run_quality_gates to finish honestly.${failedNote}`
      : `Too few reachable sources read. Run ONE new search (search_openalex/search_arxiv) for open-access, fetchable papers, then build_corpus + screen_corpus. If you already retried twice, call run_quality_gates to finish honestly with a documented data-availability limitation.${failedNote}`
  }
  return 'Follow the Allowed next tools below: read selected sources, extract evidence, then run_quality_gates.'
}

export function buildResearchWorkingSet(workspace: string, outputDir: string, maxChars = 6000, gatheredSources = 0): string {
  const abs = resolveResearchDir(workspace, outputDir)
  if (!fs.existsSync(abs)) return ''
  const spec = ensureResearchRunSpec(workspace, outputDir)

  const stats = corpusStats(workspace, outputDir)
  const evidence = evidenceStats(workspace, outputDir)
  const plan = parsePlan(workspace, outputDir)
  const progress = planProgress(plan)
  const blockers = latestQualityGateFailure(workspace, outputDir)
  const reportExists = fs.existsSync(path.join(abs, 'report.md'))
  const pending = pendingPlanItems(plan)

  const corpus = loadCorpus(workspace, outputDir)
  const failedReads = corpus
    .filter((e) => e.screeningStatus === 'selected' && e.readStatus === 'failed')
    .slice(0, 5)
    .map((e) => `${e.id}: ${e.title.slice(0, 60)}${e.readReason ? ` (${e.readReason.slice(0, 40)})` : ''}`)

  const selectedCorpus = corpus.filter((e) => e.screeningStatus === 'selected')
  const failedSelectedCount = selectedCorpus.filter((e) => e.readStatus === 'failed').length
  const unreadSelectedCount = selectedCorpus.filter((e) => e.readStatus !== 'read' && e.status !== 'read' && e.readStatus !== 'failed').length
  const unreadHigh = corpus
    .filter((e) => e.screeningStatus === 'selected' && e.readStatus !== 'read' && e.readStatus !== 'failed')
    .sort((a, b) => (b.readPriority === 'high' ? 1 : 0) - (a.readPriority === 'high' ? 1 : 0))
    .slice(0, 5)
    .map((e) => `${e.id}: ${e.title.slice(0, 55)}`)

  const claims = loadEvidence(workspace, outputDir)
  const recentClaims = claims.slice(-6).map((c) => `${c.id}: [${c.status}] ${c.claim.slice(0, 72)}…`)

  const nextSteps = recommendNextSteps(workspace, outputDir, stats, evidence, blockers, reportExists)

  // Detect a "system can't gather data" stall and, if present, surface recovery
  // tools + a strong directive so the agent escapes the reading dead-end instead
  // of looping on failing fetches.
  const th = (spec.thresholds || {}) as Record<string, number | boolean | string>
  const target = Number(th.minFullTextReads) || Number(th.minSelected) || 5
  const stall = detectDataGatheringStall({
    state: spec.state,
    reportExists,
    totalCorpus: stats.total,
    selected: stats.selected,
    selectedRead: stats.selectedRead,
    failedReads: stats.failed,
    evidenceTotal: evidence.total,
    target,
  })
  const allowedForDisplayRaw = stall.stalled
    ? [...new Set([...spec.allowedActions, ...stall.recoveryActions])]
    : spec.allowedActions
  // Honor an active source restriction: never suggest a search engine the run is not
  // allowed to use (the model can't call it anyway — this keeps guidance consistent).
  const searchPolicy = normalizeAllowedSearchTools(spec.allowedSearchTools)
  const allowedForDisplay = filterToolNamesByPolicy(allowedForDisplayRaw, searchPolicy)

  // ONE authoritative next action, elevated to the very top. The state block has many
  // sections and (on a stall) a long allowed-tools list, which caused decision paralysis:
  // the model fell back to always-available read-only inspection tools (list_corpus /
  // list_selected_corpus) and looped without ever advancing. A single imperative removes the
  // ambiguity about what to do RIGHT NOW.
  const nextAction = primaryNextAction({
    state: spec.state,
    reportExists,
    blockers,
    selectedRead: stats.selectedRead,
    unreadSelected: unreadSelectedCount,
    failedSelected: failedSelectedCount,
    evidenceSupported: evidence.supported,
    stalled: stall.stalled,
    researchKind: String(th.researchKind || 'academic'),
    corpusTotal: stats.total,
    gatheredSources,
  })

  const lines = [
    RESEARCH_STATE_MARKER.trim(),
    '',
    `**➡ NEXT ACTION:** ${nextAction}`,
    '**Do NOT** call read-only inspection tools (list_corpus, list_selected_corpus, full_text_status, list_evidence) to decide what to do — they never change state and re-calling them is a wasted step. Act on NEXT ACTION.',
    '',
    `**Run directory:** \`${outputDir}\``,
    `**Workflow state:** ${spec.state}`,
    `**Allowed next tools:** ${allowedForDisplay.join(', ') || 'none'}`,
    `**Plan:** ${progress.done}/${progress.total} complete (${progress.pct}%)`,
  ]

  if (searchPolicy) {
    lines.push(
      `**🔒 Source restriction:** this run may ONLY discover sources via ${searchPolicy.map((id) => `\`${id}\` (${searchSourceLabel(id)})`).join(', ')}. Do NOT use any other search engine. If coverage is thin, broaden queries and shift the date window WITHIN these sources.`,
    )
  }

  // Discovery → corpus handoff: search hits live in the session tracker, not on disk,
  // so corpus.jsonl stays empty (and the state stays PLANNED) until build_corpus runs.
  // Without this signal the model only sees "corpus: 0" and keeps re-searching the same
  // queries forever. Make the next step explicit once sources have been gathered.
  if (stats.total === 0 && gatheredSources > 0) {
    lines.push(
      '',
      `⚠️ DISCOVERY DONE: ${gatheredSources} source(s) already gathered from searches, but the corpus is still empty (build_corpus has not run yet).`,
      '→ Call `build_corpus` NOW to rank these gathered sources into corpus.jsonl, then `screen_corpus`. Do NOT keep searching: re-running the same queries returns cached, identical results and adds nothing. Search again only for a genuinely NEW, specific gap.',
    )
  }

  if (stall.stalled) {
    lines.push('', ...formatDataStallDirective(stall.reason, String(th.researchKind || 'academic')).split('\n'))
  }

  if (pending.length) {
    lines.push('**Open plan items:**')
    for (const p of pending) lines.push(`- [ ] ${p.id}: ${p.text.slice(0, 120)}`)
  }

  lines.push(
    '',
    `**Corpus:** ${stats.selected} selected · ${stats.selectedRead} read · ${failedSelectedCount} failed/unavailable · ${unreadSelectedCount} pending unread`,
    `**Evidence:** ${evidence.total} total · ${evidence.supported} supported · ${evidence.needsReview} needs_review · ${evidence.contested} contested`,
    reportExists ? '**report.md:** exists' : '**report.md:** not yet generated',
  )

  if (failedReads.length) {
    lines.push('**Failed reads:**', ...failedReads.map((l) => `- ${l}`))
  }
  if (unreadHigh.length) {
    lines.push('**Unread selected (priority):**', ...unreadHigh.map((l) => `- ${l}`))
  }
  if (recentClaims.length) {
    lines.push('**Recent evidence IDs:**', ...recentClaims.map((l) => `- ${l}`))
  }
  if (blockers) {
    lines.push('', '**Quality gate blockers:**', ...blockers.split('\n').slice(0, 8).map((b) => `- ${b}`))
  } else if (fs.existsSync(path.join(abs, 'quality-gates.json'))) {
    lines.push('', '**Quality gates:** last run passed.')
  }

  lines.push('', '**Diagnostic hints (secondary; obey Allowed next tools first):**')
  for (let i = 0; i < nextSteps.length; i++) lines.push(`${i + 1}. ${nextSteps[i]}`)
  lines.push('', '**Workflow guidance:**', ...formatWorkflowGuidance(spec).split('\n').map((l) => `- ${l}`))

  lines.push(
    '',
    '**Pipeline invariant:** final `report.md` must be created or repaired only via `generate_evidence_report`. Never use `write_file`, `edit_file`, `append_file`, or `generate_report` for managed research `report.md`.',
    '**When blocked:** choose the repair tool for the failing gate; do not discuss bypasses or alternative report-writing strategies.',
    '**Authoritative files:** corpus.jsonl, evidence.jsonl, plan.md, quality-gates.json in run directory.',
    '**Reload detail:** list_selected_corpus, list_evidence, full_text_status, verify_claims — do not rely on truncated chat tool output.',
  )

  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 20) + '\n…[truncated working set]'
  }
  return text
}

export function stripResearchWorkingSet(systemContent: string): string {
  const idx = systemContent.indexOf(RESEARCH_STATE_MARKER)
  if (idx >= 0) return systemContent.slice(0, idx)
  return systemContent
}

export interface ContextMessage {
  role?: string
  content?: string
}

export function injectResearchWorkingSet<M extends ContextMessage>(
  msgs: M[],
  workspace: string,
  outputDir: string,
  maxChars?: number,
): M[] {
  const block = buildResearchWorkingSet(workspace, outputDir, maxChars)
  if (!block) return msgs

  const result = [...msgs]
  const sysIdx = result.findIndex((m) => m.role === 'system')
  if (sysIdx < 0) return msgs

  const base = stripResearchWorkingSet(String(result[sysIdx].content ?? ''))
  result[sysIdx] = { ...result[sysIdx], content: base + '\n\n' + block }
  return result
}

/**
 * Build the research working set as a transient TAIL message.
 *
 * Prefix-cache discipline: the system prompt and conversation history are kept
 * stable (append-only) so llama-server reuses its KV cache / context checkpoints.
 * The volatile disk-backed state snapshot is therefore delivered as the very last
 * user message at call time and is NOT persisted into the stored conversation.
 */
export function buildResearchTailMessage(
  workspace: string,
  outputDir: string,
  maxChars?: number,
  gatheredSources = 0,
): ContextMessage | null {
  const block = buildResearchWorkingSet(workspace, outputDir, maxChars, gatheredSources)
  if (!block) return null
  return { role: 'user', content: block }
}

/** Lossless-enough compression: keep IDs, counts, blockers — drop bulk listings. */
export function compressResearchToolResult(toolName: string, result: string, maxChars: number): string {
  if (result.length <= maxChars) return result
  if (result.startsWith('Error')) return result.slice(0, maxChars)

  const header = result.split('\n').slice(0, 3).join('\n')
  const outputDirMatch = result.match(/(\.research\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[^\s"'`]+)/)
  const outputHint = outputDirMatch ? `\n[Full data: ${outputDirMatch[1]} on disk]` : ''
  const reloadHint = `\n[Use ${suggestReloadTool(toolName)} for full detail — chat context keeps summary only.]`

  switch (toolName) {
    case 'build_corpus':
    case 'screen_corpus':
    case 'list_corpus':
    case 'list_selected_corpus': {
      const count = (result.match(/^- /gm) || []).length
      return `${header}\n…[${count} corpus rows; bulk omitted]${outputHint}${reloadHint}`.slice(0, maxChars)
    }
    case 'record_evidence':
    case 'list_evidence':
    case 'verify_claims':
    case 'repair_evidence_quotes':
    case 'extract_evidence_from_corpus_item': {
      const claims = (result.match(/^[A-Z]-[a-f0-9]+|^-\s+[A-Z]-/gm) || []).length
      return `${header}\n…[${claims || 'multiple'} evidence entries; use list_evidence / verify_claims]${outputHint}${reloadHint}`.slice(0, maxChars)
    }
    case 'run_quality_gates':
    case 'gate_report': {
      const blockers = result.includes('blocker') || result.includes('FAIL') || result.includes('failed')
      const pass = result.includes('passed') || result.includes('PASS') || result.includes('13/13')
      return `${header}\n…[gates: ${pass ? 'check output above' : blockers ? 'has blockers' : 'see quality-gates.json'}]${outputHint}${reloadHint}`.slice(0, maxChars)
    }
    case 'read_corpus_item':
    case 'read_full_text_batch':
    case 'read_file': {
      const lines = result.split('\n')
      if (lines.length <= 12) return result.slice(0, maxChars)
      const head = lines.slice(0, 6).join('\n')
      const tail = lines.slice(-4).join('\n')
      return `${head}\n…[${lines.length} lines — use read_corpus_item with offset for sections]…\n${tail}${reloadHint}`.slice(0, maxChars)
    }
    case 'search_arxiv':
    case 'search_openalex':
    case 'search_huggingface_papers':
    case 'search_web': {
      const entries = result.split('\n').filter((l) => l.trim().startsWith('-') || /^\d+\./.test(l.trim()))
      const kept = entries.slice(0, 8).join('\n')
      return `${header}\n${kept}\n…[${Math.max(0, entries.length - 8)} more results omitted]${reloadHint}`.slice(0, maxChars)
    }
    default:
      return result.slice(0, maxChars - 60) + `\n…[truncated]${reloadHint}`
  }
}

function suggestReloadTool(toolName: string): string {
  const map: Record<string, string> = {
    build_corpus: 'list_selected_corpus',
    screen_corpus: 'list_selected_corpus',
    list_corpus: 'list_selected_corpus',
    list_selected_corpus: 'read_corpus_item',
    record_evidence: 'list_evidence',
    list_evidence: 'verify_claims',
    verify_claims: 'verify_claims',
    repair_evidence_quotes: 'verify_claims',
    run_quality_gates: 'run_quality_gates',
    gate_report: 'gate_report',
    read_corpus_item: 'read_corpus_item',
    read_full_text_batch: 'full_text_status',
  }
  return map[toolName] ?? 'list_evidence or list_selected_corpus'
}

export function isResearchContextTool(toolName: string): boolean {
  return RESEARCH_CONTEXT_TOOLS.has(toolName)
}

export function wantsCompactContext(userMessage: string): boolean {
  return isCompactResumeMessage(userMessage)
}

/** Build initial message window for resume — disk-backed, minimal chat noise. */
export function buildResumeMessageWindow(
  systemPrompt: string,
  workspace: string,
  outputDir: string,
  userBrief: string,
  userMessage: string,
  _maxWorkingSetChars = 5500,
): ContextMessage[] {
  // System prompt is kept frozen (stable prefix). The dynamic disk-backed state
  // snapshot is injected as a transient tail message by the agent loop instead.
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userBrief },
    { role: 'user', content: userMessage },
  ]
}
