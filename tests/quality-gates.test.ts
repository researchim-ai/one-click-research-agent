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

function writePlan() {
  const run = path.join(ws, OUT)
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'plan.md'), [
    '# Plan',
    '- [x] Q1. Methods',
    '- [x] Q2. Reasoning',
    '- [x] Q3. Rewards',
    '- [x] Q4. Benchmarks',
    '- [x] Q5. Reproducibility',
    '- [x] Q6. Safety',
  ].join('\n'))
}

function writeReport(content: string) {
  const run = path.join(ws, OUT)
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'report.md'), content)
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

  it('general research relaxes academic-only gates (review coverage + recency)', () => {
    // Survey-less corpus with NO publication year — academic would fail review+recency.
    const entries = Array.from({ length: 6 }, (_, i) => corpusEntry(i, { year: undefined, publicationType: 'unknown' }))
    writeCorpus(entries)

    const academic = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any).results
    const aBy = Object.fromEntries(academic.map((r) => [r.gate, r]))
    expect(aBy.review_source_coverage.passed).toBe(false)
    expect(aBy.recency.passed).toBe(false)

    const general = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT, researchKind: 'general' } as any).results
    const gBy = Object.fromEntries(general.map((r) => [r.gate, r]))
    expect(gBy.review_source_coverage.passed).toBe(true)
    expect(gBy.recency.passed).toBe(true)
    // Non-academic relaxation must NOT touch the core gates.
    expect(gBy.source_coverage.passed).toBe(true)
    expect(gBy.selected_corpus_minimum.passed).toBe(true)
    expect(gBy.topical_precision.passed).toBe(true)
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

  it('fails final_report_structure for a long but non-interactive evidence dump', () => {
    writePlan()
    writeCorpus(Array.from({ length: 6 }, (_, i) => corpusEntry(i, { publicationType: i === 0 ? 'survey' : 'method' })))
    writeReport([
      '# Report',
      '',
      '## Краткое резюме',
      'Текст отчёта. '.repeat(180),
      '## Метод',
      'Текст отчёта. '.repeat(180),
      '## Метрики',
      'Текст отчёта. '.repeat(180),
      '## Ограничения',
      'Текст отчёта. '.repeat(180),
      '## Тренды',
      'Текст отчёта. '.repeat(180),
    ].join('\n'))

    const { results } = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
    const gate = results.find((r) => r.gate === 'final_report_structure')!

    expect(gate.passed).toBe(false)
    expect(gate.blockers.join('\n')).toContain('interactive narrative synthesis')
  })

  it('passes final_report_structure for an interactive linked synthesis report', () => {
    writePlan()
    writeCorpus(Array.from({ length: 8 }, (_, i) => corpusEntry(i, {
      id: `abcdef000${i}`,
      publicationType: i === 0 ? 'survey' : 'method',
      url: `https://example.org/paper-${i}`,
      localPath: `${OUT}/fulltext/abcdef000${i}.md`,
      subQuestions: [`Q${(i % 6) + 1}`],
    })))
    const sourceLinks = Array.from({ length: 12 }, (_, i) => `[abcdef000${i % 8}](https://example.org/paper-${i % 8})`).join(', ')
    const fullTextRows = Array.from({ length: 8 }, (_, i) => `| S${i + 1} | [Paper ${i}](https://example.org/paper-${i}) | method | high | Q${(i % 6) + 1} | [full text](fulltext/abcdef000${i}.md) | \`abcdef000${i}\` |`).join('\n')
    const qSections = Array.from({ length: 6 }, (_, i) => [
      `## Q${i + 1}. Section ${i + 1}`,
      '',
      `**Coverage:** 3 claims; primary/benchmark/safety=2; survey=1; metadata-only=${i === 0 ? 1 : 0}.`,
      '',
      `- **Claim ${i + 1}.** Evidence: ${sourceLinks}.`,
      `  Strength: ${i === 0 ? 'metadata-only' : 'strong'}; type: primary_result; confidence=high.`,
      '  Quote: "A concrete quoted passage supports this claim and gives enough context for review."',
      '',
    ].join('\n')).join('\n')
    writeReport([
      '# Interactive Report',
      '',
      '## Краткое резюме',
      'Связный синтез с кликабельными ссылками. '.repeat(80),
      '',
      '## Как пользоваться отчётом',
      `Ссылки на источники: ${sourceLinks}.`,
      '',
      '## Матрица направлений',
      '| Направление | Reward / signal | Типовые методы | Evidence links |',
      '|---|---|---|---|',
      `| RLHF | preferences | PPO/DPO/GRPO | ${sourceLinks} |`,
      `| RLVR | verifiable | GRPO | ${sourceLinks} |`,
      '',
      '## Метод и подход к отбору источников',
      'Методология отбора и screening. '.repeat(70),
      '',
      '## Метрики и критерии оценки',
      'Benchmarks, evaluation, reward signals. '.repeat(70),
      '',
      '## Доказательная база',
      '| # | Источник | Тип | Приоритет | План | Локальный артефакт | Corpus ID |',
      '|---|---|---|---|---|---|---|',
      fullTextRows,
      '',
      // Use the exact heading composeSynthesisReport emits for ru reports.
      '## Недоступные источники высокого приоритета',
      '- [abcdef0000](https://example.org/paper-0): metadata-only / abstract-only caveat documented.',
      '',
      qSections,
      '## Сквозная интерпретация',
      'Синтез по направлениям. '.repeat(90),
      '',
      '## Ограничения и риски интерпретации',
      'metadata-only evidence and abstract-only caveats are weaker than full-text evidence.',
      '',
      '## Практические выводы',
      'Практические выводы. '.repeat(40),
      '',
      '## Тренды и дальнейшие направления',
      'Тренды и будущие направления. '.repeat(80),
    ].join('\n'))

    const { results } = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
    const gate = results.find((r) => r.gate === 'final_report_structure')!

    expect(gate.passed).toBe(true)
  })

  // Regression: the gate's unavailable-source detection must accept the exact
  // headings composeSynthesisReport emits. A mismatch (the gate looked for
  // "Недоступные high-priority источники" while the generator wrote
  // "Недоступные источники высокого приоритета") made the gate impossible to
  // satisfy for ru reports and the agent regenerated report.md forever.
  for (const heading of ['## Недоступные источники высокого приоритета', '## Unavailable High-Priority Sources']) {
    it(`accepts the real generator unavailable-source heading "${heading}"`, () => {
      writePlan()
      writeCorpus(Array.from({ length: 8 }, (_, i) => corpusEntry(i, {
        id: `abcdef000${i}`,
        publicationType: i === 0 ? 'survey' : 'method',
        url: `https://example.org/paper-${i}`,
        localPath: `${OUT}/fulltext/abcdef000${i}.md`,
        subQuestions: [`Q${(i % 6) + 1}`],
      })))
      const sourceLinks = Array.from({ length: 12 }, (_, i) => `[abcdef000${i % 8}](https://example.org/paper-${i % 8})`).join(', ')
      const fullTextRows = Array.from({ length: 8 }, (_, i) => `| S${i + 1} | [Paper ${i}](https://example.org/paper-${i}) | method | high | Q${(i % 6) + 1} | [full text](fulltext/abcdef000${i}.md) | \`abcdef000${i}\` |`).join('\n')
      const qSections = Array.from({ length: 6 }, (_, i) => [
        `## Q${i + 1}. Section ${i + 1}`,
        '',
        `**Coverage:** 3 claims; primary/benchmark/safety=2; survey=1; metadata-only=${i === 0 ? 1 : 0}.`,
        '',
        `- **Claim ${i + 1}.** Evidence: ${sourceLinks}.`,
        `  Strength: ${i === 0 ? 'metadata-only' : 'strong'}; type: primary_result; confidence=high.`,
        '  Quote: "A concrete quoted passage supports this claim and gives enough context for review."',
        '',
      ].join('\n')).join('\n')
      writeReport([
        '# Interactive Report', '',
        '## Краткое резюме', 'Связный синтез с кликабельными ссылками. '.repeat(80), '',
        '## Как пользоваться отчётом', `Ссылки на источники: ${sourceLinks}.`, '',
        '## Матрица направлений',
        '| Направление | Reward / signal | Типовые методы | Evidence links |',
        '|---|---|---|---|',
        `| RLHF | preferences | PPO/DPO/GRPO | ${sourceLinks} |`,
        `| RLVR | verifiable | GRPO | ${sourceLinks} |`, '',
        '## Метод и подход к отбору источников', 'Методология отбора и screening. '.repeat(70), '',
        '## Метрики и критерии оценки', 'Benchmarks, evaluation, reward signals. '.repeat(70), '',
        '## Доказательная база',
        '| # | Источник | Тип | Приоритет | План | Локальный артефакт | Corpus ID |',
        '|---|---|---|---|---|---|---|',
        fullTextRows, '',
        heading,
        '- [abcdef0000](https://example.org/paper-0): metadata-only / abstract-only caveat documented.', '',
        qSections,
        '## Сквозная интерпретация', 'Синтез по направлениям. '.repeat(90), '',
        '## Ограничения и риски интерпретации', 'metadata-only evidence and abstract-only caveats are weaker than full-text evidence.', '',
        '## Практические выводы', 'Практические выводы. '.repeat(40), '',
        '## Тренды и дальнейшие направления', 'Тренды и будущие направления. '.repeat(80),
      ].join('\n'))

      const { results } = runQualityGates(ws, undefined, { minSources: 5, outputDir: OUT } as any)
      const gate = results.find((r) => r.gate === 'final_report_structure')!
      expect(gate.passed).toBe(true)
    })
  }
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
