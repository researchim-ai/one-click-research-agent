import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runQualityGates, readQualityGateSnapshot, writeQualityGateSnapshot } from '../electron/quality-gates'
import { applyGateEscapeValve, GATE_DOWNGRADE_AFTER_ATTEMPTS } from '../electron/research-workflow'

let ws: string
const OUT = '.research/run'

const YEAR = new Date().getFullYear()

function corpusEntry(i: number, over: Partial<Record<string, any>> = {}) {
  return {
    id: `c${i}`,
    title: `Paper ${i}`,
    url: `https://example.org/${i}`,
    tier: 'primary',
    status: 'read',
    score: 50 - i,
    tags: [],
    addedAt: 0,
    updatedAt: 0,
    year: YEAR,
    screeningStatus: 'selected',
    readStatus: 'read',
    publicationType: 'method',
    topicalPrecisionScore: 80,
    subQuestions: [],
    ...over,
  }
}

function writeCorpus(entries: any[]) {
  const run = path.join(ws, OUT)
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qgates-'))
})
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('runQualityGates', () => {
  it('passes source/selected coverage and fails review coverage for a survey-less corpus', () => {
    writeCorpus(Array.from({ length: 6 }, (_, i) => corpusEntry(i)))
    const { results } = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
    const byGate = Object.fromEntries(results.map((r) => [r.gate, r]))
    expect(byGate.source_coverage.passed).toBe(true)
    expect(byGate.selected_corpus_minimum.passed).toBe(true)
    expect(byGate.review_source_coverage.passed).toBe(false)
  })

  it('passes review coverage when a survey is present', () => {
    const entries = Array.from({ length: 6 }, (_, i) => corpusEntry(i))
    entries[0].publicationType = 'survey'
    writeCorpus(entries)
    const { results } = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
    const review = results.find((r) => r.gate === 'review_source_coverage')!
    expect(review.passed).toBe(true)
  })

  it('writes a readable snapshot to disk', () => {
    writeCorpus(Array.from({ length: 6 }, (_, i) => corpusEntry(i)))
    runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
    const snap = readQualityGateSnapshot(ws, OUT)
    expect(snap).not.toBeNull()
    expect(snap!.total).toBeGreaterThan(0)
  })
})

describe('escape valve end-to-end on disk', () => {
  it('downgrades review_source_coverage after repeated runs and persists it', () => {
    writeCorpus(Array.from({ length: 6 }, (_, i) => corpusEntry(i)))

    let downgradedFinal: string[] = []
    for (let attempt = 0; attempt < GATE_DOWNGRADE_AFTER_ATTEMPTS; attempt++) {
      const { results: raw } = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
      const { results, downgraded } = applyGateEscapeValve(ws, OUT, raw)
      if (downgraded.length) writeQualityGateSnapshot(ws, OUT, results)
      downgradedFinal = downgraded
    }

    expect(downgradedFinal).toContain('review_source_coverage')
    const snap = readQualityGateSnapshot(ws, OUT)
    expect(snap!.failed.some((r) => r.gate === 'review_source_coverage')).toBe(false)

    const runJson = JSON.parse(fs.readFileSync(path.join(ws, OUT, 'run.json'), 'utf-8'))
    expect(runJson.downgradedGates).toContain('review_source_coverage')
    expect(runJson.gateAttempts.review_source_coverage).toBeGreaterThanOrEqual(GATE_DOWNGRADE_AFTER_ATTEMPTS)
  })
})
