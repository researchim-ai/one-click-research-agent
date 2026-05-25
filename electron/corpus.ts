import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { Source } from './sources'

export interface CorpusEntry {
  id: string
  title: string
  url: string
  doi?: string
  arxivId?: string
  pmid?: string
  authors?: string
  year?: number
  date?: string
  sourceTool?: string
  snippet?: string
  tier: 'primary' | 'secondary' | 'background'
  status: 'candidate' | 'queued_full_text' | 'read' | 'rejected'
  score: number
  tags: string[]
  localPath?: string
  addedAt: number
  updatedAt: number
}

export interface CorpusStats {
  total: number
  primary: number
  queuedFullText: number
  read: number
  withDoi: number
  withArxiv: number
}

function researchDir(workspace: string): string {
  return path.join(workspace, '.research')
}

export function corpusPath(workspace: string): string {
  return path.join(researchDir(workspace), 'corpus.jsonl')
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').trim().replace(/\s+/g, ' ')
}

function slugHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 10)
}

export function extractDoi(text: string): string | undefined {
  const doi = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]
  return doi ? doi.replace(/[.,;)\]]+$/, '') : undefined
}

export function extractArxivId(text: string): string | undefined {
  const arxiv = text.match(/\b(?:arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)\b/i)?.[1]
  if (arxiv) return arxiv
  const url = text.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?\s#]+)/i)?.[1]
  return url?.replace(/\.pdf$/i, '')
}

export function extractPmid(text: string): string | undefined {
  return text.match(/\bPMID[:\s]+(\d{5,12})\b/i)?.[1] ?? text.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)?.[1]
}

function keyFor(entry: Pick<CorpusEntry, 'doi' | 'arxivId' | 'pmid' | 'url' | 'title'>): string {
  if (entry.doi) return `doi:${entry.doi.toLowerCase()}`
  if (entry.arxivId) return `arxiv:${entry.arxivId.toLowerCase().replace(/v\d+$/, '')}`
  if (entry.pmid) return `pmid:${entry.pmid}`
  if (entry.url) return `url:${entry.url.toLowerCase().replace(/\/$/, '')}`
  return `title:${normalizeTitle(entry.title)}`
}

export function loadCorpus(workspace: string): CorpusEntry[] {
  const p = corpusPath(workspace)
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CorpusEntry)
  } catch { return [] }
}

export function saveCorpus(workspace: string, entries: CorpusEntry[]): void {
  const p = corpusPath(workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const sorted = [...entries].sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
  fs.writeFileSync(p, sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length ? '\n' : ''), 'utf-8')
}

function scoreEntry(entry: CorpusEntry): number {
  let score = 10
  if (entry.doi) score += 15
  if (entry.arxivId) score += 12
  if (entry.pmid) score += 12
  if (entry.url.includes('arxiv.org') || entry.url.includes('doi.org') || entry.url.includes('pubmed')) score += 8
  if (entry.snippet && entry.snippet.length > 80) score += 5
  if (entry.year && entry.year >= new Date().getFullYear() - 1) score += 6
  if (entry.tier === 'primary') score += 10
  return score
}

export function sourceToCorpusEntry(source: Source | Omit<Source, 'idx'>, tags: string[] = []): CorpusEntry {
  const now = Date.now()
  const text = `${source.title}\n${source.url}\n${source.snippet ?? ''}`
  const doi = extractDoi(text)
  const arxivId = extractArxivId(text)
  const pmid = extractPmid(text)
  const year = Number(String(source.date ?? '').match(/\b(19|20)\d{2}\b/)?.[0]) || undefined
  const tier: CorpusEntry['tier'] = source.sourceTool?.includes('web') ? 'secondary' : 'primary'
  const id = slugHash(keyFor({ title: source.title, url: source.url, doi, arxivId, pmid }))
  const entry: CorpusEntry = {
    id,
    title: source.title,
    url: source.url,
    doi,
    arxivId,
    pmid,
    authors: source.authors,
    year,
    date: source.date,
    sourceTool: source.sourceTool,
    snippet: source.snippet,
    tier,
    status: 'candidate',
    score: 0,
    tags,
    addedAt: now,
    updatedAt: now,
  }
  entry.score = scoreEntry(entry)
  return entry
}

export function mergeCorpusEntries(existing: CorpusEntry[], incoming: CorpusEntry[]): { entries: CorpusEntry[]; added: number; updated: number } {
  const byKey = new Map<string, CorpusEntry>()
  for (const e of existing) byKey.set(keyFor(e), e)
  let added = 0
  let updated = 0
  for (const next of incoming) {
    const k = keyFor(next)
    const prev = byKey.get(k)
    if (!prev) {
      byKey.set(k, next)
      added++
    } else {
      byKey.set(k, {
        ...prev,
        ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')),
        id: prev.id,
        tags: [...new Set([...(prev.tags || []), ...(next.tags || [])])],
        status: prev.status === 'read' ? 'read' : next.status,
        score: Math.max(prev.score, next.score),
        addedAt: prev.addedAt,
        updatedAt: Date.now(),
      } as CorpusEntry)
      updated++
    }
  }
  return { entries: [...byKey.values()], added, updated }
}

export function addSourcesToCorpus(workspace: string, sources: Array<Source | Omit<Source, 'idx'>>, tags: string[] = []): { entries: CorpusEntry[]; added: number; updated: number } {
  const existing = loadCorpus(workspace)
  const incoming = sources.filter((s) => s.title && s.url).map((s) => sourceToCorpusEntry(s, tags))
  const merged = mergeCorpusEntries(existing, incoming)
  saveCorpus(workspace, merged.entries)
  return merged
}

export function corpusStats(workspace: string): CorpusStats {
  const entries = loadCorpus(workspace)
  return {
    total: entries.length,
    primary: entries.filter((e) => e.tier === 'primary').length,
    queuedFullText: entries.filter((e) => e.status === 'queued_full_text').length,
    read: entries.filter((e) => e.status === 'read').length,
    withDoi: entries.filter((e) => !!e.doi).length,
    withArxiv: entries.filter((e) => !!e.arxivId).length,
  }
}

export function listCorpus(workspace: string, max = 20): string {
  const entries = loadCorpus(workspace).slice(0, Math.max(1, Math.min(100, max)))
  if (entries.length === 0) return 'Corpus is empty. Use build_corpus or add_to_corpus after search.'
  const stats = corpusStats(workspace)
  const lines = [`Corpus: ${stats.total} items (${stats.primary} primary, ${stats.queuedFullText} queued full text, ${stats.read} read)\n`]
  entries.forEach((e, i) => {
    lines.push([
      `${i + 1}. ${e.title}`,
      `   ID: ${e.id} | score=${e.score} | ${e.tier} | ${e.status}`,
      e.year ? `   Year: ${e.year}` : null,
      e.doi ? `   DOI: ${e.doi}` : null,
      e.arxivId ? `   arXiv: ${e.arxivId}` : null,
      `   URL: ${e.url}`,
      e.snippet ? `   Snippet: ${e.snippet.slice(0, 220)}` : null,
    ].filter(Boolean).join('\n'))
  })
  return lines.join('\n\n')
}

export function queueFullText(workspace: string, ids?: string[]): string {
  const entries = loadCorpus(workspace)
  const wanted = new Set((ids || []).map(String))
  let changed = 0
  for (const e of entries) {
    if (wanted.size === 0 || wanted.has(e.id)) {
      if (e.status === 'candidate') {
        e.status = 'queued_full_text'
        e.updatedAt = Date.now()
        changed++
      }
    }
  }
  saveCorpus(workspace, entries)
  return `Queued ${changed} corpus item(s) for full-text reading.`
}

export function rankCorpus(workspace: string): string {
  const entries = loadCorpus(workspace).map((e) => ({ ...e, score: scoreEntry(e), updatedAt: Date.now() }))
  saveCorpus(workspace, entries)
  return listCorpus(workspace, 30)
}
