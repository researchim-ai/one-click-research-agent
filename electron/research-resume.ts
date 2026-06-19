import * as fs from 'fs'
import * as path from 'path'
import { corpusStats } from './corpus'
import { evidenceStats } from './evidence'
import { parsePlan, planProgress } from './planner'
import { latestQualityGateFailure } from './quality-gates'
import { resolveResearchDir } from '../research-paths'
import { ensureResearchRunSpec, formatWorkflowGuidance } from './research-workflow'

const RESUME_RE = /^(продолжай|continue|resume|go on|дальше|продолжить|продолжение)\b/i
const RESEARCH_ARTIFACT_RE = /\/(?:run\.json|evidence\.jsonl|corpus\.jsonl|claims\.jsonl|plan\.md|quality-gates\.json|report\.md|evidence-report\.md)$/i

function normalizeExtractedOutputDir(value: string): string {
  return value.replace(/\\/g, '/').replace(RESEARCH_ARTIFACT_RE, '')
}

export function isResearchResumeMessage(text: string): boolean {
  return RESUME_RE.test(String(text || '').trim())
}

/** User asks to continue with minimal GPU context (e.g. «продолжай меленький»). */
export function isCompactResumeMessage(text: string): boolean {
  const t = String(text || '').trim()
  if (!isResearchResumeMessage(t)) return false
  return /\b(меленьк|компакт|compact|small|minimal|лёгк|легк)\b/i.test(t)
}

export function decideResearchCommandIntent(opts: {
  resumeLike: boolean
  approvalLike: boolean
  approvalPromptPending: boolean
  hasOutputDir: boolean
  hasSavedPlan: boolean
  contextModeOff: boolean
}): { planApproved: boolean; planBootstrapApproved: boolean; researchResume: boolean } {
  const approvalForKnownRun = !opts.contextModeOff && opts.hasOutputDir && opts.approvalLike
  const planApproved = !opts.contextModeOff
    && opts.hasOutputDir
    && opts.approvalLike
    && opts.hasSavedPlan
  const planBootstrapApproved = !opts.contextModeOff
    && opts.hasOutputDir
    && opts.approvalLike
    && !opts.hasSavedPlan
  const researchResume = !planApproved
    && !planBootstrapApproved
    && opts.hasOutputDir
    && (opts.resumeLike || (approvalForKnownRun && !opts.approvalPromptPending))
  return { planApproved, planBootstrapApproved, researchResume }
}

export function findLatestResearchRunDir(workspace: string): string | null {
  const root = path.join(workspace, '.research')
  if (!fs.existsSync(root)) return null
  const runs = fs.readdirSync(root)
    .filter((name) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/.test(name))
    .map((name) => {
      const full = path.join(root, name)
      let mtime = 0
      try { mtime = fs.statSync(full).mtimeMs } catch {}
      return { name, mtime }
    })
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
  return runs.length ? `.research/${runs[runs.length - 1].name}` : null
}

export function extractResearchOutputDirFromText(text: string): string | null {
  const raw = String(text ?? '')
  const explicit = raw.match(/output_dir:\s*["'`]?(\.research\/[^\s"'`]+)["'`]?/i)?.[1]
  if (explicit) return normalizeExtractedOutputDir(explicit)
  const labeled = raw.match(/Research artifact directory:\s*["'`]?(\.research\/[^\s"'`]+)["'`]?/i)?.[1]
  if (labeled) return normalizeExtractedOutputDir(labeled)
  const artifact = raw.match(/(\.research\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[^\s"'`]+)/)?.[1]
  if (artifact) return normalizeExtractedOutputDir(artifact)
  return null
}

export function extractResearchOutputDirFromMessages(messages: Array<{ role?: string; content?: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const dir = extractResearchOutputDirFromText(String(messages[i].content ?? ''))
    if (dir) return dir
  }
  return null
}

export function trimResumeSystemPrompt(content: string): string {
  let s = content
  for (const marker of ['\n\n## Summary of earlier', '\n\n## Working memory']) {
    const idx = s.indexOf(marker)
    if (idx >= 0) s = s.slice(0, idx)
  }
  return s
}

/** Strip chat history before worker load — resume rebuilds state from .research/ on disk. */
export function compactSessionForWorkerResume<T extends { messages: Array<{ role?: string; content?: string }> }>(session: T): T {
  const system = session.messages.find((m) => m.role === 'system')
  const outputDir = extractResearchOutputDirFromMessages(session.messages)
  if (!system) {
    return {
      ...session,
      messages: outputDir ? [{ role: 'user', content: `[Resume checkpoint]\noutput_dir: "${outputDir}"` }] : [],
    }
  }
  const messages: Array<{ role?: string; content?: string }> = [
    { ...system, content: trimResumeSystemPrompt(String(system.content ?? '')) },
  ]
  if (outputDir) messages.push({ role: 'user', content: `[Resume checkpoint]\noutput_dir: "${outputDir}"` })
  return {
    ...session,
    messages,
  }
}

export function buildResearchResumeBrief(workspace: string, outputDir?: string): string {
  const summary = researchRunProgressSummary(workspace, outputDir)
  return summary?.brief ?? ''
}

export function researchRunProgressSummary(workspace: string, outputDir?: string): {
  dir: string
  brief: string
  detail: string
  statusLine: string
} | null {
  const dir = outputDir || findLatestResearchRunDir(workspace)
  if (!dir) return null

  const abs = resolveResearchDir(workspace, dir)
  const spec = ensureResearchRunSpec(workspace, dir)
  const stats = corpusStats(workspace, dir)
  const evidence = evidenceStats(workspace, dir)
  const plan = parsePlan(workspace, dir)
  const progress = planProgress(plan)
  const blockers = latestQualityGateFailure(workspace, dir)
  const reportExists = fs.existsSync(path.join(abs, 'report.md'))
  const evidenceReportExists = fs.existsSync(path.join(abs, 'evidence-report.md'))

  const lines = [
    '[Research resume checkpoint — continue this run, do NOT restart from scratch]',
    '',
    `Artifact directory: \`${dir}\``,
    formatWorkflowGuidance(spec),
    `Plan progress: ${progress.done}/${progress.total} (${progress.pct}%)`,
    `Corpus: ${stats.selected} selected, ${stats.selectedRead} selected read, ${stats.failed} failed reads, ${stats.selectedReviewLike} review/survey in selected.`,
    `Evidence: ${evidence.total} claims (${evidence.supported} supported, ${evidence.needsReview} needs review).`,
    reportExists ? 'Final report.md: exists (verify quality gates before overwriting).' : 'Final report.md: not created yet.',
    evidenceReportExists ? 'Technical evidence-report.md: exists.' : 'Technical evidence-report.md: not created yet.',
  ]

  if (blockers) {
    lines.push('', 'Quality gate blockers:', blockers.split('\n').map((b) => `- ${b}`).join('\n'))
  } else if (fs.existsSync(path.join(abs, 'quality-gates.json'))) {
    lines.push('', 'Quality gates: last run passed.')
  }

  lines.push(
    '',
    'Resume instructions:',
    `- Always pass \`output_dir: "${dir}"\` to research tools.`,
    '- The workflow state and Allowed next tools above are authoritative. Choose one allowed tool; ignore preset advice that suggests a disallowed tool.',
    '- Continue by taking the next valid pipeline action, not by brainstorming alternative report-writing strategies.',
    '- Do NOT repeat record_evidence for claims that already exist — use list_evidence / verify_claims first.',
    '- If many existing claims lack quotes, call repair_evidence_quotes once, then verify_claims and run_quality_gates.',
    '- The only valid final report action is generate_evidence_report. Never use write_file, edit_file, append_file, or generate_report for managed research report.md.',
    '- If data/evidence gates fail, fix the listed blockers with concrete tools and then rerun run_quality_gates once.',
    '- If quality gates pass, or only final_report_structure fails, call generate_evidence_report for report.md.',
    '- If context was compressed, rely on on-disk artifacts in this directory rather than chat history.',
  )

  return {
    dir,
    brief: lines.join('\n'),
    detail: `${dir} · plan ${progress.done}/${progress.total} · corpus ${stats.selected} · evidence ${evidence.total}`,
    statusLine: `📂 Продолжаю тот же research run: \`${dir}\`. На диске: corpus (${stats.selected} источников), evidence (${evidence.total} claims), plan (${progress.pct}%). Все артефакты в .research/ — качество сохранено.`,
  }
}
