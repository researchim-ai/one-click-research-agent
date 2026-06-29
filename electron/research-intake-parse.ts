// Pure, dependency-free parsing/sanitization for the LLM research-intake response.
// Kept separate from main.ts (which pulls in Electron) so it can be unit-tested.

export function lastBalancedJsonObject(s: string): string | null {
  let depth = 0
  let start = -1
  let best: string | null = null
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') {
      if (depth > 0) depth--
      if (depth === 0 && start >= 0) best = s.slice(start, i + 1)
    }
  }
  return best
}

export function extractJsonObject(text: string): any | null {
  let raw = String(text || '').trim()
  if (!raw) return null
  // Thinking models wrap output in <think>…</think> and/or ```json fences — strip them first.
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(raw) } catch {}
  // Prefer the last complete, brace-balanced object (the final answer, not braces inside reasoning).
  const balanced = lastBalancedJsonObject(raw)
  if (balanced) { try { return JSON.parse(balanced) } catch {} }
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) { try { return JSON.parse(match[0]) } catch {} }
  return null
}

const PATCH_STRING_KEYS = ['topic', 'profileId', 'mode', 'dateRange', 'customDateRange', 'reportLanguage', 'extraDirections']
const PATCH_NUMBER_KEYS = ['maxSources', 'minSelectedSources', 'minFullTextReads', 'evidencePerSection']
const PATCH_BOOLEAN_KEYS = ['needFullText', 'strictDateRange', 'requireQualityPass']

export function sanitizeResearchPatch(raw: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of PATCH_STRING_KEYS) {
    if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key].trim()
  }
  for (const key of PATCH_NUMBER_KEYS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue
    const n = Number(raw[key])
    if (Number.isFinite(n)) out[key] = Math.trunc(n)
  }
  for (const key of PATCH_BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  if (Array.isArray(raw.outputs)) out.outputs = raw.outputs.map(String).filter(Boolean)
  if (Array.isArray(raw.checkpoints)) out.checkpoints = raw.checkpoints.map(String).filter(Boolean)
  // researchKind is an enum, not a free string — only accept the two known values.
  if (raw.researchKind === 'general' || raw.researchKind === 'academic') out.researchKind = raw.researchKind
  return out
}

export interface ResearchIntakeInferInput {
  message: string
  draft?: Record<string, any>
  appLanguage?: 'ru' | 'en'
  profiles?: Array<{ id: string; label?: string; domain?: string }>
}

const INTAKE_SYSTEM_PROMPT = [
  'You are the parameter planner for a research-run UI. You are the ONLY component that fills these parameters — there is no fallback keyword/regex parser, so analyze the user request carefully and return complete, sensible values.',
  'Return ONLY compact JSON with a top-level "patch" object. No prose, no markdown, no code fences.',
  'Allowed patch keys: topic, profileId, researchKind, mode, dateRange, customDateRange, maxSources, needFullText, minSelectedSources, minFullTextReads, evidencePerSection, strictDateRange, requireQualityPass, reportLanguage, outputs, checkpoints, extraDirections.',
  'Choose profileId from the provided profiles list by matching the domain of the request (e.g. ML/AI, biology, mathematics, finance). If nothing matches, use "universal". IMPORTANT: the domain profiles (finance, ml-ai, biology, mathematics, paper-reproduction) are for scholarly/professional analysis. For general/consumer/everyday questions (researchKind "general") use profileId "universal" — e.g. "сколько стоят квартиры", "стоимость недвижимости", "какой ноутбук купить" are universal, NOT finance. Pick a domain profile only when the user truly wants domain-expert, source-grounded analysis.',
  'CRITICAL — researchKind decides whether SCIENTIFIC quality gates apply. Set researchKind to "academic" ONLY when the user genuinely needs scholarly/scientific literature: research papers, studies, systematic reviews, citations, arXiv/PubMed/OpenAlex-style sources, or rigorous scientific evidence. For everyday / consumer / how-to / product / shopping / pricing / market-price / local-info / news topics use "general" — even when the topic brushes a domain like finance or biology (e.g. "квартиры в Магадане", "стоимость недвижимости", "какой ноутбук купить", "рецепт", "как настроить роутер" are ALL general). The "general" kind relaxes academic-only gates (survey/review coverage and recency) and prioritizes web sources. When unsure, prefer "general"; reserve "academic" for clearly scholarly intent. This is independent of profileId: a finance/biology profile can still be researchKind "general" for a consumer question.',
  'Allowed modes: quick, deep, systematic, reproduction, idea-scout. Pick the mode that matches the requested depth/rigor; default to deep, use systematic for "обзор/review/строго", quick for "быстро/кратко".',
  'Allowed dateRange: any, last-year, last-2-years, since-2024, custom. Use custom + customDateRange "YYYY-01-01..YYYY-12-31" when the user gives explicit years. Set strictDateRange true unless the user allows any period.',
  'Allowed reportLanguage: ru, en. Infer from the user request; otherwise use appLanguage.',
  'Meaning of numeric keys: maxSources = how many papers/sources to discover and build the corpus from (the raw cap). minSelectedSources = minimum papers kept after screening. minFullTextReads = minimum papers read in full.',
  'ALWAYS include maxSources, minSelectedSources, minFullTextReads in the patch. If the user gives no count, pick reasonable values for the chosen profile/mode (e.g. ML/AI systematic ≈ maxSources 40). An explicit user number ALWAYS overrides profile defaults. Do NOT confuse a count with a year ("2024") or a time span ("2 года").',
  'CRITICAL — how many sources end up IN THE REPORT. Any explicit count N of papers/sources/статей/источников is, BY DEFAULT, how many sources must be PRESENTED in the final report (e.g. "не менее 50 статей", "статьи самые новые не менее 50", "минимум 100 источников", "report with 50 references"). The report shows exactly the top-N most relevant; discovery and full-text reading are deliberately LARGER than N.',
  ' For such a report count N: set minSelectedSources = N (this is the number shown in the report; cap 200); set minFullTextReads = N (read at least as many as the report presents; cap 200); set maxSources = round(2.5*N) but at least 30 (cap 200) — discovery must exceed N so the best N can be chosen.',
  ' ONLY treat N as a DISCOVERY/search count (not report count) when the user explicitly talks about FINDING/COLLECTING that many, e.g. "найди/собери/просмотри не менее N статей" with no mention of the report. In that case set maxSources = N (cap 200), minSelectedSources = round(0.4*N), minFullTextReads = round(0.4*N).',
  ' When in doubt, ALWAYS use the report-count interpretation. The count word (статей/источников/papers/sources) may come before or after the number. Never silently shrink the user number (do NOT turn "50" into 23).',
  'Other toggles to infer from the request (use sensible defaults otherwise): needFullText = true when the user wants full-text reading / "полный текст / full text / читать статьи целиком" or for deep/systematic modes; requireQualityPass = true when the user says "строго / только по источникам / с проверкой / тщательно"; evidencePerSection default 2, raise to 3 for "тщательно/много доказательств"; outputs default ["brief","report","evidence-matrix"], add "ideas" if the user wants brainstorming/идеи. strictDateRange = true when a period is given and the user did not say "любой период / можно старые".',
  'Always set a topic from the user request unless they truly gave none; strip meta words like counts/dates/language from the topic itself.',
  'Checkpoints control where the run PAUSES for the user. This is auto-research: default checkpoints to ["plan"] (approve the plan, then run autonomously to report.md). Only add "corpus", "evidence" or "report" if the user explicitly asks to review that phase. If the user asks for fully autonomous / no pauses, use [].',
  'Preserve currentDraft values the user did not change.',
].join('\n')

// Builds the exact /v1/chat/completions request body used for LLM-driven intake.
// Shared by the runtime (main.ts) and the live integration test so they cannot drift.
export function buildResearchIntakeRequestBody(input: ResearchIntakeInferInput): Record<string, any> {
  return {
    model: 'local',
    temperature: 0.1,
    max_tokens: 800,
    // Force a single JSON object and skip the model's reasoning pass so the
    // response is the patch itself (not a <think> block we have to recover from).
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: INTAKE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          message: input.message,
          currentDraft: input.draft ?? {},
          appLanguage: input.appLanguage ?? 'ru',
          profiles: input.profiles ?? [],
        }),
      },
    ],
  }
}

// Combines extraction + sanitization the same way the IPC handler does, so both
// the runtime and the tests exercise identical logic.
export function parseInferredResearchPatch(content: string): { patch?: Record<string, any>; error?: string } {
  const parsed = extractJsonObject(content)
  const rawPatch = parsed?.patch && typeof parsed.patch === 'object'
    ? parsed.patch
    : parsed && typeof parsed === 'object'
      ? parsed
      : {}
  const sanitized = sanitizeResearchPatch(rawPatch)
  if (!Object.keys(sanitized).length) {
    const snippet = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    return { error: snippet ? `модель вернула не-JSON: ${snippet}` : 'модель вернула пустой ответ' }
  }
  return { patch: sanitized }
}
