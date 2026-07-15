// Central prompt registry.
//
// Every LLM-facing prompt template lives as a plain text file under `prompts/`
// (shipped with the app) instead of being hard-coded inline. Users can override
// any prompt by dropping a file with the same name into
// `~/.one-click-agent/prompts/` — that copy always wins. Dynamic values are
// injected via `{{placeholder}}` tokens rendered at call time.
//
// This module only depends on fs/path/os so it works in the Electron main
// process, the agent worker thread (vanilla Node/CJS), and under Vitest.

import fs from 'fs'
import path from 'path'
import os from 'os'

export interface PromptDef {
  /** Stable id == file name without `.md`. */
  id: string
  /** UI group for the Settings editor. */
  group: string
  /** Human label (English; UI localizes the group headers only). */
  title: string
  /** Short description of when/how the prompt is used. */
  description: string
  /** Placeholder keys the template may contain, e.g. `currentDate`. */
  placeholders: string[]
}

// The single source of truth for which prompts exist. Keep in sync with the
// files under `prompts/`. `validateAllPrompts()` enforces this at test time.
export const PROMPT_DEFS: PromptDef[] = [
  {
    id: 'system.default',
    group: 'system',
    title: 'Agent system prompt (full)',
    description: 'Base system prompt used when the model context is large enough. The runtime appends an Environment block and preset/skill guidance.',
    placeholders: [],
  },
  {
    id: 'system.compact',
    group: 'system',
    title: 'Agent system prompt (compact)',
    description: 'Shorter system prompt used automatically on small-context (<16k token) runs.',
    placeholders: [],
  },
  {
    id: 'system.summarize',
    group: 'system',
    title: 'History summarization prompt',
    description: 'Instructs the model how to compact the conversation history when the context fills up. The conversation text is appended after it.',
    placeholders: [],
  },
  {
    id: 'intake.system',
    group: 'intake',
    title: 'Research intake planner',
    description: 'System prompt for the LLM that turns a free-text research request into structured run parameters. `currentDate` anchors relative time windows.',
    placeholders: ['currentDate'],
  },
  {
    id: 'screening.semantic',
    group: 'screening',
    title: 'Semantic relevance screener',
    description: 'Language-agnostic system prompt that scores each corpus source (0–100) for relevance to the research question.',
    placeholders: [],
  },
  {
    id: 'report.section_review.system',
    group: 'report',
    title: 'Report QA rater — system',
    description: 'System role for the read-only quality pass that rates each report section and returns a markdown table.',
    placeholders: [],
  },
  {
    id: 'report.section_review.user.ru',
    group: 'report',
    title: 'Report QA rater — user (RU)',
    description: 'Russian instruction for rating condensed report sections. `sections` holds the condensed excerpts.',
    placeholders: ['sections'],
  },
  {
    id: 'report.section_review.user.en',
    group: 'report',
    title: 'Report QA rater — user (EN)',
    description: 'English instruction for rating condensed report sections. `sections` holds the condensed excerpts.',
    placeholders: ['sections'],
  },
  {
    id: 'report.source_summary.system.ru',
    group: 'report',
    title: 'Per-source summary — system (RU)',
    description: 'System role telling the model to write Russian summaries and return only JSON.',
    placeholders: [],
  },
  {
    id: 'report.source_summary.system.en',
    group: 'report',
    title: 'Per-source summary — system (EN)',
    description: 'System role telling the model to write English summaries and return only JSON.',
    placeholders: [],
  },
  {
    id: 'report.source_summary.user.ru',
    group: 'report',
    title: 'Per-source summary — user (RU)',
    description: 'Russian instruction to summarize each paper. `payload` is the JSON array of papers.',
    placeholders: ['payload'],
  },
  {
    id: 'report.source_summary.user.en',
    group: 'report',
    title: 'Per-source summary — user (EN)',
    description: 'English instruction to summarize each paper. `payload` is the JSON array of papers.',
    placeholders: ['payload'],
  },
  {
    id: 'report.synthesis.system.ru',
    group: 'report',
    title: 'Report synthesis — system (RU)',
    description: 'System role for synthesizing TL;DR + conclusion in Russian, JSON only.',
    placeholders: [],
  },
  {
    id: 'report.synthesis.system.en',
    group: 'report',
    title: 'Report synthesis — system (EN)',
    description: 'System role for synthesizing TL;DR + conclusion in English, JSON only.',
    placeholders: [],
  },
  {
    id: 'report.synthesis.user.ru',
    group: 'report',
    title: 'Report synthesis — user (RU)',
    description: 'Russian synthesis instruction. `topic` is the research topic, `evidence` the numbered supported claims.',
    placeholders: ['topic', 'evidence'],
  },
  {
    id: 'report.synthesis.user.en',
    group: 'report',
    title: 'Report synthesis — user (EN)',
    description: 'English synthesis instruction. `topic` is the research topic, `evidence` the numbered supported claims.',
    placeholders: ['topic', 'evidence'],
  },
  {
    id: 'critic.system',
    group: 'critic',
    title: 'Research critic — system',
    description: 'System role for the self-reflection critic pass.',
    placeholders: [],
  },
  {
    id: 'critic.user',
    group: 'critic',
    title: 'Research critic — user',
    description: 'Critic instruction and required output format. `criteria` is the bullet list, `findings` the reviewed text, `sourcesContext` the optional sources block.',
    placeholders: ['criteria', 'findings', 'sourcesContext'],
  },
  {
    id: 'sub_researcher.system',
    group: 'sub-researcher',
    title: 'Sub-researcher system prompt',
    description: 'System prompt for a focused sub-researcher agent. `task` is the sub-question, `maxIters` the call budget, `tools` the allowed tool list.',
    placeholders: ['task', 'maxIters', 'tools'],
  },
]

const KNOWN_IDS = new Set(PROMPT_DEFS.map((d) => d.id))

function assertKnown(id: string): void {
  if (!KNOWN_IDS.has(id)) throw new Error(`Unknown prompt id: "${id}"`)
}

function existsDir(p?: string | null): p is string {
  try {
    return !!p && fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

let bundledDirCache: string | null = null

/** Directory holding the shipped default prompt files. */
export function bundledPromptsDir(): string {
  if (bundledDirCache && existsDir(bundledDirCache)) return bundledDirCache
  const dn = typeof __dirname !== 'undefined' ? __dirname : null
  const resourcesPath = typeof (process as any).resourcesPath === 'string' ? (process as any).resourcesPath : null
  const candidates = [
    process.env.OCA_PROMPTS_DIR || null,
    resourcesPath ? path.join(resourcesPath, 'prompts') : null,
    dn ? path.join(dn, '..', 'prompts') : null, // dist-electron/<file>.js → ../prompts
    dn ? path.join(dn, 'prompts') : null,
    path.join(process.cwd(), 'prompts'),
  ]
  for (const c of candidates) {
    if (existsDir(c) && fs.existsSync(path.join(c, 'system.default.md'))) {
      bundledDirCache = c
      return c
    }
  }
  // Last resort: cwd/prompts (read will throw a clear error if truly missing).
  bundledDirCache = path.join(process.cwd(), 'prompts')
  return bundledDirCache
}

/** Directory where user overrides live; created on demand. */
export function userPromptsDir(): string {
  return path.join(os.homedir(), '.one-click-agent', 'prompts')
}

interface CacheEntry {
  mtimeMs: number
  text: string
}

const fileCache = new Map<string, CacheEntry>()

/** Read a file with a mtime-keyed cache so manual edits hot-reload automatically. */
function readFileCached(abs: string): string | null {
  try {
    const st = fs.statSync(abs)
    const hit = fileCache.get(abs)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text
    const text = fs.readFileSync(abs, 'utf-8')
    fileCache.set(abs, { mtimeMs: st.mtimeMs, text })
    return text
  } catch {
    return null
  }
}

/** Normalize file content into the exact prompt string (strip one trailing newline). */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '')
}

export interface RawPrompt {
  text: string
  source: 'user' | 'default'
  path: string
}

/** Resolve a prompt's raw template text, preferring a user override. */
export function getRawPrompt(id: string): RawPrompt {
  assertKnown(id)
  const file = `${id}.md`
  const userPath = path.join(userPromptsDir(), file)
  const overriden = readFileCached(userPath)
  if (overriden != null && overriden.trim()) {
    return { text: normalize(overriden), source: 'user', path: userPath }
  }
  const defPath = path.join(bundledPromptsDir(), file)
  const def = readFileCached(defPath)
  if (def == null) {
    throw new Error(`Prompt "${id}" not found (looked for ${file} in ${bundledPromptsDir()})`)
  }
  return { text: normalize(def), source: 'default', path: defPath }
}

/** The shipped default text for a prompt (ignores any user override). */
export function defaultPromptText(id: string): string {
  assertKnown(id)
  const defPath = path.join(bundledPromptsDir(), `${id}.md`)
  const def = readFileCached(defPath)
  if (def == null) throw new Error(`Default prompt "${id}" missing at ${defPath}`)
  return normalize(def)
}

function applyVars(text: string, vars: Record<string, string | number>, id: string): string {
  const out = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key])
    return m
  })
  if (!process.env.VITEST) {
    const leftover = out.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g)
    if (leftover && leftover.length) {
      // eslint-disable-next-line no-console
      console.warn(`[prompts] "${id}" has unresolved placeholders: ${leftover.join(', ')}`)
    }
  }
  return out
}

/** Render a prompt, substituting `{{placeholder}}` tokens with `vars`. */
export function renderPrompt(id: string, vars: Record<string, string | number> = {}): string {
  const { text } = getRawPrompt(id)
  return applyVars(text, vars, id)
}

export interface PromptListItem extends PromptDef {
  source: 'user' | 'default'
  overridden: boolean
  text: string
  defaultText: string
}

/** Everything the Settings UI needs to display/edit prompts. */
export function listPrompts(): PromptListItem[] {
  return PROMPT_DEFS.map((d) => {
    const raw = getRawPrompt(d.id)
    return {
      ...d,
      source: raw.source,
      overridden: raw.source === 'user',
      text: raw.text,
      defaultText: defaultPromptText(d.id),
    }
  })
}

/** Write a user override (or delete it when `text` is null/blank to restore default). */
export function savePromptOverride(id: string, text: string | null): void {
  assertKnown(id)
  const file = path.join(userPromptsDir(), `${id}.md`)
  if (text == null || !text.trim() || normalize(text) === defaultPromptText(id)) {
    try {
      fs.unlinkSync(file)
    } catch {}
    fileCache.delete(file)
    return
  }
  fs.mkdirSync(userPromptsDir(), { recursive: true })
  fs.writeFileSync(file, normalize(text) + '\n')
  fileCache.delete(file)
}

/** Delete every user override, restoring all shipped defaults. */
export function resetAllPromptOverrides(): void {
  for (const d of PROMPT_DEFS) {
    const file = path.join(userPromptsDir(), `${d.id}.md`)
    try {
      fs.unlinkSync(file)
    } catch {}
    fileCache.delete(file)
  }
}

/**
 * Populate the user prompts directory with editable copies of any prompts that
 * do not already have an override, plus a README. Existing overrides are never
 * touched. Returns the directory path so callers can reveal it.
 */
export function seedUserPromptsDir(): string {
  const dir = userPromptsDir()
  fs.mkdirSync(dir, { recursive: true })
  for (const d of PROMPT_DEFS) {
    const target = path.join(dir, `${d.id}.md`)
    if (fs.existsSync(target)) continue
    try {
      fs.writeFileSync(target, defaultPromptText(d.id) + '\n')
    } catch {}
  }
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), buildReadme())
  } catch {}
  return dir
}

function buildReadme(): string {
  const lines: string[] = [
    '# Editable prompts',
    '',
    'Each `*.md` file here overrides the matching built-in prompt. Edit the text and',
    'save — the app picks up changes automatically on the next LLM call.',
    '',
    'To restore a built-in prompt, delete its file (or use "Reset to default" in',
    'Settings → Prompts). `{{name}}` tokens are filled in at runtime — keep them.',
    '',
    '## Prompts',
    '',
  ]
  for (const d of PROMPT_DEFS) {
    const ph = d.placeholders.length ? d.placeholders.map((p) => `\`{{${p}}}\``).join(', ') : '—'
    lines.push(`- **${d.id}.md** — ${d.description} Placeholders: ${ph}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Migrate the legacy single-string prompt overrides from config.json into the
 * file-based registry, then clear them. Idempotent. `getLegacy`/`clearLegacy`
 * are injected so this stays free of the Electron config import.
 */
export function migrateLegacyPromptConfig(
  getLegacy: () => { systemPrompt: string | null; summarizePrompt: string | null },
  clearLegacy: (keys: { systemPrompt?: null; summarizePrompt?: null }) => void,
): void {
  const legacy = getLegacy()
  const cleared: { systemPrompt?: null; summarizePrompt?: null } = {}
  if (legacy.systemPrompt && legacy.systemPrompt.trim()) {
    savePromptOverride('system.default', legacy.systemPrompt)
    cleared.systemPrompt = null
  }
  if (legacy.summarizePrompt && legacy.summarizePrompt.trim()) {
    savePromptOverride('system.summarize', legacy.summarizePrompt)
    cleared.summarizePrompt = null
  }
  if (Object.keys(cleared).length) clearLegacy(cleared)
}

/**
 * Sanity-check invoked by tests: every declared prompt has a default file, and
 * every declared placeholder actually appears in that file (typo guard).
 */
export function validateAllPrompts(): string[] {
  const problems: string[] = []
  for (const d of PROMPT_DEFS) {
    let text: string
    try {
      text = defaultPromptText(d.id)
    } catch (e: any) {
      problems.push(`${d.id}: ${e?.message || e}`)
      continue
    }
    for (const ph of d.placeholders) {
      if (!text.includes(`{{${ph}}}`)) problems.push(`${d.id}: declared placeholder {{${ph}}} not found in file`)
    }
    const used = new Set((text.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || []).map((m) => m.replace(/[{}\s]/g, '')))
    for (const u of used) {
      if (!d.placeholders.includes(u)) problems.push(`${d.id}: file uses {{${u}}} not declared in PROMPT_DEFS`)
    }
  }
  return problems
}
