import { describe, expect, it } from 'vitest'
import { sourceToCorpusEntry } from '../electron/corpus'
import { parseOpenAlexResults } from '../electron/sources'

describe('OpenAlex open-access metadata', () => {
  it('preserves the direct OA PDF while keeping DOI as the citation URL', () => {
    const [source] = parseOpenAlexResults([
      'Found 1 OpenAlex paper(s):',
      '',
      '1. A Review of Multi-Agent Reinforcement Learning Algorithms',
      '   Published: 2025-02-19',
      '   DOI: https://doi.org/10.3390/electronics14040820',
      '   Landing Page: https://doi.org/10.3390/electronics14040820',
      '   Open PDF: https://www.mdpi.com/2079-9292/14/4/820/pdf',
      '   Abstract: Review text.',
    ].join('\n'))

    expect(source.url).toBe('https://doi.org/10.3390/electronics14040820')
    expect(source.openAccessUrl).toBe('https://www.mdpi.com/2079-9292/14/4/820/pdf')

    const corpus = sourceToCorpusEntry(source)
    expect(corpus.doi).toBe('10.3390/electronics14040820')
    expect(corpus.openAccessUrl).toBe(source.openAccessUrl)
  })
})
