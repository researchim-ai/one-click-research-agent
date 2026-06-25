import { describe, it, expect } from 'vitest'
import {
  applyResearchIntakePatch,
  defaultResearchRequest,
  missingResearchFields,
} from '../src/utils/research-intake'

describe('applyResearchIntakePatch — validation of a model-produced patch', () => {
  it('applies a corpus size chosen by the model', () => {
    const base = defaultResearchRequest('ru')
    const next = applyResearchIntakePatch(base, { topic: 'RL в LLM', maxSources: 50, minSelectedSources: 23, minFullTextReads: 14 })
    expect(next.maxSources).toBe(50)
    expect(next.minSelectedSources).toBe(23)
    expect(next.minFullTextReads).toBe(14)
  })

  it('clamps out-of-range numbers to the allowed bounds', () => {
    const base = defaultResearchRequest('ru')
    const next = applyResearchIntakePatch(base, { maxSources: 999, minSelectedSources: 0, minFullTextReads: -5 })
    expect(next.maxSources).toBe(200)
    expect(next.minSelectedSources).toBe(1)
    expect(next.minFullTextReads).toBe(0)
  })

  it('falls back to the base value when a number is not finite', () => {
    const base = defaultResearchRequest('ru')
    const next = applyResearchIntakePatch(base, { maxSources: Number.NaN })
    expect(next.maxSources).toBe(base.maxSources)
  })

  it('falls back to a valid profile id when the model returns an unknown profile', () => {
    const base = defaultResearchRequest('ru')
    const next = applyResearchIntakePatch(base, { profileId: 'made-up' as never })
    expect(next.profileId).toBe('universal')
  })

  it('keeps base outputs/checkpoints when the model omits them', () => {
    const base = defaultResearchRequest('ru')
    const next = applyResearchIntakePatch(base, { topic: 'x' })
    expect(next.outputs).toEqual(base.outputs)
    expect(next.checkpoints).toEqual(base.checkpoints)
  })

  it('topic is the only hard requirement before a run can start', () => {
    const base = defaultResearchRequest('ru')
    expect(missingResearchFields(base)).toContain('topic')
    const ready = applyResearchIntakePatch(base, { topic: 'RL в LLM' })
    expect(missingResearchFields(ready)).not.toContain('topic')
  })
})
