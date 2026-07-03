import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { repairEvidenceQuotes, loadEvidence } from '../electron/evidence'

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

function corpusItem(id: string, over: Record<string, any> = {}) {
  return {
    id,
    title: `Paper ${id}`,
    url: `https://example.org/${id}`,
    snippet: '',
    tier: 'primary',
    status: 'read',
    tags: [],
    addedAt: 0,
    updatedAt: 0,
    screeningStatus: 'selected',
    readStatus: 'read',
    ...over,
  }
}

function evidenceRow(id: string, over: Record<string, any> = {}) {
  return {
    id,
    topic: 'Q1',
    claim: 'Некоторое русскоязычное утверждение, синтезированное из англоязычного источника.',
    sourceIdxs: [],
    corpusIds: ['c1'],
    sourceUrls: ['https://example.org/c1'],
    planItemId: 'Q1',
    evidenceType: 'survey_statement',
    confidence: 'high',
    support: 'supports',
    status: 'supported',
    createdAt: 0,
    ...over,
  }
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-quotes-'))
  fs.mkdirSync(runDir(), { recursive: true })
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('repairEvidenceQuotes guarantees forward progress', () => {
  it('attaches an honest paraphrase caveat when no verbatim quote is extractable (empty/cross-language full text)', () => {
    // Full text file exists but is empty (failed/paywalled download) → no quote extractable.
    fs.writeFileSync(path.join(runDir(), 'ft.md'), '')
    writeCorpus([corpusItem('c1', { localPath: `${OUT}/ft.md` })])
    writeEvidence([evidenceRow('C-1', { corpusIds: ['c1'], localPath: `${OUT}/ft.md` })])

    const out = repairEvidenceQuotes(ws, OUT)
    expect(out).toMatch(/Repaired evidence quotes: 1/)
    expect(out).toMatch(/honest paraphrase\/abstract caveats: 1/)

    const rows = loadEvidence(ws, OUT)
    // The gate accepts a quote OR a notes field containing "abstract".
    expect((rows[0].notes || '').toLowerCase()).toContain('abstract')
  })

  it('prefers a real verbatim quote when the source text supports the claim', () => {
    const passage = 'Micronized purified flavonoid fraction improves venous symptoms across all stages of chronic venous disease in this systematic review of randomized trials.'
    fs.writeFileSync(path.join(runDir(), 'ft.md'), `Title\n\n${passage}\n`)
    writeCorpus([corpusItem('c1', { localPath: `${OUT}/ft.md` })])
    writeEvidence([evidenceRow('C-1', {
      claim: 'flavonoid fraction improves venous symptoms across all stages of chronic venous disease systematic review',
      corpusIds: ['c1'],
      localPath: `${OUT}/ft.md`,
    })])

    const out = repairEvidenceQuotes(ws, OUT)
    expect(out).toMatch(/verbatim quotes: 1/)
    const rows = loadEvidence(ws, OUT)
    expect((rows[0].quote || '').length).toBeGreaterThan(0)
  })

  it('leaves claims with no source link unresolved (linkage problem, not a citation one)', () => {
    writeCorpus([])
    writeEvidence([evidenceRow('C-1', { corpusIds: [], sourceUrls: [] })])

    const out = repairEvidenceQuotes(ws, OUT)
    expect(out).toMatch(/Repaired evidence quotes: 0/)
    expect(out).toMatch(/Still missing quote\/caveat \(1\)/)
    const rows = loadEvidence(ws, OUT)
    expect((rows[0].notes || '').toLowerCase()).not.toContain('abstract')
  })
})
