import { describe, it, expect } from 'vitest'
import { buildResearchIntakeRequestBody, parseInferredResearchPatch } from '../electron/research-intake-parse'

// Live integration test against a running llama-server. It is SKIPPED automatically
// when the server is not reachable, so CI/local runs without the model stay green.
// Run it on purpose with the app/model up:  npx vitest run tests/research-intake-live.test.ts
const LLAMA_URL = process.env.LLAMA_API_URL || 'http://127.0.0.1:7863'

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

const PROFILES = [
  { id: 'universal', label: 'Universal Research', domain: 'general' },
  { id: 'ml-ai', label: 'ML/AI Research', domain: 'machine-learning' },
  { id: 'biology', label: 'Biology', domain: 'biology' },
  { id: 'mathematics', label: 'Mathematics', domain: 'mathematics' },
  { id: 'finance', label: 'Finance', domain: 'finance' },
]

async function infer(message: string) {
  const body = buildResearchIntakeRequestBody({ message, appLanguage: 'ru', profiles: PROFILES })
  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const msg = data?.choices?.[0]?.message ?? {}
  const content = String(msg?.content ?? '') || String(msg?.reasoning_content ?? '')
  return { content, ...parseInferredResearchPatch(content) }
}

const up = await serverUp()
const live = up ? describe : describe.skip

if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[research-intake-live] llama-server not reachable at ${LLAMA_URL} — skipping live tests.`)
}

live('research intake against the live model', () => {
  it('honors an explicit corpus floor ("не менее 40 статей")', async () => {
    const { patch, error, content } = await infer('RL в LLM не менее 40 статей рассмотреть самых новых')
    expect(error, `model content: ${content}`).toBeUndefined()
    expect(patch?.topic, 'topic should be set').toBeTruthy()
    expect(Number(patch?.maxSources)).toBeGreaterThanOrEqual(40)
    expect(Number(patch?.maxSources)).toBeLessThanOrEqual(200)
  }, 40000)

  it('honors a larger floor ("минимум 100 статей")', async () => {
    const { patch, error, content } = await infer('LLM в RL самые свежие статьи, минимум 100 статей')
    expect(error, `model content: ${content}`).toBeUndefined()
    expect(Number(patch?.maxSources)).toBeGreaterThanOrEqual(100)
  }, 40000)

  it('picks a Russian report language and a sensible profile', async () => {
    const { patch, error, content } = await infer('Глубокий обзор по RLHF на русском за 2024-2026')
    expect(error, `model content: ${content}`).toBeUndefined()
    expect(patch?.reportLanguage).toBe('ru')
    expect(typeof patch?.maxSources).toBe('number')
  }, 40000)
})
