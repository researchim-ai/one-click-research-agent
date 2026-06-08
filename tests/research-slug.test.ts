import { describe, it, expect } from 'vitest'
import { canonicalResearchSlug, canonicalResearchOutputDir, makeResearchRunDirFromTopic } from '../research-slug'

describe('canonicalResearchSlug', () => {
  it('lowercases and dashes plain ascii', () => {
    expect(canonicalResearchSlug('Hello World')).toBe('hello-world')
  })

  it('transliterates cyrillic deterministically (confusables take priority)', () => {
    expect(canonicalResearchSlug('Привет мир')).toBe('ppibet-mip')
  })

  it('collapses repeated separators and trims', () => {
    expect(canonicalResearchSlug('  a---b  ')).toBe('a-b')
  })

  it('falls back when empty', () => {
    expect(canonicalResearchSlug('!!!', 'fallback')).toBe('fallback')
  })
})

describe('canonicalResearchOutputDir', () => {
  it('keeps timestamp prefix and canonicalizes suffix', () => {
    const out = canonicalResearchOutputDir('.research/2026-06-06_12-00-00_Привет')
    expect(out).toBe('.research/2026-06-06_12-00-00_ppibet')
  })

  it('defaults to .research when empty', () => {
    expect(canonicalResearchOutputDir('')).toBe('.research')
  })
})

describe('makeResearchRunDirFromTopic', () => {
  it('builds a timestamped canonical dir', () => {
    const d = new Date(2026, 5, 6, 9, 5, 3)
    expect(makeResearchRunDirFromTopic('My Topic', d)).toBe('.research/2026-06-06_09-05-03_my-topic')
    expect(makeResearchRunDirFromTopic('', d)).toBe('.research/2026-06-06_09-05-03_research')
  })
})
