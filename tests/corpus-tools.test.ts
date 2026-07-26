import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool, executeToolAsync } from '../electron/tools'
import { loadCorpus } from '../electron/corpus'
import { ensureResearchRunSpec } from '../electron/research-workflow'
import { getSourceTracker } from '../electron/sources'

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

describe('build_corpus auto-screens against the saved screening contract', () => {
  it('leaves no unscreened raw backlog once a screen contract exists', () => {
    // Simulate: the model already screened once, so the contract is stored on the spec.
    const sessionId = `sess_${Date.now()}`
    ensureResearchRunSpec(ws, OUT, {
      topic: 'reinforcement learning for LLM',
      screenParams: { question: 'reinforcement learning LLM', subQuestions: [], researchKind: 'academic' },
    })

    // Fresh sources gathered by a later search wave: on-topic + clearly off-topic.
    getSourceTracker(sessionId).addMany([
      { title: 'Reinforcement Learning for LLM alignment with RLHF and DPO', url: 'https://arxiv.org/abs/2401.00001', tier: 'primary' },
      { title: 'Reinforcement Learning for LLM reasoning via GRPO', url: 'https://arxiv.org/abs/2401.00002', tier: 'primary' },
      { title: 'Primordial Black Holes in a Radiation-Dominated Universe', url: 'https://arxiv.org/abs/2401.00003', tier: 'primary' },
    ] as any)

    const result = executeTool('build_corpus', { session_id: sessionId, output_dir: OUT }, ws)
    expect(result).toContain('Auto-screened')

    const corpus = loadCorpus(ws, OUT)
    // The whole point: nothing is left in the unscreened `raw` limbo.
    expect(corpus.filter((e) => !e.screeningStatus || e.screeningStatus === 'raw')).toHaveLength(0)
    // On-topic gets selected; the astrophysics paper is rejected, not silently selected.
    expect(corpus.filter((e) => e.screeningStatus === 'selected').length).toBeGreaterThanOrEqual(1)
    expect(corpus.some((e) => /Primordial Black Holes/.test(e.title) && e.screeningStatus === 'rejected')).toBe(true)
  })

  it('leaves items raw before any screening contract exists (first build)', () => {
    const sessionId = `sess_${Date.now()}_2`
    ensureResearchRunSpec(ws, OUT, { topic: 'reinforcement learning for LLM' })
    getSourceTracker(sessionId).addMany([
      { title: 'Reinforcement Learning for LLM alignment', url: 'https://arxiv.org/abs/2402.00001', tier: 'primary' },
    ] as any)

    const result = executeTool('build_corpus', { session_id: sessionId, output_dir: OUT }, ws)
    expect(result).not.toContain('Auto-screened')
    const corpus = loadCorpus(ws, OUT)
    expect(corpus.every((e) => !e.screeningStatus || e.screeningStatus === 'raw')).toBe(true)
  })
})

describe('read_corpus_item', () => {
  it('does not refetch an item already marked read', async () => {
    writeCorpus([corpusEntry({
      readStatus: 'read',
      status: 'read',
      localPath: '.research/run/fulltext/item1.md',
    })])

    const result = await executeToolAsync('read_corpus_item', { id: 'item1', output_dir: OUT }, ws)

    expect(result).toContain('No-op')
    expect(result).toContain('already marked read')
  })

  it('does not retry a failed item with a non-retriable HTTP error', async () => {
    writeCorpus([corpusEntry({
      readStatus: 'failed',
      readReason: 'Error: fetch_url failed - HTTP403',
    })])

    const result = await executeToolAsync('read_corpus_item', { id: 'item1', output_dir: OUT }, ws)

    expect(result).toContain('Error:')
    expect(result).toContain('already failed')
    expect(result).toContain('Do not retry')
  })

  it('reconciles a rebuild mismatch (status=read but readStatus=not_read) instead of looping', async () => {
    const localPath = path.join(ws, OUT, 'fulltext', 'item1.html')
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    fs.writeFileSync(localPath, '<html>already downloaded</html>')
    // After a corpus rebuild the read state can desync: status says read while
    // readStatus was reset. The existing full-text file should let us reconcile.
    writeCorpus([corpusEntry({ status: 'read', readStatus: 'not_read', localPath })])

    const result = await executeToolAsync('read_corpus_item', { id: 'item1', output_dir: OUT }, ws)

    expect(result).toContain('Reconciled corpus item1')
    expect(result).not.toContain('No-op')

    // full_text_status must now agree that the item is read (no more loop).
    const status = executeTool('full_text_status', { output_dir: OUT }, ws)
    expect(status).toContain('1/1 selected read')
  })
})
