import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getCorpusSelection, setCorpusItemIncluded, loadCorpus } from '../electron/corpus'

let ws: string
const OUT = '.research/run'

function writeCorpus(entries: any[]) {
  const run = path.join(ws, OUT)
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function corpusEntry(over: Record<string, any>) {
  return {
    id: 'item1',
    title: 'Paper under test',
    url: 'https://example.invalid/paper',
    tier: 'primary',
    screeningStatus: 'selected',
    readPriority: 'high',
    status: 'candidate',
    readStatus: 'not_read',
    score: 50,
    tags: [],
    addedAt: 0,
    updatedAt: 0,
    subQuestions: [],
    ...over,
  }
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-sel-'))
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('getCorpusSelection', () => {
  it('returns only selected items, best-first, as structured rows', () => {
    writeCorpus([
      corpusEntry({ id: 'a', title: 'High', score: 90, year: 2025, publicationType: 'method', subQuestions: ['Q1'] }),
      corpusEntry({ id: 'b', title: 'Low', score: 30 }),
      corpusEntry({ id: 'c', title: 'Rejected', screeningStatus: 'rejected' }),
    ])

    const items = getCorpusSelection(ws, OUT)
    expect(items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(items[0]).toMatchObject({ id: 'a', title: 'High', year: 2025, publicationType: 'method', included: true })
    expect(items[0].subQuestions).toEqual(['Q1'])
  })
})

describe('setCorpusItemIncluded', () => {
  it('excludes a source without losing it (reversible, no failed read)', () => {
    writeCorpus([corpusEntry({ id: 'a' }), corpusEntry({ id: 'b' })])

    const res = setCorpusItemIncluded(ws, 'a', false, OUT)
    expect(res.ok).toBe(true)
    expect(res.selected).toBe(1)

    const entry = loadCorpus(ws, OUT).find((e) => e.id === 'a')!
    expect(entry.screeningStatus).toBe('rejected')
    expect(entry.status).toBe('rejected')
    // Excluding must NOT mark the read as failed — it has to be cleanly restorable.
    expect(entry.readStatus).toBe('not_read')
  })

  it('restores a previously excluded source', () => {
    writeCorpus([corpusEntry({ id: 'a' })])
    setCorpusItemIncluded(ws, 'a', false, OUT)

    const res = setCorpusItemIncluded(ws, 'a', true, OUT)
    expect(res.ok).toBe(true)
    expect(res.selected).toBe(1)

    const entry = loadCorpus(ws, OUT).find((e) => e.id === 'a')!
    expect(entry.screeningStatus).toBe('selected')
    expect(entry.status).toBe('candidate')
    expect(getCorpusSelection(ws, OUT).map((i) => i.id)).toContain('a')
  })

  it('returns ok=false for an unknown id', () => {
    writeCorpus([corpusEntry({ id: 'a' })])
    const res = setCorpusItemIncluded(ws, 'missing', false, OUT)
    expect(res.ok).toBe(false)
    expect(res.selected).toBe(1)
  })
})
