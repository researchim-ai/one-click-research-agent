import * as fs from 'fs'
import * as path from 'path'
import { isReviewLike, loadCorpus, corpusStats, MIN_SELECTABLE_TOPICAL_PRECISION } from './corpus'
import { evidenceStats, loadEvidence, verifyClaims } from './evidence'
import { getSourceTracker } from './sources'
import { parsePlan, planProgress } from './planner'
import { resolveResearchDir } from '../research-paths'

export interface GateResult {
  gate: string
  passed: boolean
  score?: number
  blockers: string[]
  warnings: string[]
}

interface QualityGateFile {
  summary?: string
  results?: GateResult[]
  at?: number
}

function researchDir(workspace: string, outputDir?: string): string {
  return resolveResearchDir(workspace, outputDir)
}

function qualityPath(workspace: string, outputDir?: string): string {
  return path.join(researchDir(workspace, outputDir), 'quality-gates.json')
}

function pass(gate: string, score: number, warnings: string[] = []): GateResult {
  return { gate, passed: true, score, blockers: [], warnings }
}

function fail(gate: string, blockers: string[], score = 0, warnings: string[] = []): GateResult {
  return { gate, passed: false, score, blockers, warnings }
}

function claimKey(claim: { claim: string; planItemId?: string; topic?: string }): string {
  return `${claim.planItemId || claim.topic || ''}:${claim.claim.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').trim().replace(/\s+/g, ' ').slice(0, 240)}`
}

function uniqueClaims<T extends { claim: string; planItemId?: string; topic?: string; quote?: string; notes?: string; sourceIdxs: number[]; corpusIds?: string[]; sourceUrls?: string[]; status: string; support?: string; confidence?: string }>(rows: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) {
    const key = claimKey(row)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, row)
      continue
    }
    byKey.set(key, {
      ...prev,
      ...row,
      quote: prev.quote || row.quote,
      notes: [prev.notes, row.notes].filter(Boolean).join(' '),
      sourceIdxs: [...new Set([...(prev.sourceIdxs ?? []), ...(row.sourceIdxs ?? [])])],
      corpusIds: [...new Set([...(prev.corpusIds ?? []), ...(row.corpusIds ?? [])])],
      sourceUrls: [...new Set([...(prev.sourceUrls ?? []), ...(row.sourceUrls ?? [])])],
      status: prev.status === 'supported' || row.status === 'supported' ? 'supported' : row.status,
    } as T)
  }
  return [...byKey.values()]
}

export function runQualityGates(workspace: string, sessionId?: string, opts?: { minSources?: number; minEvidence?: number; requirePlanCompletion?: boolean; outputDir?: string; researchKind?: string }): { results: GateResult[]; summary: string } {
  // 'general' = non-academic web research. It reuses the whole tuned pipeline but
  // relaxes the academic-only gates (survey/review coverage and recency), because
  // general web pages rarely are surveys and often carry no publication year.
  // 'academic' (default) keeps the science pipeline byte-for-byte unchanged.
  const general = String(opts?.researchKind || 'academic') === 'general'
  const minSources = Math.max(1, Number(opts?.minSources) || 5)
  const minEvidence = Math.max(0, Number(opts?.minEvidence) || 3)
  const minSelected = Math.max(1, Number((opts as any)?.minSelected) || Math.min(12, minSources))
  const minFullTextReads = Math.max(0, Number((opts as any)?.minFullTextReads) || Math.min(8, Math.ceil(minSelected * 0.6)))
  const evidencePerSection = Math.max(1, Number((opts as any)?.evidencePerSection) || 2)
  const minReviewLike = Math.max(1, Math.min(3, Number((opts as any)?.minReviewLike) || Math.ceil(minSelected * 0.12)))
  const results: GateResult[] = []

  const tracker = sessionId ? getSourceTracker(sessionId) : null
  const sourceCount = tracker?.count() ?? 0
  const corpus = corpusStats(workspace, opts?.outputDir)
  const totalSources = Math.max(sourceCount, corpus.total)
  results.push(totalSources >= minSources
    ? pass('source_coverage', Math.min(100, Math.round(totalSources / minSources * 100)))
    : fail('source_coverage', [`Only ${totalSources} source(s); target is at least ${minSources}.`], Math.round(totalSources / minSources * 100)))

  const eStats = evidenceStats(workspace, opts?.outputDir)
  results.push(eStats.total >= minEvidence
    ? pass('evidence_coverage', Math.min(100, Math.round(eStats.supported / Math.max(1, eStats.total) * 100)), eStats.needsReview ? [`${eStats.needsReview} claim(s) still need review.`] : [])
    : fail('evidence_coverage', [`Only ${eStats.total} evidence claim(s); target is at least ${minEvidence}.`], Math.round(eStats.total / Math.max(1, minEvidence) * 100)))

  const claims = uniqueClaims(loadEvidence(workspace, opts?.outputDir))
  const unresolved = claims.filter((claim) => {
    const hasStableSource = claim.sourceIdxs.length > 0 || Boolean(claim.corpusIds?.length) || Boolean(claim.sourceUrls?.length)
    return !hasStableSource || claim.status !== 'supported'
  })
  results.push(unresolved.length === 0
    ? pass('claim_support', 100)
    : fail('claim_support', unresolved.slice(0, 5).map((c: any) => `${c.id}: ${c.status}; sources=${c.sourceIdxs.length}; corpus=${c.corpusIds?.length ?? 0}`), Math.max(0, 100 - unresolved.length * 20)))

  const plan = parsePlan(workspace, opts?.outputDir)
  const progress = planProgress(plan)
  if (plan.length > 0 || opts?.requirePlanCompletion) {
    results.push(progress.pct >= 80
      ? pass('plan_progress', progress.pct)
      : fail('plan_progress', [`Plan is ${progress.pct}% complete (${progress.done}/${progress.total}).`], progress.pct))
  }

  const entries = loadCorpus(workspace, opts?.outputDir)
  const currentYear = new Date().getFullYear()
  const fresh = entries.filter((e) => e.year && e.year >= currentYear - 1).length
  if (entries.length > 0) {
    results.push(general || fresh > 0
      ? pass('recency', general ? 100 : Math.min(100, Math.round(fresh / entries.length * 100)), general
        ? ['Recency is not enforced for general (web) research; web pages often lack a publication year.']
        : [`${fresh}/${entries.length} corpus item(s) are from ${currentYear - 1}+.`])
      : fail('recency', ['No recent corpus item found from the last two years.'], 0))
  }

  const selected = entries.filter((e) => e.screeningStatus === 'selected')
  const selectedRead = selected.filter((e) => e.readStatus === 'read' || e.status === 'read')
  const highPriority = selected.filter((e) => e.readPriority === 'high')
  const highPriorityRead = highPriority.filter((e) => e.readStatus === 'read' || e.status === 'read')
  const selectedReviewLike = selected.filter(isReviewLike)
  const weakTopicSelected = selected.filter((e) => (e.topicalPrecisionScore ?? e.relevanceScore ?? 0) < MIN_SELECTABLE_TOPICAL_PRECISION)
  const failedHighPriority = highPriority.filter((e) => e.readStatus === 'failed')
  const rawUnscreened = entries.filter((e) => !e.screeningStatus || e.screeningStatus === 'raw').length
  results.push(selected.length >= minSelected
    ? pass('selected_corpus_minimum', Math.min(100, Math.round(selected.length / minSelected * 100)))
    : fail('selected_corpus_minimum', [
      rawUnscreened > 0
        // The corpus already holds enough sources — they are just not screened yet. Tell
        // the agent to screen (cheap, local) instead of interpreting this as "search more".
        ? `Only ${selected.length} selected corpus item(s); target is at least ${minSelected}. ${rawUnscreened} corpus item(s) are still UNSCREENED — run screen_corpus (min_selected: ${minSelected}) to screen and promote on-topic items FIRST; do not search for more sources until the existing corpus has been screened.`
        : `Only ${selected.length} selected corpus item(s); target is at least ${minSelected}.`,
    ], Math.round(selected.length / minSelected * 100)))

  results.push(general || selected.length === 0 || selectedReviewLike.length >= minReviewLike
    ? pass('review_source_coverage', selected.length ? Math.min(100, Math.round(selectedReviewLike.length / minReviewLike * 100)) : 100, general && selected.length
      ? ['Survey/review coverage is not required for general (web) research.']
      : [])
    : fail('review_source_coverage', [`Only ${selectedReviewLike.length} selected review/survey source(s); target is at least ${minReviewLike}. Add survey/review/systematic overview papers before synthesis.`], Math.round(selectedReviewLike.length / minReviewLike * 100)))

  results.push(weakTopicSelected.length === 0
    ? pass('topical_precision', 100)
    : fail('topical_precision', [
      `${weakTopicSelected.length} selected source(s) are off-topic (precision < ${MIN_SELECTABLE_TOPICAL_PRECISION}). Remove them with reject_corpus_items (ids: ${weakTopicSelected.slice(0, 12).map((e) => e.id).join(',')}) — rejection is sticky and will not be undone by later screening. Do NOT search for replacements just to keep the count.`,
      ...weakTopicSelected.slice(0, 8).map((e) => `${e.id}: precision=${e.topicalPrecisionScore ?? e.relevanceScore ?? 0}; ${e.title}`),
    ], Math.max(0, 100 - weakTopicSelected.length * 10)))

  const readTarget = Math.min(selected.length || minFullTextReads, minFullTextReads)
  results.push(readTarget === 0 || selectedRead.length >= readTarget
    ? pass('full_text_coverage', selected.length ? Math.round(selectedRead.length / selected.length * 100) : 100, highPriority.length ? [`High-priority read coverage: ${highPriorityRead.length}/${highPriority.length}.`] : [])
    : fail('full_text_coverage', [`Only ${selectedRead.length}/${selected.length} selected item(s) read; target is at least ${readTarget}.`], selected.length ? Math.round(selectedRead.length / selected.length * 100) : 0))

  results.push(failedHighPriority.length === 0
    ? pass('high_priority_availability', 100)
    : fail('high_priority_availability', failedHighPriority.slice(0, 8).map((e) => `${e.id}: ${e.title}; ${e.readReason ?? 'failed full-text read'}`), Math.max(0, 100 - failedHighPriority.length * 15)))

  const unreadTop = selected
    .filter((e) => e.readStatus !== 'read' && e.status !== 'read')
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  results.push(unreadTop.length === 0 || selectedRead.length >= readTarget
    ? pass('unread_top_sources', 100, unreadTop.length ? [`${unreadTop.length} top selected source(s) still unread but minimum read threshold is met.`] : [])
    : fail('unread_top_sources', unreadTop.map((e) => `${e.id}: ${e.title}`), 0))

  const corpusLinked = claims.filter((claim) => claim.corpusIds?.length).length
  results.push(claims.length === 0 || corpusLinked >= Math.ceil(claims.length * 0.8)
    ? pass('evidence_to_corpus_linkage', claims.length ? Math.round(corpusLinked / claims.length * 100) : 100)
    : fail('evidence_to_corpus_linkage', [`Only ${corpusLinked}/${claims.length} evidence claim(s) link to stable corpus IDs.`], Math.round(corpusLinked / Math.max(1, claims.length) * 100)))

  if (plan.length > 0) {
    const missingPlan = plan.filter((item) => {
      const assigned = selected.filter((e) => e.subQuestions?.includes(item.id))
      const readForPlan = assigned.filter((e) => e.readStatus === 'read' || e.status === 'read')
      const evidenceForPlan = claims.filter((c) => c.planItemId === item.id || c.topic === item.id)
      return assigned.length === 0 || readForPlan.length === 0 || evidenceForPlan.length < evidencePerSection
    })
    results.push(missingPlan.length === 0
      ? pass('plan_section_coverage', 100)
      : fail('plan_section_coverage', missingPlan.slice(0, 8).map((i) => `${i.id}: needs selected+read sources and ${evidencePerSection} evidence row(s).`), Math.max(0, 100 - missingPlan.length * 15)))
  }

  const dateViolations = selected.filter((e) => e.screeningReason?.toLowerCase().includes('outside strict date range')).length
  results.push(dateViolations === 0
    ? pass('date_range_compliance', 100)
    : fail('date_range_compliance', [`${dateViolations} selected corpus item(s) are outside the strict date range.`], 0))

  const topRejected = entries.slice(0, Math.min(20, entries.length)).filter((e) => e.screeningStatus === 'rejected').length
  results.push(topRejected <= 5
    ? pass('noise_ratio', Math.max(0, 100 - topRejected * 10))
    : fail('noise_ratio', [`${topRejected}/20 top-ranked corpus item(s) are rejected/noise. Re-screen corpus before reporting.`], Math.max(0, 100 - topRejected * 10)))

  const quoteLinked = claims.filter((claim) => claim.quote || claim.notes?.toLowerCase().includes('abstract')).length
  results.push(claims.length === 0 || quoteLinked >= Math.ceil(claims.length * 0.7)
    ? pass('report_citation_coverage', claims.length ? Math.round(quoteLinked / claims.length * 100) : 100)
    : fail('report_citation_coverage', [`Only ${quoteLinked}/${claims.length} evidence claim(s) have a quote/passage or explicit abstract-only caveat.`], Math.round(quoteLinked / Math.max(1, claims.length) * 100)))

  const reportPath = path.join(researchDir(workspace, opts?.outputDir), 'report.md')
  if (fs.existsSync(reportPath)) {
    const report = fs.readFileSync(reportPath, 'utf-8')
    const headings = (report.match(/^##\s+/gm) || []).length
    const tables = (report.match(/^\|.+\|\s*$/gm) || []).length
    const markdownLinks = (report.match(/\[[^\]]+\]\((https?:\/\/|[^)#][^)]+)\)/g) || []).length
    const localArtifactLinks = (report.match(/\[[^\]]*(?:full text|полный текст|локальный артефакт)[^\]]*\]\((?:\.\/)?fulltext\/[^)]+\)/gi) || []).length
    const sourceIdLinks = (report.match(/\[[a-f0-9]{10}\]\(https?:\/\/[^)]+\)/gi) || []).length
    const metadataOnlyMentions = (report.match(/metadata-only|abstract-only|только метаданн|только аннотац/gi) || []).length
    const qSections = (report.match(/^##\s+Q\d+\./gm) || []).length
    const evidenceDumpIndex = report.search(/Приложение: evidence claims|Приложение: доказательные утверждения|Appendix: evidence claims/i)
    const evidenceDumpTooEarly = evidenceDumpIndex >= 0 && evidenceDumpIndex < Math.max(2500, report.length * 0.65)
    // Must match the headings composeSynthesisReport actually emits in each language
    // (RU: "## Недоступные источники высокого приоритета", EN: "## Unavailable High-Priority Sources").
    // A mismatch here makes the gate impossible to satisfy and the agent regenerates forever.
    const unavailableSection = /Недоступные источники высокого приоритета|Недоступные high-priority источники|Unavailable High-Priority Sources/i.test(report)
    const analyticalSections = [
      /executive summary|резюме|кратк/i,
      /method|метод|подход/i,
      /benchmark|метрик|оценк/i,
      /limitations|ограничен|риски/i,
      /future|trend|направлен|тренд/i,
      /матрица направлений|direction matrix/i,
    ].filter((rx) => rx.test(report)).length
    const appendixMatch = report.search(/Evidence matrix|Selected Corpus Appendix|Приложение: selected corpus/i)
    const appendixHeavy = appendixMatch >= 0 && appendixMatch < Math.max(800, report.length * 0.35)
    // General (web) reports are consumer-shaped: still a structured, link-rich narrative
    // grounded in read sources, but without the academic survey skeleton (Q-sections,
    // mandatory "unavailable high-priority sources" block, metadata-only caveats, local
    // fulltext artifacts). Academic reports keep the full, stricter contract unchanged.
    const interactiveEnough = general
      ? markdownLinks >= 6 && sourceIdLinks >= 4
      : markdownLinks >= 12 && localArtifactLinks >= 3 && sourceIdLinks >= 8
    const narrativeEnough = general
      ? report.length >= 2500 && headings >= 4 && analyticalSections >= 3
      : report.length >= 7500 && headings >= 8 && analyticalSections >= 5 && qSections >= Math.min(4, plan.length || 4)
    const structuredEnough = general
      ? tables >= 2
      : tables >= 8 && unavailableSection && metadataOnlyMentions >= 1
    results.push(narrativeEnough && structuredEnough && interactiveEnough && !appendixHeavy && !evidenceDumpTooEarly
      ? pass('final_report_structure', 100)
      : fail('final_report_structure', [
        `report.md must be an interactive narrative synthesis${general ? ' (general/web shape)' : ''}: length=${report.length}, h2=${headings}, q_sections=${qSections}, analytical_sections=${analyticalSections}, table_rows=${tables}, markdown_links=${markdownLinks}, source_links=${sourceIdLinks}, local_artifact_links=${localArtifactLinks}, metadata_mentions=${metadataOnlyMentions}${appendixHeavy ? ', appendix appears too early' : ''}${evidenceDumpTooEarly ? ', evidence dump appears too early' : ''}${!general && !unavailableSection ? ', missing unavailable-source section' : ''}.`,
      ], Math.min(100, Math.round(report.length / 60))))
  }

  const passed = results.filter((r) => r.passed).length
  const summary = `Quality gates: ${passed}/${results.length} passed.`
  try {
    fs.mkdirSync(path.dirname(qualityPath(workspace, opts?.outputDir)), { recursive: true })
    fs.writeFileSync(qualityPath(workspace, opts?.outputDir), JSON.stringify({ summary, results, at: Date.now() }, null, 2), 'utf-8')
  } catch {}
  return { results, summary }
}

/** Persist a (possibly post-processed) set of gate results to quality-gates.json. */
export function writeQualityGateSnapshot(workspace: string, outputDir: string | undefined, results: GateResult[]): void {
  const passed = results.filter((r) => r.passed).length
  const summary = `Quality gates: ${passed}/${results.length} passed.`
  try {
    fs.mkdirSync(path.dirname(qualityPath(workspace, outputDir)), { recursive: true })
    fs.writeFileSync(qualityPath(workspace, outputDir), JSON.stringify({ summary, results, at: Date.now() }, null, 2), 'utf-8')
  } catch {}
}

function safeMtimeMs(p: string): number {
  try { return fs.statSync(p).mtimeMs } catch { return 0 }
}

/**
 * Quality-gate results are authoritative ONLY if they were computed AFTER the latest
 * change to corpus/evidence. Otherwise the snapshot reflects an older, smaller run
 * (e.g. gates run at 4 selected, then the corpus grew to 70) and must NOT drive state
 * inference or be shown as current blockers — that is what made runs flap between
 * EVIDENCE and GATES_FAILED and chase stale "Only 4 selected" blockers in circles.
 */
export function isQualityGateSnapshotFresh(workspace: string, outputDir?: string): boolean {
  const dir = researchDir(workspace, outputDir)
  const gatesMs = safeMtimeMs(path.join(dir, 'quality-gates.json'))
  if (gatesMs === 0) return false
  return gatesMs >= safeMtimeMs(path.join(dir, 'corpus.jsonl'))
    && gatesMs >= safeMtimeMs(path.join(dir, 'evidence.jsonl'))
}

export function latestQualityGateFailure(workspace: string, outputDir?: string, opts?: { ignoreGates?: string[] }): string | null {
  // Stale gate results (older than the current corpus/evidence) describe a run state
  // that no longer exists — surfacing them just confuses the agent. Ignore until re-run.
  if (!isQualityGateSnapshotFresh(workspace, outputDir)) return null
  const snap = readQualityGateSnapshot(workspace, outputDir)
  if (!snap || snap.allPassed) return null
  const ignored = new Set(opts?.ignoreGates ?? [])
  const failed = snap.failed.filter((r) => !ignored.has(r.gate))
  if (failed.length === 0) return null
  return failed.map((r) => `${r.gate}: ${r.blockers.join('; ') || 'failed'}`).join('\n')
}

function readQualityGateFile(workspace: string, outputDir?: string): QualityGateFile | null {
  const p = qualityPath(workspace, outputDir)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as QualityGateFile
  } catch {
    return null
  }
}

export function readQualityGateSnapshot(workspace: string, outputDir?: string): {
  passed: number
  total: number
  failed: GateResult[]
  allPassed: boolean
} | null {
  const data = readQualityGateFile(workspace, outputDir)
  if (!data) return null
  const results = data.results || []
  const failed = results.filter((r) => !r.passed)
  const passed = results.filter((r) => r.passed).length
  return { passed, total: results.length, failed, allPassed: failed.length === 0 && results.length > 0 }
}

// Internal gate names → calm, non-technical phrases for the end user. We deliberately
// avoid exposing gate names, tool names ("generate_evidence_report"), IDs or HTTP errors
// in the chat: this is an auto-research run, the user just needs a friendly progress note.
// The full technical blockers still go to the model via the supervisor directive.
const GATE_FRIENDLY: Record<string, { ru: string; en: string }> = {
  source_coverage: { ru: 'расширяю список источников', en: 'broadening the source list' },
  evidence_coverage: { ru: 'добираю доказательства', en: 'gathering more evidence' },
  claim_support: { ru: 'перепроверяю утверждения', en: 'double-checking claims' },
  plan_progress: { ru: 'закрываю пункты плана', en: 'wrapping up the plan' },
  recency: { ru: 'добавляю свежие источники', en: 'adding recent sources' },
  selected_corpus_minimum: { ru: 'отбираю больше источников', en: 'selecting more sources' },
  review_source_coverage: { ru: 'добавляю обзорные статьи', en: 'adding survey/review sources' },
  topical_precision: { ru: 'уточняю релевантность источников', en: 'refining source relevance' },
  full_text_coverage: { ru: 'дочитываю источники', en: 'finishing full-text reads' },
  high_priority_availability: { ru: 'заменяю недоступные источники', en: 'replacing unavailable sources' },
  unread_top_sources: { ru: 'дочитываю ключевые источники', en: 'reading key sources' },
  evidence_to_corpus_linkage: { ru: 'связываю доказательства с источниками', en: 'linking evidence to sources' },
  plan_section_coverage: { ru: 'довожу покрытие по подзадачам', en: 'filling coverage per subtopic' },
  date_range_compliance: { ru: 'привожу источники к нужному периоду', en: 'aligning sources to the date range' },
  noise_ratio: { ru: 'чищу список источников', en: 'cleaning up the source list' },
  report_citation_coverage: { ru: 'добавляю цитаты к выводам', en: 'adding citations to findings' },
}

/** Friendly, non-technical gate progress for the chat UI (auto-research). */
export function formatQualityGateUserStatus(
  workspace: string,
  outputDir?: string,
  lang: 'ru' | 'en' = 'ru',
): string | null {
  const snap = readQualityGateSnapshot(workspace, outputDir)
  if (!snap) return null
  const ru = lang === 'ru'

  if (snap.allPassed) {
    return ru
      ? '✅ Проверки качества пройдены — формирую финальный отчёт…'
      : '✅ Quality checks passed — building the final report…'
  }

  if (snap.failed.length > 0 && snap.failed.every((r) => r.gate === 'final_report_structure')) {
    return ru
      ? '📝 Данные готовы — дорабатываю и переписываю отчёт…'
      : '📝 Data is ready — polishing and rewriting the report…'
  }

  const phrases: string[] = []
  for (const r of snap.failed) {
    const phrase = GATE_FRIENDLY[r.gate]?.[lang] ?? (ru ? 'довожу качество данных' : 'polishing the data')
    if (!phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length >= 3) break
  }
  const joined = phrases.join(ru ? ', ' : ', ')
  return ru
    ? `🔧 Дорабатываю отчёт: ${joined}. Это часть авто-ресёрча — финальный отчёт появится автоматически.`
    : `🔧 Finishing the report: ${joined}. This is part of the auto-research — the final report will appear automatically.`
}

export function formatGateResults(workspace: string, sessionId: string | undefined, outputDir: string | undefined, results: GateResult[], summary: string): string {
  const lines = [`# Research Quality Gates`, '', summary, '']
  for (const r of results) {
    lines.push(`## ${r.passed ? 'PASS' : 'FAIL'} ${r.gate}${r.score !== undefined ? ` (${r.score}%)` : ''}`)
    for (const b of r.blockers) lines.push(`- Blocker: ${b}`)
    for (const w of r.warnings) lines.push(`- Warning: ${w}`)
    if (r.blockers.length === 0 && r.warnings.length === 0) lines.push('- No issues.')
    lines.push('')
  }
  if (loadEvidence(workspace, outputDir).length > 0) {
    lines.push('---', '', verifyClaims(workspace, sessionId, outputDir))
  }
  return lines.join('\n')
}

export function formatGateReport(workspace: string, sessionId?: string, outputDir?: string): string {
  const stored = readQualityGateFile(workspace, outputDir)
  if (stored?.results?.length) {
    const summary = stored.summary || `Quality gates: ${stored.results.filter((r) => r.passed).length}/${stored.results.length} passed.`
    return formatGateResults(workspace, sessionId, outputDir, stored.results, summary)
  }

  const { results, summary } = runQualityGates(workspace, sessionId, { outputDir })
  return formatGateResults(workspace, sessionId, outputDir, results, summary)
}
