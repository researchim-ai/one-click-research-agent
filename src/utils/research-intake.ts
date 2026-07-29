import { RESEARCH_PROFILES } from '../../research-profiles'
import { SEARCH_SOURCE_IDS, normalizeAllowedSearchTools, searchSourceLabel } from '../../search-sources'
import type { NewResearchRequest } from '../components/NewResearchDialog'

export type ResearchIntakePatch = Partial<NewResearchRequest>

export interface ResearchIntakeMessage {
  role: 'assistant' | 'user'
  content: string
}

export function defaultResearchRequest(appLanguage: 'ru' | 'en' = 'ru'): NewResearchRequest {
  const profile = RESEARCH_PROFILES.find((p) => p.id === 'universal') ?? RESEARCH_PROFILES[0]
  return {
    topic: '',
    profileId: profile.id,
    researchKind: 'general',
    mode: 'deep',
    dateRange: 'last-2-years',
    customDateRange: '',
    maxSources: 25,
    needFullText: true,
    minSelectedSources: 12,
    minFullTextReads: 8,
    evidencePerSection: 2,
    strictDateRange: true,
    requireQualityPass: true,
    reportLanguage: appLanguage === 'ru' ? 'ru' : 'en',
    outputs: ['brief', 'report', 'evidence-matrix'],
    // Auto-research: the plan is the single approval gate (it has real programmatic
    // pause/resume). Everything after it — corpus, reading, evidence, quality gates,
    // report.md — runs autonomously. Corpus/evidence/report checkpoints are opt-in
    // via manual mode for users who want to review those phases.
    checkpoints: ['plan'],
    extraDirections: '',
    // All discovery sources enabled by default = no restriction. A user can narrow this
    // (e.g. only arXiv) in the dialog or via the intake model.
    allowedSearchTools: [...SEARCH_SOURCE_IDS],
  }
}

export function applyResearchIntakePatch(base: NewResearchRequest, patch: ResearchIntakePatch): NewResearchRequest {
  const next = { ...base, ...patch }
  if (!RESEARCH_PROFILES.some((p) => p.id === next.profileId)) next.profileId = 'universal'
  if (next.researchKind !== 'general' && next.researchKind !== 'academic') next.researchKind = base.researchKind ?? 'general'
  // General (web) research uses the universal profile. The domain profiles (finance,
  // ml-ai, biology, mathematics, paper-reproduction) inject academic-leaning tools and
  // instructions that don't fit a consumer/everyday topic — keep them for academic runs
  // only. This is why "сколько стоят квартиры" must not stay on the finance profile.
  if (next.researchKind === 'general' && next.profileId !== 'universal') next.profileId = 'universal'
  next.maxSources = clampInt(next.maxSources, 10, 200, base.maxSources)
  next.minSelectedSources = clampInt(next.minSelectedSources, 1, 200, base.minSelectedSources)
  next.minFullTextReads = clampInt(next.minFullTextReads, 0, 200, base.minFullTextReads)
  next.evidencePerSection = clampInt(next.evidencePerSection, 1, 20, base.evidencePerSection)
  next.outputs = Array.isArray(next.outputs) && next.outputs.length ? next.outputs : base.outputs
  next.checkpoints = Array.isArray(next.checkpoints) && next.checkpoints.length ? next.checkpoints : base.checkpoints
  // allowedSearchTools: keep only known ids. If the patch/base leaves it empty, fall back to
  // "all sources" so a run never ends up with zero search engines.
  next.allowedSearchTools = Array.isArray(next.allowedSearchTools)
    ? next.allowedSearchTools.filter((id) => SEARCH_SOURCE_IDS.includes(id))
    : [...SEARCH_SOURCE_IDS]
  if (!next.allowedSearchTools.length) next.allowedSearchTools = [...SEARCH_SOURCE_IDS]
  return next
}

export function missingResearchFields(request: NewResearchRequest): string[] {
  const missing: string[] = []
  // A topic just needs to be non-empty. Valid research topics are often 2-char acronyms
  // ("RL", "AI", "ML"), so requiring 3+ chars wrongly re-asked for a topic the user already
  // gave (e.g. "RL за последний месяц" → the model correctly extracts topic "RL").
  if (!request.topic.trim()) missing.push('topic')
  if (!request.reportLanguage) missing.push('reportLanguage')
  if (request.dateRange === 'custom' && !request.customDateRange.trim()) missing.push('customDateRange')
  return missing
}

export function nextResearchIntakeQuestion(request: NewResearchRequest, appLanguage: 'ru' | 'en' = 'ru'): string {
  const missing = missingResearchFields(request)
  const L = appLanguage === 'ru'
  if (missing.includes('topic')) return L ? 'Что исследуем? Напиши тему обычным текстом.' : 'What should we research? Describe the topic in plain text.'
  if (missing.includes('customDateRange')) return L ? 'Какой точный период использовать? Например: 2024-01-01..2026-05-27.' : 'What exact date range should I use? Example: 2024-01-01..2026-05-27.'
  return L
    ? 'Я собрал параметры. Проверь краткое резюме ниже и нажми “Начать исследование”, либо уточни что изменить.'
    : 'I have enough parameters. Review the summary below and click “Start research”, or tell me what to change.'
}

export function summarizeResearchRequest(request: NewResearchRequest, appLanguage: 'ru' | 'en' = 'ru'): Array<[string, string]> {
  const L = appLanguage === 'ru'
  const profile = RESEARCH_PROFILES.find((p) => p.id === request.profileId)
  const date = request.dateRange === 'custom' ? request.customDateRange || 'custom' : request.dateRange
  return [
    [L ? 'Тема' : 'Topic', request.topic || (L ? 'не указана' : 'not set')],
    [L ? 'Профиль' : 'Profile', profile?.label ?? request.profileId],
    [L ? 'Тип источников' : 'Source kind', request.researchKind === 'academic' ? (L ? 'научный' : 'academic') : (L ? 'общий (web)' : 'general (web)')],
    [L ? 'Режим' : 'Mode', request.mode],
    [L ? 'Период' : 'Date range', date],
    [L ? 'Язык отчёта' : 'Report language', request.reportLanguage === 'ru' ? 'Русский' : 'English'],
    [L ? 'Источники' : 'Sources', `raw max ${request.maxSources}, selected min ${request.minSelectedSources}, full-text min ${request.minFullTextReads}`],
    [L ? 'Evidence' : 'Evidence', `${request.evidencePerSection}/${L ? 'секция' : 'section'}`],
    [L ? 'Артефакты' : 'Outputs', request.outputs.join(', ')],
    [L ? 'Checkpoint’ы' : 'Checkpoints', request.checkpoints.join(', ')],
    [L ? 'Источники поиска' : 'Search sources', describeSearchSources(request.allowedSearchTools, L)],
  ]
}

function describeSearchSources(list: string[] | undefined, ru: boolean): string {
  const restricted = normalizeAllowedSearchTools(list)
  if (!restricted) return ru ? 'все доступные' : 'all available'
  return restricted.map((id) => searchSourceLabel(id)).join(', ')
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
