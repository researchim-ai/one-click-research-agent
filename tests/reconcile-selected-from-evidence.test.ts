import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadCorpus } from '../electron/corpus'
import { reconcileSelectedFromEvidence } from '../electron/evidence'

let ws: string
const OUT = '.research/run'

function runDir() {
  return path.join(ws, OUT)
}

function writeCorpus(entries: any[]) {
  fs.mkdirSync(runDir(), { recursive: true })
  fs.writeFileSync(path.join(runDir(), 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function writeEvidence(rows: any[]) {
  fs.mkdirSync(runDir(), { recursive: true })
  fs.writeFileSync(path.join(runDir(), 'evidence.jsonl'), rows.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function entry(over: Record<string, any>) {
  return {
    id: 'x',
    title: 'Paper',
    url: 'https://example.invalid/p',
    tier: 'primary',
    screeningStatus: 'needs_review',
    status: 'read',
    readStatus: 'read',
    score: 50,
    tags: [],
    addedAt: 0,
    updatedAt: 0,
    subQuestions: [],
    ...over,
  }
}

function claim(over: Record<string, any>) {
  return {
    id: `E-${Math.random().toString(36).slice(2, 8)}`,
    claim: 'A grounded claim',
    sourceIdxs: [],
    corpusIds: [],
    sourceUrls: [],
    confidence: 'medium',
    support: 'supports',
    status: 'supported',
    createdAt: 0,
    ...over,
  }
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'))
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('reconcileSelectedFromEvidence', () => {
  it('promotes a read source cited by supported evidence to selected', () => {
    writeCorpus([entry({ id: 'us001', screeningStatus: 'needs_review' })])
    writeEvidence([claim({ corpusIds: ['us001'] })])

    const promoted = reconcileSelectedFromEvidence(ws, OUT)

    expect(promoted).toBe(1)
    const c = loadCorpus(ws, OUT).find((e) => e.id === 'us001')!
    expect(c.screeningStatus).toBe('selected')
    expect(c.screeningReason).toContain('Auto-selected')
  })

  it('never promotes an unread source even if evidence references it', () => {
    writeCorpus([entry({ id: 'us002', readStatus: 'not_read', status: 'queued_full_text' })])
    writeEvidence([claim({ corpusIds: ['us002'] })])

    expect(reconcileSelectedFromEvidence(ws, OUT)).toBe(0)
    expect(loadCorpus(ws, OUT)[0].screeningStatus).toBe('needs_review')
  })

  it('respects a manual rejection pin and never resurrects it', () => {
    writeCorpus([entry({ id: 'us003', pinnedStatus: 'rejected', screeningStatus: 'rejected' })])
    writeEvidence([claim({ corpusIds: ['us003'] })])

    expect(reconcileSelectedFromEvidence(ws, OUT)).toBe(0)
    expect(loadCorpus(ws, OUT)[0].screeningStatus).toBe('rejected')
  })

  it('ignores unsupported/weak evidence rows', () => {
    writeCorpus([entry({ id: 'us004' })])
    writeEvidence([claim({ corpusIds: ['us004'], support: 'weak', status: 'needs_review' })])

    expect(reconcileSelectedFromEvidence(ws, OUT)).toBe(0)
    expect(loadCorpus(ws, OUT)[0].screeningStatus).toBe('needs_review')
  })
})
