import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { loadCorpus } from './corpus'
import { loadEvidence } from './evidence'

export interface IdeaCard {
  id: string
  title: string
  hypothesis: string
  rationale: string
  sources: string[]
  novelty: number
  feasibility: number
  impact: number
  nextSteps: string[]
  createdAt: number
}

function ideasPath(workspace: string): string {
  return path.join(workspace, '.research', 'ideas.jsonl')
}

function makeId(): string {
  return `I-${crypto.randomUUID().slice(0, 8)}`
}

export function loadIdeas(workspace: string): IdeaCard[] {
  const p = ideasPath(workspace)
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as IdeaCard)
  } catch { return [] }
}

export function saveIdea(workspace: string, idea: Omit<IdeaCard, 'id' | 'createdAt'>): string {
  const card: IdeaCard = { ...idea, id: makeId(), createdAt: Date.now() }
  const rows = loadIdeas(workspace)
  rows.push(card)
  const p = ideasPath(workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  return `Saved idea ${card.id}: ${card.title}`
}

export function scoutIdeas(workspace: string, topic: string, maxIdeas?: number): string {
  const q = String(topic ?? '').trim()
  if (!q) return 'Error: topic is required.'
  const limit = Math.max(1, Math.min(10, Number(maxIdeas) || 5))
  const corpus = loadCorpus(workspace).slice(0, 30)
  const evidence = loadEvidence(workspace).slice(0, 30)
  const themes = new Map<string, number>()
  for (const item of corpus) {
    for (const token of item.title.toLowerCase().split(/[^a-zа-я0-9]+/i).filter((t) => t.length > 5)) {
      themes.set(token, (themes.get(token) ?? 0) + 1)
    }
  }
  const topThemes = [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t)
  const gaps = evidence.filter((e) => e.status !== 'supported' || e.confidence === 'low' || e.confidence === 'speculative').slice(0, 5)
  const ideas: IdeaCard[] = []
  for (let i = 0; i < limit; i++) {
    const theme = topThemes[i % Math.max(1, topThemes.length)] || q
    const gap = gaps[i % Math.max(1, gaps.length)]
    ideas.push({
      id: makeId(),
      title: `${q}: investigate ${theme} gap`,
      hypothesis: gap ? `A weak/contested claim around "${gap.claim.slice(0, 100)}" may reveal a useful research direction.` : `A focused synthesis around "${theme}" may reveal underexplored methods or datasets.`,
      rationale: `Generated from ${corpus.length} corpus item(s), ${evidence.length} evidence claim(s), and profile topic "${q}".`,
      sources: corpus.slice(i, i + 3).map((c) => c.id),
      novelty: Math.max(50, 85 - i * 6),
      feasibility: Math.max(45, 80 - i * 4),
      impact: Math.max(50, 75 - i * 3),
      nextSteps: [
        `Run smart_search for "${q} ${theme} recent papers"`,
        'Build a small corpus and record claim-level evidence.',
        'Check code/data availability before proposing implementation.',
      ],
      createdAt: Date.now(),
    })
  }
  const p = ideasPath(workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, ideas.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  return formatIdeas(ideas)
}

export function prioritizeIdeas(workspace: string): string {
  const ideas = loadIdeas(workspace)
  if (ideas.length === 0) return 'No ideas saved yet. Use scout_ideas first.'
  const ranked = [...ideas].sort((a, b) => (b.novelty + b.feasibility + b.impact) - (a.novelty + a.feasibility + a.impact))
  return formatIdeas(ranked)
}

function formatIdeas(ideas: IdeaCard[]): string {
  if (ideas.length === 0) return 'No idea cards.'
  return ideas.map((idea, i) => [
    `${i + 1}. ${idea.title}`,
    `   ID: ${idea.id}`,
    `   Scores: novelty=${idea.novelty}, feasibility=${idea.feasibility}, impact=${idea.impact}`,
    `   Hypothesis: ${idea.hypothesis}`,
    `   Rationale: ${idea.rationale}`,
    `   Sources: ${idea.sources.join(', ') || 'none'}`,
    `   Next: ${idea.nextSteps.join(' | ')}`,
  ].join('\n')).join('\n\n')
}
