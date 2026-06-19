import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool } from '../electron/tools'

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
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-tools-'))
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('read_corpus_item', () => {
  it('does not refetch an item already marked read', () => {
    writeCorpus([corpusEntry({
      readStatus: 'read',
      status: 'read',
      localPath: '.research/run/fulltext/item1.md',
    })])

    const result = executeTool('read_corpus_item', { id: 'item1', output_dir: OUT }, ws)

    expect(result).toContain('No-op')
    expect(result).toContain('already marked read')
  })

  it('does not retry a failed item with a non-retriable HTTP error', () => {
    writeCorpus([corpusEntry({
      readStatus: 'failed',
      readReason: 'Error: fetch_url failed - HTTP403',
    })])

    const result = executeTool('read_corpus_item', { id: 'item1', output_dir: OUT }, ws)

    expect(result).toContain('Error:')
    expect(result).toContain('already failed')
    expect(result).toContain('Do not retry')
  })
})
