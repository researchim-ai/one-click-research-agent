import { describe, it, expect } from 'vitest'
import { parseBiorxivResults, extractSourcesFromToolResult } from '../electron/sources'

const SAMPLE = `Found 2 bioRxiv/medRxiv preprint(s) for "chronic venous disease flavonoid":

1. Micronized purified flavonoid fraction in chronic venous disease
   Published: 2026-05-27
   Server: medRxiv (preprint — not peer-reviewed)
   Authors: Doe J, Smith A
   URL: https://doi.org/10.1101/2026.05.27.727997
   DOI: https://doi.org/10.1101/2026.05.27.727997
   Abstract: A randomized trial of MPFF in patients with chronic venous disease showing symptom improvement.

2. Venous tone modulation by flavonoids
   Published: 2026-04-01
   Server: bioRxiv (preprint — not peer-reviewed)
   Authors: Roe R
   URL: https://doi.org/10.1101/2026.04.01.700000
   DOI: https://doi.org/10.1101/2026.04.01.700000
   Abstract: Mechanistic study of flavonoid effects on venous smooth muscle.`

describe('parseBiorxivResults', () => {
  it('extracts title, url, authors, date and tags the source tool', () => {
    const items = parseBiorxivResults(SAMPLE)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Micronized purified flavonoid fraction in chronic venous disease')
    expect(items[0].url).toBe('https://doi.org/10.1101/2026.05.27.727997')
    expect(items[0].authors).toBe('Doe J, Smith A')
    expect(items[0].date).toBe('2026-05-27')
    expect(items[0].sourceTool).toBe('search_biorxiv')
  })

  it('is wired into extractSourcesFromToolResult for search_biorxiv', () => {
    const items = extractSourcesFromToolResult('search_biorxiv', SAMPLE)
    expect(items.length).toBe(2)
    expect(items.every((s) => s.url.startsWith('https://doi.org/10.1101/'))).toBe(true)
  })
})
