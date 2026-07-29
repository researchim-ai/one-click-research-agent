// Pure, dependency-free parsing/sanitization for the LLM research-intake response.
// Kept separate from main.ts (which pulls in Electron) so it can be unit-tested.

import { renderPrompt } from './prompts'
import { SEARCH_SOURCE_IDS } from '../search-sources'

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
  // allowedSearchTools is a whitelist of known search-engine ids; drop anything unknown.
  if (Array.isArray(raw.allowedSearchTools)) {
    const ids = [...new Set(raw.allowedSearchTools.map(String))].filter((x) => SEARCH_SOURCE_IDS.includes(x))
    if (ids.length) out.allowedSearchTools = ids
  }
  // researchKind is an enum, not a free string — only accept the two known values.
  if (raw.researchKind === 'general' || raw.researchKind === 'academic') out.researchKind = raw.researchKind
  return out
}

export interface ResearchIntakeInferInput {
  message: string
  draft?: Record<string, any>
  appLanguage?: 'ru' | 'en'
  profiles?: Array<{ id: string; label?: string; domain?: string }>
  /** Today's date (YYYY-MM-DD). Injected so the model can resolve RELATIVE windows
   * ("last week", "за последний месяц") instead of guessing a stale year. */
  currentDate?: string
}

/** Today's date as YYYY-MM-DD (UTC), used as the default anchor for relative ranges. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function buildIntakeSystemPrompt(currentDate: string): string {
  return renderPrompt('intake.system', { currentDate })
}

// Builds the exact /v1/chat/completions request body used for LLM-driven intake.
// Shared by the runtime (main.ts) and the live integration test so they cannot drift.
export function buildResearchIntakeRequestBody(input: ResearchIntakeInferInput): Record<string, any> {
  const currentDate = input.currentDate && /^\d{4}-\d{2}-\d{2}$/.test(input.currentDate)
    ? input.currentDate
    : todayIso()
  return {
    model: 'local',
    temperature: 0.1,
    max_tokens: 800,
    // Force a single JSON object and skip the model's reasoning pass so the
    // response is the patch itself (not a <think> block we have to recover from).
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: buildIntakeSystemPrompt(currentDate) },
      {
        role: 'user',
        content: JSON.stringify({
          message: input.message,
          currentDraft: input.draft ?? {},
          appLanguage: input.appLanguage ?? 'ru',
          currentDate,
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
