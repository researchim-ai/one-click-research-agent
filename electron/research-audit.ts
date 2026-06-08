import * as fs from 'fs'
import * as path from 'path'
import { loadCorpus } from './corpus'
import { loadEvidence } from './evidence'
import { parsePlan, planProgress } from './planner'
import { resolveResearchDir } from '../research-paths'

export interface ResearchAudit {
  at: number
  corpus: {
    total: number
    selected: number
    rejected: number
    read: number
    selectedRead: number
    highPriority: number
    highPriorityRead: number
    outsideDateRange: number
    topUnread: Array<{ id: string; title: string; score: number; readPriority?: string }>
  }
  evidence: {
    total: number
    withCorpus: number
    withQuote: number
    planItemsCovered: number
  }
  plan: { total: number; done: number; pct: number }
  report: { exists: boolean; path: string; mentionsCorpusTotal: boolean }
  blockers: string[]
  warnings: string[]
}

function researchDir(workspace: string, outputDir?: string): string {
  return resolveResearchDir(workspace, outputDir)
}

function writeAuditFiles(dir: string, audit: ResearchAudit): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(audit, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, 'audit.md'), formatAuditMarkdown(audit), 'utf-8')
}

export function auditResearchRun(workspace: string, opts?: { outputDir?: string; yearFrom?: number; yearTo?: number; minSelected?: number; minRead?: number; minEvidence?: number }): ResearchAudit {
  const dir = researchDir(workspace, opts?.outputDir)
  const corpus = loadCorpus(workspace, opts?.outputDir)
  const evidence = loadEvidence(workspace, opts?.outputDir)
  const planItems = parsePlan(workspace, opts?.outputDir)
  const progress = planProgress(planItems)
  const selected = corpus.filter((e) => e.screeningStatus === 'selected')
  const selectedRead = selected.filter((e) => e.readStatus === 'read' || e.status === 'read')
  const highPriority = selected.filter((e) => e.readPriority === 'high')
  const highPriorityRead = highPriority.filter((e) => e.readStatus === 'read' || e.status === 'read')
  const outsideDateRange = corpus.filter((e) => e.screeningStatus === 'selected' && e.year && ((opts?.yearFrom && e.year < opts.yearFrom) || (opts?.yearTo && e.year > opts.yearTo))).length
  const topUnread = selected
    .filter((e) => e.readStatus !== 'read' && e.status !== 'read')
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((e) => ({ id: e.id, title: e.title, score: e.score, readPriority: e.readPriority }))

  const reportPath = path.join(dir, 'report.md')
  const reportText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf-8') : ''
  const planCovered = new Set(evidence.map((e) => e.planItemId || e.topic).filter(Boolean)).size
  const audit: ResearchAudit = {
    at: Date.now(),
    corpus: {
      total: corpus.length,
      selected: selected.length,
      rejected: corpus.filter((e) => e.screeningStatus === 'rejected').length,
      read: corpus.filter((e) => e.readStatus === 'read' || e.status === 'read').length,
      selectedRead: selectedRead.length,
      highPriority: highPriority.length,
      highPriorityRead: highPriorityRead.length,
      outsideDateRange,
      topUnread,
    },
    evidence: {
      total: evidence.length,
      withCorpus: evidence.filter((e) => e.corpusIds?.length).length,
      withQuote: evidence.filter((e) => !!e.quote).length,
      planItemsCovered: planCovered,
    },
    plan: progress,
    report: {
      exists: !!reportText,
      path: reportPath,
      mentionsCorpusTotal: corpus.length > 0 && new RegExp(`\\b${corpus.length}\\b`).test(reportText),
    },
    blockers: [],
    warnings: [],
  }

  const minSelected = opts?.minSelected ?? 12
  const minRead = opts?.minRead ?? 8
  const minEvidence = opts?.minEvidence ?? Math.max(3, progress.total * 2)
  if (audit.corpus.selected < minSelected) audit.blockers.push(`Only ${audit.corpus.selected} selected corpus item(s); need at least ${minSelected}.`)
  if (audit.corpus.selectedRead < minRead) audit.blockers.push(`Only ${audit.corpus.selectedRead} selected item(s) read; need at least ${minRead}.`)
  if (audit.corpus.highPriority > 0 && audit.corpus.highPriorityRead / audit.corpus.highPriority < 0.6) audit.blockers.push(`High-priority read coverage is ${audit.corpus.highPriorityRead}/${audit.corpus.highPriority}; need at least 60%.`)
  if (audit.evidence.total < minEvidence) audit.blockers.push(`Only ${audit.evidence.total} evidence claim(s); need at least ${minEvidence}.`)
  if (audit.evidence.withCorpus < Math.ceil(audit.evidence.total * 0.8)) audit.blockers.push('Less than 80% of evidence claims are linked to stable corpus IDs.')
  if (audit.corpus.outsideDateRange > 0) audit.blockers.push(`${audit.corpus.outsideDateRange} selected corpus item(s) are outside the requested date range.`)
  if (audit.report.mentionsCorpusTotal && audit.corpus.selectedRead < audit.corpus.total * 0.25) {
    audit.warnings.push('Report appears to mention total raw corpus count although less than 25% of corpus was read.')
  }
  if (audit.corpus.topUnread.length > 0) audit.warnings.push(`${audit.corpus.topUnread.length} top selected source(s) remain unread.`)

  writeAuditFiles(dir, audit)
  return audit
}

export function formatAuditMarkdown(audit: ResearchAudit): string {
  const lines = [
    '# Research Run Audit',
    '',
    `Generated: ${new Date(audit.at).toISOString()}`,
    '',
    '## Summary',
    '',
    `- Corpus: ${audit.corpus.total} total, ${audit.corpus.selected} selected, ${audit.corpus.selectedRead} selected read.`,
    `- High priority: ${audit.corpus.highPriorityRead}/${audit.corpus.highPriority} read.`,
    `- Evidence: ${audit.evidence.total} claims, ${audit.evidence.withCorpus} corpus-linked, ${audit.evidence.withQuote} with quotes.`,
    `- Plan: ${audit.plan.done}/${audit.plan.total} (${audit.plan.pct}%).`,
    '',
    '## Blockers',
    '',
    ...(audit.blockers.length ? audit.blockers.map((b) => `- ${b}`) : ['- None.']),
    '',
    '## Warnings',
    '',
    ...(audit.warnings.length ? audit.warnings.map((w) => `- ${w}`) : ['- None.']),
    '',
    '## Top Unread Selected Sources',
    '',
    ...(audit.corpus.topUnread.length ? audit.corpus.topUnread.map((s) => `- ${s.id} (${s.score}, ${s.readPriority ?? 'low'}): ${s.title}`) : ['- None.']),
    '',
  ]
  return lines.join('\n')
}

export function formatAuditResult(audit: ResearchAudit): string {
  return [
    `Audit complete: ${audit.blockers.length} blocker(s), ${audit.warnings.length} warning(s).`,
    `Corpus selected/read: ${audit.corpus.selectedRead}/${audit.corpus.selected}.`,
    `Evidence corpus-linked: ${audit.evidence.withCorpus}/${audit.evidence.total}.`,
    audit.blockers.length ? `Blockers:\n${audit.blockers.map((b) => `- ${b}`).join('\n')}` : 'No blockers.',
    'Artifacts written: audit.md, audit.json',
  ].join('\n')
}
