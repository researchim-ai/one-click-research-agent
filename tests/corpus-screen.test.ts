import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool } from '../electron/tools'
import { loadCorpus } from '../electron/corpus'

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
