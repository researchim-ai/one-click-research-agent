import { useMemo, useState } from 'react'
import { RESEARCH_PROFILES, type ResearchProfileId } from '../../research-profiles'
import {
  applyResearchIntakePatch,
  defaultResearchRequest,
  missingResearchFields,
  nextResearchIntakeQuestion,
  summarizeResearchRequest,
  type ResearchIntakeMessage,
  type ResearchIntakePatch,
} from '../utils/research-intake'

export type ResearchRunMode = 'quick' | 'deep' | 'systematic' | 'reproduction' | 'idea-scout'
export type ResearchDateRange = 'any' | 'last-year' | 'last-2-years' | 'since-2024' | 'custom'
export type ResearchCheckpoint = 'plan' | 'corpus' | 'evidence' | 'report'
export type ResearchOutput = 'brief' | 'report' | 'evidence-matrix' | 'export'
export type ResearchReportLanguage = 'ru' | 'en'
export type ResearchKind = 'general' | 'academic'

export interface NewResearchRequest {
  topic: string
  profileId: ResearchProfileId
  researchKind: ResearchKind
  mode: ResearchRunMode
  dateRange: ResearchDateRange
  customDateRange: string
  maxSources: number
  needFullText: boolean
  minSelectedSources: number
  minFullTextReads: number
  evidencePerSection: number
  strictDateRange: boolean
  requireQualityPass: boolean
  reportLanguage: ResearchReportLanguage
  outputs: ResearchOutput[]
  checkpoints: ResearchCheckpoint[]
  extraDirections: string
}

interface Props {
  open: boolean
  busy: boolean
  appLanguage?: 'ru' | 'en'
  onClose: () => void
  onStart: (request: NewResearchRequest) => void
}

const MODES: Array<{ id: ResearchRunMode; ru: string; en: string; descRu: string; descEn: string }> = [
  { id: 'quick', ru: 'Quick Scan', en: 'Quick Scan', descRu: 'Быстрый обзор и короткий brief.', descEn: 'Fast scan and short brief.' },
  { id: 'deep', ru: 'Deep Research', en: 'Deep Research', descRu: 'Итеративный поиск, evidence и quality gates.', descEn: 'Iterative search, evidence and quality gates.' },
  { id: 'systematic', ru: 'Systematic Review', en: 'Systematic Review', descRu: 'Строгий corpus, screening и матрица evidence.', descEn: 'Strict corpus, screening and evidence matrix.' },
  { id: 'reproduction', ru: 'Paper Reproduction', en: 'Paper Reproduction', descRu: 'Paper, code, данные, baseline и log.', descEn: 'Paper, code, data, baseline and log.' },
  { id: 'idea-scout', ru: 'Idea Scout', en: 'Idea Scout', descRu: 'Поиск gaps, трендов и research ideas.', descEn: 'Find gaps, trends and research ideas.' },
]

const CHECKPOINTS: Array<{ id: ResearchCheckpoint; ru: string; en: string }> = [
  { id: 'plan', ru: 'после плана', en: 'after plan' },
  { id: 'corpus', ru: 'после корпуса', en: 'after corpus' },
  { id: 'evidence', ru: 'после evidence', en: 'after evidence' },
  { id: 'report', ru: 'перед финальным отчётом', en: 'before final report' },
]

const OUTPUTS: Array<{ id: ResearchOutput; ru: string; en: string }> = [
  { id: 'brief', ru: 'brief', en: 'brief' },
  { id: 'report', ru: 'report.md', en: 'report.md' },
  { id: 'evidence-matrix', ru: 'evidence matrix', en: 'evidence matrix' },
  { id: 'export', ru: 'экспорт PDF/DOCX/BibTeX', en: 'PDF/DOCX/BibTeX export' },
]

export function NewResearchDialog({ open, busy, appLanguage = 'ru', onClose, onStart }: Props) {
  const L = appLanguage === 'ru'
  const [modeView, setModeView] = useState<'dialog' | 'manual'>('dialog')
  const [topic, setTopic] = useState('')
  const [profileId, setProfileId] = useState<ResearchProfileId>('universal')
  const [researchKind, setResearchKind] = useState<ResearchKind>('general')
  const [mode, setMode] = useState<ResearchRunMode>('deep')
  const [dateRange, setDateRange] = useState<ResearchDateRange>('last-2-years')
  const [customDateRange, setCustomDateRange] = useState('')
  const [maxSources, setMaxSources] = useState(25)
  const [needFullText, setNeedFullText] = useState(true)
  const [minSelectedSources, setMinSelectedSources] = useState(12)
  const [minFullTextReads, setMinFullTextReads] = useState(8)
  const [evidencePerSection, setEvidencePerSection] = useState(2)
  const [strictDateRange, setStrictDateRange] = useState(true)
  const [requireQualityPass, setRequireQualityPass] = useState(true)
  const [reportLanguage, setReportLanguage] = useState<ResearchReportLanguage>(appLanguage === 'ru' ? 'ru' : 'en')
  const [outputs, setOutputs] = useState<ResearchOutput[]>(['brief', 'report', 'evidence-matrix'])
  const [checkpoints, setCheckpoints] = useState<ResearchCheckpoint[]>(['plan'])
  const [extraDirections, setExtraDirections] = useState('')
  const [draft, setDraft] = useState<NewResearchRequest>(() => defaultResearchRequest(appLanguage))
  const [intakeInput, setIntakeInput] = useState('')
  const [intakeBusy, setIntakeBusy] = useState(false)
  const [intakeMessages, setIntakeMessages] = useState<ResearchIntakeMessage[]>([
    {
      role: 'assistant',
      content: appLanguage === 'ru'
        ? 'Что исследуем? Можно написать обычным текстом: тема, период, язык отчёта, глубина, ограничения.'
        : 'What should we research? You can describe topic, date range, report language, depth and constraints in plain text.',
    },
  ])

  const activeProfile = useMemo(() => RESEARCH_PROFILES.find((p) => p.id === profileId) ?? RESEARCH_PROFILES[0], [profileId])
  const draftProfile = useMemo(() => RESEARCH_PROFILES.find((p) => p.id === draft.profileId) ?? RESEARCH_PROFILES[0], [draft.profileId])

  if (!open) return null

  const toggle = <T extends string>(items: T[], value: T, setter: (items: T[]) => void) => {
    setter(items.includes(value) ? items.filter((x) => x !== value) : [...items, value])
  }

  const canStart = topic.trim().length > 2 && !busy
  const draftReady = missingResearchFields(draft).length === 0 && !busy

  const submit = () => {
    if (!canStart) return
    onStart({
      topic: topic.trim(),
      profileId,
      researchKind,
      mode,
      dateRange,
      customDateRange: customDateRange.trim(),
      maxSources,
      needFullText,
      minSelectedSources,
      minFullTextReads,
      evidencePerSection,
      strictDateRange,
      requireQualityPass,
      reportLanguage,
      outputs,
      checkpoints,
      extraDirections: extraDirections.trim(),
    })
  }

  const requestFromManualForm = (): NewResearchRequest => ({
    topic: topic.trim(),
    profileId,
    researchKind,
    mode,
    dateRange,
    customDateRange: customDateRange.trim(),
    maxSources,
    needFullText,
    minSelectedSources,
    minFullTextReads,
    evidencePerSection,
    strictDateRange,
    requireQualityPass,
    reportLanguage,
    outputs,
    checkpoints,
    extraDirections: extraDirections.trim(),
  })

  const applyDraftToManualForm = (next: NewResearchRequest) => {
    setTopic(next.topic)
    setProfileId(next.profileId)
    setResearchKind(next.researchKind)
    setMode(next.mode)
    setDateRange(next.dateRange)
    setCustomDateRange(next.customDateRange)
    setMaxSources(next.maxSources)
    setNeedFullText(next.needFullText)
    setMinSelectedSources(next.minSelectedSources)
    setMinFullTextReads(next.minFullTextReads)
    setEvidencePerSection(next.evidencePerSection)
    setStrictDateRange(next.strictDateRange)
    setRequireQualityPass(next.requireQualityPass)
    setReportLanguage(next.reportLanguage)
    setOutputs(next.outputs)
    setCheckpoints(next.checkpoints)
    setExtraDirections(next.extraDirections)
  }

  const mergeDraft = (patch: ResearchIntakePatch, userText?: string, assistantOverride?: string): NewResearchRequest => {
    const next = applyResearchIntakePatch(draft, patch)
    setDraft(next)
    if (userText) {
      setIntakeMessages((prev) => [
        ...prev,
        { role: 'user', content: userText },
        { role: 'assistant', content: assistantOverride ?? nextResearchIntakeQuestion(next, appLanguage) },
      ])
    }
    return next
  }

  const submitIntakeMessage = async () => {
    const text = intakeInput.trim()
    if (!text || intakeBusy) return
    setIntakeInput('')
    setIntakeBusy(true)
    let patch: ResearchIntakePatch = {}
    let llmFailed = false
    let llmError = ''
    try {
      if (window.api?.inferResearchRequest) {
        const inferred = await window.api.inferResearchRequest({
          message: text,
          draft,
          appLanguage,
          profiles: RESEARCH_PROFILES.map((p) => ({ id: p.id, label: p.label, domain: p.domain })),
        })
        if (inferred?.error) {
          llmFailed = true
          llmError = String(inferred.error)
        } else if (inferred?.patch && Object.keys(inferred.patch).length) {
          patch = inferred.patch
        } else {
          llmFailed = true
        }
      } else {
        llmFailed = true
      }
    } catch (e: any) {
      llmFailed = true
      llmError = String(e?.message || e)
    }
    // No regex/heuristic parsing: the model is the only brain for parameters.
    // If it could not analyze the request, just capture the raw text as the topic
    // so the user can still continue (or open manual mode).
    let assistantOverride: string | undefined
    if (llmFailed) {
      if (!draft.topic.trim()) patch = { ...patch, topic: text }
      assistantOverride = appLanguage === 'ru'
        ? `Не удалось разобрать запрос моделью${llmError ? ` (${llmError})` : ''}. Записал текст как тему — уточни остальные параметры в диалоге или открой ручной режим.`
        : `The model could not analyze the request${llmError ? ` (${llmError})` : ''}. I saved the text as the topic — refine the rest in the dialog or open manual mode.`
    }
    mergeDraft(patch, text, assistantOverride)
    setIntakeBusy(false)
  }

  const openManualMode = () => {
    applyDraftToManualForm(draft)
    setModeView('manual')
  }

  const startFromDialog = () => {
    if (!draftReady) return
    onStart(draft)
  }

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-zinc-100">{L ? 'Новое исследование' : 'New Research'}</div>
            <div className="text-sm text-zinc-500 mt-1">
              {L
                ? 'По умолчанию агент уточнит параметры в диалоге. Опросник доступен как ручной режим.'
                : 'By default the agent clarifies parameters in a dialog. The form is available as manual mode.'}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (modeView === 'manual') setDraft(requestFromManualForm())
                  setModeView('dialog')
                }}
                className={`px-3 py-1.5 rounded-lg border text-xs cursor-pointer ${
                  modeView === 'dialog' ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                {L ? 'Диалог' : 'Dialog'}
              </button>
              <button
                type="button"
                onClick={openManualMode}
                className={`px-3 py-1.5 rounded-lg border text-xs cursor-pointer ${
                  modeView === 'manual' ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                {L ? 'Опросник / Advanced' : 'Form / Advanced'}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {modeView === 'dialog' ? (
            <>
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
                <div className="text-xs text-zinc-500">
                  {L
                    ? 'Напиши цель исследования свободно. Я выделю параметры, задам уточнение если чего-то не хватает, и перед запуском покажу резюме.'
                    : 'Describe the research goal freely. I will extract parameters, ask for missing details, and show a summary before starting.'}
                </div>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {intakeMessages.map((m, i) => (
                    <div
                      key={`${m.role}-${i}`}
                      className={`rounded-xl px-3 py-2 text-sm ${
                        m.role === 'user'
                          ? 'bg-blue-500/10 border border-blue-500/20 text-blue-100 ml-8'
                          : 'bg-zinc-950 border border-zinc-800 text-zinc-300 mr-8'
                      }`}
                    >
                      {m.content}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={intakeInput}
                    onChange={(e) => setIntakeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitIntakeMessage()
                    }}
                    rows={3}
                    placeholder={L ? 'Например: нужен глубокий отчёт на русском по RL за 2024-2026, full text, строго по источникам.' : 'Example: deep Russian report on RL 2024-2026, full text, strict sources.'}
                    className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 outline-none resize-none"
                  />
                  <button
                    type="button"
                    onClick={submitIntakeMessage}
                    disabled={!intakeInput.trim() || intakeBusy}
                    className="self-end px-3 py-2 rounded-lg bg-blue-600 text-sm text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {intakeBusy ? (L ? 'Думаю…' : 'Thinking…') : (L ? 'Отправить' : 'Send')}
                  </button>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <div className="text-sm font-medium text-zinc-200">{L ? 'Параметры запуска' : 'Launch parameters'}</div>
                    <div className="text-xs text-zinc-500 mt-1">
                      {draftReady
                        ? (L ? 'Готово к запуску. Можно ещё написать уточнение в диалоге.' : 'Ready to start. You can still refine via chat.')
                        : nextResearchIntakeQuestion(draft, appLanguage)}
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded-lg text-[11px] border ${
                    draftReady ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  }`}>
                    {draftReady ? (L ? 'готово' : 'ready') : (L ? 'нужно уточнение' : 'needs input')}
                  </span>
                </div>
                <div className="grid md:grid-cols-2 gap-2">
                  {summarizeResearchRequest(draft, appLanguage).map(([label, value]) => (
                    <div key={label} className="flex items-start justify-between gap-3 rounded-lg bg-zinc-900/50 px-3 py-2">
                      <span className="text-xs text-zinc-500">{label}</span>
                      <span className="text-xs text-zinc-200 text-right">{value}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={startFromDialog}
                    disabled={!draftReady}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {L ? 'Начать исследование' : 'Start research'}
                  </button>
                  <button
                    type="button"
                    onClick={openManualMode}
                    className="px-4 py-2 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                  >
                    {L ? 'Настроить вручную' : 'Tune manually'}
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
          <section>
            <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Тема / вопрос' : 'Topic / question'}</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              placeholder={L ? 'Например: свежие подходы к memory в LLM agents' : 'Example: recent approaches to memory in LLM agents'}
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 outline-none resize-none"
            />
          </section>

          <section className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Профиль' : 'Profile'}</label>
              <div className="space-y-2">
                {RESEARCH_PROFILES.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => {
                      setProfileId(profile.id)
                      if (profile.uiDefaults.mode === 'reproduction') setMode('reproduction')
                      else if (profile.uiDefaults.mode === 'systematic') setMode('systematic')
                      else if (profile.uiDefaults.mode === 'deep') setMode('deep')
                      setMaxSources(profile.uiDefaults.maxSources)
                      setNeedFullText(profile.uiDefaults.preferFullText)
                      setMinSelectedSources(Math.max(8, Math.min(30, Math.round(profile.uiDefaults.maxSources * 0.45))))
                      setMinFullTextReads(Math.max(5, Math.min(20, Math.round(profile.uiDefaults.maxSources * 0.28))))
                    }}
                    className={`w-full text-left px-3 py-2 rounded-xl border transition-colors cursor-pointer ${
                      profile.id === profileId
                        ? 'border-blue-500/50 bg-blue-500/10'
                        : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                    }`}
                  >
                    <div className="text-sm font-medium text-zinc-200">{profile.label}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">{profile.domain}</div>
                  </button>
                ))}
              </div>
              <div className="mt-3">
                <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Тип источников' : 'Source kind'}</label>
                <select
                  value={researchKind}
                  onChange={(e) => setResearchKind(e.target.value as ResearchKind)}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
                >
                  <option value="general">{L ? 'Общий (web) — без научных гейтов' : 'General (web) — no academic gates'}</option>
                  <option value="academic">{L ? 'Научный — обзоры/свежесть обязательны' : 'Academic — survey/recency required'}</option>
                </select>
                <div className="text-[11px] text-zinc-500 mt-1">
                  {L
                    ? '«Общий» для бытовых/рыночных тем (web-источники). «Научный» — только когда реально нужны статьи и исследования.'
                    : '“General” for everyday/market topics (web sources). “Academic” only when papers/studies are truly needed.'}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Режим' : 'Mode'}</label>
                <div className="space-y-2">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMode(m.id)}
                      className={`w-full text-left px-3 py-2 rounded-xl border transition-colors cursor-pointer ${
                        mode === m.id ? 'border-blue-500/50 bg-blue-500/10' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                      }`}
                    >
                      <div className="text-sm font-medium text-zinc-200">{L ? m.ru : m.en}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">{L ? m.descRu : m.descEn}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="grid md:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Min selected' : 'Min selected'}</label>
              <input
                type="number"
                min={1}
                max={100}
                value={minSelectedSources}
                onChange={(e) => setMinSelectedSources(Number(e.target.value) || 1)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Min full-text' : 'Min full-text'}</label>
              <input
                type="number"
                min={0}
                max={100}
                value={minFullTextReads}
                onChange={(e) => setMinFullTextReads(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Evidence/Q' : 'Evidence/Q'}</label>
              <input
                type="number"
                min={1}
                max={20}
                value={evidencePerSection}
                onChange={(e) => setEvidencePerSection(Number(e.target.value) || 1)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
              />
            </div>
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-900/50 cursor-pointer mt-6">
              <input type="checkbox" checked={strictDateRange} onChange={(e) => setStrictDateRange(e.target.checked)} />
              <span className="text-xs text-zinc-300">{L ? 'строгие даты' : 'strict dates'}</span>
            </label>
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-900/50 cursor-pointer mt-6">
              <input type="checkbox" checked={requireQualityPass} onChange={(e) => setRequireQualityPass(e.target.checked)} />
              <span className="text-xs text-zinc-300">{L ? 'gate pass' : 'gate pass'}</span>
            </label>
          </section>

          <section className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Свежесть' : 'Date range'}</label>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as ResearchDateRange)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
              >
                <option value="any">{L ? 'любой период' : 'any time'}</option>
                <option value="last-year">{L ? 'последний год' : 'last year'}</option>
                <option value="last-2-years">{L ? 'последние 2 года' : 'last 2 years'}</option>
                <option value="since-2024">{L ? 'с 2024' : 'since 2024'}</option>
                <option value="custom">{L ? 'свой диапазон' : 'custom'}</option>
              </select>
              {dateRange === 'custom' && (
                <input
                  value={customDateRange}
                  onChange={(e) => setCustomDateRange(e.target.value)}
                  placeholder="2023-01-01..2026-05-25"
                  className="w-full mt-2 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 outline-none"
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Макс. источников' : 'Max sources'}</label>
              <select
                value={maxSources}
                onChange={(e) => setMaxSources(Number(e.target.value))}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
              >
                {[10, 25, 40, 50, 75, 100, 150, 200].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-3 px-3 py-2 rounded-xl border border-zinc-800 bg-zinc-900/50 cursor-pointer mt-6">
              <input type="checkbox" checked={needFullText} onChange={(e) => setNeedFullText(e.target.checked)} />
              <span className="text-sm text-zinc-300">{L ? 'читать full text' : 'read full text'}</span>
            </label>
          </section>

          <section className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Язык отчёта' : 'Report language'}</label>
              <select
                value={reportLanguage}
                onChange={(e) => setReportLanguage(e.target.value as ResearchReportLanguage)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 focus:border-blue-500 outline-none"
              >
                <option value="ru">{L ? 'Русский' : 'Russian'}</option>
                <option value="en">{L ? 'Английский' : 'English'}</option>
              </select>
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Checkpoint’ы для правок' : 'Review checkpoints'}</label>
              <div className="flex flex-wrap gap-2">
                {CHECKPOINTS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(checkpoints, c.id, setCheckpoints)}
                    className={`px-3 py-1.5 rounded-lg border text-xs cursor-pointer ${
                      checkpoints.includes(c.id)
                        ? 'border-blue-500/50 bg-blue-500/10 text-blue-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                    }`}
                  >
                    {L ? c.ru : c.en}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Выходные артефакты' : 'Outputs'}</label>
              <div className="flex flex-wrap gap-2">
                {OUTPUTS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggle(outputs, o.id, setOutputs)}
                    className={`px-3 py-1.5 rounded-lg border text-xs cursor-pointer ${
                      outputs.includes(o.id)
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                    }`}
                  >
                    {L ? o.ru : o.en}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <label className="block text-xs font-medium text-zinc-400 mb-2">{L ? 'Дополнения / ограничения' : 'Extra directions / constraints'}</label>
            <textarea
              value={extraDirections}
              onChange={(e) => setExtraDirections(e.target.value)}
              rows={3}
              placeholder={L ? 'Например: не использовать старые статьи, отдельно проверить GitHub repos, сначала спросить перед full-text чтением.' : 'Example: avoid old papers, check GitHub repos separately, ask before full-text reading.'}
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 outline-none resize-none"
            />
          </section>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-3">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{L ? 'Как это будет работать' : 'How it will run'}</div>
            <div className="text-xs text-zinc-400">
              {L
                ? `Агент стартует в профиле ${activeProfile.label}, сначала создаст план и остановится на выбранных checkpoint’ах для твоих правок. Между checkpoint’ами он может автономно искать, собирать corpus, записывать evidence и проверять качество.`
                : `The agent will start with ${activeProfile.label}, create a plan first, and stop at selected checkpoints for your edits. Between checkpoints it can search, build corpus, record evidence and run quality checks.`}
            </div>
          </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-between gap-3">
          <div className="text-xs text-zinc-500">
            {modeView === 'dialog'
              ? (L ? 'Research session создастся только после подтверждения параметров.' : 'The research session is created only after you confirm parameters.')
              : (L ? 'Можно будет дополнять направление прямо в чате на каждом checkpoint’е.' : 'You can refine direction in chat at every checkpoint.')}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
            >
              {L ? 'Отмена' : 'Cancel'}
            </button>
            {modeView === 'manual' && (
              <button
                type="button"
                onClick={submit}
                disabled={!canStart}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                {L ? 'Начать исследование' : 'Start research'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
