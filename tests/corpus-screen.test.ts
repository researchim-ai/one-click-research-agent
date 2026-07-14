import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool } from '../electron/tools'
import { loadCorpus, screenCorpus, semanticQueryKey } from '../electron/corpus'

let ws: string
const OUT = '.research/run'
const YEAR = new Date().getFullYear()

function raw(id: string, title: string) {
  return {
    id,
    title,
    url: `https://arxiv.org/abs/${id}`,
    arxivId: id,
    tier: 'primary',
    screeningStatus: 'raw',
    status: 'candidate',
    readStatus: 'not_read',
    score: 0,
    tags: [],
    year: YEAR,
    addedAt: 0,
    updatedAt: 0,
    subQuestions: [],
  }
}

function writeCorpus(entries: any[]) {
  const run = path.join(ws, OUT)
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-screen-'))
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('screen_corpus min_selected soft floor', () => {
  it('promotes on-topic borderline items to reach the floor but never selects off-topic', () => {
    writeCorpus([
      // Strong on-topic (RL + LLM): selected outright.
      raw('s1', 'Reinforcement Learning for LLM alignment with RLHF and DPO'),
      raw('s2', 'Reinforcement Learning for LLM reasoning via GRPO and PPO'),
      // Borderline on-topic (RL only, no explicit LLM): needs_review, eligible for promotion.
      raw('b1', 'Reinforcement learning for robotics control policy'),
      raw('b2', 'Reinforcement learning reward shaping for agents'),
      raw('b3', 'Reinforcement learning policy optimization study'),
      raw('b4', 'Reinforcement learning offline value methods'),
      // Clearly off-topic: must be rejected and never promoted.
      raw('off1', 'Photography guidance with cameras and lenses'),
      raw('off2', 'Speech synthesis for podcast production'),
    ])

    const out = executeTool('screen_corpus', {
      question: 'reinforcement learning LLM',
      min_selected: 5,
      output_dir: OUT,
    }, ws)
    expect(out).toContain('Screened')

    const corpus = loadCorpus(ws, OUT)
    const selected = corpus.filter((e) => e.screeningStatus === 'selected')
    expect(selected.length).toBeGreaterThanOrEqual(5)

    const offSelected = selected.filter((e) => e.id.startsWith('off'))
    expect(offSelected).toHaveLength(0)

    for (const off of corpus.filter((e) => e.id.startsWith('off'))) {
      expect(off.screeningStatus).toBe('rejected')
    }
  })

  it('ignores uniform query-level topic tags so off-topic sources are still rejected', () => {
    // build_corpus applies the same topic tags to every source. These tags must NOT
    // be treated as the paper's own subject, otherwise every item looks on-topic.
    const topicTags = ['RL', 'LLM', 'RLHF', 'DPO', 'GRPO', 'reasoning', 'alignment']
    const offTopic = [
      raw('off1', 'Primordial Black Holes in a Radiation-Dominated Universe'),
      raw('off2', 'Cavity-mediated probabilistic magic T-gate injection'),
      raw('off3', 'Poisson bracket and L-infinity algebras'),
    ].map((e) => ({ ...e, tags: [...topicTags] }))
    writeCorpus([
      { ...raw('s1', 'Reinforcement Learning for LLM alignment with RLHF and DPO'), tags: [...topicTags] },
      ...offTopic,
    ])

    executeTool('screen_corpus', { question: 'reinforcement learning LLM', output_dir: OUT }, ws)
    const corpus = loadCorpus(ws, OUT)

    for (const off of corpus.filter((e) => e.id.startsWith('off'))) {
      expect(off.topicalPrecisionScore ?? 0).toBeLessThan(30)
      expect(off.screeningStatus).toBe('rejected')
    }
    expect(corpus.find((e) => e.id === 's1')?.screeningStatus).toBe('selected')
  })

  it('general (web) research filters off-topic by query-term coverage, not RL/LLM vocabulary', () => {
    // A general query has no RL/LLM vocabulary, so the academic precision heuristic would
    // be a flat no-op and let everything through. The generic strategy must still reject
    // pages that share none of the query terms while keeping on-topic ones.
    const onTopic = [
      { ...raw('g1', 'Цены и стоимость квартир в Магадане в 2026 году'), url: 'https://example.com/magadan-prices' },
      { ...raw('g2', 'Обзор рынка недвижимости: стоимость квартир в Магадане'), url: 'https://example.com/magadan-market' },
    ]
    const offTopic = [
      { ...raw('o1', 'Лучшие рецепты борща и домашней выпечки'), url: 'https://example.com/recipes' },
      { ...raw('o2', 'Гайд по настройке игрового ноутбука для стриминга'), url: 'https://example.com/laptop' },
    ]
    writeCorpus([...onTopic, ...offTopic])

    executeTool('screen_corpus', {
      question: 'стоимость квартир в Магадане',
      research_kind: 'general',
      output_dir: OUT,
    }, ws)
    const corpus = loadCorpus(ws, OUT)

    for (const off of corpus.filter((e) => e.id.startsWith('o'))) {
      expect(off.screeningStatus).toBe('rejected')
    }
    expect(corpus.filter((e) => e.id.startsWith('g') && e.screeningStatus === 'selected').length).toBeGreaterThanOrEqual(1)
  })

  it('selects cross-language general sources using the executed English search queries', () => {
    // Real failure: a Russian question over English web pages drove topical precision to
    // ~40 for genuinely on-topic sources, so screen_corpus selected almost nothing and the
    // agent looped re-screening. Folding the English search queries the agent actually ran
    // into the vocabulary must let those English pages be selected, while off-topic pages
    // (a flat in a different city) stay out.
    const en = (id: string, title: string) => ({ ...raw(id, title), url: `https://example.com/${id}`, arxivId: undefined })
    writeCorpus([
      en('e1', 'Singapore Private Property Market: 2025 Review and 2026 Outlook'),
      en('e2', 'Singapore HDB resale flat prices 2024 2025 median by town'),
      en('e3', 'Singapore condo price per square foot 2024 2025 residential market'),
      { ...raw('off1', 'Купить квартиру на улице Кочетова (Чайковский)'), url: 'https://example.com/off1', arxivId: undefined },
    ])

    const augment = [
      'singapore housing prices 2024 2025 hdb condo average cost',
      'singapore property market trends price growth regional differences',
      'singapore hdb resale flat prices median by town district',
    ]
    // Without the English augment the on-topic English pages are under-selected.
    screenCorpus(ws, {
      question: 'Какова стоимость квартир в Сингапуре в 2024–2026 годах?',
      researchKind: 'general',
      minSelected: 3,
    }, OUT)
    const before = loadCorpus(ws, OUT).filter((e) => e.id.startsWith('e') && e.screeningStatus === 'selected').length

    screenCorpus(ws, {
      question: 'Какова стоимость квартир в Сингапуре в 2024–2026 годах?',
      researchKind: 'general',
      minSelected: 3,
      queryAugment: augment,
    }, OUT)
    const corpus = loadCorpus(ws, OUT)
    const selectedEn = corpus.filter((e) => e.id.startsWith('e') && e.screeningStatus === 'selected').length

    expect(selectedEn).toBeGreaterThan(before)
    expect(selectedEn).toBeGreaterThanOrEqual(3)
    expect(corpus.find((e) => e.id === 'off1')?.screeningStatus).not.toBe('selected')
  })

  it('uses the cached LLM semantic score as topical relevance regardless of language', () => {
    // The whole point of language-agnosticism: an English source under a Russian question is
    // selected purely on the LLM-judged semantic score, with ZERO shared tokens. And a source
    // the LLM marked off-topic is rejected even if it happens to share query words.
    const question = 'Какова стоимость квартир в Сингапуре в 2024–2026 годах?'
    const key = semanticQueryKey(question, [])
    writeCorpus([
      // English, no token overlap with the Russian question, but LLM says highly on-topic.
      { ...raw('e1', 'Singapore Private Property Market: 2025 Review and 2026 Outlook'), arxivId: undefined, url: 'https://x/e1', semanticRelevanceScore: 88, semanticOnTopic: true, semanticQueryKey: key },
      { ...raw('e2', 'Singapore HDB resale flat prices 2024 2025 median by town'), arxivId: undefined, url: 'https://x/e2', semanticRelevanceScore: 82, semanticOnTopic: true, semanticQueryKey: key },
      // Shares the Russian word "квартир" but the LLM judged it off-topic (different city).
      { ...raw('o1', 'Купить квартиру на улице Кочетова в Чайковском'), arxivId: undefined, url: 'https://x/o1', semanticRelevanceScore: 8, semanticOnTopic: false, semanticQueryKey: key },
    ])

    screenCorpus(ws, { question, researchKind: 'general', minSelected: 2 }, OUT)
    const corpus = loadCorpus(ws, OUT)

    expect(corpus.find((e) => e.id === 'e1')?.screeningStatus).toBe('selected')
    expect(corpus.find((e) => e.id === 'e2')?.screeningStatus).toBe('selected')
    expect(corpus.find((e) => e.id === 'o1')?.screeningStatus).toBe('rejected')
  })

  it('ignores a stale semantic score cached for a DIFFERENT query (falls back to lexical)', () => {
    // A cached score bound to another question must not leak into an unrelated screen.
    writeCorpus([
      { ...raw('g1', 'Reinforcement learning for LLM alignment with RLHF and DPO'), semanticRelevanceScore: 5, semanticOnTopic: false, semanticQueryKey: 'some-other-query-key' },
    ])
    executeTool('screen_corpus', { question: 'reinforcement learning LLM', output_dir: OUT }, ws)
    // The stale 5 must be ignored; lexical relevance selects the clearly on-topic paper.
    expect(loadCorpus(ws, OUT).find((e) => e.id === 'g1')?.screeningStatus).toBe('selected')
  })

  it('keeps manually rejected items rejected across a later re-screen (sticky reject)', () => {
    // Root cause of off-topic leaking into reports: the agent rejected off-topic items,
    // but a subsequent build_corpus/screen_corpus resurrected them. Rejection must stick.
    writeCorpus([
      raw('s1', 'Reinforcement Learning for LLM alignment with RLHF and DPO'),
      raw('s2', 'Reinforcement Learning for LLM reasoning via GRPO and PPO'),
      raw('x1', 'Reinforcement Learning for LLM reward modeling and preference optimization'),
    ])
    // First screen selects the on-topic items.
    executeTool('screen_corpus', { question: 'reinforcement learning LLM', output_dir: OUT }, ws)
    expect(loadCorpus(ws, OUT).find((e) => e.id === 'x1')?.screeningStatus).toBe('selected')

    // Agent rejects x1 explicitly.
    executeTool('reject_corpus_items', { ids: 'x1', reason: 'off-topic', output_dir: OUT }, ws)
    const afterReject = loadCorpus(ws, OUT).find((e) => e.id === 'x1')
    expect(afterReject?.screeningStatus).toBe('rejected')
    expect(afterReject?.pinnedStatus).toBe('rejected')

    // A later re-screen (e.g. via build_corpus auto-screen) must NOT bring it back.
    executeTool('screen_corpus', { question: 'reinforcement learning LLM', output_dir: OUT }, ws)
    const afterReScreen = loadCorpus(ws, OUT).find((e) => e.id === 'x1')
    expect(afterReScreen?.screeningStatus).toBe('rejected')
  })

  it('never floor-promotes an item below the gate topical-precision threshold', () => {
    // The floor promotion must share the topical_precision gate threshold (45): promoting a
    // precision-40 item to hit the count is exactly what forced the gate to be downgraded.
    writeCorpus([
      raw('s1', 'Reinforcement Learning for LLM alignment with RLHF and DPO'),
      // Off-topic-ish "LLM" paper with no RL content — low precision, must not be promoted.
      raw('w1', 'When LLMs Read Tables Carelessly: Measuring Data Referencing Errors'),
      raw('w2', 'Annif at SemEval: Traditional XMTC augmented by LLMs for subject indexing'),
    ])
    executeTool('screen_corpus', { question: 'reinforcement learning LLM', min_selected: 3, output_dir: OUT }, ws)
    const corpus = loadCorpus(ws, OUT)
    for (const e of corpus.filter((c) => c.id.startsWith('w') && c.screeningStatus === 'selected')) {
      expect(e.topicalPrecisionScore ?? 0).toBeGreaterThanOrEqual(45)
    }
  })

  it('does not force selections when no minimum is requested', () => {
    writeCorpus([
      raw('b1', 'Reinforcement learning for robotics control policy'),
      raw('b2', 'Reinforcement learning reward shaping for agents'),
    ])
    executeTool('screen_corpus', { question: 'reinforcement learning LLM', output_dir: OUT }, ws)
    const corpus = loadCorpus(ws, OUT)
    // Borderline RL-only items stay needs_review without a floor pushing them in.
    expect(corpus.filter((e) => e.screeningStatus === 'selected').length).toBe(0)
  })
})
