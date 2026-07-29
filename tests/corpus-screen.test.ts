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

describe('screen_corpus day-precise window + source preference', () => {
  const mk = (id: string, title: string, over: Record<string, any> = {}) => ({ ...raw(id, title), ...over })
  const FROM = `${YEAR}-05-01`
  const TO = `${YEAR}-08-01`

  it('enforces a sub-year window at DAY precision even within the same calendar year', () => {
    writeCorpus([
      mk('in1', 'Reinforcement Learning for LLM alignment with RLHF and DPO', { date: `${YEAR}-06-15T00:00:00Z` }),
      // Same YEAR but January → outside the May..Aug window; year-only filtering would keep it.
      mk('out1', 'Reinforcement Learning for LLM reasoning via GRPO and PPO', { date: `${YEAR}-01-10T00:00:00Z` }),
    ])
    screenCorpus(ws, { question: 'reinforcement learning LLM', yearFrom: YEAR, yearTo: YEAR, fromDate: FROM, toDate: TO, strictDateRange: true, minSelected: 1 }, OUT)
    const corpus = loadCorpus(ws, OUT)
    expect(corpus.find((e) => e.id === 'in1')?.screeningStatus).toBe('selected')
    expect(corpus.find((e) => e.id === 'out1')?.screeningStatus).toBe('rejected')
    expect(corpus.find((e) => e.id === 'out1')?.screeningReason).toMatch(/Outside strict date range/)
  })

  it('demotes an undated source under a strict day window (never auto-selects, never re-promotes)', () => {
    writeCorpus([
      mk('u1', 'Reinforcement Learning for LLM alignment with RLHF and DPO', { date: undefined, year: undefined, arxivId: undefined, url: 'https://link.springer.com/article/xyz' }),
    ])
    // A minimum floor must NOT re-promote the demoted undated source.
    screenCorpus(ws, { question: 'reinforcement learning LLM', fromDate: FROM, toDate: TO, strictDateRange: true, minSelected: 3 }, OUT)
    const e = loadCorpus(ws, OUT).find((c) => c.id === 'u1')
    expect(e?.screeningStatus).toBe('needs_review')
    expect(e?.screeningReason).toMatch(/No day-precise date/)
  })

  it('demotes a YEAR-ONLY source under a strict day window (a bare 2026 cannot confirm Apr–Jul)', () => {
    writeCorpus([
      // On-topic web page tagged year 2026 but with no day-precise date — the exact leak seen
      // in production where undated 2026 aggregator pages slipped in via the year fallback.
      mk('y1', 'Reinforcement Learning for LLM alignment: a comprehensive survey', { date: undefined, year: YEAR, arxivId: undefined, sourceTool: 'search_web', url: 'https://example.com/rl-llm-survey' }),
    ])
    screenCorpus(ws, { question: 'reinforcement learning LLM', yearFrom: YEAR, yearTo: YEAR, fromDate: FROM, toDate: TO, strictDateRange: true, minSelected: 3 }, OUT)
    const e = loadCorpus(ws, OUT).find((c) => c.id === 'y1')
    expect(e?.screeningStatus).toBe('needs_review')
    expect(e?.screeningReason).toMatch(/only year/)
  })

  it('does NOT demand day precision for a whole-year-aligned multi-year window (2024-01-01..2026-12-31)', () => {
    // A 3-year range expressed with Jan-1/Dec-31 edges is really a YEAR range: an undated
    // survey must stay selectable, not get demoted "No day-precise date" (the bug that left
    // reasoning/quantum/robotics plan items empty because all their surveys were undated).
    writeCorpus([
      mk('u1', 'A Survey of Reinforcement Learning for Large Reasoning Models', { date: undefined, year: undefined }),
    ])
    screenCorpus(ws, {
      question: 'reinforcement learning survey',
      fromDate: '2024-01-01', toDate: '2026-12-31', yearFrom: 2024, yearTo: 2026,
      strictDateRange: true, minSelected: 1,
    }, OUT)
    const e = loadCorpus(ws, OUT).find((c) => c.id === 'u1')!
    expect(e.screeningReason ?? '').not.toMatch(/No day-precise date/)
    expect(e.screeningStatus).toBe('selected')
  })

  it('treats "whole year to present" (from=Jan-1, to=today) as a coarse year range — does NOT demote year-only sources', () => {
    // Reproduces the hung run 2026-07-24: the user asked for papers "за 2026". Intake expressed it
    // as strictDateRange from=YYYY-01-01 to=<today>. That is NOT a sub-year cutoff — nothing can be
    // published after today — so a year-only 2026 survey must NOT be demoted to needs_review. The
    // old logic demoted every such source, leaving only 1 of 51 selected and the agent looping on
    // duplicate searches until it hung.
    const today = new Date().toISOString().slice(0, 10)
    const question = 'Обзорные статьи по reasoning в LLM'
    const key = semanticQueryKey(question, [])
    writeCorpus([
      mk('y1', 'A Survey of Inductive Reasoning for Large Language Models', { arxivId: 'y1', date: undefined, year: YEAR, semanticRelevanceScore: 95, semanticOnTopic: true, semanticQueryKey: key }),
      mk('y2', 'Toward large reasoning models: A survey of reinforced reasoning', { arxivId: 'y2', date: undefined, year: YEAR, semanticRelevanceScore: 90, semanticOnTopic: true, semanticQueryKey: key }),
    ])
    screenCorpus(ws, {
      question,
      researchKind: 'academic',
      strictDateRange: true, fromDate: `${YEAR}-01-01`, toDate: today, yearFrom: YEAR, yearTo: YEAR,
      minSelected: 2,
    }, OUT)
    const corpus = loadCorpus(ws, OUT)
    for (const id of ['y1', 'y2']) {
      const e = corpus.find((c) => c.id === id)!
      expect(e.screeningReason ?? '').not.toMatch(/No day-precise date/)
      expect(e.screeningStatus).toBe('selected')
    }
  })

  it('still enforces DAY precision for a genuine sub-year window that ends BEFORE today (e.g. Q1 of a past year)', () => {
    // Contrast with the "to present" case: a window whose upper edge is a past mid-year cutoff
    // (Jan-1 .. Mar-31 of LAST year) genuinely cannot confirm a year-only source, so demotion must
    // still apply. Using last year keeps the upper edge unambiguously < today whenever tests run.
    const LY = YEAR - 1
    writeCorpus([
      mk('u1', 'A Survey of Inductive Reasoning for Large Language Models', { arxivId: 'u1', date: undefined, year: LY }),
    ])
    screenCorpus(ws, {
      question: 'Обзорные статьи по reasoning в LLM',
      researchKind: 'academic',
      strictDateRange: true, fromDate: `${LY}-01-01`, toDate: `${LY}-03-31`, yearFrom: LY, yearTo: LY,
    }, OUT)
    const e = loadCorpus(ws, OUT).find((c) => c.id === 'u1')!
    expect(e.screeningReason ?? '').toMatch(/No day-precise date/)
    expect(e.screeningStatus).toBe('needs_review')
  })

  it('prefers open arXiv/OpenAlex over a closed, undated publisher landing page for academic runs', () => {
    writeCorpus([
      mk('open1', 'Reinforcement learning for robotics control policy and value methods'),
      mk('closed1', 'Reinforcement learning for robotics control policy and value methods', { arxivId: undefined, url: 'https://www.sciencedirect.com/science/article/pii/x' }),
    ])
    screenCorpus(ws, { question: 'reinforcement learning robotics', researchKind: 'academic' }, OUT)
    const open1 = loadCorpus(ws, OUT).find((c) => c.id === 'open1')!
    const closed1 = loadCorpus(ws, OUT).find((c) => c.id === 'closed1')!
    expect(open1.score).toBeGreaterThan(closed1.score)
  })

  it('assigns cross-language sub-topics: quantum survey → quantum Q, broad survey → general Q', () => {
    // Plan phrased in Russian, sources in English. The old token-overlap matcher tagged
    // neither (sub=[]) so those plan items stayed uncovered. Now: quantum → its own Q,
    // and a broad RL survey with no specific match falls back to the "general" Q.
    writeCorpus([
      mk('qz', 'Quantum Reinforcement Learning: Recent Advances and Future Directions', { arxivId: 'qz' }),
      mk('gen', 'A Survey on Model-Based Reinforcement Learning', { arxivId: 'gen' }),
    ])
    screenCorpus(ws, {
      question: 'Обзорные статьи по Reinforcement Learning за 2024–2026',
      subQuestions: [
        'Обзорные статьи по общим направлениям RL (general RL surveys)',
        'Обзорные статьи по RL для LLM и alignment (RLHF, DPO)',
        'Обзорные статьи по квантовому RL и hybrid quantum-classical RL',
      ],
      researchKind: 'academic',
    }, OUT)
    const c = loadCorpus(ws, OUT)
    expect(c.find((e) => e.id === 'qz')?.subQuestions).toContain('Q3')
    expect(c.find((e) => e.id === 'gen')?.subQuestions).toContain('Q1')
  })

  it('guarantees a sparse sub-topic its slot instead of letting popular topics take the whole cap', () => {
    // 4 popular RLHF/multi-agent surveys + 1 quantum survey, cap = 3. A pure top-3-by-score
    // cutoff would drop the quantum survey; balanced selection must still keep it.
    writeCorpus([
      mk('a1', 'Reinforcement Learning from Human Feedback for LLM alignment: A Survey', { arxivId: 'a1' }),
      mk('a2', 'A Survey of RLHF and DPO preference optimization for large language models', { arxivId: 'a2' }),
      mk('a3', 'Multi-Agent Reinforcement Learning: A Comprehensive Survey', { arxivId: 'a3' }),
      mk('a4', 'Cooperative Multi-Agent Reinforcement Learning: A Review', { arxivId: 'a4' }),
      mk('qz', 'Quantum Reinforcement Learning: A Survey of Recent Advances', { arxivId: 'qz' }),
    ])
    screenCorpus(ws, {
      question: 'Обзорные статьи по Reinforcement Learning',
      subQuestions: [
        'Обзорные статьи по RL для LLM и alignment (RLHF, DPO)',
        'Обзорные статьи по multi-agent RL и cooperative systems',
        'Обзорные статьи по квантовому RL и hybrid quantum-classical RL',
      ],
      researchKind: 'academic',
      maxSelected: 3,
    }, OUT)
    const qz = loadCorpus(ws, OUT).find((e) => e.id === 'qz')!
    expect(qz.subQuestions).toContain('Q3')
    expect(qz.screeningStatus).toBe('selected')
  })

  it('keeps strong on-topic surveys even when max_selected is set too low (model guessed a small cap)', () => {
    writeCorpus([
      mk('s1', 'A Survey of Reinforcement Learning for Robotics', { arxivId: 's1' }),
      mk('s2', 'Multi-Agent Reinforcement Learning: A Comprehensive Survey', { arxivId: 's2' }),
      mk('s3', 'A Survey of Quantum Reinforcement Learning', { arxivId: 's3' }),
      mk('s4', 'Reinforcement Learning for LLM alignment: A Survey', { arxivId: 's4' }),
      mk('s5', 'Model-Based Reinforcement Learning: A Survey', { arxivId: 's5' }),
    ])
    screenCorpus(ws, {
      question: 'Обзорные статьи по Reinforcement Learning',
      subQuestions: [
        'Обзорные статьи по RL в robotics',
        'Обзорные статьи по multi-agent RL',
        'Обзорные статьи по квантовому RL (quantum RL)',
        'Обзорные статьи по RL для LLM alignment',
        'Обзорные статьи по model-based RL',
      ],
      researchKind: 'academic',
      maxSelected: 2,
    }, OUT)
    const sel = loadCorpus(ws, OUT).filter((e) => e.screeningStatus === 'selected')
    expect(sel.length).toBeGreaterThanOrEqual(5)
  })

  it('selects LLM-judged high-semantic surveys beyond a low cap even when they are closed-publisher/DOI (not "strong survey")', () => {
    // Reproduces run 2026-07-23_19-40-54: excellent reasoning surveys scored 85–95 by the LLM sat
    // stranded in needs_review because they are closed-publisher/DOI hits (isStrongSurvey excludes
    // them as likely-unreadable), and max_selected=2 kept the cap tiny. The agent then over-searched
    // (61 searches) and never converged. High semantic relevance must promote them past the cap.
    const question = 'Обзорные статьи по reasoning в больших языковых моделях (LLM)'
    const key = semanticQueryKey(question, [])
    const closed = (id: string, title: string, sem: number) => ({
      ...raw(id, title),
      arxivId: undefined,
      openAccessUrl: undefined,
      doi: `10.1000/${id}`,
      url: `https://link.springer.com/article/${id}`,
      semanticRelevanceScore: sem,
      semanticOnTopic: true,
      semanticQueryKey: key,
    })
    writeCorpus([
      closed('h1', 'A Survey of Inductive Reasoning for Large Language Models', 95),
      closed('h2', 'A Survey on Chain-of-Thought Reasoning Evaluation in LLMs', 92),
      closed('h3', 'Toward large reasoning models: A survey of reinforced reasoning', 90),
      closed('h4', 'A survey of long chain-of-thought for reasoning large language models', 85),
      closed('h5', 'A Survey on LLM Symbolic Reasoning', 80),
    ])
    screenCorpus(ws, { question, researchKind: 'academic', maxSelected: 2 }, OUT)
    const sel = loadCorpus(ws, OUT).filter((e) => e.screeningStatus === 'selected')
    // All five high-semantic surveys should be selected despite max_selected=2.
    expect(sel.length).toBeGreaterThanOrEqual(5)
  })

  it('ranks non-scholarly web pages below a real scholarly review in academic runs (soft preference, never excludes)', () => {
    // Reproduces run 2026-07-28: a LinkedIn post and an "Ultimate Guide … 2026" blog scored 90+ by
    // the LLM (which rates TOPIC, not authority). We do NOT forcibly exclude them (the user controls
    // sources in the New Research dialog) — but in an academic run an equally-relevant arXiv survey
    // must rank ABOVE them so it wins selection slots first. General (web) runs apply no preference.
    const question = 'Reinforcement learning reasoning in large language models'
    const key = semanticQueryKey(question, [])
    const web = (id: string, title: string, url: string) => ({
      ...raw(id, title),
      arxivId: undefined,
      openAccessUrl: undefined,
      url,
      semanticRelevanceScore: 92,
      semanticOnTopic: true,
      semanticQueryKey: key,
    })
    const arxivPaper = {
      ...raw('a1', 'A Survey of Reinforcement Learning for Reasoning in Large Language Models'),
      semanticRelevanceScore: 90,
      semanticOnTopic: true,
      semanticQueryKey: key,
    }
    const entries = [
      arxivPaper,
      web('li', 'Reinforcement Learning for LLM Reasoning — my reading notes', 'https://www.linkedin.com/posts/someone_llm-reasoning'),
      web('sf', 'The Ultimate Guide to the Best Open Source Reasoning LLMs in 2026', 'https://siliconflow.com/blog/ultimate-guide-reasoning-llms'),
    ]

    // Academic: the arXiv survey outranks the blog/social pages, but nothing is rejected/excluded.
    writeCorpus(entries)
    screenCorpus(ws, { question, researchKind: 'academic' }, OUT)
    const acad = loadCorpus(ws, OUT)
    const arxivScore = acad.find((e) => e.id === 'a1')!.score
    for (const id of ['li', 'sf']) {
      const e = acad.find((c) => c.id === id)!
      expect(arxivScore).toBeGreaterThan(e.score)
      expect(e.screeningStatus).not.toBe('rejected')
    }

    // General (web): no academic source preference — the blog is not down-ranked for being a blog.
    writeCorpus(entries)
    screenCorpus(ws, { question, researchKind: 'general' }, OUT)
    const gen = loadCorpus(ws, OUT)
    expect(gen.find((e) => e.id === 'li')!.screeningStatus).not.toBe('rejected')
  })

  it('does not demand an RL+LLM intersection when only ONE sub-topic mentions LLM (broad-RL run)', () => {
    // Reproduces run 2026-07-19: main question is "RL surveys", but sub-topics include an
    // RLHF/LLM item. Intent must come from the MAIN question, so RL-only surveys (quantum,
    // robotics, multi-agent) stay on-topic instead of being rejected as "missing RL+LLM".
    writeCorpus([
      mk('q4', 'A survey of quantum reinforcement learning', { arxivId: 'q4', url: 'https://arxiv.org/abs/q4' }),
      mk('q5', 'Reinforcement learning for robotics and sim-to-real: a review', { arxivId: 'q5', url: 'https://arxiv.org/abs/q5' }),
      mk('q3', 'Multi-agent reinforcement learning survey', { arxivId: 'q3', url: 'https://arxiv.org/abs/q3' }),
    ])
    screenCorpus(ws, {
      question: 'Обзорные (survey/review) статьи по Reinforcement Learning (RL) за 2024–2026',
      subQuestions: [
        'Обзорные статьи по общим вопросам RL / Deep RL',
        'Обзорные статьи по RLHF и alignment LLM',
        'Обзорные статьи по Multi-Agent RL',
        'Обзорные статьи по квантовому RL',
        'Обзорные статьи по RL в робототехнике и sim-to-real',
      ],
      researchKind: 'academic',
      minSelected: 3,
    }, OUT)
    const corpus = loadCorpus(ws, OUT)
    for (const id of ['q4', 'q5', 'q3']) {
      const e = corpus.find((c) => c.id === id)!
      expect(e.screeningReason ?? '').not.toMatch(/RL\+LLM topical intersection/)
      expect(e.screeningStatus).toBe('selected')
    }
  })
})
