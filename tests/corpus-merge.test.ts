import { describe, it, expect } from 'vitest'
import { mergeCorpusEntries, type CorpusEntry } from '../electron/corpus'

function entry(over: Partial<CorpusEntry>): CorpusEntry {
  return {
    id: 'x',
    title: 'A Survey of RL for LLMs',
    url: 'https://arxiv.org/abs/2401.00001',
    arxivId: '2401.00001',
    tier: 'primary',
    publicationType: 'survey',
    screeningStatus: 'raw',
    readStatus: 'not_read',
    subQuestions: [],
    status: 'candidate',
    score: 10,
    tags: [],
    addedAt: 1,
    updatedAt: 1,
    ...over,
  } as CorpusEntry
}

describe('mergeCorpusEntries — progress is sticky across rebuilds', () => {
  it('does not regress read/selection progress when a fresh entry is re-merged', () => {
    const prev = entry({
      id: 'prev1',
      screeningStatus: 'selected',
      readStatus: 'read',
      readPriority: 'high',
      localPath: '.research/run/fulltext/prev1.html',
      readReason: 'arXiv HTML downloaded',
      subQuestions: ['Q1'],
      status: 'read',
      score: 80,
    })
    // Same paper rediscovered by a later search → default/raw progress.
    const incoming = entry({ id: 'newid', screeningStatus: 'raw', readStatus: 'not_read', score: 40 })

    const { entries, updated } = mergeCorpusEntries([prev], [incoming])
    expect(updated).toBe(1)
    expect(entries).toHaveLength(1)
    const m = entries[0]
    expect(m.id).toBe('prev1')
    expect(m.readStatus).toBe('read')
    expect(m.status).toBe('read')
    expect(m.screeningStatus).toBe('selected')
    expect(m.readPriority).toBe('high')
    expect(m.localPath).toBe('.research/run/fulltext/prev1.html')
    expect(m.subQuestions).toEqual(['Q1'])
    expect(m.score).toBe(80)
  })

  it('keeps a queued read state rather than dropping it back to not_read', () => {
    const prev = entry({ readStatus: 'queued', screeningStatus: 'selected', status: 'queued_full_text' })
    const incoming = entry({ readStatus: 'not_read', screeningStatus: 'raw' })
    const { entries } = mergeCorpusEntries([prev], [incoming])
    expect(entries[0].readStatus).toBe('queued')
    expect(entries[0].screeningStatus).toBe('selected')
  })

  it('still adds genuinely new entries', () => {
    const prev = entry({ id: 'a', url: 'https://arxiv.org/abs/2401.00001', arxivId: '2401.00001' })
    const incoming = entry({ id: 'b', url: 'https://arxiv.org/abs/2402.99999', arxivId: '2402.99999' })
    const { entries, added } = mergeCorpusEntries([prev], [incoming])
    expect(added).toBe(1)
    expect(entries).toHaveLength(2)
  })
})
