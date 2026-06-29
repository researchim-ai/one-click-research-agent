import { describe, it, expect } from 'vitest'
import {
  lastBalancedJsonObject,
  extractJsonObject,
  sanitizeResearchPatch,
  parseInferredResearchPatch,
} from '../electron/research-intake-parse'

describe('lastBalancedJsonObject', () => {
  it('returns the last top-level balanced object, ignoring braces inside reasoning', () => {
    const s = 'Here is an example like {"a":1} but the real one is {"patch":{"topic":"x"}}'
    expect(lastBalancedJsonObject(s)).toBe('{"patch":{"topic":"x"}}')
  })

  it('ignores braces that appear inside strings', () => {
    const s = '{"topic":"a } b { c"}'
    expect(lastBalancedJsonObject(s)).toBe('{"topic":"a } b { c"}')
  })

  it('returns null when there is no object', () => {
    expect(lastBalancedJsonObject('no json here')).toBeNull()
  })
})

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    expect(extractJsonObject('{"patch":{"maxSources":40}}')).toEqual({ patch: { maxSources: 40 } })
  })

  it('strips a <think> block and parses the trailing JSON', () => {
    const content = '<think>The user wants RL papers, at least 40. I should set maxSources=40.</think>{"patch":{"topic":"RL в LLM","maxSources":40}}'
    expect(extractJsonObject(content)).toEqual({ patch: { topic: 'RL в LLM', maxSources: 40 } })
  })

  it('handles an unclosed <think> followed by JSON', () => {
    const content = '<think>reasoning with a sample {"x":1} inside\n{"patch":{"maxSources":50}}'
    // greedy strip of <think> tags then balanced extraction wins the last object
    expect(extractJsonObject(content)).toEqual({ patch: { maxSources: 50 } })
  })

  it('strips ```json fences', () => {
    const content = '```json\n{"patch":{"reportLanguage":"ru"}}\n```'
    expect(extractJsonObject(content)).toEqual({ patch: { reportLanguage: 'ru' } })
  })

  it('returns null for empty or non-JSON content', () => {
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('I cannot help with that')).toBeNull()
  })
})

describe('sanitizeResearchPatch', () => {
  it('keeps only whitelisted, well-typed keys', () => {
    const out = sanitizeResearchPatch({
      topic: '  RL  ',
      profileId: 'ml-ai',
      maxSources: 40.9,
      minSelectedSources: '18',
      needFullText: true,
      requireQualityPass: 'yes', // wrong type → dropped
      outputs: ['brief', 'report', ''],
      checkpoints: ['plan'],
      bogus: 'nope',
    })
    expect(out).toEqual({
      topic: 'RL',
      profileId: 'ml-ai',
      maxSources: 40,
      minSelectedSources: 18,
      needFullText: true,
      outputs: ['brief', 'report'],
      checkpoints: ['plan'],
    })
  })

  it('drops empty strings and non-finite numbers', () => {
    const out = sanitizeResearchPatch({ topic: '   ', maxSources: 'abc', minFullTextReads: null })
    expect(out).toEqual({})
  })

  it('returns {} for null/garbage input', () => {
    expect(sanitizeResearchPatch(null)).toEqual({})
    expect(sanitizeResearchPatch(undefined)).toEqual({})
  })

  it('accepts researchKind only for the known enum values', () => {
    expect(sanitizeResearchPatch({ researchKind: 'general' })).toEqual({ researchKind: 'general' })
    expect(sanitizeResearchPatch({ researchKind: 'academic' })).toEqual({ researchKind: 'academic' })
    // anything else (free text, wrong type) is dropped — never silently coerced
    expect(sanitizeResearchPatch({ researchKind: 'scientific' })).toEqual({})
    expect(sanitizeResearchPatch({ researchKind: true })).toEqual({})
  })
})

describe('parseInferredResearchPatch — end-to-end model output handling', () => {
  it('returns a sanitized patch for a realistic thinking-model response', () => {
    const content = '<think>RL в LLM, минимум 40 статей.</think>{"patch":{"topic":"RL в LLM","profileId":"ml-ai","mode":"systematic","maxSources":40,"minSelectedSources":18,"minFullTextReads":11,"reportLanguage":"ru"}}'
    const res = parseInferredResearchPatch(content)
    expect(res.error).toBeUndefined()
    expect(res.patch).toEqual({
      topic: 'RL в LLM',
      profileId: 'ml-ai',
      mode: 'systematic',
      maxSources: 40,
      minSelectedSources: 18,
      minFullTextReads: 11,
      reportLanguage: 'ru',
    })
  })

  it('unwraps a bare object without a top-level "patch" key', () => {
    const res = parseInferredResearchPatch('{"topic":"diffusion models","maxSources":30}')
    expect(res.patch).toEqual({ topic: 'diffusion models', maxSources: 30 })
  })

  it('reports a diagnostic error (with snippet) when the model returns prose', () => {
    const res = parseInferredResearchPatch('Sorry, I could not parse that request.')
    expect(res.patch).toBeUndefined()
    expect(res.error).toContain('модель вернула не-JSON')
    expect(res.error).toContain('Sorry')
  })

  it('reports an empty-response error for blank content', () => {
    const res = parseInferredResearchPatch('   ')
    expect(res.error).toBe('модель вернула пустой ответ')
  })
})
