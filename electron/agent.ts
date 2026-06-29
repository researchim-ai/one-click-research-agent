import { getBuiltinToolDefinitions, executeTool, executeToolAsync, executeCustomTool, isAsyncTool } from './tools'
import type { AgentEvent, AgentActivity } from './types'
import type { AppConfig } from './config'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getWebSearchStatus } from './searxng'
import { getResearchPresetById } from '../research-presets'
import { formatResearchProfileForPrompt, getResearchProfileByPresetId } from '../research-profiles'
import { getSourceTracker, extractSourcesFromToolResult } from './sources'
import { getCorpusSelection } from './corpus'
import { loadPriorKnowledge } from './memory'
import { skillPackForPreset } from './research-skills'
import { resolveResearchDir } from '../research-paths'
import {
  decideResearchCommandIntent,
  isResearchResumeMessage,
  researchRunProgressSummary,
} from './research-resume'
import {
  formatQualityGateUserStatus,
  readQualityGateSnapshot,
} from './quality-gates'
import { parsePlan } from './planner'
import {
  type ResearchContextMode,
  buildResearchTailMessage,
  buildResumeMessageWindow,
  compressResearchToolResult,
  isResearchContextTool,
  resolveResearchContextMode,
  resolveResearchOutputDir,
  updateResearchRunState,
  wantsCompactContext,
} from './research-context'
import { ensureResearchRunSpec, formatWorkflowGuidance, updateResearchWorkflowAfterTool, formatDataStallDirective } from './research-workflow'
import { extractTextToolCalls } from './tool-call-parser'

// Bridge: main process implements with Electron/win; worker implements with postMessage.
export interface AgentBridge {
  emit(event: AgentEvent): void
  requestApproval(toolName: string, args: Record<string, any>): Promise<boolean>
  getConfig(): AppConfig
  getSession(): Session
  saveSession(session: Session): void
  getApiUrl(): string
  getCtxSize(): number
  setCtxSize(n: number): void
  queryActualCtxSize(): Promise<void>
  isCancelRequested(): boolean
  notifyWorkspaceChanged(): void
}

// ---------------------------------------------------------------------------
// Debug logging — writes to ~/.one-click-agent/agent-debug.log
// ---------------------------------------------------------------------------

const LOG_FILE = path.join(os.homedir(), '.one-click-agent', 'agent-debug.log')

function debugLog(category: string, ...args: any[]) {
  try {
    const ts = new Date().toISOString()
    const msg = args.map((a) => typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)).join(' ')
    const line = `[${ts}] [${category}] ${msg}\n`
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

const FILE_OPS_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'delete_file', 'create_directory'])
const COMMAND_TOOL = 'execute_command'
const WORKSPACE_ARTIFACT_TOOLS = new Set([
  'plan_research',
  'update_plan_status',
  'download_arxiv_html',
  'download_arxiv_pdf',
  'generate_report',
  'export_report',
  'screenshot_page',
  'build_corpus',
  'queue_full_text',
  'audit_research_run',
  'screen_corpus',
  'reject_corpus_items',
  'assign_corpus_to_plan',
  'read_corpus_item',
  'read_full_text_batch',
  'record_evidence',
  'extract_evidence_from_corpus_item',
  'repair_evidence_quotes',
  'run_quality_gates',
  'generate_evidence_report',
  'scout_ideas',
  'save_idea',
])

const FALLBACK_CTX_TOKENS = 32768
const SUMMARIZE_TIMEOUT_MS = 20000

/** Research context policy for the current runAgent invocation. */
let researchContextMode: ResearchContextMode = 'off'
let activeResearchOutputDir: string | null = null
let activeWorkspace: string | null = null

let currentBridge: AgentBridge | null = null

// Per-run durable trace of the model's reasoning chain + actions. The live UI only
// streams 'thinking' transiently and the debug log keeps short previews, so a failed or
// looping research run cannot be reconstructed afterwards. When a managed run is active
// we append reasoning, tool calls/results, status and errors to reasoning-trace.jsonl
// inside the run directory so we can diagnose exactly what the model did and why.
const TRACE_EVENT_TYPES = new Set(['thinking', 'tool_call', 'tool_result', 'status', 'error', 'response'])
function appendRunReasoningTrace(e: AgentEvent): void {
  if (!activeResearchOutputDir || !activeWorkspace) return
  if (!TRACE_EVENT_TYPES.has((e as any).type)) return
  try {
    const dir = resolveResearchDir(activeWorkspace, activeResearchOutputDir)
    const anyE = e as any
    const entry: Record<string, any> = { at: new Date().toISOString(), type: anyE.type }
    if (typeof anyE.content === 'string' && anyE.content.length) entry.content = anyE.content
    if (anyE.name) entry.name = anyE.name
    if (anyE.args !== undefined) entry.args = anyE.args
    if (typeof anyE.result === 'string') entry.result = anyE.result.slice(0, 4000)
    if (entry.content === undefined && entry.name === undefined && entry.result === undefined) return
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'reasoning-trace.jsonl'), JSON.stringify(entry) + '\n')
  } catch {}
}

function doEmit(e: AgentEvent): void {
  currentBridge!.emit(e)
  appendRunReasoningTrace(e)
}
function emitActivity(phase: AgentActivity['phase'], label: string, detail?: string): void {
  doEmit({ type: 'agent_activity', activity: { phase, label, detail } })
}

/**
 * After screening/assignment, surface the currently-selected sources to the UI as a
 * NON-BLOCKING review panel. The run keeps going; the user can prune or restore sources
 * via an IPC that toggles screeningStatus. We never pause for this.
 */
function maybeEmitCorpusSelection(toolName: string, result: string, workspace: string): void {
  if (toolName !== 'screen_corpus' && toolName !== 'assign_corpus_to_plan') return
  if (/^error/i.test(String(result || '').trim())) return
  const outputDir = activeResearchOutputDir ?? undefined
  try {
    const items = getCorpusSelection(workspace, outputDir)
    if (items.length > 0) {
      doEmit({ type: 'corpus_selection', corpusSelection: { outputDir: outputDir ?? '', items } })
    }
  } catch {}
}
function doRequestApproval(name: string, args: Record<string, any>): Promise<boolean> { return currentBridge!.requestApproval(name, args) }
function doGetConfig(): AppConfig { return currentBridge!.getConfig() }
function doGetSession(): Session { return currentBridge!.getSession() }
function doSaveSession(s: Session): void { currentBridge!.saveSession(s) }
function doGetApiUrl(): string { return currentBridge!.getApiUrl() }
function doGetCtxSize(): number { return currentBridge!.getCtxSize() }
function doSetCtxSize(n: number): void { currentBridge!.setCtxSize(n) }
function doQueryActualCtxSize(): Promise<void> { return currentBridge!.queryActualCtxSize() }
function doIsCancelRequested(): boolean { return currentBridge!.isCancelRequested() }

function getMaxIterations(): number { return doGetConfig().maxIterations || 200 }
function getBaseTemperature(): number { return doGetConfig().temperature ?? 0.3 }
function getIdleTimeoutMs(): number { return (doGetConfig().idleTimeoutSec || 60) * 1000 }
function getMaxEmptyRetries(): number { return doGetConfig().maxEmptyRetries || 3 }
/** Whether this tool requires user approval given current config (file ops vs commands split). */
function needsApprovalForTool(toolName: string, isCustom: boolean): boolean {
  const cfg = doGetConfig()
  if (isCustom) return (cfg.approvalForFileOps ?? true) || (cfg.approvalForCommands ?? true)
  if (FILE_OPS_TOOLS.has(toolName)) return cfg.approvalForFileOps ?? true
  if (toolName === COMMAND_TOOL) return cfg.approvalForCommands ?? true
  return false
}

function shouldNotifyWorkspaceChanged(toolName: string, isCustom: boolean, result: string): boolean {
  if (result.startsWith('[Denied')) return false
  if (isCustom || toolName === COMMAND_TOOL) return true
  if (FILE_OPS_TOOLS.has(toolName)) return !result.startsWith('Error')
  if (WORKSPACE_ARTIFACT_TOOLS.has(toolName)) return !result.startsWith('Error')
  return false
}

function getGeneratedReportPath(result: string, workspace: string): string | null {
  const rel = result.match(/^Report saved to (.+?) \(/m)?.[1]?.trim()
  if (!rel) return null
  const resolved = path.resolve(workspace, rel)
  const root = path.resolve(workspace)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null
  return resolved
}

function researchTitleFromOutputDir(outputDir: string): string {
  const slug = outputDir.replace(/^\.research\//, '').replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, '').replace(/-/g, ' ')
  return slug.slice(0, 120) || 'Research Report'
}

function isPlanApprovalMessage(text: string): boolean {
  const t = String(text || '').trim().toLowerCase()
  return /^(дела[йе]?|сделай|давай|ок|окей|поехали|начинай|продолжай|утверждаю|утвердить|согласен|go|start|approved?|continue)\b/.test(t)
}

function hasRecentPlanApprovalPrompt(messages: Message[]): boolean {
  return messages.slice(-8).some((m: any) => {
    if (m.role !== 'assistant' || typeof m.content !== 'string') return false
    const t = m.content.toLowerCase()
    return /утверд|approve|approval|перейти к поиску|жду вашего решения|что вы хотите сделать|редактировать/.test(t)
      && /план|plan|подзадач|research/.test(t)
  })
}

function hasPlanCheckpointRequest(messages: Message[]): boolean {
  return messages.slice(-12).some((m: any) => {
    if (m.role !== 'user' || typeof m.content !== 'string') return false
    const t = m.content.toLowerCase()
    return /checkpoint\s*:\s*plan|user-review checkpoints:[\s\S]*-\s*plan:|checkpoints?:[\s\S]*\bplan\b|останов(и|иться)[\s\S]*план|утверд(ить|ите)[\s\S]*план/.test(t)
  })
}

function formatPlanCheckpoint(workspacePath: string, outputDir: string | undefined): string {
  const plan = parsePlan(workspacePath, outputDir)
  const lines = [
    'План исследования сохранён. Вот его структура:',
    '',
    '| ID | Подвопрос | Статус |',
    '|---|---|---|',
  ]
  if (plan.length === 0) {
    lines.push('| - | План сохранён, но пункты не распознаны. Откройте `plan.md` и проверьте структуру. | ⚠️ |')
  } else {
    for (const item of plan) {
      const text = item.text.replace(/^([QA]\d+(\.\d+)*)\.?\s*/, '')
      lines.push(`| ${item.id} | ${text} | ${item.done ? '✅' : '⬜'} |`)
    }
  }
  lines.push(
    '',
    'Что вы хотите сделать?',
    '',
    '✅ Утвердить план и перейти к поиску источников',
    '✏️ Редактировать — что добавить, убрать или изменить в подзадачах?',
    '📝 Расширить/сузить — нужны ли дополнительные или fewer подзадачи?',
    '',
    'Жду вашего решения.',
  )
  return lines.join('\n')
}

function phaseForResearchTool(toolName: string): Parameters<typeof updateResearchRunState>[1]['phase'] | undefined {
  if (toolName === 'plan_research' || toolName === 'update_plan_status') return 'planning'
  if (['build_corpus', 'screen_corpus', 'assign_corpus_to_plan', 'queue_full_text', 'read_corpus_item', 'read_full_text_batch'].includes(toolName)) return 'corpus'
  if (['record_evidence', 'extract_evidence_from_corpus_item', 'extract_evidence_batch', 'repair_evidence_quotes', 'verify_claims'].includes(toolName)) return 'evidence'
  if (toolName === 'generate_evidence_report') return 'report_generated'
  return undefined
}

/** After gate_report / run_quality_gates: explain status to user; auto-generate report when all gates pass. */
function followUpQualityGates(
  toolName: string,
  toolArgs: Record<string, any>,
  result: string,
  session: Session,
  workspace: string,
): string {
  if (toolName !== 'gate_report' && toolName !== 'run_quality_gates') return result
  if (result.startsWith('Error')) return result

  const outputDir = toolArgs.output_dir ? String(toolArgs.output_dir).replace(/\\/g, '/') : activeResearchOutputDir
  if (!outputDir) return result

  const userStatus = formatQualityGateUserStatus(workspace, outputDir, doGetConfig().appLanguage ?? 'ru')
  if (userStatus) doEmit({ type: 'status', content: userStatus })

  const snap = readQualityGateSnapshot(workspace, outputDir)
  const onlyReportStructureFailed = Boolean(
    snap && snap.failed.length > 0 && snap.failed.every((r) => r.gate === 'final_report_structure'),
  )
  if (!snap) return result
  if (!snap.allPassed && !onlyReportStructureFailed) {
    const spec = updateResearchWorkflowAfterTool(workspace, outputDir, toolName, { gateResults: snap.failed })
    const failed = snap.failed.map((r) => `- ${r.gate}: ${r.blockers.join('; ') || 'failed'}`).join('\n')
    return `${result}\n\n[Research supervisor — mandatory next action]\nQuality gates are NOT complete. Do not produce a final answer, do not discuss shortcuts, and do not attempt to write report.md manually.\n\nFix these blockers first:\n${failed}\n\n${formatWorkflowGuidance(spec)}\n\nCall one allowed repair tool now with the same output_dir. After repairs, run run_quality_gates exactly once. Only generate_evidence_report may create report.md.`
  }

  updateResearchWorkflowAfterTool(workspace, outputDir, toolName, { gateResults: snap.failed })

  doEmit({
    type: 'status',
    content: onlyReportStructureFailed
      ? '📝 Данные прошли gates; текущий report.md плохой — регенерирую narrative report.md…'
      : '📝 Все gates пройдены — генерирую report.md…',
  })
  emitActivity('tool_exec', 'generate_evidence_report', outputDir)
  try {
    const genResult = executeTool('generate_evidence_report', {
      output_dir: outputDir,
      title: researchTitleFromOutputDir(outputDir),
      output_path: `${outputDir}/report.md`,
      session_id: session.id,
      report_language: doGetConfig().appLanguage ?? 'ru',
    }, workspace)
    doEmit({ type: 'tool_call', name: 'generate_evidence_report', args: { output_dir: outputDir } })
    doEmit({ type: 'tool_result', name: 'generate_evidence_report', result: genResult.slice(0, 4000) })
    const reportPath = getGeneratedReportPath(genResult, workspace)
    if (reportPath) {
      doEmit({ type: 'open_file', filePath: reportPath })
      doEmit({ type: 'status', content: `✅ Отчёт готов: \`${path.relative(workspace, reportPath)}\` — открываю в редакторе.` })
      updateResearchRunState(workspace, {
        outputDir,
        phase: 'report_generated',
        lastTool: 'generate_evidence_report',
      })
      updateResearchWorkflowAfterTool(workspace, outputDir, 'generate_evidence_report')
    } else if (genResult.startsWith('Error')) {
      doEmit({ type: 'status', content: `⚠ ${genResult.slice(0, 600)}` })
    }

    const verifyArgs = {
      output_dir: outputDir,
      session_id: session.id,
      min_sources: toolArgs.min_sources,
      min_evidence: toolArgs.min_evidence,
      min_selected: toolArgs.min_selected,
      min_full_text_reads: toolArgs.min_full_text_reads,
      evidence_per_section: toolArgs.evidence_per_section,
      require_plan_completion: toolArgs.require_plan_completion,
    }
    const verifyResult = executeTool('run_quality_gates', verifyArgs, workspace)
    doEmit({ type: 'tool_call', name: 'run_quality_gates', args: verifyArgs })
    doEmit({ type: 'tool_result', name: 'run_quality_gates', result: verifyResult.slice(0, 4000) })
    const finalStatus = formatQualityGateUserStatus(workspace, outputDir, doGetConfig().appLanguage ?? 'ru')
    if (finalStatus) doEmit({ type: 'status', content: finalStatus })

    return `${result}\n\n---\n[Auto] ${genResult}\n\n---\n[Post-report verification]\n${verifyResult}`
  } catch (e: any) {
    doEmit({ type: 'status', content: `⚠ Не удалось сгенерировать report.md: ${e.message ?? e}` })
    return result
  }
}

// Graduated compression thresholds (fraction of message budget)
const COMPRESS_TOOL_RESULTS_AT = 0.35
const SUMMARIZE_AT = 0.55
const AGGRESSIVE_PRUNE_AT = 0.80
const EMERGENCY_AT = 0.92

function keepRecentTurns(): number {
  const budget = getMessageBudget()
  if (budget < 3000) return 2
  if (budget < 6000) return 3
  return 4
}

// ---------------------------------------------------------------------------
// Accurate token counting via server /tokenize endpoint (with heuristic fallback)
// ---------------------------------------------------------------------------

let tokenizeAvailable: boolean | null = null

async function countTokensViaServer(text: string): Promise<number | null> {
  if (tokenizeAvailable === false) return null
  try {
    const r = await fetch(`${doGetApiUrl()}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) { tokenizeAvailable = false; return null }
    const json = await r.json() as any
    if (Array.isArray(json.tokens)) {
      tokenizeAvailable = true
      return json.tokens.length
    }
    return null
  } catch {
    tokenizeAvailable = false
    return null
  }
}

let tokenRatioCalibrated = false
let calibratedRatio = 3.2 // chars per token, updated after first real measurement

async function calibrateTokenRatio(): Promise<void> {
  if (tokenRatioCalibrated) return
  const sample = 'Hello, I am an AI assistant. I can help you write code, debug errors, and answer questions about programming.'
  const serverCount = await countTokensViaServer(sample)
  if (serverCount && serverCount > 0) {
    calibratedRatio = sample.length / serverCount
    tokenRatioCalibrated = true
  }
}

export const DEFAULT_SYSTEM_PROMPT = `You are a local-first research agent running on an open-source model inside the user's machine. Your job is to investigate topics, inspect files, run tools when useful, synthesize findings, and produce grounded outputs without sending data to external APIs.

## Core workflow

1. **Clarify the task.** Understand whether the user wants topic research, document analysis, repository analysis, comparison, or reproduction.
2. **Explore first.** Use list_directory, read_file, and find_files to understand the available materials before making claims.
3. **Search before guessing.** Base conclusions on actual evidence from files, command results, and retrieved content.
4. **Read before editing.** If you need to create notes, scripts, or reports, inspect the surrounding files first.
5. **Use commands intentionally.** Run commands when they help inspect, reproduce, validate, or extract data. Always check exit codes and logs.
6. **Synthesize, don't just dump.** Turn raw evidence into findings, comparisons, caveats, and next steps.
7. **Avoid unnecessary mutation.** Do not modify files unless the user asks for artifacts, notes, scripts, or reproducible outputs.

## Tool usage

- **read_file**: Read documents, notes, configs, source files, logs, or generated artifacts. Use offset/limit for large files.
- **list_directory**: Understand workspace structure and find relevant folders quickly.
- **find_files**: Use type="name" for file patterns and type="content" to locate exact text or symbols.
- **search_arxiv**: Use for arXiv discovery. It supports result limits plus optional date filters and sorting.
- **search_huggingface_papers**: Use to find Hugging Face paper pages, linked GitHub repos, project pages, and paper summaries.
- **search_openalex**: Use for broader academic discovery, citation-aware paper search, venues, DOI metadata, and open-access links.
- **search_web**: Use when a SearXNG backend is configured and you need broad web results beyond arXiv, such as docs, repos, datasets, benchmarks, or project pages.
- **execute_command**: Use for reproducibility, data extraction, builds, tests, scripts, or repo inspection. Always inspect the result.
- **write_file / edit_file / append_file**: Use only when the user wants saved outputs such as notes, summaries, scripts, or fixes.
- **create_directory / delete_file**: Use sparingly and only with a clear purpose.

## Managed research contract

When the task is a managed/deep research run with a \`.research/YYYY-MM-DD_HH-MM-SS_...\` artifact directory:

1. Treat the artifact directory as the run's database. Always pass the exact \`output_dir\` to every research tool that supports it.
2. **The live "Research state" block at the END of the conversation is your single source of truth for what to do next.** It lists the current workflow state and the exact allowed next tools. Pick one allowed tool and call it — do not deliberate about alternatives.
3. Normal phase order: \`plan_research\` → discovery/search → \`build_corpus\` → \`screen_corpus\` → full-text reads → evidence extraction/recording → \`verify_claims\` / \`audit_research_run\` → \`run_quality_gates\` → \`generate_evidence_report\`.
4. The only valid way to create or repair the final \`report.md\` is \`generate_evidence_report\`. \`write_file\`, \`edit_file\`, \`append_file\`, and \`generate_report\` are blocked for managed \`report.md\` — do not attempt or discuss them.
5. If quality gates fail, follow the gate repair route shown in the live state, then run \`run_quality_gates\` once with the same \`output_dir\`. Do not discuss shortcuts.
6. Do not repeat a tool with identical arguments — its result will not change. Use \`list_evidence\` / \`verify_claims\` to check existing claims before adding new ones.
6a. \`evidence_coverage_by_plan\`, \`evidence_matrix\`, \`list_evidence\`, \`list_selected_corpus\`, \`full_text_status\`, \`verify_claims\` and \`audit_research_run\` are READ-ONLY inspection tools. Call each at most once per decision. They never change state, so re-checking coverage does not move the run forward. Once evidence is recorded, stop inspecting and call \`run_quality_gates\` — that is the terminal step and it auto-generates \`report.md\` when gates pass.
7. User-review checkpoints are control points, not synthesis tasks. When a checkpoint is requested, finish the required state-changing tool, then stop. Do not generate the same checkpoint prose twice, and do not continue to the next phase until the user approves.
8. Preset advice is secondary. If preset guidance suggests a tool that is not listed in the live "Allowed next tools", ignore the preset and choose an allowed workflow tool.

## Time awareness

- You MUST pay attention to the current date provided in the environment section.
- For requests like "latest", "recent", "newest", "today", "this week", "this month", "за сегодня", "за неделю", "самые последние", prefer date-aware search instead of plain relevance search.
- For arXiv freshness requests, prefer \`sort_by=submittedDate\`, \`sort_order=descending\`, and add \`from_date\` / \`to_date\` when the user implies a concrete time window.
- For broad freshness requests without a precise source, prefer a combination of \`search_web\`, \`search_huggingface_papers\`, and \`search_openalex\`, and explain which source determines the ranking.

## Output quality

- Distinguish clearly between evidence, inference, and uncertainty.
- Prefer structured outputs: summary, findings, comparison, limitations, next steps.
- Cite concrete sources from the workspace or command results when possible.
- If a claim is weakly supported, say so explicitly.
- Preserve the user's privacy-first workflow: keep work local and do not assume external services.

## Communication

- Use hidden reasoning internally when needed, but do not emit \`<think>\` tags yourself.
- Emit each action as a native tool call. Do not narrate the call you are "about to make" and then stop — when you have decided on a tool, actually call it that same turn.
- Keep the visible answer clean: no \`<think>\` tags and no raw tool-call markup unless the native tool-call channel is unavailable.
- Be concise and practical.
- Use markdown.
- Respond in the language specified in the Environment section.
- If the task is ambiguous, state your interpretation and proceed conservatively.`

export const DEFAULT_SUMMARIZE_PROMPT = `You are compacting a local research agent's conversation history. Create a STRUCTURED summary so the agent can continue the investigation without losing context.

CRITICAL — preserve these sections:
1. **CURRENT STEP**: What was the agent doing last and what happened?
2. **GOAL**: What is the user trying to learn, build, analyze, or reproduce?
3. **PLAN**: Remaining steps in numbered form.
4. **FILES AND SOURCES**: ALL file paths, repositories, documents, and sources mentioned. Use full paths when available.
5. **FINDINGS**: Important facts already established.
6. **WHAT WORKED**: Successful commands, reads, or analyses and their results.
7. **WHAT FAILED**: Errors, dead ends, blocked steps, and exact error messages.
8. **DECISIONS**: Key choices and assumptions.
9. **NEXT ACTION**: What should happen immediately next?

Rules:
- Be concise but preserve crucial evidence, paths, and errors verbatim.
- Use bullet points, not prose.
- Separate confirmed facts from assumptions.

CONVERSATION:
`

const COMPACT_SYSTEM_PROMPT = `You are a local-first autonomous research agent with tool access.

## Workflow
1. Clarify the research goal
2. Explore first with list_directory, read_file, and find_files
3. Use execute_command for validation, extraction, or reproduction
4. Avoid editing unless the user wants artifacts or concrete changes
5. Produce grounded findings, not guesses

## Rules
- Prefer evidence over speculation
- Keep outputs structured and concise
- Use the current date from the environment for freshness-sensitive searches
- For "latest/recent/today" requests, prefer date-aware sorting and filters over plain relevance
- Use hidden reasoning internally when needed, but do not emit <think> tags or put tool calls inside reasoning
- Be concise. Respond in the user's language
- Prefer read_file over shell file reads

## Managed research runs
If a \`.research/YYYY-MM-DD_HH-MM-SS_...\` run directory is present, treat it as the run database. Always pass exact \`output_dir\` to research tools. The live "Research state" block at the end of the conversation is authoritative: choose one tool from "Allowed next tools" and call it. Final \`report.md\` may be created or repaired only via \`generate_evidence_report\`. At user-review checkpoints, stop after the required state-changing tool and wait for approval; do not duplicate checkpoint prose or continue to the next phase.`

function getOsInfo(): string {
  const platform = process.platform
  const isWin = platform === 'win32'
  const isMac = platform === 'darwin'
  const osName = isWin ? 'Windows' : isMac ? 'macOS' : 'Linux'
  const shell = isWin ? 'PowerShell/cmd' : (process.env.SHELL?.split('/').pop() ?? 'bash')
  const now = new Date()
  const isoDate = now.toISOString().slice(0, 10)
  const lang = doGetConfig().appLanguage ?? 'ru'
  const langLabel = lang === 'ru' ? 'Russian (русский)' : 'English'
  return `\n\n## Environment\n- **OS**: ${osName} (${process.arch})\n- **Shell**: ${shell}\n- **Today**: ${isoDate}\n- **Response language**: ${langLabel} — you MUST respond in this language.\n` +
    (isWin
      ? '- Use Windows-compatible commands: `dir` instead of `ls`, `type` instead of `cat`, `del` instead of `rm`, `mkdir` (works on both), `move` instead of `mv`, `copy` instead of `cp`\n- Use `\\\\` or `/` for path separators in commands\n- PowerShell commands like `Get-ChildItem`, `Get-Content` also work\n'
      : '- Standard Unix commands available: `ls`, `cat`, `rm`, `mv`, `cp`, `grep`, `find`, etc.\n')
}

function getSystemPrompt(): string {
  const cfg = doGetConfig()
  const preset = getResearchPresetById(cfg.selectedPreset)
  const profile = getResearchProfileByPresetId(cfg.selectedPreset)
  const skillPack = skillPackForPreset(cfg.selectedPreset)
  const custom = cfg.systemPrompt
  const base = custom || (ctxTokens() < 16384 ? COMPACT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT)
  const webSearchStatus = getWebSearchStatus(cfg)
  const webSearchInfo = webSearchStatus.provider === 'managed-searxng'
    ? webSearchStatus.dockerAvailable
      ? '\n## Web Search\n- `search_web` uses a managed local SearXNG backend and can auto-start it on first use.\n'
      : '\n## Web Search\n- Managed local SearXNG is selected, but Docker is unavailable, so general web search is currently unavailable.\n'
    : webSearchStatus.provider === 'custom-searxng' && webSearchStatus.effectiveBaseUrl
      ? `\n## Web Search\n- \`search_web\` is available through the configured SearXNG instance at ${webSearchStatus.effectiveBaseUrl}\n`
      : '\n## Web Search\n- General web search is currently unavailable.\n'
  let sourcesBlock = ''
  let priorKnowledgeBlock = ''
  try {
    const session = doGetSession()
    const tracker = getSourceTracker(session.id)
    if (tracker.count() > 0) {
      const maxSourceChars = Math.floor(getMessageBudget() * calibratedRatio * 0.10)
      sourcesBlock = '\n\n' + tracker.formatForSystemPrompt(maxSourceChars)
    }
  } catch {}
  try {
    if (workspace) {
      const maxKnowledgeChars = Math.floor(getMessageBudget() * calibratedRatio * 0.08)
      const knowledge = loadPriorKnowledge(workspace, maxKnowledgeChars)
      if (knowledge) priorKnowledgeBlock = '\n\n' + knowledge
    }
  } catch {}
  return base + '\n\n' + preset.promptAddon + '\n\n' + formatResearchProfileForPrompt(profile) + (skillPack ? '\n\n' + skillPack : '') + webSearchInfo + getOsInfo() + sourcesBlock + priorKnowledgeBlock
}

function getSummarizePrompt(): string {
  return doGetConfig().summarizePrompt || DEFAULT_SUMMARIZE_PROMPT
}

function compactToolDefs(tools: any[]): any[] {
  return tools.map((t) => {
    const fn = t.function
    const params = fn.parameters
    const compactProps: Record<string, any> = {}
    for (const [k, v] of Object.entries(params.properties ?? {})) {
      compactProps[k] = { type: (v as any).type }
    }
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description.split('.')[0] + '.',
        parameters: { ...params, properties: compactProps },
      },
    }
  })
}

function getAllTools(): any[] {
  const customTools = doGetConfig().customTools.filter((t) => t.enabled)
  const customDefs = customTools.map((ct) => ({
    type: 'function',
    function: {
      name: ct.name,
      description: ct.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          ct.parameters.map((p) => [p.name, { type: 'string', description: p.description }]),
        ),
        required: ct.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }))
  const all = [...getBuiltinToolDefinitions(doGetConfig()), ...customDefs]
  // On small contexts, use compact descriptions to save ~40% tool overhead
  return ctxTokens() < 16384 ? compactToolDefs(all) : all
}

interface Message {
  role: string
  content?: string
  tool_calls?: any[]
  tool_call_id?: string
}

export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface Session {
  id: string
  title: string
  messages: Message[]
  uiMessages: any[]
  projectContextAdded: boolean
  createdAt: number
  updatedAt: number
  /** Workspace key (hash) so we know which folder to save to when updating from worker. */
  workspaceKey?: string
}

// ---------------------------------------------------------------------------
// Session storage (per-workspace: each project has its own chats)
// ---------------------------------------------------------------------------

const BASE_SESSIONS_DIR = path.join(os.homedir(), '.one-click-agent', 'sessions')
const ACTIVE_FILE = '_active.json'

/** Stable key for workspace so sessions are stored in their own folder. */
function getWorkspaceKey(ws: string): string {
  if (!ws || !ws.trim()) return '_empty'
  const normalized = path.normalize(ws).trim()
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function sessionsDir(ws: string): string {
  const d = path.join(BASE_SESSIONS_DIR, getWorkspaceKey(ws))
  fs.mkdirSync(d, { recursive: true })
  return d
}

function sessionFilePath(ws: string, id: string): string {
  return path.join(sessionsDir(ws), `${id}.json`)
}

/** In-memory: sessions per workspace (workspaceKey -> Map<sessionId, Session>). */
const sessionsByWorkspace = new Map<string, Map<string, Session>>()
/** Active session id per workspace (workspaceKey -> sessionId). */
const activeIdByWorkspace = new Map<string, string>()

let workspace = ''
let currentAbort: AbortController | null = null
let cancelRequested = false

function getSessionsMap(ws: string): Map<string, Session> {
  const key = getWorkspaceKey(ws)
  if (!sessionsByWorkspace.has(key)) {
    sessionsByWorkspace.set(key, new Map())
  }
  return sessionsByWorkspace.get(key)!
}

function loadSessionsForWorkspace(ws: string): void {
  if (!ws || !ws.trim()) return
  const key = getWorkspaceKey(ws)
  if (sessionsByWorkspace.has(key)) return
  const map = new Map<string, Session>()
  sessionsByWorkspace.set(key, map)
  try {
    const dir = sessionsDir(ws)
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json') && f !== ACTIVE_FILE)
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
        const data = JSON.parse(raw)
        if (data.id && Array.isArray(data.messages)) {
          const session: Session = {
            id: data.id,
            title: data.title ?? 'Без названия',
            messages: data.messages,
            uiMessages: data.uiMessages ?? [],
            projectContextAdded: data.projectContextAdded ?? false,
            createdAt: data.createdAt ?? Date.now(),
            updatedAt: data.updatedAt ?? Date.now(),
            workspaceKey: key,
          }
          map.set(session.id, session)
        }
      } catch {}
    }
    const activePath = path.join(dir, ACTIVE_FILE)
    if (fs.existsSync(activePath)) {
      const activeRaw = fs.readFileSync(activePath, 'utf-8')
      const activeData = JSON.parse(activeRaw)
      if (typeof activeData?.activeSessionId === 'string' && map.has(activeData.activeSessionId)) {
        activeIdByWorkspace.set(key, activeData.activeSessionId)
      }
    }
  } catch {}
}

function saveActiveId(ws: string): void {
  if (!ws?.trim()) return
  const key = getWorkspaceKey(ws)
  const activeId = activeIdByWorkspace.get(key) ?? null
  try {
    const dir = sessionsDir(ws)
    fs.writeFileSync(path.join(dir, ACTIVE_FILE), JSON.stringify({ activeSessionId: activeId }), 'utf-8')
  } catch {}
}

export function saveSession(session: Session): void {
  const key = session.workspaceKey ?? getWorkspaceKey(workspace)
  try {
    const dir = path.join(BASE_SESSIONS_DIR, key)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify({
      id: session.id,
      title: session.title,
      messages: session.messages,
      uiMessages: session.uiMessages,
      projectContextAdded: session.projectContextAdded,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workspaceKey: session.workspaceKey ?? key,
    }), 'utf-8')
  } catch {}
}

function deleteSessionFile(ws: string, id: string): void {
  try { fs.unlinkSync(sessionFilePath(ws, id)) } catch {}
}

function generateSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function titleFromMessage(text: string): string {
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/\[.*?\]/g, '').trim()
  const firstLine = clean.split('\n')[0] ?? ''
  return firstLine.length > 50 ? firstLine.slice(0, 47) + '…' : firstLine || 'Новый чат'
}

/** Path where main process writes session for worker (same layout as our storage). */
export function getSessionPathForWorker(ws: string, sessionId: string): string {
  return sessionFilePath(ws, sessionId)
}

export function getActiveSession(ws: string): Session {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  const activeId = activeIdByWorkspace.get(key)
  if (activeId && map.has(activeId)) {
    return map.get(activeId)!
  }
  const id = generateSessionId()
  const session: Session = {
    id,
    title: 'Новый чат',
    messages: [],
    uiMessages: [],
    projectContextAdded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceKey: key,
  }
  map.set(id, session)
  activeIdByWorkspace.set(key, id)
  saveSession(session)
  saveActiveId(ws)
  return session
}

// ---------------------------------------------------------------------------
// Public session management (all take workspace)
// ---------------------------------------------------------------------------

export function createSession(ws: string): string {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  const id = generateSessionId()
  const session: Session = {
    id,
    title: 'Новый чат',
    messages: [],
    uiMessages: [],
    projectContextAdded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceKey: key,
  }
  map.set(id, session)
  activeIdByWorkspace.set(key, id)
  saveSession(session)
  saveActiveId(ws)
  return id
}

export function switchSession(ws: string, id: string): boolean {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  if (!map.has(id)) return false
  activeIdByWorkspace.set(key, id)
  saveActiveId(ws)
  return true
}

export function listSessions(ws: string): SessionInfo[] {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  return [...map.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.filter((m) => m.role === 'user').length,
    }))
}

export function deleteSession(ws: string, id: string): void {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  map.delete(id)
  deleteSessionFile(ws, id)
  if (map.size === 0) {
    createSession(ws)
    return
  }
  if (activeIdByWorkspace.get(key) === id) {
    const first = map.keys().next().value
    if (first) activeIdByWorkspace.set(key, first)
    else activeIdByWorkspace.delete(key)
    saveActiveId(ws)
  }
}

export function renameSession(ws: string, id: string, title: string): void {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  const session = map.get(id)
  if (session) {
    session.title = title
    saveSession(session)
  }
}

export function getActiveSessionId(ws: string): string | null {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  return activeIdByWorkspace.get(key) ?? null
}

// Debounced session persist so main process doesn't block on every tool call
let pendingSessionPersist: Session | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 1000

function flushSessionPersist(): void {
  if (pendingSessionPersist) {
    const s = pendingSessionPersist
    pendingSessionPersist = null
    saveSession(s)
  }
  persistTimer = null
}

/** Called from main when worker sends session-update. In-memory update + debounced disk write. */
export function updateSessionFromWorker(session: Session, immediate = false): void {
  const key = session.workspaceKey ?? getWorkspaceKey(workspace)
  const map = sessionsByWorkspace.get(key)
  if (map) map.set(session.id, session)
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = null
    pendingSessionPersist = session
    flushSessionPersist()
  } else {
    pendingSessionPersist = session
    if (!persistTimer) persistTimer = setTimeout(flushSessionPersist, PERSIST_DEBOUNCE_MS)
  }
}

export function saveUiMessages(ws: string, id: string, uiMsgs: any[]): void {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  const session = map.get(id)
  if (session) {
    session.uiMessages = uiMsgs
    saveSession(session)
  }
}

export function getUiMessages(ws: string, id: string): any[] {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  return map.get(id)?.uiMessages ?? []
}

export function initSessions(): void {
  fs.mkdirSync(BASE_SESSIONS_DIR, { recursive: true })
}

function emitContextUsage(msgs: Message[]) {
  const used = estimateContextTokens(msgs)
  const budget = getMessageBudget()
  const maxCtx = ctxTokens()
  const pct = Math.round((used / budget) * 100)
  doEmit({
    type: 'context_usage',
    contextUsage: { usedTokens: used, budgetTokens: budget, maxContextTokens: maxCtx, percent: Math.min(pct, 100) },
  })
}

function extractThinking(content: string): [string, string] {
  let thinking = ''
  let visible = content
  const re = /<think>([\s\S]*?)<\/think>/g
  let match
  while ((match = re.exec(content)) !== null) {
    thinking += (thinking ? '\n' : '') + match[1].trim()
  }
  visible = content.replace(re, '').trim()
  const openThink = visible.search(/<think>/i)
  if (openThink >= 0) {
    const before = visible.slice(0, openThink).trim()
    const after = visible.slice(openThink).replace(/<think>/i, '').trim()
    thinking += (thinking && after ? '\n' : '') + after
    visible = before
  }
  return [thinking, visible]
}

function cleanThinkingText(content: string): string {
  return content.replace(/<\/?think>/gi, '').trim()
}

// ---------------------------------------------------------------------------
// Progressive file content streaming — extract partial content from tool call
// arguments as they're being generated, so the UI can show file writes in real-time
// ---------------------------------------------------------------------------

const FILE_CONTENT_TOOLS = new Set(['write_file', 'edit_file', 'append_file'])
const TOOL_STREAM_INTERVAL_MS = 200

function extractPartialFileContent(partialArgs: string, toolName: string): { path: string; content: string } | null {
  // Tool args are partial JSON like: {"path": "foo.js", "content": "line1\nline2...
  // We need to extract the path and the content field from incomplete JSON
  const contentKey = toolName === 'edit_file' ? 'new_string' : 'content'

  // Extract path
  const pathMatch = partialArgs.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const filePath = pathMatch?.[1] ?? ''

  // Find the content/new_string field start
  const keyPattern = new RegExp(`"${contentKey}"\\s*:\\s*"`)
  const keyMatch = keyPattern.exec(partialArgs)
  if (!keyMatch) return null

  const contentStart = keyMatch.index + keyMatch[0].length
  let raw = partialArgs.slice(contentStart)

  // Remove trailing quote if the JSON is complete
  if (raw.endsWith('"}') || raw.endsWith('", ') || raw.endsWith('",')) {
    raw = raw.replace(/"\s*[,}]\s*$/, '')
  } else if (raw.endsWith('"')) {
    raw = raw.slice(0, -1)
  }

  // Unescape JSON string
  try {
    const content = JSON.parse(`"${raw}"`)
    return { path: filePath, content }
  } catch {
    // If JSON parse fails, do basic unescaping
    const content = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    return { path: filePath, content }
  }
}

// ---------------------------------------------------------------------------
// Streaming LLM call — SSE parser with incremental think/response emission
// ---------------------------------------------------------------------------

function parseAccumulatedThinking(content: string): { thinking: string; visible: string; thinkingDone: boolean } {
  const openIdx = content.indexOf('<think>')
  if (openIdx === -1) return { thinking: '', visible: content.trim(), thinkingDone: true }

  const closeIdx = content.indexOf('</think>')
  if (closeIdx === -1) {
    return {
      thinking: content.slice(openIdx + 7).trim(),
      visible: content.slice(0, openIdx).trim(),
      thinkingDone: false,
    }
  }

  const thinking = content.slice(openIdx + 7, closeIdx).trim()
  const visible = (content.slice(0, openIdx) + content.slice(closeIdx + 8)).trim()
  return { thinking, visible, thinkingDone: true }
}

interface StreamResult {
  content: string
  toolCalls: any[] | undefined
  rawToolCalls: any[] | undefined
  finishReason: string | null
  elapsedMs: number
  estimatedOutputTokens: number
}

/**
 * Checks if the llama-server is still responsive. Used to diagnose network
 * errors from `fetch` (e.g. "fetch failed", "terminated"). A transport break
 * alone is not a root cause, so we only use this as extra diagnostics.
 */
async function pingLlamaServer(apiUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const base = apiUrl.replace(/\/v1\/chat\/completions\/?$/, '')
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(`${base}/health`, { signal: ctrl.signal })
      return r.ok
    } finally {
      clearTimeout(to)
    }
  } catch {
    return false
  }
}

/** True for low-level transport errors from undici/fetch. */
function isNetworkStreamError(e: any): boolean {
  const name = e?.name ?? ''
  const msg = (e?.message ?? String(e ?? '')).toLowerCase()
  const causeCode = e?.cause?.code ?? ''
  if (name === 'TypeError' && (msg.includes('fetch failed') || msg.includes('terminated'))) return true
  if (msg.includes('socket hang up')) return true
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode)) return true
  return false
}

async function streamLlmResponse(
  apiUrl: string,
  msgs: Message[],
  fullResponseSoFar: string,
  signal: AbortSignal,
  maxTokensOverride?: number,
  temperatureOverride?: number,
): Promise<StreamResult> {
  const cleanMsgs = sanitizeMessages(msgs)
  const maxTok = (maxTokensOverride && maxTokensOverride > 0) ? maxTokensOverride : getMaxResponseTokens()
  const temp = temperatureOverride ?? getBaseTemperature()
  const msgRoles = cleanMsgs.map((m) => m.role + (m.tool_calls ? `(${m.tool_calls.length}tc)` : '')).join(', ')
  debugLog('STREAM', `Sending request: ${cleanMsgs.length} msgs [${msgRoles}], max_tokens=${maxTok}, temp=${temp}, ctx=${ctxTokens()}, budget=${getMessageBudget()}, used=${estimateContextTokens(cleanMsgs)}`)

  emitActivity('llm_queue', 'Загружаю контекст на GPU (llama-server)…', `${cleanMsgs.length} сообщений · ~${Math.round(estimateContextTokens(cleanMsgs) / 1024)}K токенов`)

  const startMs = Date.now()
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen',
      messages: cleanMsgs,
      tools: getAllTools(),
      tool_choice: 'auto',
      temperature: temp,
      max_tokens: maxTok,
      stream: true,
    }),
    signal,
  })

  debugLog('STREAM', `Response status: ${r.status} (${Date.now() - startMs}ms)`)

  if (!r.ok) {
    const errBody = await r.text()
    debugLog('STREAM', `ERROR body: ${errBody.slice(0, 1000)}`)
    throw new Error(`HTTP ${r.status}: ${errBody.slice(0, 500)}`)
  }

  if (!r.body) {
    debugLog('STREAM', 'ERROR: No response body')
    throw new Error('No response body for streaming')
  }

  const reader = (r.body as any).getReader()
  const decoder = new TextDecoder()

  let accContent = ''
  let lastThinkLen = 0
  let lastVisibleLen = 0
  let wasThinkingDone = true
  const toolCallMap = new Map<number, any>()
  let sseBuffer = ''
  let lastEmitMs = 0
  let lastToolStreamMs = 0
  let lastStreamStatsEmitMs = 0
  const EMIT_INTERVAL_MS = 150 // max ~7 UI updates per second
  const STREAM_STATS_INTERVAL_MS = 500
  let finishReason: string | null = null

  // Idle timeout: abort if no data received for 60s (server stalled)
  const IDLE_TIMEOUT_MS = getIdleTimeoutMs()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let chunkCount = 0
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      debugLog('STREAM', `IDLE TIMEOUT after ${Date.now() - startMs}ms, ${chunkCount} chunks received, content=${accContent.length}chars`)
      try { reader.cancel() } catch {}
    }, IDLE_TIMEOUT_MS)
  }
  resetIdle()

  while (true) {
    const { done, value } = await reader.read()
    if (done) { if (idleTimer) clearTimeout(idleTimer); break }
    chunkCount++
    resetIdle()
    if (chunkCount === 1) {
      emitActivity('llm_generate', 'Модель генерирует на GPU…')
    }

    sseBuffer += decoder.decode(value, { stream: true })
    const lines = sseBuffer.split('\n')
    sseBuffer = lines.pop()!

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (!trimmed.startsWith('data: ')) continue

      let chunk: any
      try {
        chunk = JSON.parse(trimmed.slice(6))
      } catch { continue }

      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      const delta = choice?.delta
      if (!delta) continue

      // Log first few chunks for debugging empty responses
      if (chunkCount <= 3) {
        debugLog('SSE_CHUNK', `#${chunkCount}: content=${JSON.stringify(delta.content)}, tc=${delta.tool_calls ? 'yes' : 'no'}, role=${delta.role ?? '-'}, finish=${choice.finish_reason ?? '-'}`)
      }

      // Capture reasoning_content (Qwen's separate thinking field)
      if (delta.reasoning_content) {
        const rc = delta.reasoning_content
        accContent += accContent.includes('<think>') ? rc : `<think>${rc}`
        const { thinking } = parseAccumulatedThinking(accContent)
        if (thinking.length > lastThinkLen) {
          doEmit( { type: 'thinking', content: cleanThinkingText(thinking.slice(lastThinkLen)) })
          lastThinkLen = thinking.length
        }
        wasThinkingDone = false
      }

      // Accumulate content tokens
      if (delta.content) {
        // Close any open reasoning_content thinking block before visible content
        if (!wasThinkingDone && !delta.content.includes('<think>')) {
          accContent += '</think>'
          wasThinkingDone = true
          doEmit( { type: 'status', content: '' })
        }
        accContent += delta.content

        const { thinking, visible, thinkingDone } = parseAccumulatedThinking(accContent)

        // Emit thinking-done transition
        if (thinkingDone && !wasThinkingDone) {
          doEmit( { type: 'status', content: '' })
        }
        wasThinkingDone = thinkingDone

        // Emit thinking delta
        if (thinking.length > lastThinkLen) {
          doEmit( { type: 'thinking', content: cleanThinkingText(thinking.slice(lastThinkLen)) })
          lastThinkLen = thinking.length
        }
        // Emit visible response (time-based throttle — max ~7 updates/sec)
        if (visible.length > lastVisibleLen) {
          const now = Date.now()
          if (now - lastEmitMs >= EMIT_INTERVAL_MS || thinkingDone) {
            lastEmitMs = now
            const fullNow = fullResponseSoFar
              ? fullResponseSoFar + '\n\n' + visible
              : visible
            doEmit( { type: 'response', content: fullNow, done: false })
          }
          lastVisibleLen = visible.length
        }
      }

      // Accumulate tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, {
              id: tc.id ?? '',
              type: tc.type ?? 'function',
              function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              },
            })
          } else {
            const existing = toolCallMap.get(idx)!
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.function.name += tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }

          // Stream file content for write/edit/append tools
          const entry = toolCallMap.get(idx)!
          const toolName = entry.function.name
          if (FILE_CONTENT_TOOLS.has(toolName)) {
            const now = Date.now()
            if (now - lastToolStreamMs >= TOOL_STREAM_INTERVAL_MS) {
              lastToolStreamMs = now
              const partial = extractPartialFileContent(entry.function.arguments, toolName)
              if (partial) {
                doEmit( {
                  type: 'tool_streaming',
                  name: toolName,
                  toolStreamPath: partial.path,
                  toolStreamContent: partial.content,
                })
              }
            }
          }
        }
      }

      // Emit tokens/s during any generation — thinking or visible (throttled)
      const now = Date.now()
      const elapsedMs = now - startMs
      if (elapsedMs >= 300 && now - lastStreamStatsEmitMs >= STREAM_STATS_INTERVAL_MS) {
        lastStreamStatsEmitMs = now
        const est = estimateTokens(accContent)
        if (est > 0) {
          doEmit({ type: 'stream_stats', tokensPerSecond: Math.round((est * 1000) / elapsedMs) })
        }
      }
    }
  }

  // Final visible emission to ensure nothing is lost
  const { visible: finalVisible } = parseAccumulatedThinking(accContent)
  if (finalVisible.length > 0) {
    const fullNow = fullResponseSoFar
      ? fullResponseSoFar + '\n\n' + finalVisible
      : finalVisible
    doEmit( { type: 'response', content: fullNow, done: false })
  }

  // Final tool streaming emission (ensure UI gets the complete content)
  for (const entry of toolCallMap.values()) {
    if (FILE_CONTENT_TOOLS.has(entry.function.name)) {
      const partial = extractPartialFileContent(entry.function.arguments, entry.function.name)
      if (partial) {
        doEmit( {
          type: 'tool_streaming',
          name: entry.function.name,
          toolStreamPath: partial.path,
          toolStreamContent: partial.content,
          done: true,
        })
      }
    }
  }

  const rawToolCalls = toolCallMap.size > 0 ? [...toolCallMap.values()] : undefined
  const toolCalls = validateAndFixToolCalls(rawToolCalls)

  const elapsedMs = Date.now() - startMs
  const tcNames = toolCalls?.map((tc: any) => tc.function?.name).join(', ') ?? 'none'
  const contentPreview = accContent.length > 200 ? accContent.slice(0, 200) + '…' : accContent
  debugLog('STREAM', `Completed: ${elapsedMs}ms, ${chunkCount} chunks, content=${accContent.length}chars, rawTC=${rawToolCalls?.length ?? 0}, validTC=${toolCalls?.length ?? 0}, tools=[${tcNames}], finish=${finishReason}`)
  if (accContent.length === 0 && !rawToolCalls) {
    debugLog('STREAM', `WARNING: Completely empty response! ${chunkCount} SSE chunks received but no content or tool calls extracted`)
  }
  if (rawToolCalls && (!toolCalls || toolCalls.length === 0)) {
    const rawName = rawToolCalls[0]?.function?.name ?? '?'
    const rawArgsLen = rawToolCalls[0]?.function?.arguments?.length ?? 0
    debugLog('STREAM', `WARNING: All ${rawToolCalls.length} tool calls invalid! fn=${rawName}, argsLen=${rawArgsLen}, finish=${finishReason}, first300: ${rawToolCalls[0]?.function?.arguments?.slice(0, 300)}`)
  }
  debugLog('STREAM', `Content preview: ${contentPreview || '(empty)'}`)

  const estimatedOutputTokens = estimateTokens(accContent)
  return { content: accContent, toolCalls, rawToolCalls, finishReason, elapsedMs, estimatedOutputTokens }
}

// ---------------------------------------------------------------------------
// Token estimation — heuristic with calibration from /tokenize
// ---------------------------------------------------------------------------

// Correction factor for heuristic: calibrated from first accurate count.
// Default 1.5 because chat templates add ~50% overhead (role tokens, <|im_start|>, etc.)
let heuristicCorrectionFactor = 1.5

function estimateTokens(text: string): number {
  if (!text) return 0
  const base = Math.ceil(text.length / calibratedRatio)
  const jsonBrackets = (text.match(/[{}\[\]":,]/g) || []).length
  const structureBonus = Math.ceil(jsonBrackets * 0.1)
  return base + structureBonus + 4
}

function estimateContextTokensRaw(msgs: Message[]): number {
  let total = 4
  for (const m of msgs) {
    total += 4
    total += estimateTokens(m.content ?? '')
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return total
}

function estimateContextTokens(msgs: Message[]): number {
  return Math.ceil(estimateContextTokensRaw(msgs) * heuristicCorrectionFactor)
}

async function countContextTokensAccurate(msgs: Message[]): Promise<number> {
  const fullText = msgs.map((m) => {
    let s = `<|${m.role}|>\n${m.content ?? ''}`
    if (m.tool_calls) s += '\n' + JSON.stringify(m.tool_calls)
    return s
  }).join('\n')
  // Avoid blocking llama-server tokenize on megabyte-scale prompts (resume / deep research).
  if (fullText.length > 48_000) {
    return estimateContextTokens(msgs)
  }
  const serverCount = await countTokensViaServer(fullText)
  if (serverCount !== null) {
    const overhead = msgs.length * 4 + 4
    const total = serverCount + overhead

    // Calibrate heuristic correction factor from real data
    const rawHeuristic = estimateContextTokensRaw(msgs)
    if (rawHeuristic > 50) {
      const newFactor = total / rawHeuristic
      // Smooth update (moving average) to avoid jumps
      heuristicCorrectionFactor = heuristicCorrectionFactor * 0.3 + newFactor * 0.7
    }

    const correctedHeuristic = estimateContextTokens(msgs)
    debugLog('TOKENS', `Accurate: ${total} (server=${serverCount}+overhead=${overhead}), heuristic=${correctedHeuristic}, correction=${heuristicCorrectionFactor.toFixed(2)}`)
    return total
  }
  return estimateContextTokens(msgs)
}

function toolsOverheadTokens(): number {
  return estimateTokens(JSON.stringify(getAllTools()))
}

// ---------------------------------------------------------------------------
// Context budget — allocates tokens across zones
// ---------------------------------------------------------------------------

function ctxTokens(): number {
  const ctx = doGetCtxSize()
  return ctx > 0 ? ctx : FALLBACK_CTX_TOKENS
}

function getUsableBudget(): number {
  return ctxTokens() - toolsOverheadTokens()
}

function getMaxResponseTokens(): number {
  const budget = getUsableBudget()
  // Scale minimum with context: small contexts get smaller min to leave room for messages
  const minTokens = Math.max(1024, Math.min(4096, Math.floor(budget * 0.25)))
  return Math.min(16384, Math.max(minTokens, Math.floor(budget * 0.30)))
}

function getMessageBudget(): number {
  return getUsableBudget() - getMaxResponseTokens()
}

function dynamicToolResultLimit(): number {
  const budget = getMessageBudget()
  const charBudget = Math.floor(budget * calibratedRatio)
  // On small contexts, limit tool results much harder to prevent context bloat
  if (budget < 8000) return Math.min(Math.max(800, Math.floor(charBudget * 0.08)), 3000)
  if (budget < 15000) return Math.min(Math.max(1200, Math.floor(charBudget * 0.10)), 5000)
  return Math.min(Math.max(1500, Math.floor(charBudget * 0.15)), 40000)
}

function smartTruncateToolResult(toolName: string, result: string, maxChars: number): string {
  if (isResearchContextTool(toolName)) {
    return compressResearchToolResult(toolName, result, maxChars)
  }
  if (result.length <= maxChars) return result

  // For file reads — context-aware auto-limiting
  if (toolName === 'read_file') {
    const budget = getMessageBudget()
    const lines = result.split('\n')
    const totalLines = lines.length

    // On small contexts, aggressively limit line count even if chars would fit
    let maxLines = Infinity
    if (budget < 8000) maxLines = 100
    else if (budget < 15000) maxLines = 200
    else if (budget < 30000) maxLines = 400

    if (totalLines > maxLines && maxLines < Infinity) {
      const headCount = Math.floor(maxLines * 0.6)
      const tailCount = Math.floor(maxLines * 0.35)
      const head = lines.slice(0, headCount).join('\n')
      const tail = lines.slice(-tailCount).join('\n')
      const hint = `\n\n… [${totalLines} lines total, showing first ${headCount} + last ${tailCount}. Use offset/limit params to read specific sections.]\n\n`
      const truncated = head + hint + tail
      return truncated.length <= maxChars ? truncated : compressToolResultText(result, maxChars)
    }

    return compressToolResultText(result, maxChars)
  }

  // For directory listings — keep first N lines (shallow hierarchy most useful)
  if (toolName === 'list_directory') {
    const lines = result.split('\n')
    let acc = ''
    for (const line of lines) {
      if ((acc.length + line.length + 1) > maxChars - 50) {
        return acc + `\n… [${lines.length} total entries, truncated]`
      }
      acc += (acc ? '\n' : '') + line
    }
    return acc
  }

  // For command output — keep last N lines (errors usually at the end)
  if (toolName === 'execute_command') {
    const lines = result.split('\n')
    const headBudget = Math.floor(maxChars * 0.3)
    const tailBudget = Math.floor(maxChars * 0.5)
    const headLines: string[] = []
    let headLen = 0
    for (const line of lines) {
      if (headLen + line.length + 1 > headBudget) break
      headLines.push(line)
      headLen += line.length + 1
    }
    const tailLines: string[] = []
    let tailLen = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      if (tailLen + lines[i].length + 1 > tailBudget) break
      tailLines.unshift(lines[i])
      tailLen += lines[i].length + 1
    }
    return headLines.join('\n') +
      `\n\n… [${lines.length} lines, middle omitted] …\n\n` +
      tailLines.join('\n')
  }

  // For search results — keep head (most relevant matches first)
  if (toolName === 'find_files') {
    const lines = result.split('\n')
    let acc = ''
    for (const line of lines) {
      if ((acc.length + line.length + 1) > maxChars - 50) {
        return acc + `\n… [more results truncated]`
      }
      acc += (acc ? '\n' : '') + line
    }
    return acc
  }

  return compressToolResultText(result, maxChars)
}

// ---------------------------------------------------------------------------
// Message sanitization — fix/remove broken tool_calls that poison history
// ---------------------------------------------------------------------------

function isValidToolCallArgs(argsStr: string): boolean {
  try {
    JSON.parse(argsStr)
    return true
  } catch {
    return false
  }
}

function sanitizeMessages(msgs: Message[]): Message[] {
  let result: Message[] = []
  const brokenCallIds = new Set<string>()

  // Pass 1: Fix/remove broken tool_calls
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const validCalls: any[] = []
      for (const tc of m.tool_calls) {
        const argsStr = typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {})
        if (isValidToolCallArgs(argsStr)) {
          validCalls.push(tc)
        } else {
          brokenCallIds.add(tc.id)
        }
      }

      if (validCalls.length > 0) {
        result.push({ ...m, tool_calls: validCalls })
      } else if (m.content) {
        result.push({ role: 'assistant', content: m.content })
      }
      continue
    }

    if (m.role === 'tool' && m.tool_call_id && brokenCallIds.has(m.tool_call_id)) {
      continue
    }

    result.push(m)
  }

  // Pass 2: Remove orphaned tool results (tool_call_id not in any preceding assistant)
  const validCallIds = new Set<string>()
  const cleaned: Message[] = []
  for (const m of result) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) validCallIds.add(tc.id)
      }
    }
    if (m.role === 'tool' && m.tool_call_id && !validCallIds.has(m.tool_call_id)) {
      continue
    }
    cleaned.push(m)
  }
  result = cleaned

  // Pass 3: Merge consecutive assistant messages (llama.cpp rejects 2+ in a row)
  const merged: Message[] = []
  for (const m of result) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null
    if (m.role === 'assistant' && prev?.role === 'assistant' && !prev.tool_calls && !m.tool_calls) {
      const combinedContent = [prev.content, m.content].filter(Boolean).join('\n\n')
      merged[merged.length - 1] = { role: 'assistant', content: combinedContent }
    } else if (m.role === 'assistant' && prev?.role === 'assistant') {
      // Two assistant messages but one has tool_calls — keep the one with tool_calls
      if (m.tool_calls && m.tool_calls.length > 0) {
        if (!prev.tool_calls || prev.tool_calls.length === 0) {
          merged[merged.length - 1] = m
        }
        // else both have tool_calls — skip the second one (shouldn't happen but safe)
      }
      // else prev has tool_calls, m doesn't — skip m
    } else {
      merged.push(m)
    }
  }

  const removedBroken = msgs.length - result.length
  const removedOrphans = result.length - cleaned.length
  const mergedCount = cleaned.length - merged.length
  if (removedBroken > 0 || removedOrphans > 0 || mergedCount > 0) {
    debugLog('SANITIZE', `Cleaned: ${removedBroken} broken, ${removedOrphans} orphans, ${mergedCount} merged. ${msgs.length} → ${merged.length} msgs`)
  }

  // Pass 4: Fix ending — server rejects 2+ trailing assistant messages
  while (merged.length > 1) {
    const last = merged[merged.length - 1]
    const prev = merged[merged.length - 2]
    if (last.role === 'assistant' && prev.role === 'assistant') {
      const combinedContent = [prev.content, last.content].filter(Boolean).join('\n\n')
      const keepCalls = last.tool_calls || prev.tool_calls
      merged.splice(merged.length - 2, 2, {
        role: 'assistant',
        content: combinedContent || undefined,
        ...(keepCalls ? { tool_calls: keepCalls } : {}),
      })
    } else {
      break
    }
  }

  // Pass 5: Trailing assistant without tool_calls → "response prefill" error with enable_thinking.
  // Convert it to user context so the model can continue without prefill conflict.
  if (merged.length > 0) {
    const last = merged[merged.length - 1]
    if (last.role === 'assistant' && !last.tool_calls) {
      merged.pop()
      if (last.content) {
        merged.push({ role: 'user', content: `[Previous assistant work summary]\n${last.content}\n\nPlease continue the task.` })
      }
    }
  }

  // Pass 6: Ensure at least one user message exists (Qwen template hard requirement)
  const hasUser = merged.some((m) => m.role === 'user')
  if (!hasUser) {
    const sysIdx = merged.findIndex((m) => m.role === 'system')
    merged.splice(sysIdx >= 0 ? sysIdx + 1 : 0, 0, { role: 'user', content: 'Continue with the current task.' })
    debugLog('SANITIZE', 'Injected synthetic user message — template requires at least one')
  }

  return merged
}

function validateAndFixToolCalls(toolCalls: any[] | undefined): any[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return toolCalls
  const valid: any[] = []
  for (const tc of toolCalls) {
    const argsStr = typeof tc.function?.arguments === 'string'
      ? tc.function.arguments
      : JSON.stringify(tc.function?.arguments ?? {})
    if (isValidToolCallArgs(argsStr)) {
      valid.push(tc)
    }
  }
  return valid.length > 0 ? valid : undefined
}

// ---------------------------------------------------------------------------
// Truncated tool call repair — salvage partial write_file / edit_file content
// ---------------------------------------------------------------------------

function tryRepairTruncatedToolCall(tc: any): { name: string; args: Record<string, any>; truncated: boolean } | null {
  const fnName = tc.function?.name
  const argsStr = tc.function?.arguments
  if (!fnName || !argsStr || typeof argsStr !== 'string') return null
  if (argsStr.length < 20) return null

  // Only repair write_file and edit_file — the tools that carry large content
  if (fnName !== 'write_file' && fnName !== 'edit_file' && fnName !== 'append_file') return null

  // First try: maybe it's already valid
  try {
    const parsed = JSON.parse(argsStr)
    return { name: fnName, args: parsed, truncated: false }
  } catch {}

  // The JSON is truncated mid-string. Strategy: trim trailing bytes and try closing
  for (let trim = 0; trim < 20; trim++) {
    const base = trim > 0 ? argsStr.slice(0, -trim) : argsStr
    // Try closing with just quote + brace (most common: truncated inside a string value)
    for (const suffix of ['"}', '\\n"}', '"}}\n']) {
      try {
        const parsed = JSON.parse(base + suffix)
        if (parsed.path) {
          debugLog('REPAIR', `Repaired ${fnName}: trimmed ${trim} chars, path=${parsed.path}, content=${(parsed.content ?? '').length} chars`)
          return { name: fnName, args: parsed, truncated: true }
        }
      } catch {}
    }
  }

  // Aggressive: find the last complete JSON key-value and build from there
  const pathMatch = argsStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (pathMatch && fnName === 'write_file') {
    const contentMatch = argsStr.match(/"content"\s*:\s*"/)
    if (contentMatch) {
      const contentStart = argsStr.indexOf(contentMatch[0]) + contentMatch[0].length
      let rawContent = argsStr.slice(contentStart)
      // Strip trailing incomplete escape
      rawContent = rawContent.replace(/\\[^"\\\/bfnrtu]?$/, '')
      // Unescape the content we have
      try {
        const fakeJson = `{"v":"${rawContent}"}`
        const parsed = JSON.parse(fakeJson)
        debugLog('REPAIR', `Aggressive repair ${fnName}: path=${pathMatch[1]}, content=${parsed.v.length} chars`)
        return { name: fnName, args: { path: pathMatch[1], content: parsed.v }, truncated: true }
      } catch {}
      // Last resort: raw content without JSON unescaping
      const plainContent = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      if (plainContent.length > 50) {
        debugLog('REPAIR', `Raw repair ${fnName}: path=${pathMatch[1]}, content=${plainContent.length} chars`)
        return { name: fnName, args: { path: pathMatch[1], content: plainContent }, truncated: true }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Message cleaning — strip thinking, compress tool results
// ---------------------------------------------------------------------------

function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/**
 * Append a visible-text segment to the streamed response, skipping duplicates.
 * The model sometimes narrates the same prose twice — once alongside a tool call
 * and again as its final answer (common at checkpoints) — which previously got
 * concatenated and shown to the user twice. If the new segment is already present
 * we keep the accumulator; if it is a superset we replace it.
 */
export function appendVisibleSegment(acc: string, segment: string): string {
  const seg = (segment || '').trim()
  if (!seg) return acc
  if (!acc) return seg
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
  const na = norm(acc)
  const ns = norm(seg)
  if (na.includes(ns)) return acc
  if (ns.includes(na)) return seg
  return `${acc}\n\n${seg}`
}

function compressToolResultText(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = Math.floor(maxChars * 0.25)
  return (
    content.slice(0, headSize) +
    `\n\n… [${Math.round(content.length / 1024)}KB, middle omitted] …\n\n` +
    content.slice(-tailSize)
  )
}

function toolCallOneLiner(msg: Message): string {
  if (!msg.tool_calls || msg.tool_calls.length === 0) return ''
  return msg.tool_calls.map((tc: any) => {
    const name = tc.function?.name ?? '?'
    let args: string
    try {
      const parsed = typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function?.arguments ?? {}
      const keys = Object.keys(parsed)
      args = keys.slice(0, 2).map((k) => {
        const v = String(parsed[k])
        return `${k}=${v.length > 60 ? v.slice(0, 57) + '…' : v}`
      }).join(', ')
    } catch {
      args = '…'
    }
    return `${name}(${args})`
  }).join('; ')
}

// ---------------------------------------------------------------------------
// Working memory — structured state that survives summarization
// ---------------------------------------------------------------------------

interface WorkingMemory {
  currentTask: string
  currentPlan: string[]
  approach: string
  filesModified: string[]
  filesRead: string[]
  keyFacts: string[]
  lastResults: string[]
  researchQuestions: string[]
  hypotheses: string[]
  searchesDone: string[]
}

function extractWorkingMemory(msgs: Message[]): WorkingMemory {
  const mem: WorkingMemory = {
    currentTask: '', currentPlan: [], approach: '',
    filesModified: [], filesRead: [], keyFacts: [], lastResults: [],
    researchQuestions: [], hypotheses: [], searchesDone: [],
  }
  const modifiedFiles = new Set<string>()
  const readFiles = new Set<string>()

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]

    // Extract current task from last user message
    if (m.role === 'user' && !mem.currentTask) {
      const clean = (m.content ?? '').replace(/```[\s\S]*?```/g, '').replace(/\[Context was compacted[\s\S]*?\]/, '').trim()
      if (clean.length > 5) {
        mem.currentTask = clean.length > 300 ? clean.slice(0, 297) + '…' : clean
      }
    }

    // Extract plan (numbered lists) and approach from assistant messages
    if (m.role === 'assistant' && m.content && mem.currentPlan.length === 0) {
      const text = stripThinking(m.content ?? '')
      // Look for numbered plan: "1. ...", "2. ..." etc.
      const planMatch = text.match(/(?:^|\n)\s*\d+[\.\)]\s+.+/g)
      if (planMatch && planMatch.length >= 2) {
        mem.currentPlan = planMatch.slice(0, 6).map((s) => s.trim().slice(0, 120))
      }
      // Approach: first meaningful sentence of the last assistant content
      if (!mem.approach && text.length > 10) {
        const firstSentence = text.replace(/\n/g, ' ').match(/^(.{10,200}?[.!?])/)
        if (firstSentence) mem.approach = firstSentence[1]
      }
    }

    // Track files modified and read, and search queries
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name
        if (!name) continue
        try {
          const args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments) : tc.function.arguments
          if ((name === 'write_file' || name === 'edit_file' || name === 'append_file') && args.path) {
            modifiedFiles.add(args.path)
          }
          if (name === 'create_directory' && args.path) {
            modifiedFiles.add(args.path + '/')
          }
          if (name === 'read_file' && args.path) {
            readFiles.add(args.path)
          }
          if (['search_arxiv', 'search_openalex', 'search_huggingface_papers', 'search_web'].includes(name) && args.query) {
            if (mem.searchesDone.length < 10) {
              mem.searchesDone.push(`${name.replace('search_', '')}:"${String(args.query).slice(0, 60)}"`)
            }
          }
        } catch {}
      }
    }

    // Extract research questions and hypotheses from assistant text
    if (m.role === 'assistant' && m.content && mem.researchQuestions.length < 5) {
      const text = stripThinking(m.content ?? '')
      const rqMatches = text.match(/(?:research question|sub-question|подвопрос|вопрос)[\s:]+(.{10,150})/gi)
      if (rqMatches) {
        for (const rq of rqMatches.slice(0, 3)) {
          const cleaned = rq.replace(/^.*?[:]\s*/, '').trim()
          if (cleaned.length > 10 && mem.researchQuestions.length < 5) mem.researchQuestions.push(cleaned.slice(0, 120))
        }
      }
      const hypMatches = text.match(/(?:hypothesis|hypothes[ei]s|гипотеза)[\s:]+(.{10,150})/gi)
      if (hypMatches) {
        for (const h of hypMatches.slice(0, 3)) {
          const cleaned = h.replace(/^.*?[:]\s*/, '').trim()
          if (cleaned.length > 10 && mem.hypotheses.length < 3) mem.hypotheses.push(cleaned.slice(0, 120))
        }
      }
    }

    // Extract key facts and last significant results
    if (m.role === 'tool' && m.content) {
      const c = m.content
      if (c.startsWith('Error') || c.includes('Exit code: 1')) {
        const line = c.split('\n')[0] ?? ''
        if (line.length > 10 && mem.keyFacts.length < 5) {
          mem.keyFacts.push(line.slice(0, 150))
        }
      }
      // Track last significant results (both success and error)
      if (mem.lastResults.length < 3) {
        const firstLine = c.split('\n')[0] ?? ''
        if (firstLine.length > 5) {
          mem.lastResults.push(firstLine.slice(0, 100))
        }
      }
    }
  }

  mem.filesModified = [...modifiedFiles].slice(0, 20)
  mem.filesRead = [...readFiles].slice(0, 15)
  return mem
}

function formatWorkingMemory(mem: WorkingMemory): string {
  const parts: string[] = []
  if (mem.currentTask) {
    parts.push(`**Current task:** ${mem.currentTask}`)
  }
  if (mem.approach) {
    parts.push(`**Current approach:** ${mem.approach}`)
  }
  if (mem.currentPlan.length > 0) {
    parts.push(`**Plan:**\n${mem.currentPlan.join('\n')}`)
  }
  if (mem.filesModified.length > 0) {
    parts.push(`**Files created/modified (do NOT re-read):** ${mem.filesModified.join(', ')}`)
  }
  if (mem.filesRead.length > 0) {
    const readOnly = mem.filesRead.filter((f) => !mem.filesModified.includes(f))
    if (readOnly.length > 0) {
      parts.push(`**Files already read (use offset/limit if needed again):** ${readOnly.join(', ')}`)
    }
  }
  if (mem.keyFacts.length > 0) {
    parts.push(`**Key facts:**\n${mem.keyFacts.map((f) => `- ${f}`).join('\n')}`)
  }
  if (mem.lastResults.length > 0) {
    parts.push(`**Recent results:** ${mem.lastResults.join(' | ')}`)
  }
  if (mem.researchQuestions.length > 0) {
    parts.push(`**Active research questions:**\n${mem.researchQuestions.map((q) => `- ${q}`).join('\n')}`)
  }
  if (mem.hypotheses.length > 0) {
    parts.push(`**Working hypotheses:**\n${mem.hypotheses.map((h) => `- ${h}`).join('\n')}`)
  }
  if (mem.searchesDone.length > 0) {
    parts.push(`**Searches performed (avoid repeating):** ${mem.searchesDone.join(', ')}`)
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Tiered compression pipeline
// ---------------------------------------------------------------------------

// Tier 0: Strip thinking from stored assistant messages (done on insert, not here)

// Tier 1: Compress old tool results — those the model has already acted upon
function tier1CompressOldToolResults(msgs: Message[]): { msgs: Message[]; saved: number } {
  let saved = 0
  const result = [...msgs]
  const budget = getMessageBudget()

  // Adaptive limits based on context size
  const oldThreshold = budget < 8000 ? 300 : budget < 15000 ? 500 : 800
  const oldLimit = budget < 8000 ? 150 : budget < 15000 ? 250 : 400
  // Also compress recent results on small contexts (but less aggressively)
  const recentThreshold = budget < 8000 ? 600 : budget < 15000 ? 1200 : Infinity
  const recentLimit = budget < 8000 ? 300 : budget < 15000 ? 600 : Infinity

  const recentTurns = keepRecentTurns()
  let recentStart = result.length
  let userCount = 0
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }

  for (let i = 0; i < result.length; i++) {
    const m = result[i]
    if (m.role !== 'tool' || !m.content) continue

    const isOld = i < recentStart
    const threshold = isOld ? oldThreshold : recentThreshold
    const limit = isOld ? oldLimit : recentLimit

    if (m.content.length > threshold) {
      const compressed = compressToolResultText(m.content, limit)
      saved += m.content.length - compressed.length
      result[i] = { ...m, content: compressed }
    }
  }

  return { msgs: result, saved }
}

// Tier 2: Collapse entire old tool-call chains to one-liners
function tier2CollapseOldChains(msgs: Message[]): { msgs: Message[]; saved: number } {
  let saved = 0
  const result: Message[] = []

  const recentTurns = keepRecentTurns()
  let recentStart = msgs.length
  let userCount = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }

  let i = 0
  while (i < msgs.length) {
    if (i >= recentStart) {
      result.push(msgs[i])
      i++
      continue
    }

    const m = msgs[i]

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const chainSummary = toolCallOneLiner(m)
      const toolCount = m.tool_calls.length
      let toolResults: string[] = []
      let j = i + 1
      while (j < msgs.length && j < i + 1 + toolCount && msgs[j].role === 'tool') {
        const r = msgs[j].content ?? ''
        const isError = r.startsWith('Error') || r.includes('Exit code: 1')
        if (isError) {
          toolResults.push(r.length > 150 ? r.slice(0, 147) + '…' : r)
        } else {
          toolResults.push(r.length > 80 ? r.slice(0, 77) + '…' : r)
        }
        saved += (msgs[j].content ?? '').length
        j++
      }

      const oldText = (m.content ? stripThinking(m.content) : '')
      saved += (m.content ?? '').length

      const collapsed = [
        oldText ? oldText + '\n' : '',
        `[Executed: ${chainSummary}]`,
        toolResults.length > 0 ? toolResults.map((r) => `→ ${r}`).join('\n') : '',
      ].filter(Boolean).join('\n')

      saved -= collapsed.length
      result.push({ role: 'assistant', content: collapsed })
      i = j
      continue
    }

    result.push(m)
    i++
  }

  return { msgs: result, saved }
}

// Tier 3: LLM-based summarization of old conversation
async function tier3Summarize(
  msgs: Message[],
  apiUrl: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const systemMsg = msgs.find((m) => m.role === 'system')

  const recentTurns = keepRecentTurns()
  let recentStart = msgs.length
  let userCount = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }
  while (recentStart > 0 && msgs[recentStart]?.role !== 'user') recentStart++

  const oldMessages = msgs.slice(systemMsg ? 1 : 0, recentStart)
  const recentMessages = msgs.slice(recentStart)

  if (oldMessages.length < 3) return msgs

  const workingMem = extractWorkingMemory(msgs)

  // Format old messages compactly for summarization
  const parts: string[] = []
  for (const m of oldMessages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      parts.push(`**User:** ${(m.content ?? '').slice(0, 500)}`)
    } else if (m.role === 'assistant') {
      const text = stripThinking(m.content ?? '').slice(0, 400)
      parts.push(`**Assistant:** ${text}`)
    } else if (m.role === 'tool') {
      parts.push(`**Tool:** ${(m.content ?? '').slice(0, 200)}`)
    }
  }
  const conversationText = parts.join('\n\n')

  const maxSummaryInputTokens = Math.floor(getMessageBudget() * 0.4)
  const maxSummaryInputChars = maxSummaryInputTokens * 3
  const truncatedText = conversationText.length > maxSummaryInputChars
    ? conversationText.slice(0, Math.floor(maxSummaryInputChars * 0.7)) +
      '\n\n…[middle omitted]…\n\n' +
      conversationText.slice(-Math.floor(maxSummaryInputChars * 0.2))
    : conversationText

  try {
    const summaryAbort = new AbortController()
    const summaryTimeout = setTimeout(() => {
      try { summaryAbort.abort() } catch {}
    }, SUMMARIZE_TIMEOUT_MS)
    const combinedSignal = signal
      ? AbortSignal.any([signal, summaryAbort.signal])
      : summaryAbort.signal

    const summaryMaxTokens = Math.min(1024, Math.floor(getMessageBudget() * 0.3))
    const fetchPromise = fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen',
        messages: [{ role: 'user', content: getSummarizePrompt() + truncatedText }],
        temperature: 0.1,
        max_tokens: Math.max(256, summaryMaxTokens),
      }),
      signal: combinedSignal,
    })
    const r = await Promise.race([
      fetchPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARIZE_TIMEOUT_MS + 2000)),
    ])
    clearTimeout(summaryTimeout)
    if (!r) {
      debugLog('CTX', 'tier3Summarize: hard timeout — skipping LLM summary')
      return msgs
    }
    if (!r.ok) return msgs
    const json = await r.json() as any
    const summary = json.choices?.[0]?.message?.content
    if (!summary || summary.length < 50) return msgs

    const memBlock = formatWorkingMemory(workingMem)
    const baseSystem = systemMsg?.content ?? getSystemPrompt()

    const marker = '\n\n## Working memory\n'
    const markerIdx = baseSystem.indexOf(marker)
    const cleanBase = markerIdx >= 0 ? baseSystem.slice(0, markerIdx) : baseSystem

    const summaryMarker = '\n\n## Summary of earlier conversation\n'
    const summaryIdx = cleanBase.indexOf(summaryMarker)
    const pureBase = summaryIdx >= 0 ? cleanBase.slice(0, summaryIdx) : cleanBase

    // Budget for system prompt: leave enough room for recent messages
    const budget = getMessageBudget()
    const recentTokens = estimateContextTokens(recentMessages)
    const sysTokenBudget = Math.max(500, budget - recentTokens - 100)
    const sysCharBudget = Math.floor(sysTokenBudget * calibratedRatio)

    // Build system content, truncating summary/memory if needed
    let summaryText = summary
    let memText = memBlock
    const baseLen = pureBase.length + marker.length + summaryMarker.length + 20
    const availForSummary = sysCharBudget - baseLen
    if (availForSummary < 200) {
      summaryText = ''
      memText = ''
    } else {
      const memLen = memText.length
      const summaryBudget = availForSummary - Math.min(memLen, Math.floor(availForSummary * 0.3))
      if (summaryText.length > summaryBudget) {
        summaryText = summaryText.slice(0, summaryBudget - 10) + '\n…[truncated]'
      }
      if (memText.length > Math.floor(availForSummary * 0.3)) {
        memText = memText.slice(0, Math.floor(availForSummary * 0.3) - 10) + '\n…'
      }
    }

    const newSystem = pureBase +
      (memText ? marker + memText + '\n' : '') +
      (summaryText ? summaryMarker + summaryText + '\n' : '')

    // Also truncate recent tool results if still too big
    const compactRecent = recentMessages.map((m) => {
      if (m.role === 'tool' && m.content && m.content.length > 600) {
        return { ...m, content: compressToolResultText(m.content, 400) }
      }
      return m
    })

    const compacted: Message[] = [
      { role: 'system', content: newSystem },
      ...compactRecent,
    ]

    const newTokens = estimateContextTokens(compacted)
    const pctUsed = Math.round((newTokens / budget) * 100)
    doEmit( {
      type: 'status',
      content: `✅ Контекст сжат: ${oldMessages.length} сообщений → саммари. ~${pctUsed}% бюджета`,
    })

    return compacted
  } catch {
    return msgs
  }
}

// Tier 4: Emergency hard prune — absolute last resort
function tier4EmergencyPrune(msgs: Message[]): Message[] {
  const budget = getMessageBudget()

  const result = [...msgs]

  // Step 1: Aggressively truncate all tool results
  for (let i = 0; i < result.length; i++) {
    const m = result[i]
    if (m.role === 'tool' && m.content && m.content.length > 200) {
      result[i] = { ...m, content: m.content.slice(0, 150) + '\n…[pruned]' }
    }
  }

  // Step 2: Strip summary and working memory from system prompt
  const sysIdx = result.findIndex((m) => m.role === 'system')
  if (sysIdx >= 0 && result[sysIdx].content) {
    let sysTxt = result[sysIdx].content!
    const summaryMark = sysTxt.indexOf('\n\n## Summary of earlier')
    if (summaryMark >= 0) sysTxt = sysTxt.slice(0, summaryMark)
    const memMark = sysTxt.indexOf('\n\n## Working memory')
    if (memMark >= 0) sysTxt = sysTxt.slice(0, memMark)
    result[sysIdx] = { ...result[sysIdx], content: sysTxt }
  }

  let tokens = estimateContextTokens(result)
  if (tokens <= budget) return result

  // Step 3: Drop messages from the front (keep system + last user + last N)
    const system = result.find((m) => m.role === 'system')
    const rest = result.filter((m) => m.role !== 'system')

  // Always preserve the last user message to satisfy chat template requirements
  let lastUserIdx = -1
  for (let j = rest.length - 1; j >= 0; j--) {
    if (rest[j].role === 'user') { lastUserIdx = j; break }
  }

  let keep = rest.length
  while (keep > 2) {
    keep--
    let kept = rest.slice(rest.length - keep)
    // Ensure the last user message is always included
    if (lastUserIdx >= 0 && rest.length - keep > lastUserIdx) {
      const userMsg = rest[lastUserIdx]
      if (!kept.some((m) => m.role === 'user')) {
        kept = [userMsg, ...kept]
      }
    }
    const candidate = system ? [system, ...kept] : kept
    if (estimateContextTokens(candidate) <= budget) return candidate
  }

  // Step 4: Hard truncate system prompt to fit
  const lastMsgs = lastUserIdx >= 0
    ? [rest[lastUserIdx], ...rest.slice(-2).filter((m) => m !== rest[lastUserIdx])].slice(0, 3)
    : rest.slice(-2)
  const restTokens = estimateContextTokens(lastMsgs)
  const sysTokenBudget = Math.max(100, budget - restTokens - 50)
  const sysCharBudget = Math.floor(sysTokenBudget * calibratedRatio)

  if (system && system.content) {
    const sysTruncated = system.content.slice(0, sysCharBudget) + '\n…[truncated]'
    return [{ ...system, content: sysTruncated }, ...lastMsgs]
  }

  return system ? [system, ...lastMsgs] : lastMsgs
}

// ---------------------------------------------------------------------------
// Inject working memory into system prompt — survives compression
// ---------------------------------------------------------------------------

function injectWorkingMemory(msgs: Message[], originalMsgs: Message[]): Message[] {
  const mem = extractWorkingMemory(originalMsgs)
  const memBlock = formatWorkingMemory(mem)
  if (!memBlock) return msgs

  const sysIdx = msgs.findIndex((m) => m.role === 'system')
  if (sysIdx < 0) return msgs

  let sysTxt = msgs[sysIdx].content ?? ''
  const memMark = sysTxt.indexOf('\n\n## Working memory\n')
  if (memMark >= 0) sysTxt = sysTxt.slice(0, memMark)

  // Budget: working memory shouldn't exceed 15% of message budget
  const maxChars = Math.floor(getMessageBudget() * calibratedRatio * 0.15)
  const memTrimmed = memBlock.length > maxChars ? memBlock.slice(0, maxChars - 10) + '\n…' : memBlock

  sysTxt += '\n\n## Working memory\n' + memTrimmed
  msgs[sysIdx] = { ...msgs[sysIdx], content: sysTxt }
  return msgs
}

// ---------------------------------------------------------------------------
// Rehydration: guide model after compaction so it doesn't re-read everything
// ---------------------------------------------------------------------------

function getLastToolAction(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const names = m.tool_calls.map((tc) => {
        const name = tc.function?.name ?? '?'
        try {
          const args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments) : tc.function?.arguments
          const target = args?.path ?? args?.command?.slice(0, 60) ?? ''
          return target ? `${name}(${target})` : name
        } catch { return name }
      })
      return names.join(', ')
    }
  }
  return 'unknown'
}

function injectRehydrationHint(msgs: Message[], originalMsgs: Message[]): Message[] {
  const mem = extractWorkingMemory(originalMsgs)
  const lastAction = getLastToolAction(originalMsgs)
  const recentFiles = mem.filesModified.slice(-3)

  const parts: string[] = [
    '[Context was compacted to save space. Summary of earlier work is in the system prompt above.]',
  ]
  if (lastAction !== 'unknown') {
    parts.push(`Your last action was: ${lastAction}`)
  }
  if (recentFiles.length > 0) {
    parts.push(`Files you were working on: ${recentFiles.join(', ')}`)
  }
  parts.push('Continue from where you left off. Do NOT re-read files you already read unless you need a specific section (use offset/limit). Proceed with the next step of the task.')

  msgs.push({ role: 'user', content: parts.join('\n') })
  return msgs
}

// ---------------------------------------------------------------------------
// Main context management — graduated compression pipeline
// ---------------------------------------------------------------------------

let lastTier3Iteration = -10

async function manageContext(
  msgs: Message[],
  apiUrl: string,
  signal?: AbortSignal,
  iteration?: number,
  opts?: { skipTier3?: boolean },
): Promise<Message[]> {
  const budget = getMessageBudget()
  let tokens = estimateContextTokens(msgs)
  const useDiskSnapshot = researchContextMode !== 'off' && Boolean(activeResearchOutputDir)

  debugLog('CTX', `manageContext: ${msgs.length} msgs, ${tokens} tokens, budget=${budget}, ctx=${ctxTokens()}, ratio=${(tokens/budget*100).toFixed(0)}%, researchMode=${researchContextMode}`)

  // Under threshold — no compression needed
  if (tokens <= budget * COMPRESS_TOOL_RESULTS_AT) return msgs

  emitActivity(
    'context_compress',
    'Сжимаю контекст для продолжения…',
    `${msgs.length} сообщений · ~${Math.round(tokens / 1024)}K / ${Math.round(budget / 1024)}K токенов`,
  )

  // Preserve original messages for working memory extraction before compression
  const originalMsgs = [...msgs]
  let current = msgs

  // Tier 1: Compress old tool results
  if (tokens > budget * COMPRESS_TOOL_RESULTS_AT) {
    emitActivity('context_compress', 'Сжатие: компактные результаты инструментов…')
    const { msgs: compressed } = tier1CompressOldToolResults(current)
    current = compressed
    tokens = estimateContextTokens(current)
    if (tokens <= budget * SUMMARIZE_AT) {
      return injectWorkingMemory(current, originalMsgs)
    }
  }

  // Tier 2: Collapse old tool-call chains
  if (tokens > budget * SUMMARIZE_AT) {
    emitActivity('context_compress', 'Сжатие: сворачиваю старые tool-цепочки…')
    const nonSystem = current.filter((m) => m.role !== 'system')
    if (nonSystem.length >= 6) {
      const { msgs: collapsed } = tier2CollapseOldChains(current)
      current = collapsed
      tokens = estimateContextTokens(current)
      if (tokens <= budget * AGGRESSIVE_PRUNE_AT) {
        return injectWorkingMemory(current, originalMsgs)
      }
    }
  }

  // Tier 3: LLM summarization (with cooldown to avoid spamming on small contexts)
  const iter = iteration ?? 0
  const tier3Cooldown = budget < 8000 ? 5 : budget < 15000 ? 3 : 2
  const tier3Ready = (iter - lastTier3Iteration) >= tier3Cooldown

  // NOTE: the research working set is NOT injected into the message history here.
  // It is delivered as a transient tail message at call time (appendResearchTail)
  // so the stored history + system prompt remain a stable prefix for the KV cache.

  // Tier 3b (general chat): LLM summarization — never used during research runs
  const noTier3 = opts?.skipTier3 ?? useDiskSnapshot
  if (tokens > budget * SUMMARIZE_AT && tier3Ready && !noTier3) {
    const nonSystem = current.filter((m) => m.role !== 'system')
    if (nonSystem.length >= 4) {
      emitActivity('context_compress', 'Сжатие: LLM-саммари истории (GPU)…')
      current = await tier3Summarize(current, apiUrl, signal)
      lastTier3Iteration = iter
      tokens = estimateContextTokens(current)
      current = injectRehydrationHint(current, originalMsgs)
      if (tokens <= budget * EMERGENCY_AT) return current
    }
  }

  // Tier 4: structural prune when still over budget
  const tier4Threshold = useDiskSnapshot ? budget * SUMMARIZE_AT : budget * EMERGENCY_AT
  if (tokens > tier4Threshold) {
    emitActivity(
      'context_compress',
      useDiskSnapshot
        ? 'Структурное сжатие chat-истории (research-данные в .research/)…'
        : 'Экстренное сжатие контекста…',
    )
    doEmit({ type: 'status', content: useDiskSnapshot ? '🗜️ Сжатие chat-истории — полные данные в .research/' : '⚠️ Экстренная обрезка контекста' })
    current = tier4EmergencyPrune(current)
    current = injectRehydrationHint(current, originalMsgs)
  }

  return current
}

/**
 * Append the disk-backed research working set as a transient TAIL user message.
 *
 * Prefix-cache discipline: the returned array is used only for the LLM call. The
 * persistent `messages` stay append-only and the system prompt is never mutated,
 * so llama-server keeps its KV-cache prefix (context checkpoints) valid between
 * iterations. Returns the same array reference when not in a research run.
 */
function appendResearchTail(msgs: Message[]): Message[] {
  if (researchContextMode === 'off' || !activeResearchOutputDir) return msgs
  const tail = buildResearchTailMessage(
    workspace,
    activeResearchOutputDir,
    Math.floor(getMessageBudget() * calibratedRatio * 0.15),
  )
  if (!tail) return msgs
  return [...msgs, tail as Message]
}

// Cached project context — invalidated on workspace change
let projectContextCache: { ws: string; ctx: string; ts: number } | null = null
const PROJECT_CTX_CACHE_TTL = 60000

export function invalidateProjectContextCache() {
  projectContextCache = null
}

function getProjectContext(ws: string): string {
  try {
    // Return cached if fresh
    if (projectContextCache && projectContextCache.ws === ws && (Date.now() - projectContextCache.ts) < PROJECT_CTX_CACHE_TTL) {
      return budgetTrimProjectContext(projectContextCache.ctx)
    }

    // Build full context (cached at max detail level)
    const tree = executeTool('list_directory', { depth: 2 }, ws)
    let ctx = `## Project: ${ws}\n\`\`\`\n${tree}\n\`\`\`\n`

    const fs = require('fs')
    const path = require('path')
    const indicators: [string, string][] = [
      ['package.json', 'Node.js'],
      ['Cargo.toml', 'Rust'],
      ['go.mod', 'Go'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['pom.xml', 'Java/Maven'],
      ['CMakeLists.txt', 'C/C++ CMake'],
      ['Dockerfile', 'Docker'],
    ]
    const detected: string[] = []
    for (const [file, desc] of indicators) {
      if (fs.existsSync(path.join(ws, file))) detected.push(desc)
    }
    if (detected.length > 0) {
      ctx += `Type: ${detected.join(', ')}\n`
    }

    // Include .research/ directory contents if it exists
    const researchDir = path.join(ws, '.research')
    if (fs.existsSync(researchDir) && fs.statSync(researchDir).isDirectory()) {
      try {
        const researchTree = executeTool('list_directory', { path: '.research', depth: 2 }, ws)
        ctx += `\n## Research workspace (.research/)\n\`\`\`\n${researchTree}\n\`\`\`\n`
        const planPath = path.join(researchDir, 'plan.md')
        if (fs.existsSync(planPath)) {
          const planContent = fs.readFileSync(planPath, 'utf-8').trim()
          if (planContent) {
            const planSnippet = planContent.length > 1000 ? planContent.slice(0, 1000) + '\n...' : planContent
            ctx += `### Research plan\n${planSnippet}\n`
          }
        }
      } catch {}
    }

    projectContextCache = { ws, ctx, ts: Date.now() }
    return budgetTrimProjectContext(ctx)
  } catch {
    return ''
  }
}

function budgetTrimProjectContext(ctx: string): string {
  const ctxSize = ctxTokens()
  // Budget-aware sizing: smaller contexts get smaller repo maps
  let maxLines: number
  if (ctxSize < 16384) maxLines = 15
  else if (ctxSize < 32768) maxLines = 30
  else maxLines = Infinity

  if (maxLines < Infinity) {
    const lines = ctx.split('\n')
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + '\n…[truncated]\n'
    }
  }

  const budgetFraction = ctxSize < 16384 ? 0.12 : ctxSize < 32768 ? 0.20 : 0.35
  const budgetForCtx = Math.max(Math.floor(getMessageBudget() * budgetFraction), 200)
  if (ctx.length > budgetForCtx) {
    return ctx.slice(0, budgetForCtx - 20) + '\n…[truncated]\n'
  }
  return ctx
}

export function setWorkspace(ws: string) {
  workspace = ws
  invalidateProjectContextCache()
}

export function resetAgent(ws: string) {
  const session = getActiveSession(ws)
  session.messages = []
  session.projectContextAdded = false
  session.updatedAt = Date.now()
  saveSession(session)
}

export function isCancelRequested(): boolean {
  return cancelRequested
}

export function cancelAgent() {
  cancelRequested = true
  if (currentAbort) {
    try {
      currentAbort.abort()
    } catch {
      // ignore
    }
  }
}

function finishAgentError(session: Session, messages: Message[], message: string): string {
  emitActivity('done', 'Остановлено')
  doEmit({ type: 'error', content: message })
  doEmit({ type: 'response', content: '', done: true })
  session.messages = messages
  session.updatedAt = Date.now()
  doSaveSession(session)
  return message.startsWith('Error:') ? message : `Error: ${message}`
}

function toolLoopSignature(toolName: string, toolArgs: Record<string, any>): string {
  if (toolName === 'record_evidence') {
    const claim = String(toolArgs.claim ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)
    return `${toolName}:${claim}:${toolArgs.plan_item_id ?? ''}:${String(toolArgs.corpus_ids ?? toolArgs.corpusIds ?? '').slice(0, 48)}`
  }
  if (toolName === 'extract_evidence_from_corpus_item') {
    // Key on the source + plan item + claim, ignoring volatile session_id/output_dir.
    // Re-extracting the SAME corpus item for the SAME plan item never changes state,
    // so identical calls across turns must collapse to a single loop signature.
    const claim = String(toolArgs.claim ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)
    return `${toolName}:${toolArgs.corpus_id ?? toolArgs.corpusId ?? ''}:${toolArgs.plan_item_id ?? ''}:${claim}`
  }
  if (['run_quality_gates', 'gate_report', 'list_selected_corpus', 'list_evidence', 'full_text_status', 'verify_claims', 'screen_corpus', 'build_corpus', 'evidence_coverage_by_plan', 'evidence_matrix', 'audit_research_run', 'generate_evidence_report'].includes(toolName)) {
    return `${toolName}:${toolArgs.output_dir ?? ''}`
  }
  return `${toolName}:${JSON.stringify(toolArgs)}`
}

/** Read/fetch tools whose repeated failures indicate a data-gathering stall. */
function isSourceReadTool(toolName: string): boolean {
  return toolName === 'read_corpus_item' || toolName === 'read_full_text_batch' || toolName === 'fetch_url'
}

/** Heuristic: did a source-read tool fail to retrieve usable content? */
function isFailedReadResult(toolName: string, result: string): boolean {
  if (!isSourceReadTool(toolName)) return false
  const r = String(result || '')
  if (r.startsWith('Error')) return true
  // read_full_text_batch returns a summary; treat as failure only if nothing was read.
  if (toolName === 'read_full_text_batch') return /\b0\s+(?:read|succeeded|ok)\b/i.test(r) && /fail/i.test(r)
  return /fetch_url failed|fetch failed|:\s*failed\b|HTTP\s+\d{3}|could not (?:fetch|retrieve|read)|unavailable/i.test(r)
}

function isLoopSensitiveTool(toolName: string): boolean {
  return ['read_file', 'list_directory', 'find_files', 'record_evidence', 'extract_evidence_from_corpus_item', 'run_quality_gates', 'gate_report', 'list_selected_corpus', 'list_evidence', 'full_text_status', 'verify_claims', 'screen_corpus', 'build_corpus', 'evidence_coverage_by_plan', 'evidence_matrix', 'audit_research_run', 'generate_evidence_report'].includes(toolName)
}

function duplicateToolThreshold(toolName: string): number {
  return ['list_selected_corpus', 'list_evidence', 'full_text_status', 'verify_claims', 'screen_corpus', 'build_corpus', 'evidence_coverage_by_plan', 'evidence_matrix', 'audit_research_run', 'generate_evidence_report', 'extract_evidence_from_corpus_item'].includes(toolName) ? 1 : 2
}

/**
 * Forward-driving message returned when a read-only inspection tool is called
 * repeatedly with identical arguments. Inspection tools never change state, so
 * the only useful move is to advance the workflow. For research runs the
 * terminal path is run_quality_gates (which auto-generates report.md once gates
 * pass), so we point the model there instead of letting it re-inspect forever.
 */
function loopBreakDirective(toolName: string): string {
  const INSPECTION_TOOLS = new Set([
    'evidence_coverage_by_plan', 'evidence_matrix', 'list_evidence', 'list_selected_corpus',
    'full_text_status', 'verify_claims', 'audit_research_run', 'gate_report',
  ])
  if (toolName === 'record_evidence') {
    return `You already recorded this evidence claim. Use list_evidence / verify_claims, fix quality gate blockers if any, then proceed to generate_evidence_report. Do not re-record duplicates.`
  }
  if (toolName === 'extract_evidence_from_corpus_item') {
    return `You already extracted this SAME claim from this SAME corpus item for this SAME plan item — re-extracting it never adds a new evidence row and never changes state. STOP re-extracting it. If a plan item is still short on evidence, you MUST do ONE of these instead: (a) extract a DIFFERENT claim, or extract from a DIFFERENT corpus_id, for that plan item; (b) if no corpus item contains usable new information for that plan item, accept that the data is insufficient — do NOT fabricate or duplicate — and move on; (c) when every plan item has the evidence the corpus can support, call run_quality_gates once (it auto-generates report.md when gates pass). A plan item with fewer rows than ideal is acceptable when the sources genuinely lack more data; padding it with duplicate extractions is not.`
  }
  if (toolName === 'run_quality_gates') {
    return `Quality gates were just run with the same output_dir. Read the blockers, fix corpus/evidence/full-text issues, then rerun once — not in a loop.`
  }
  if (toolName === 'generate_evidence_report') {
    return `report.md has already been generated on disk and regenerating with the same inputs produces an identical file. The only outstanding gate is final_report_structure, which is a non-blocking structural/cosmetic check — it does NOT prevent the report from being final. Stop calling generate_evidence_report. Give the user a short final summary and point them to the report.md you produced.`
  }
  if (INSPECTION_TOOLS.has(toolName)) {
    return `You already called ${toolName}; this is a read-only inspection tool and its result will not change. Stop inspecting. Per-section coverage is whatever it is — if a section is genuinely short, record one more grounded claim with record_evidence/extract_evidence_from_corpus_item; otherwise call run_quality_gates now (it auto-generates report.md once gates pass). Do not call any inspection tool again.`
  }
  return `You already called ${toolName} with these exact arguments; the result hasn't changed. Stop re-running it and proceed with the next concrete step from the live Research state. If gates are the next step, call run_quality_gates once.`
}

export async function runAgent(userMessage: string, ws: string, bridge: AgentBridge): Promise<string> {
  currentBridge = bridge
  try {
  emitActivity('starting', 'Запуск агента…')
  workspace = ws
  cancelRequested = false
  lastTier3Iteration = -10

  const session = doGetSession()
  let { messages } = session

  // Auto-title from first user message
  if (session.title === 'Новый чат' && messages.filter((m) => m.role === 'user').length === 0) {
    session.title = titleFromMessage(userMessage)
  }

  // On first message in this session, prepend project context
  if (!session.projectContextAdded && ws) {
    const ctx = getProjectContext(ws)
    if (ctx) {
      messages = [
        { role: 'system', content: getSystemPrompt() + '\n\n' + ctx },
        ...messages.filter((m) => m.role !== 'system'),
      ]
    } else {
      if (!messages.some((m) => m.role === 'system')) {
        messages.unshift({ role: 'system', content: getSystemPrompt() })
      }
    }
    session.projectContextAdded = true
  } else if (!messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: getSystemPrompt() })
  }

  activeResearchOutputDir = resolveResearchOutputDir(ws, messages, userMessage)
  activeWorkspace = ws
  researchContextMode = resolveResearchContextMode({
    userMessage,
    presetId: (doGetConfig() as any).selectedPreset,
    outputDir: activeResearchOutputDir,
  })
  const resumeLike = isResearchResumeMessage(userMessage)
  const approvalLike = isPlanApprovalMessage(userMessage)
  const approvalPromptPending = hasRecentPlanApprovalPrompt(messages as Message[])
  const hasSavedPlan = Boolean(activeResearchOutputDir && parsePlan(ws, activeResearchOutputDir).length > 0)
  const { planApproved, planBootstrapApproved, researchResume } = decideResearchCommandIntent({
    resumeLike,
    approvalLike,
    approvalPromptPending,
    hasOutputDir: Boolean(activeResearchOutputDir),
    hasSavedPlan,
    contextModeOff: researchContextMode === 'off',
  })
  if (activeResearchOutputDir && researchContextMode !== 'off') {
    updateResearchRunState(ws, {
      outputDir: activeResearchOutputDir,
      phase: researchResume ? 'started' : 'started',
    })
  }
  if (planApproved && activeResearchOutputDir) {
    const spec = ensureResearchRunSpec(ws, activeResearchOutputDir, { state: 'PLANNED' })
    doEmit({
      type: 'status',
      content: `✅ План утверждён. Перехожу к поиску источников для \`${activeResearchOutputDir}\`.`,
    })
    messages.push({
      role: 'user',
      content: [
        '[Research workflow checkpoint approved]',
        `The user approved the saved plan for output_dir: "${activeResearchOutputDir}".`,
        formatWorkflowGuidance(spec),
        'Do not restate the plan and do not ask for approval again.',
        'Next action: call one focused search tool now (`search_arxiv`, `search_openalex`, `search_huggingface_papers`, or `search_web`) with a query derived from the approved plan and 2024-2026 date range. After search results, build_corpus and screen_corpus for the same output_dir.',
      ].join('\n'),
    })
  }

  if (planBootstrapApproved && activeResearchOutputDir) {
    doEmit({
      type: 'status',
      content: `✅ План утверждён. Сначала сохраняю его в \`${activeResearchOutputDir}/plan.md\`, затем перейду к поиску источников.`,
    })
    messages.push({
      role: 'user',
      content: [
        '[Research workflow plan approved — plan.md is not saved yet]',
        `The user approved the research plan you just proposed for output_dir: "${activeResearchOutputDir}".`,
        'Mandatory next action: call `plan_research` now.',
        'Use the exact top-level question and sub-questions from your previous assistant message; do not ask for approval again.',
        `Pass output_dir exactly as "${activeResearchOutputDir}".`,
        'After plan_research succeeds, continue immediately with the next valid pipeline action: search sources for the approved sub-questions.',
      ].join('\n'),
    })
  }

  if (researchResume) {
    const summary = researchRunProgressSummary(ws, activeResearchOutputDir ?? undefined)
    if (summary) {
      activeResearchOutputDir = summary.dir
      researchContextMode = 'resume'
      emitActivity('resume_checkpoint', 'Продолжаю research run с диска', summary.detail)
      doEmit({ type: 'status', content: summary.statusLine })
      const wsBudget = wantsCompactContext(userMessage) ? 3500 : 5500
      messages = buildResumeMessageWindow(
        getSystemPrompt(),
        ws,
        summary.dir,
        summary.brief,
        userMessage,
        wsBudget,
      ) as Message[]
    } else {
      emitActivity('resume_checkpoint', 'Checkpoint .research/ не найден', 'Структурное сжатие текущей истории')
      doEmit({ type: 'status', content: '⚠️ Каталог .research/ не найден — сжимаю историю; research-state недоступен.' })
      messages = tier4EmergencyPrune(messages)
      messages.push({ role: 'user', content: userMessage })
    }
  } else {
    // Research working set is delivered as a transient tail message per call
    // (appendResearchTail); the stored history stays append-only for prefix caching.
    if (!planApproved && !planBootstrapApproved) messages.push({ role: 'user', content: userMessage })
  }
  session.messages = messages

  const apiUrl = `${doGetApiUrl()}/v1/chat/completions`

  emitActivity('context_compress', 'Подготавливаю контекст модели…')

  // Calibrate token ratio from server (non-blocking, happens once)
  calibrateTokenRatio().catch(() => {})

  // Verify actual server ctx size (catches mismatches from server auto-reducing ctx)
  doQueryActualCtxSize().catch(() => {})

  // Summarize/prune context if approaching limit
  messages = await manageContext(messages, apiUrl)
  session.messages = messages
  emitContextUsage( messages)
  let fullResponse = ''
  let emptyRetries = 0

  // Track files created this turn to detect pointless re-reads after compression
  const filesCreatedThisTurn = new Set<string>()
  let consecutiveReReads = 0

  // General loop detection: same tool + same args repeated (single loop-breaker)
  let lastToolSig = ''
  let sameToolRepeatCount = 0
  // Data-gathering stall guard: count consecutive failing source reads (different
  // IDs each time, so the identical-args loop guard never catches it). After a
  // streak we inject a one-time recovery directive so the agent stops hammering
  // unfetchable URLs and re-screens / re-searches / finishes honestly.
  let consecutiveReadFailures = 0
  let stallDirectiveInjected = false
  // Evidence-loop escalation: when the model keeps re-issuing the SAME evidence /
  // extraction call (loop-break directive ignored), the duplicate guard short-
  // circuits each turn but the model keeps burning context. After a few ignored
  // breaks in a managed research run we force-advance to quality gates (which
  // auto-generates report.md once gates pass) so the run terminates instead of
  // padding evidence forever / overflowing context.
  let evidenceLoopBreaks = 0
  let forcedGateRunDone = false

  const EVIDENCE_LOOP_TOOLS = new Set(['record_evidence', 'extract_evidence_from_corpus_item'])
  /**
   * Called whenever a duplicate loop-break fires. For repeated evidence/extraction
   * loops in a research run, force run_quality_gates once and inject a hard "stop
   * gathering, finish honestly" directive. Returns true if it injected the forced
   * directive (so callers can avoid double-injecting the normal skip message).
   */
  const escalateEvidenceLoop = (toolName: string): boolean => {
    if (!EVIDENCE_LOOP_TOOLS.has(toolName)) return false
    evidenceLoopBreaks++
    if (evidenceLoopBreaks < 3 || forcedGateRunDone || !activeResearchOutputDir) return false
    forcedGateRunDone = true
    try {
      const gateArgs = { output_dir: activeResearchOutputDir, session_id: session.id }
      doEmit({ type: 'status', content: '⛔ Модель зациклилась на извлечении доказательств — принудительно запускаю quality gates и перехожу к отчёту.' })
      doEmit({ type: 'tool_call', name: 'run_quality_gates', args: gateArgs })
      // Route through followUpQualityGates so report.md is auto-generated when
      // gates pass (same path as a normal run_quality_gates call), rather than
      // relying on the model to obey the directive below.
      let gateResult = executeTool('run_quality_gates', gateArgs, workspace)
      gateResult = followUpQualityGates('run_quality_gates', gateArgs, gateResult, session, workspace)
      doEmit({ type: 'tool_result', name: 'run_quality_gates', result: gateResult.length > 4000 ? gateResult.slice(0, 4000) + '\n… [truncated]' : gateResult })
      messages.push({
        role: 'user',
        content: [
          '[Runtime hard stop] You repeatedly re-issued the SAME evidence/extraction call; the runtime ran quality gates for you (result above).',
          'STOP extracting evidence now. Re-extracting the same claim from the same source never adds rows.',
          'A plan item with fewer rows than ideal is ACCEPTABLE when the sources genuinely lack more data — do not pad it with duplicates and do not fabricate.',
          'If gates passed, report.md was already generated for you — just give the user a short final summary. If gates list blockers, fix only what a NEW, distinct source/claim can fix; otherwise document the data-availability limitation honestly and finish. Do not loop.',
        ].join('\n'),
      })
    } catch {}
    return true
  }

  for (let i = 0; i < getMaxIterations(); i++) {
    if (doIsCancelRequested()) {
      doEmit( { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
      session.updatedAt = Date.now()
      doSaveSession(session)
      return 'Canceled'
    }

    // Signal the UI to start a new assistant "bubble" for each iteration
    if (i > 0) {
      doEmit( { type: 'new_turn' })
      fullResponse = ''
    }

    // Pre-flight: sanitize structure + ensure messages fit in context budget.
    // Token accounting includes the transient research tail so the clamp is exact.
    messages = sanitizeMessages(messages)
    const accurateTokens = await countContextTokensAccurate(appendResearchTail(messages))
    const preflightBudget = getMessageBudget()
    const serverCtx = ctxTokens()
    debugLog('PREFLIGHT', `iter=${i}, msgs=${messages.length}, tokens=${accurateTokens}, budget=${preflightBudget}, ctx=${serverCtx}, ratio=${(accurateTokens/preflightBudget*100).toFixed(0)}%, maxResp=${getMaxResponseTokens()}`)

    if (accurateTokens > preflightBudget * EMERGENCY_AT) {
      doEmit( { type: 'status', content: '🗜️ Обрезка контекста перед запросом…' })
      messages = tier4EmergencyPrune(messages)
      messages = sanitizeMessages(messages)
      session.messages = messages
    }

    // Hard clamp: max_tokens must NEVER exceed (server ctx - prompt tokens)
    // This prevents HTTP 400 "exceeds available context size" errors
    const postPruneTokens = await countContextTokensAccurate(appendResearchTail(messages))
    const desiredMaxTokens = getMaxResponseTokens()
    const hardLimit = Math.max(256, serverCtx - postPruneTokens - 50)
    const effectiveMaxTokens = Math.min(desiredMaxTokens, hardLimit)
    if (effectiveMaxTokens < desiredMaxTokens) {
      debugLog('PREFLIGHT', `Clamped max_tokens: ${desiredMaxTokens} → ${effectiveMaxTokens} (ctx=${serverCtx}, prompt=${postPruneTokens})`)
    }

    let streamResult: StreamResult | undefined
    const retryTemp = emptyRetries > 0 ? getBaseTemperature() + emptyRetries * 0.2 : undefined
    let netTransportAttempts = 0
    const maxNetTransportAttempts = 2

    while (!streamResult) {
      const controller = new AbortController()
      currentAbort = controller
      doEmit({ type: 'stream_stats', tokensPerSecond: 0 })

      // Transient tail: stored `messages` stay append-only; only this call carries
      // the fresh disk-backed research state at the very end (stable-prefix discipline).
      const sendMessages = appendResearchTail(messages)

      try {
        streamResult = await streamLlmResponse(apiUrl, sendMessages, fullResponse, controller.signal, effectiveMaxTokens, retryTemp)
      } catch (e: any) {
        debugLog('ERROR', `Catch in runAgent: name=${e?.name}, message=${e?.message}, cancelRequested=${cancelRequested}, stack=${(e?.stack ?? '').slice(0, 500)}`)
        if (doIsCancelRequested()) {
          doEmit({ type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
          session.updatedAt = Date.now()
          doSaveSession(session)
          return 'Canceled'
        }

        const errMsg = e.message ?? String(e)
        const isAbort = e?.name === 'AbortError' || errMsg.includes('aborted')
        const isContextError = errMsg.includes('500') || errMsg.includes('400') || errMsg.includes('context')
        const isNetErr = !isContextError && !isAbort && isNetworkStreamError(e)

        if (isAbort && !isContextError) {
          return finishAgentError(session, messages, 'Соединение с моделью прервано (сервер не отвечал 60 секунд). Попробуйте ещё раз.')
        }

        if (isNetErr) {
          debugLog('ERROR', `Network-level stream failure: name=${e?.name}, msg=${errMsg}, cause=${e?.cause?.code ?? '-'}`)
          doEmit({ type: 'status', content: '🔌 Соединение с llama-server прервано — проверяю состояние сервера…' })
          await new Promise((r) => setTimeout(r, 1500))
          const alive = await pingLlamaServer(apiUrl)
          debugLog('ERROR', `llama-server health after transport failure: ${alive ? 'ok' : 'unreachable'}`)
          if (!alive) {
            return finishAgentError(
              session,
              messages,
              '❌ llama-server не отвечает после разрыва соединения. Проверьте ~/.one-click-agent/server-debug.log: там записаны команда запуска, stderr/stdout и exit/signal сервера.',
            )
          }
          if (netTransportAttempts < maxNetTransportAttempts) {
            netTransportAttempts++
            doEmit({ type: 'status', content: `🔁 Повтор после сетевой ошибки (${netTransportAttempts}/${maxNetTransportAttempts}) — сжимаю контекст…` })
            messages = tier4EmergencyPrune(messages)
            messages = await manageContext(messages, apiUrl, undefined, i)
            session.messages = messages
            emitContextUsage(messages)
            continue
          }
          return finishAgentError(session, messages, `LLM transport error: ${errMsg}`)
        }

        if (isContextError) {
          const ctxMatch = errMsg.match(/n_ctx[":=\s]*(\d+)/)
          if (ctxMatch) {
            const realCtx = parseInt(ctxMatch[1])
            if (realCtx > 0 && realCtx !== ctxTokens()) {
              debugLog('CTX_FIX', `Server reports n_ctx=${realCtx}, we tracked ${ctxTokens()} — correcting!`)
              doSetCtxSize(realCtx)
              emitContextUsage(messages)
            }
          }

          doEmit({ type: 'status', content: `🔧 Ошибка контекста (реальный ctx=${ctxTokens()}) — очищаю и повторяю…` })
          messages = sanitizeMessages(messages)
          messages = tier4EmergencyPrune(messages)
          session.messages = messages
          doSaveSession(session)
          try {
            const retryController = new AbortController()
            currentAbort = retryController
            streamResult = await streamLlmResponse(apiUrl, appendResearchTail(messages), fullResponse, retryController.signal, effectiveMaxTokens, retryTemp)
          } catch (retryErr: any) {
            return finishAgentError(session, messages, `LLM request failed after recovery: ${retryErr.message}`)
          }
        } else {
          return finishAgentError(session, messages, `LLM request failed: ${errMsg}`)
        }
      }
    }

    const content = streamResult.content
    const toolCalls = streamResult.toolCalls
    const rawToolCalls = streamResult.rawToolCalls
    const finishReason = streamResult.finishReason

    if (streamResult.elapsedMs > 0 && streamResult.estimatedOutputTokens > 0) {
      const tokPerSec = Math.round((streamResult.estimatedOutputTokens * 1000) / streamResult.elapsedMs)
      doEmit({ type: 'stream_stats', tokensPerSecond: tokPerSec })
    }

    // --- Truncated tool call handling ---
    // Model tried to call a tool but JSON was too large and got cut off
    if (!toolCalls && rawToolCalls && rawToolCalls.length > 0) {
      debugLog('TRUNCATED', `Detected truncated tool call(s): ${rawToolCalls.length}, finish=${finishReason}`)

      let repaired = false
      for (const rawTc of rawToolCalls) {
        const repair = tryRepairTruncatedToolCall(rawTc)
        if (repair && repair.truncated) {
          const { name: repairName, args: repairArgs } = repair
          debugLog('TRUNCATED', `Repaired ${repairName}: path=${repairArgs.path}, chars=${(repairArgs.content ?? '').length}`)
          doEmit( { type: 'status', content: `🔧 Tool call обрезался — спасаю частичный контент (${(repairArgs.content ?? '').length} символов)…` })
          doEmit( { type: 'tool_call', name: repairName, args: repairArgs })

          const needsApproval = needsApprovalForTool(repairName, false)
          const approved = needsApproval ? await doRequestApproval( repairName, repairArgs) : true

          if (approved) {
            const result = executeTool(repairName, repairArgs, workspace)
            const uiResult = result.length > 5000 ? result.slice(0, 5000) : result
            doEmit( { type: 'tool_result', name: repairName, result: uiResult })

            if (shouldNotifyWorkspaceChanged(repairName, false, result)) {
              invalidateProjectContextCache()
              try { currentBridge!.notifyWorkspaceChanged() } catch {}
            }

            const tcId = rawTc.id || `repair-${Date.now()}`
            messages.push({
              role: 'assistant',
              tool_calls: [{ id: tcId, type: 'function', function: { name: repairName, arguments: JSON.stringify(repairArgs) } }],
            })
            messages.push({ role: 'tool' as any, tool_call_id: tcId, content: result.slice(0, dynamicToolResultLimit()) })

            // Self-correction: tell model what happened and how to continue
            const contentLen = (repairArgs.content ?? '').length
            messages.push({
              role: 'user',
              content: `⚠️ Your ${repairName} call was truncated by the generation limit — the file was saved with partial content (${contentLen} chars). The file is INCOMPLETE. Please:\n1. read_file to see what was saved\n2. Use edit_file or append_file to add the remaining content in small chunks (under 100 lines per call)\nDo NOT rewrite the entire file — continue from where it was cut off.`,
            })
            repaired = true
          } else {
            messages.push({ role: 'assistant', content: `Tried to ${repairName} but approval was denied.` })
          }
        }
      }

      if (repaired) {
        session.messages = messages
        doSaveSession(session)
        emitContextUsage( messages)
        continue
      }

      // Could not repair — give self-correction feedback without executing
      const rawName = rawToolCalls[0]?.function?.name ?? 'unknown'
      debugLog('TRUNCATED', `Could not repair ${rawName}, giving feedback`)
      doEmit( { type: 'status', content: `⚠️ Tool call "${rawName}" обрезался — прошу модель разбить на части…` })
      messages.push({ role: 'assistant', content: `I tried to call ${rawName} but the content was too large and the JSON was truncated.` })
      messages.push({
        role: 'user',
        content: `Your ${rawName} tool call failed — the JSON arguments were truncated because the content was too large for a single generation. IMPORTANT: Break large file writes into smaller steps:\n1. First write_file with just the skeleton/structure (imports, basic HTML structure, empty function bodies) — under 80 lines\n2. Then use edit_file to fill in each section one at a time\n3. Or use append_file to add content incrementally\nNever put more than 100 lines of content in a single tool call.`,
      })
      session.messages = messages
      doSaveSession(session)
      continue
    }

    // --- Recover text-based tool calls (native API is primary; this is the fallback) ---
    // Primary recovery target is the VISIBLE content (after stripping <think>).
    //
    // Reasoning models (Qwen3, etc.) frequently emit their committed tool call inside
    // the reasoning channel and leave the visible content empty. Nagging them to move
    // the call to the native channel just burns turns and eventually aborts the run, so
    // when the model produced NOTHING but reasoning that ends in a tool call, we recover
    // the LAST tool call it decided on and execute it as a real action. This is bounded:
    // the loop guard below short-circuits repeated identical inspection calls and points
    // the model forward, and we only ever take the single final call (not speculative
    // intermediate ones), so it cannot run away.
    if (!toolCalls && content) {
      const [thinking, visibleForTools] = extractThinking(content)
      let textCalls = extractTextToolCalls(visibleForTools)
      let recoveredFromReasoning = false
      if (textCalls.length === 0 && !visibleForTools.trim() && thinking) {
        const hiddenCalls = extractTextToolCalls(thinking)
        if (hiddenCalls.length > 0) {
          textCalls = [hiddenCalls[hiddenCalls.length - 1]]
          recoveredFromReasoning = true
        }
      }
      if (textCalls.length > 0) {
        debugLog('TEXT_TOOL', `Recovered ${textCalls.length} text-based tool call(s) from ${recoveredFromReasoning ? 'reasoning channel' : 'visible content'}: ${textCalls.map((t) => t.name).join(', ')}`)
        if (recoveredFromReasoning) {
          doEmit({ type: 'status', content: '↪️ Модель оставила tool call в reasoning — выполняю его как зафиксированное действие.' })
        }
        if (thinking) {
          doEmit( { type: 'thinking', content: cleanThinkingText(thinking) })
        }

        const recoveredCustomTools = doGetConfig().customTools
        const uniqueTextCalls: typeof textCalls = []
        const seenTextCallSigs = new Set<string>()
        for (const tc of textCalls) {
          const rawSig = toolLoopSignature(tc.name, tc.args)
          if (seenTextCallSigs.has(rawSig)) continue
          seenTextCallSigs.add(rawSig)
          uniqueTextCalls.push(tc)
        }
        if (uniqueTextCalls.length < textCalls.length) {
          doEmit({
            type: 'status',
            content: `⚠️ Модель повторила ${textCalls.length - uniqueTextCalls.length} одинаковых tool call(s) в одном ответе; выполняю каждый уникальный вызов только один раз.`,
          })
          messages.push({
            role: 'user',
            content: `[Runtime guard] You emitted duplicate text-based tool calls in one answer. The runtime executed each unique tool+args at most once. Continue with the next allowed workflow action; do not repeat identical calls.`,
          })
        }

        for (const tc of uniqueTextCalls) {
          const isCustom = recoveredCustomTools.some((ct: any) => ct.name === tc.name)
          const SESSION_AWARE_RECOVERED = new Set(['generate_report', 'verify_sources', 'reflect', 'plan_research', 'save_finding', 'spawn_sub_researcher', 'export_report', 'build_corpus', 'assign_corpus_to_plan', 'record_evidence', 'extract_evidence_from_corpus_item', 'repair_evidence_quotes', 'verify_claims', 'run_quality_gates', 'gate_report', 'generate_evidence_report'])
          let toolArgs = SESSION_AWARE_RECOVERED.has(tc.name) ? { ...tc.args, session_id: session.id } : tc.args
          if (researchContextMode !== 'off' && activeResearchOutputDir && isResearchContextTool(tc.name) && !toolArgs.output_dir) {
            toolArgs = { ...toolArgs, output_dir: activeResearchOutputDir }
          }

          // Single loop-breaker: identical tool+args repeated past threshold.
          const textToolSig = toolLoopSignature(tc.name, toolArgs)
          if (textToolSig === lastToolSig && isLoopSensitiveTool(tc.name)) {
            sameToolRepeatCount++
            if (sameToolRepeatCount >= duplicateToolThreshold(tc.name)) {
              const skipMsg = loopBreakDirective(tc.name)
              const callId = `text_tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
              messages.push({
                role: 'assistant',
                content: stripThinking(content),
                tool_calls: [{ id: callId, type: 'function', function: { name: tc.name, arguments: JSON.stringify(toolArgs) } }],
              })
              messages.push({ role: 'tool', tool_call_id: callId, content: skipMsg })
              doEmit({ type: 'tool_result', name: tc.name, result: skipMsg })
              escalateEvidenceLoop(tc.name)
              continue
            }
          } else {
            sameToolRepeatCount = 0
          }
          lastToolSig = textToolSig

          doEmit( { type: 'tool_call', name: tc.name, args: toolArgs })

          if (needsApprovalForTool(tc.name, isCustom)) {
            const approved = await doRequestApproval( tc.name, toolArgs)
            if (!approved) {
              const deniedResult = `[Denied by user] Operation "${tc.name}" was not approved.`
              doEmit( { type: 'tool_result', name: tc.name, result: deniedResult })
              messages.push({ role: 'assistant', content: stripThinking(content) })
              messages.push({ role: 'user', content: deniedResult })
              break
            }
          }

          let result: string
          if (isCustom) {
            const ct = recoveredCustomTools.find((t: any) => t.name === tc.name)
            result = ct ? executeCustomTool(ct, toolArgs, workspace) : `Error: custom tool "${tc.name}" not found`
          } else if (isAsyncTool(tc.name)) {
            result = await executeToolAsync(tc.name, toolArgs, workspace, { apiUrl, temperature: getBaseTemperature() })
          } else {
            result = executeTool(tc.name, toolArgs, workspace)
          }
          result = followUpQualityGates(tc.name, toolArgs, result, session, workspace)

          const uiResult = result.length > 5000 ? result.slice(0, 5000) + '\n… [truncated]' : result
          doEmit( { type: 'tool_result', name: tc.name, result: uiResult })

          try {
            const sources = extractSourcesFromToolResult(tc.name, result)
            if (sources.length > 0) getSourceTracker(session.id).addMany(sources)
          } catch {}

          if (shouldNotifyWorkspaceChanged(tc.name, isCustom, result)) {
            invalidateProjectContextCache()
            try { currentBridge!.notifyWorkspaceChanged() } catch {}
          }
          if (toolArgs.output_dir) {
            activeResearchOutputDir = String(toolArgs.output_dir).replace(/\\/g, '/')
            if (researchContextMode === 'off') researchContextMode = 'active'
          }
          maybeEmitCorpusSelection(tc.name, result, workspace)
          if (researchContextMode !== 'off' && activeResearchOutputDir && isResearchContextTool(tc.name)) {
            const snap = readQualityGateSnapshot(workspace, activeResearchOutputDir)
            const gatePhase = tc.name === 'run_quality_gates' || tc.name === 'gate_report'
              ? (snap?.allPassed ? 'gates_passed' : 'gates_failed')
              : undefined
            updateResearchRunState(workspace, {
              outputDir: activeResearchOutputDir,
              phase: gatePhase ?? phaseForResearchTool(tc.name),
              lastTool: tc.name,
              gatesPassed: snap?.passed,
              gatesTotal: snap?.total,
            })
          }

          // Build proper tool_calls message format
          const callId = `text_tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          messages.push({
            role: 'assistant',
            content: stripThinking(content),
            tool_calls: [{ id: callId, type: 'function', function: { name: tc.name, arguments: JSON.stringify(toolArgs) } }],
          })
          messages.push({ role: 'tool', tool_call_id: callId, content: smartTruncateToolResult(tc.name, result, dynamicToolResultLimit()) })

          // Data-gathering stall guard (mirror of native path).
          if (isSourceReadTool(tc.name)) {
            if (isFailedReadResult(tc.name, result)) {
              consecutiveReadFailures++
              if (consecutiveReadFailures >= 4 && !stallDirectiveInjected && activeResearchOutputDir) {
                const kind = String((ensureResearchRunSpec(workspace, activeResearchOutputDir).thresholds || {}).researchKind || 'academic')
                const directive = formatDataStallDirective(`${consecutiveReadFailures} source reads in a row failed`, kind)
                messages.push({ role: 'user', content: `[Runtime recovery] ${directive}` })
                doEmit({ type: 'status', content: '⚠️ Источники не читаются — переключаюсь на восстановление (re-screen / re-search / честный отчёт).' })
                stallDirectiveInjected = true
              }
            } else {
              consecutiveReadFailures = 0
              stallDirectiveInjected = false
            }
          }
        }

        session.messages = messages
        doSaveSession(session)
        emitContextUsage( messages)
        continue
      }
    }

    // --- Truly empty response handling ---
    // A response that is only reasoning with a committed tool call is recovered and
    // executed in the text-tool-call recovery block above, so by this point a response
    // with no visible content and no tool calls really is empty (pure deliberation with
    // no committed action). Treat it as an empty response and nudge the model forward.
    const [, visibleForEmpty] = content ? extractThinking(content) : ['', '']
    const visibleContent = visibleForEmpty.trim()
    const isEffectivelyEmpty = !visibleContent && !toolCalls
    if (isEffectivelyEmpty) {
      const usedTokens = estimateContextTokens(messages)
      const budgetNow = getMessageBudget()
      const usageRatio = usedTokens / budgetNow
      debugLog('EMPTY', `Empty response #${emptyRetries + 1}, msgs=${messages.length}, tokens=${usedTokens}, budget=${budgetNow}, usage=${(usageRatio * 100).toFixed(0)}%`)
      emptyRetries++

      if (emptyRetries <= getMaxEmptyRetries()) {
        if (usageRatio > 0.5) {
          doEmit( { type: 'status', content: `⚠️ Пустой ответ — обрезаю контекст и повторяю (${emptyRetries}/${getMaxEmptyRetries()})…` })
          messages = tier4EmergencyPrune(messages)
          session.messages = messages
        } else {
          // Nudge the model — add a user message to break the empty-response loop
          const lastMsg = messages[messages.length - 1]
          const afterTool = lastMsg?.role === 'tool'
          const nudge = afterTool
            ? 'The tool above returned a result. Please analyze it and continue with the task. Respond in the user\'s language.'
            : 'Please respond to the user\'s request. Use tools as needed, but do not emit reasoning tags or tool-call markup inside reasoning.'
          messages.push({ role: 'user', content: `[System: empty response detected, retry ${emptyRetries}/${getMaxEmptyRetries()}] ${nudge}` })
          debugLog('EMPTY', `Added nudge message (afterTool=${afterTool})`)
          doEmit( { type: 'status', content: `⚠️ Пустой ответ от модели — повторяю с подсказкой (${emptyRetries}/${getMaxEmptyRetries()})…` })
        }
        doSaveSession(session)
        continue
      }
      doEmit( { type: 'error', content: 'Модель вернула пустой ответ после нескольких попыток. Попробуйте переформулировать запрос или начать новый чат.' })
      session.updatedAt = Date.now()
      doSaveSession(session)
      return 'Empty response after retries'
    }
    emptyRetries = 0

    const [, visible] = extractThinking(content)

    // No tool calls → final response.
    // Direct manipulation of managed report.md is blocked at the tool layer
    // (write_file/edit_file/append_file/generate_report) and the report is
    // auto-generated by followUpQualityGates once gates pass, so no text-level
    // "bypass" interception is needed here.
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = visible || content
      fullResponse = appendVisibleSegment(fullResponse, finalText)
      doEmit( { type: 'response', content: fullResponse, done: true })
      emitActivity('done', 'Готово')
      messages.push({ role: 'assistant', content: stripThinking(content) })
      session.messages = messages
      session.updatedAt = Date.now()
      doSaveSession(session)
      return fullResponse
    }

    // Has tool calls — accumulate partial text
    if (visible) {
      fullResponse = appendVisibleSegment(fullResponse, visible)
    }

    // Store without <think> blocks; only valid tool_calls
    const validToolCalls = validateAndFixToolCalls(toolCalls)
    if (validToolCalls && validToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: stripThinking(content) || undefined,
        tool_calls: validToolCalls,
      })
    } else {
      // All tool calls were broken (truncated mid-JSON) — treat as text response
      const brokenText = visible || stripThinking(content)
      if (brokenText) {
        fullResponse = appendVisibleSegment(fullResponse, brokenText)
      }
      const notice = 'Модель попыталась выполнить действие, но ответ был обрезан. Попробую ещё раз.'
      doEmit( { type: 'status', content: `⚠️ ${notice}` })
      messages.push({ role: 'assistant', content: brokenText || notice })
      messages.push({ role: 'user', content: 'Your previous tool call was truncated and could not be parsed. Please try again, but break large file writes into smaller parts or use a shorter approach.' })
      session.messages = messages
      doSaveSession(session)
      continue
    }

    // Execute tool calls. A single model turn may occasionally contain the same
    // call many times; execute each unique function+args at most once.
    const uniqueValidToolCalls: typeof validToolCalls = []
    const seenNativeCallSigs = new Set<string>()
    for (const tc of validToolCalls) {
      const fn = tc.function
      let argsForSig: Record<string, any>
      try {
        argsForSig = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
      } catch {
        argsForSig = {}
      }
      const sig = toolLoopSignature(fn.name, argsForSig)
      if (seenNativeCallSigs.has(sig)) continue
      seenNativeCallSigs.add(sig)
      uniqueValidToolCalls.push(tc)
    }
    if (uniqueValidToolCalls.length < validToolCalls.length) {
      doEmit({
        type: 'status',
        content: `⚠️ Модель повторила ${validToolCalls.length - uniqueValidToolCalls.length} одинаковых native tool call(s); выполняю каждый уникальный вызов только один раз.`,
      })
    }

    for (const tc of uniqueValidToolCalls) {
      const fn = tc.function
      const toolName = fn.name
      let toolArgs: Record<string, any>
      try {
        toolArgs = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
      } catch {
        toolArgs = {}
      }

      if (researchContextMode !== 'off' && activeResearchOutputDir && isResearchContextTool(toolName) && !toolArgs.output_dir) {
        toolArgs = { ...toolArgs, output_dir: activeResearchOutputDir }
      }

      doEmit( { type: 'tool_call', name: toolName, args: toolArgs })
      const toolDetail = toolArgs.path ?? toolArgs.output_dir ?? toolArgs.claim?.slice?.(0, 80) ?? toolArgs.query?.slice?.(0, 80)
      emitActivity('tool_exec', `Инструмент: ${toolName}`, toolDetail ? String(toolDetail) : undefined)

      // Track files created this turn
      if ((toolName === 'write_file' || toolName === 'append_file' || toolName === 'create_directory') && toolArgs.path) {
        filesCreatedThisTurn.add(toolArgs.path)
      }

      // General loop detection: same tool + same args called repeatedly
      const toolSig = toolLoopSignature(toolName, toolArgs)
      if (toolSig === lastToolSig && isLoopSensitiveTool(toolName)) {
        sameToolRepeatCount++
        debugLog('LOOP', `Duplicate ${toolName} call #${sameToolRepeatCount + 1}: ${toolArgs.path ?? toolArgs.claim?.slice?.(0, 60) ?? ''}`)
        if (sameToolRepeatCount >= duplicateToolThreshold(toolName)) {
          const skipMsg = loopBreakDirective(toolName)
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: skipMsg })
          doEmit({ type: 'tool_result', name: toolName, result: skipMsg })
          escalateEvidenceLoop(toolName)
          continue
        }
      } else {
        sameToolRepeatCount = 0
      }
      lastToolSig = toolSig

      // Detect pointless re-reads of files we JUST created
      if (toolName === 'read_file' && toolArgs.path && filesCreatedThisTurn.has(toolArgs.path)) {
        consecutiveReReads++
        debugLog('LOOP', `Re-read of just-created file: ${toolArgs.path} (consecutive: ${consecutiveReReads})`)
        if (consecutiveReReads >= 3) {
          const skipMsg = `You just created ${toolArgs.path} in this session — its contents are exactly what you wrote. Instead of re-reading files you just created, continue with the next step of the task. What files still need to be created or modified?`
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: skipMsg })
          doEmit( { type: 'tool_result', name: toolName, result: skipMsg })
          continue
        }
      } else {
        consecutiveReReads = 0
      }

      // Inject session_id into tools that need access to the per-session source tracker / planner context.
      const SESSION_AWARE_TOOLS = new Set([
        'generate_report', 'verify_sources', 'reflect', 'plan_research',
        'save_finding', 'spawn_sub_researcher', 'export_report',
        'build_corpus', 'assign_corpus_to_plan', 'record_evidence', 'extract_evidence_from_corpus_item', 'repair_evidence_quotes', 'verify_claims', 'run_quality_gates', 'gate_report', 'generate_evidence_report',
      ])
      if (SESSION_AWARE_TOOLS.has(toolName)) toolArgs = { ...toolArgs, session_id: session.id }

      // Auto verify_sources before generate_report when enabled
      if (toolName === 'generate_report') {
        const autoVerify = (doGetConfig() as any).autoVerifyBeforeReport
        const recentVerify = messages.slice(-30).some((m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('Verified '))
        if (autoVerify && !recentVerify) {
          try {
            const verifyResult = executeTool('verify_sources', { session_id: session.id }, workspace)
            doEmit({ type: 'tool_call', name: 'verify_sources', args: { session_id: session.id } })
            doEmit({ type: 'tool_result', name: 'verify_sources', result: verifyResult })
            messages.push({
              role: 'user',
              content: `[Auto verify_sources before generate_report]\n${verifyResult.slice(0, 4000)}`,
            })
          } catch {}
        }
      }

      // Request user approval when enabled for file ops or commands (or custom tools)
      let result: string
      const customTools = doGetConfig().customTools
      const isCustom = customTools.some((ct) => ct.name === toolName)

      const runTool = async (): Promise<string> => {
        if (isCustom) {
          const ct = customTools.find((t) => t.name === toolName)!
          return executeCustomTool(ct, toolArgs, workspace)
        }
        if (isAsyncTool(toolName)) {
          return await executeToolAsync(toolName, toolArgs, workspace, { apiUrl, temperature: getBaseTemperature() })
        }
        return executeTool(toolName, toolArgs, workspace)
      }

      const needsApproval = needsApprovalForTool(toolName, isCustom)
      if (needsApproval) {
        const approved = await doRequestApproval( toolName, toolArgs)
        if (approved) {
          result = await runTool()
        } else {
          result = `[Denied by user] Operation "${toolName}" was not approved.`
        }
      } else {
        result = await runTool()
      }

      result = followUpQualityGates(toolName, toolArgs, result, session, workspace)

      if (toolName === 'plan_research' && !result.startsWith('Error')) {
        const planOutputDir = toolArgs.output_dir ? String(toolArgs.output_dir).replace(/\\/g, '/') : activeResearchOutputDir ?? undefined
        const savedPlan = planOutputDir ? parsePlan(workspace, planOutputDir) : []
        if (savedPlan.length === 0) {
          result = [
            'Error: plan_research reported success, but plan.md was not found or could not be parsed.',
            `output_dir=${planOutputDir || 'missing'}`,
            'The managed research run cannot continue until plan.md exists on disk.',
          ].join('\n')
        }
      }

      if (toolArgs.output_dir) {
        activeResearchOutputDir = String(toolArgs.output_dir).replace(/\\/g, '/')
        if (researchContextMode === 'off') researchContextMode = 'active'
      } else {
        const dirInResult = result.match(/(\.research\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[^\s"'`]+)/)?.[1]
        if (dirInResult) {
          activeResearchOutputDir = dirInResult
          if (researchContextMode === 'off') researchContextMode = 'active'
        }
      }
      maybeEmitCorpusSelection(toolName, result, workspace)
      if (researchContextMode !== 'off' && activeResearchOutputDir && isResearchContextTool(toolName)) {
        const snap = readQualityGateSnapshot(workspace, activeResearchOutputDir)
        const spec = updateResearchWorkflowAfterTool(workspace, activeResearchOutputDir, toolName, {
          gateResults: (toolName === 'run_quality_gates' || toolName === 'gate_report') ? (snap?.failed ?? []) : undefined,
        })
        const gatePhase = toolName === 'run_quality_gates' || toolName === 'gate_report'
          ? (snap?.allPassed ? 'gates_passed' : 'gates_failed')
          : undefined
        updateResearchRunState(workspace, {
          outputDir: activeResearchOutputDir,
          phase: gatePhase ?? (spec.state === 'REPORT_READY' ? 'report_generated' : phaseForResearchTool(toolName)),
          lastTool: toolName,
          gatesPassed: snap?.passed,
          gatesTotal: snap?.total,
        })
      }

      // Collect sources from search tools
      try {
        const sources = extractSourcesFromToolResult(toolName, result)
        if (sources.length > 0) getSourceTracker(session.id).addMany(sources)
      } catch {}

      // Truncate for UI
      const uiResult = result.length > 5000
        ? result.slice(0, 5000) + `\n… [${Math.round(result.length / 1024)}KB total]`
        : result
      doEmit( { type: 'tool_result', name: toolName, result: uiResult })
      if (toolName === 'generate_report' || toolName === 'generate_evidence_report') {
        const reportPath = getGeneratedReportPath(result, workspace)
        if (reportPath) doEmit({ type: 'open_file', filePath: reportPath })
      }

      // Notify renderer to refresh file tree when agent modifies filesystem
      if (shouldNotifyWorkspaceChanged(toolName, isCustom, result)) {
        invalidateProjectContextCache()
        try {
          try { currentBridge!.notifyWorkspaceChanged() } catch {}
        } catch {}
      }

      // Truncate for LLM context — dynamic limit based on context window
      const maxToolChars = dynamicToolResultLimit()
      const llmResult = smartTruncateToolResult(toolName, result, maxToolChars)

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: llmResult })

      // Data-gathering stall guard: consecutive failing source reads use different
      // IDs, so the identical-args loop guard never catches them. After a streak,
      // inject a one-time recovery directive so the agent stops hammering
      // unfetchable URLs and recovers (re-screen / re-search / honest report).
      if (isSourceReadTool(toolName)) {
        if (isFailedReadResult(toolName, result)) {
          consecutiveReadFailures++
          if (consecutiveReadFailures >= 4 && !stallDirectiveInjected && activeResearchOutputDir) {
            const kind = String((ensureResearchRunSpec(workspace, activeResearchOutputDir).thresholds || {}).researchKind || 'academic')
            const directive = formatDataStallDirective(`${consecutiveReadFailures} source reads in a row failed`, kind)
            messages.push({ role: 'user', content: `[Runtime recovery] ${directive}` })
            doEmit({ type: 'status', content: '⚠️ Источники не читаются — переключаюсь на восстановление (re-screen / re-search / честный отчёт).' })
            stallDirectiveInjected = true
          }
        } else {
          consecutiveReadFailures = 0
          stallDirectiveInjected = false
        }
      }

      if (toolName === 'plan_research' && !result.startsWith('Error') && hasPlanCheckpointRequest(messages)) {
        const checkpoint = formatPlanCheckpoint(workspace, activeResearchOutputDir ?? toolArgs.output_dir)
        fullResponse = appendVisibleSegment(fullResponse, checkpoint)
        messages.push({ role: 'assistant', content: checkpoint })
        doEmit({ type: 'response', content: fullResponse, done: true })
        session.messages = messages
        session.updatedAt = Date.now()
        doSaveSession(session)
        return fullResponse
      }
    }

    // Research state is injected fresh as a tail message on every LLM call
    // (appendResearchTail), so no periodic system-prompt mutation is needed here.
    messages = await manageContext(messages, apiUrl, undefined, i)
    session.messages = messages
    emitContextUsage( messages)
  }

  const msg = 'Reached maximum iterations. Stopping.'
  fullResponse += (fullResponse ? '\n\n' : '') + msg
  doEmit( { type: 'response', content: fullResponse, done: true })
  session.updatedAt = Date.now()
  doSaveSession(session)
  return fullResponse
  } finally {
    researchContextMode = 'off'
    activeResearchOutputDir = null
    activeWorkspace = null
    currentBridge = null
  }
}
