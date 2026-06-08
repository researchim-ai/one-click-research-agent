import { RESEARCH_PROFILES, type ResearchProfileId } from '../../research-profiles'
import type {
  NewResearchRequest,
  ResearchDateRange,
  ResearchReportLanguage,
  ResearchRunMode,
} from '../components/NewResearchDialog'

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
    checkpoints: ['plan', 'corpus', 'report'],
    extraDirections: '',
  }
}

export function applyResearchIntakePatch(base: NewResearchRequest, patch: ResearchIntakePatch): NewResearchRequest {
  const next = { ...base, ...patch }
  if (!RESEARCH_PROFILES.some((p) => p.id === next.profileId)) next.profileId = 'universal'
  next.maxSources = clampInt(next.maxSources, 10, 100, base.maxSources)
  next.minSelectedSources = clampInt(next.minSelectedSources, 1, 100, base.minSelectedSources)
  next.minFullTextReads = clampInt(next.minFullTextReads, 0, 100, base.minFullTextReads)
  next.evidencePerSection = clampInt(next.evidencePerSection, 1, 20, base.evidencePerSection)
  next.outputs = Array.isArray(next.outputs) && next.outputs.length ? next.outputs : base.outputs
  next.checkpoints = Array.isArray(next.checkpoints) && next.checkpoints.length ? next.checkpoints : base.checkpoints
  return next
}

export function inferResearchRequestPatch(text: string, current: NewResearchRequest, appLanguage: 'ru' | 'en' = 'ru'): ResearchIntakePatch {
  const raw = String(text || '').trim()
  const lower = raw.toLowerCase()
  const patch: ResearchIntakePatch = {}

  const topic = extractTopic(raw)
  if (topic) patch.topic = topic

  const profileId = inferProfile(lower)
  if (profileId) {
    patch.profileId = profileId
    const profile = RESEARCH_PROFILES.find((p) => p.id === profileId)
    if (profile) {
      patch.maxSources = profile.uiDefaults.maxSources
      patch.needFullText = profile.uiDefaults.preferFullText
      patch.minSelectedSources = Math.max(8, Math.min(30, Math.round(profile.uiDefaults.maxSources * 0.45)))
      patch.minFullTextReads = Math.max(5, Math.min(20, Math.round(profile.uiDefaults.maxSources * 0.28)))
      if (profile.uiDefaults.mode !== 'monitoring') patch.mode = profile.uiDefaults.mode
    }
  }

  const mode = inferMode(lower)
  if (mode) patch.mode = mode

  const dateRange = inferDateRange(lower)
  if (dateRange.dateRange) {
    patch.dateRange = dateRange.dateRange
    patch.customDateRange = dateRange.customDateRange ?? ''
    patch.strictDateRange = dateRange.strictDateRange
  }

  const language = inferLanguage(lower, appLanguage)
  if (language) patch.reportLanguage = language

  if (/без full[ -]?text|не читать full|только abstract|только абстракт|без полного текста/i.test(lower)) {
    patch.needFullText = false
    patch.minFullTextReads = 0
  } else if (/full[ -]?text|полный текст|читать статьи|читать pdf|читать html/i.test(lower)) {
    patch.needFullText = true
  }

  const maxSources = matchNumber(lower, /(?:до|макс(?:имум)?|max(?:imum)?|не больше)\s+(\d{1,3})\s+(?:источник|source|paper|стат)/i)
  if (maxSources) patch.maxSources = maxSources

  const selected = matchNumber(lower, /(?:min selected|min selected sources|минимум selected|отобрать)\s+(\d{1,3})/i)
  if (selected) patch.minSelectedSources = selected

  const reads = matchNumber(lower, /(?:min full(?:-|\s)?text|min reads|прочитать минимум|минимум full)\s+(\d{1,3})/i)
  if (reads !== null) patch.minFullTextReads = reads

  if (/кратк|brief|коротк|быстро/i.test(lower)) {
    patch.outputs = ['brief']
    patch.mode = patch.mode ?? 'quick'
  } else if (/report|отч[её]т|md|подробн|полный/i.test(lower)) {
    patch.outputs = current.outputs.includes('report') ? current.outputs : [...current.outputs, 'report']
  }

  if (/без checkpoint|не спрашивай|автономно/i.test(lower)) patch.checkpoints = ['report']
  if (/согласов|checkpoint|провер|правк|уточн/i.test(lower)) patch.checkpoints = ['plan', 'corpus', 'evidence', 'report']

  const extra = raw.replace(topic ?? '', '').trim()
  if (extra.length > 10 && !current.extraDirections.includes(extra)) {
    patch.extraDirections = [current.extraDirections, extra].filter(Boolean).join('\n')
  }

  return patch
}

export function missingResearchFields(request: NewResearchRequest): string[] {
  const missing: string[] = []
  if (!request.topic.trim() || request.topic.trim().length < 3) missing.push('topic')
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
    [L ? 'Режим' : 'Mode', request.mode],
    [L ? 'Период' : 'Date range', date],
    [L ? 'Язык отчёта' : 'Report language', request.reportLanguage === 'ru' ? 'Русский' : 'English'],
    [L ? 'Источники' : 'Sources', `raw max ${request.maxSources}, selected min ${request.minSelectedSources}, full-text min ${request.minFullTextReads}`],
    [L ? 'Evidence' : 'Evidence', `${request.evidencePerSection}/${L ? 'секция' : 'section'}`],
    [L ? 'Артефакты' : 'Outputs', request.outputs.join(', ')],
    [L ? 'Checkpoint’ы' : 'Checkpoints', request.checkpoints.join(', ')],
  ]
}

function extractTopic(text: string): string | null {
  const cleaned = text
    .replace(/^(хочу|надо|нужно|давай|сделай|проведи|исследуй|найди|посмотри|research|study|analyze|analyse)\s+/i, '')
    .replace(/\b(на русском|по-русски|in russian|in english|на английском|по-английски)\b/gi, '')
    .trim()
  if (cleaned.length < 3) return null
  const sentence = cleaned.split(/[.!?]\s+/)[0]?.trim() || cleaned
  return sentence.slice(0, 240)
}

function inferProfile(lower: string): ResearchProfileId | null {
  if (/biology|biomed|protein|crispr|gene|medical|pubmed|биолог|медиц|протеин|геном/i.test(lower)) return 'biology'
  if (/math|theorem|proof|lemma|математ|теорем|доказ/i.test(lower)) return 'mathematics'
  if (/finance|market|trading|portfolio|risk|финанс|рынок|портфел/i.test(lower)) return 'finance'
  if (/reproduce|reproduction|репродуц|воспроизв|paper implementation/i.test(lower)) return 'paper-reproduction'
  if (/llm|agent|reinforcement|rlhf|rlvr|machine learning|deep learning|нейросет|машинн|ai|ии/i.test(lower)) return 'ml-ai'
  return null
}

function inferMode(lower: string): ResearchRunMode | null {
  if (/quick|быстр|кратк|scan/i.test(lower)) return 'quick'
  if (/systematic|систематич|строг|review/i.test(lower)) return 'systematic'
  if (/reproduce|reproduction|воспроизв/i.test(lower)) return 'reproduction'
  if (/idea|идеи|гипотез|scout/i.test(lower)) return 'idea-scout'
  if (/deep|глубок|подробн/i.test(lower)) return 'deep'
  return null
}

function inferDateRange(lower: string): { dateRange?: ResearchDateRange; customDateRange?: string; strictDateRange?: boolean } {
  const custom = lower.match(/\b(20\d{2})(?:[-/.]\d{2}[-/.]\d{2})?\s*(?:\.{2}|-|—|до|to)\s*(20\d{2})(?:[-/.]\d{2}[-/.]\d{2})?\b/i)
  if (custom) return { dateRange: 'custom', customDateRange: `${custom[1]}-01-01..${custom[2]}-12-31`, strictDateRange: true }
  if (/2024|с 2024|since 2024|2024[\s-]*(?:2025|2026)/i.test(lower)) return { dateRange: 'since-2024', strictDateRange: true }
  if (/последн(?:ий|ие)\s+2|last\s+2|two years/i.test(lower)) return { dateRange: 'last-2-years', strictDateRange: true }
  if (/последн(?:ий)?\s+год|last year|this year/i.test(lower)) return { dateRange: 'last-year', strictDateRange: true }
  if (/любой период|any time|без огранич/i.test(lower)) return { dateRange: 'any', strictDateRange: false }
  return {}
}

function inferLanguage(lower: string, appLanguage: 'ru' | 'en'): ResearchReportLanguage | null {
  if (/на русском|по-русски|russian|русский отч[её]т/i.test(lower)) return 'ru'
  if (/на английском|по-английски|english|английский отч[её]т/i.test(lower)) return 'en'
  return appLanguage === 'ru' ? 'ru' : 'en'
}

function matchNumber(text: string, pattern: RegExp): number | null {
  const raw = text.match(pattern)?.[1]
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
