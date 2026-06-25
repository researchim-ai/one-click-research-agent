import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { composeSynthesisReport } from '../electron/tools'
import { ensureResearchRunSpec } from '../electron/research-workflow'

let ws: string
const OUT = '.research/2026-01-01_00-00-00_topic'

function makeEntry(i: number, score: number) {
  const id = `id${String(i).padStart(2, '0')}`
  return {
    id,
    title: `Paper ${i} on reinforcement learning`,
    url: `https://arxiv.org/abs/2501.${1000 + i}`,
    tier: 'primary',
    screeningStatus: 'selected',
    readStatus: 'read',
    status: 'read',
    score,
    year: 2025,
    tags: [],
    addedAt: 0,
    updatedAt: 0,
  }
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'report-topn-'))
  fs.mkdirSync(path.join(ws, OUT), { recursive: true })
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('composeSynthesisReport report-source limit', () => {
  it('presents only the top-N most relevant sources when a count is set', () => {
    // 10 read+selected sources with ascending score: id10 has the highest score.
    const entries = Array.from({ length: 10 }, (_, k) => makeEntry(k + 1, (k + 1) * 10))
    fs.writeFileSync(path.join(ws, OUT, 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    ensureResearchRunSpec(ws, OUT, { thresholds: { minSelected: 3 } })

    const report = composeSynthesisReport(ws, 'Test', OUT, true)

    // The 3 highest-scoring ids must appear; the lower-scoring ones must not.
    expect(report).toContain('id10')
    expect(report).toContain('id09')
    expect(report).toContain('id08')
    expect(report).not.toContain('id01')
    expect(report).not.toContain('id05')
  })

  it('uses a cached in-language summary for a presented source', () => {
    const e = { ...makeEntry(1, 100), summary: 'Это закэшированная русская выжимка по статье.', summaryLang: 'ru' }
    fs.writeFileSync(path.join(ws, OUT, 'corpus.jsonl'), JSON.stringify(e) + '\n')
    ensureResearchRunSpec(ws, OUT, { thresholds: { minSelected: 1 } })

    const report = composeSynthesisReport(ws, 'Test', OUT, true)
    expect(report).toContain('Это закэшированная русская выжимка по статье.')
    expect(report).toContain('## Аннотации источников')
  })

  it('shows all read sources when no count is set', () => {
    const entries = Array.from({ length: 5 }, (_, k) => makeEntry(k + 1, (k + 1) * 10))
    fs.writeFileSync(path.join(ws, OUT, 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    ensureResearchRunSpec(ws, OUT, {})

    const report = composeSynthesisReport(ws, 'Test', OUT, true)
    for (let i = 1; i <= 5; i++) expect(report).toContain(`id0${i}`)
  })
})
