import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { embedTexts, isRunning as embedRunning } from './embed'
import { parseDocument, isDocumentExtension } from './document-parser'

const MEMORY_ROOT = path.join(os.homedir(), '.one-click-agent', 'memory')

export interface Chunk {
  id: string
  doc: string
  chunkIdx: number
  text: string
  tokens: string[]
  vector?: number[]
}

function workspaceKey(workspacePath: string): string {
  return workspacePath
    ? crypto.createHash('sha256').update(path.resolve(workspacePath).toLowerCase()).digest('hex').slice(0, 16)
    : '_global'
}

function indexDir(workspacePath: string): string {
  const dir = path.join(MEMORY_ROOT, workspaceKey(workspacePath))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function indexPath(workspacePath: string): string {
  return path.join(indexDir(workspacePath), 'index.jsonl')
}

function hashPath(workspacePath: string): string {
  return path.join(indexDir(workspacePath), 'index.hash')
}

// ---------------------------------------------------------------------------
// Tokenization & BM25
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'as', 'from', 'this', 'that', 'these', 'those', 'it', 'its',
  'they', 'them', 'their', 'we', 'us', 'our', 'you', 'your', 'i', 'my', 'me',
  'not', 'no', 'yes',
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 40 && !STOP_WORDS.has(t))
}

export function chunkText(text: string, chunkWords = 400, overlap = 50): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= chunkWords) return [text]
  const chunks: string[] = []
  const step = chunkWords - overlap
  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + chunkWords)
    if (slice.length === 0) break
    chunks.push(slice.join(' '))
    if (i + chunkWords >= words.length) break
  }
  return chunks
}

interface Bm25Stats {
  k1: number
  b: number
  avgdl: number
  n: number
  df: Map<string, number>
}

function computeBm25Stats(chunks: Chunk[], k1 = 1.2, b = 0.75): Bm25Stats {
  const df = new Map<string, number>()
  let totalTokens = 0
  for (const c of chunks) {
    totalTokens += c.tokens.length
    const uniq = new Set(c.tokens)
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1)
  }
  return {
    k1, b,
    avgdl: chunks.length ? totalTokens / chunks.length : 0,
    n: chunks.length,
    df,
  }
}

function bm25Score(queryTokens: string[], chunk: Chunk, stats: Bm25Stats): number {
  const tf = new Map<string, number>()
  for (const t of chunk.tokens) tf.set(t, (tf.get(t) || 0) + 1)
  const dl = chunk.tokens.length || 1
  let score = 0
  for (const q of new Set(queryTokens)) {
    const docFreq = stats.df.get(q) || 0
    if (docFreq === 0) continue
    const idf = Math.log(1 + (stats.n - docFreq + 0.5) / (docFreq + 0.5))
    const termFreq = tf.get(q) || 0
    if (termFreq === 0) continue
    const numerator = termFreq * (stats.k1 + 1)
    const denominator = termFreq + stats.k1 * (1 - stats.b + stats.b * (dl / (stats.avgdl || 1)))
    score += idf * (numerator / denominator)
  }
  return score
}

function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

// ---------------------------------------------------------------------------
// Index persistence
// ---------------------------------------------------------------------------

export function loadIndex(workspacePath: string): Chunk[] {
  const p = indexPath(workspacePath)
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Chunk)
  } catch { return [] }
}

export function saveIndex(workspacePath: string, chunks: Chunk[]): void {
  const p = indexPath(workspacePath)
  const out = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n'
  fs.writeFileSync(p, out, 'utf-8')
}

export function appendChunks(workspacePath: string, newChunks: Chunk[]): void {
  if (newChunks.length === 0) return
  const p = indexPath(workspacePath)
  const out = newChunks.map((c) => JSON.stringify(c)).join('\n') + '\n'
  fs.appendFileSync(p, out, 'utf-8')
}

// ---------------------------------------------------------------------------
// Indexing operations
// ---------------------------------------------------------------------------

async function maybeEmbed(texts: string[]): Promise<number[][] | null> {
  if (!embedRunning()) return null
  try { return await embedTexts(texts) } catch { return null }
}

export async function indexText(workspacePath: string, docId: string, text: string): Promise<number> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return 0
  const vectors = await maybeEmbed(chunks)
  const records: Chunk[] = chunks.map((txt, idx) => ({
    id: `${docId}#${idx}`,
    doc: docId,
    chunkIdx: idx,
    text: txt,
    tokens: tokenize(txt),
    vector: vectors ? vectors[idx] : undefined,
  }))
  appendChunks(workspacePath, records)
  return records.length
}

export async function indexFile(workspacePath: string, filePath: string): Promise<number> {
  if (!fs.existsSync(filePath)) return 0
  const ext = path.extname(filePath).toLowerCase()
  let text = ''
  try {
    if (isDocumentExtension(ext)) {
      const parsed = parseDocument(filePath)
      text = parsed.text
    } else {
      text = fs.readFileSync(filePath, 'utf-8')
    }
  } catch { return 0 }
  if (!text.trim()) return 0
  const docId = path.relative(workspacePath, filePath) || filePath
  return indexText(workspacePath, docId, text)
}

async function collectResearchFiles(workspacePath: string): Promise<string[]> {
  const research = path.join(workspacePath, '.research')
  if (!fs.existsSync(research)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else {
        const ext = path.extname(e.name).toLowerCase()
        if (['.md', '.txt', '.pdf', '.docx', '.html', '.htm'].includes(ext)) out.push(full)
      }
    }
  }
  walk(research)
  return out
}

export async function rebuildIndex(workspacePath: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const files = await collectResearchFiles(workspacePath)
  const findings = loadFindingsAsText(workspacePath)
  const totalUnits = files.length + (findings ? 1 : 0)
  const all: Chunk[] = []
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    const docId = path.relative(workspacePath, filePath) || filePath
    const ext = path.extname(filePath).toLowerCase()
    let text = ''
    try {
      if (isDocumentExtension(ext)) text = parseDocument(filePath).text
      else text = fs.readFileSync(filePath, 'utf-8')
    } catch {}
    if (!text.trim()) continue
    const chunks = chunkText(text)
    const vectors = await maybeEmbed(chunks)
    for (let j = 0; j < chunks.length; j++) {
      all.push({
        id: `${docId}#${j}`,
        doc: docId,
        chunkIdx: j,
        text: chunks[j],
        tokens: tokenize(chunks[j]),
        vector: vectors ? vectors[j] : undefined,
      })
    }
    if (onProgress) onProgress(i + 1, totalUnits)
  }
  if (findings) {
    const chunks = chunkText(findings)
    const vectors = await maybeEmbed(chunks)
    for (let j = 0; j < chunks.length; j++) {
      all.push({
        id: `findings#${j}`,
        doc: 'findings',
        chunkIdx: j,
        text: chunks[j],
        tokens: tokenize(chunks[j]),
        vector: vectors ? vectors[j] : undefined,
      })
    }
    if (onProgress) onProgress(totalUnits, totalUnits)
  }
  saveIndex(workspacePath, all)
  try { fs.writeFileSync(hashPath(workspacePath), String(Date.now()), 'utf-8') } catch {}
  return all.length
}

function loadFindingsAsText(workspacePath: string): string {
  const p = path.join(MEMORY_ROOT, workspaceKey(workspacePath), 'research-log.jsonl')
  if (!fs.existsSync(p)) return ''
  try {
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    const parts: string[] = []
    for (const line of lines) {
      try {
        const f = JSON.parse(line)
        parts.push(`# ${f.topic}\n${f.content}\nTags: ${(f.tags || []).join(', ')}\n`)
      } catch {}
    }
    return parts.join('\n\n')
  } catch { return '' }
}

// ---------------------------------------------------------------------------
// Search (hybrid BM25 + vector, Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

export interface SearchResult {
  chunk: Chunk
  score: number
  bm25Rank?: number
  vectorRank?: number
}

export async function searchHybrid(
  workspacePath: string,
  query: string,
  k = 10,
): Promise<SearchResult[]> {
  const chunks = loadIndex(workspacePath)
  if (chunks.length === 0) return []
  const queryTokens = tokenize(query)

  // BM25 ranking
  const stats = computeBm25Stats(chunks)
  const bm25Scored = chunks
    .map((c) => ({ chunk: c, score: bm25Score(queryTokens, c, stats) }))
    .sort((a, b) => b.score - a.score)
  const bm25Top = bm25Scored.filter((x) => x.score > 0).slice(0, k * 3)

  // Vector ranking
  let vectorTop: { chunk: Chunk; score: number }[] = []
  if (embedRunning()) {
    try {
      const [qVec] = await embedTexts([query])
      if (qVec) {
        vectorTop = chunks
          .filter((c) => c.vector)
          .map((c) => ({ chunk: c, score: cosineSim(qVec, c.vector!) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k * 3)
      }
    } catch {}
  }

  // Reciprocal Rank Fusion
  const rrfK = 60
  const scoreMap = new Map<string, { chunk: Chunk; score: number; bm25Rank?: number; vectorRank?: number }>()
  bm25Top.forEach((entry, rank) => {
    const rec = scoreMap.get(entry.chunk.id) || { chunk: entry.chunk, score: 0 }
    rec.score += 1 / (rrfK + rank)
    rec.bm25Rank = rank + 1
    scoreMap.set(entry.chunk.id, rec)
  })
  vectorTop.forEach((entry, rank) => {
    const rec = scoreMap.get(entry.chunk.id) || { chunk: entry.chunk, score: 0 }
    rec.score += 1 / (rrfK + rank)
    rec.vectorRank = rank + 1
    scoreMap.set(entry.chunk.id, rec)
  })
  const merged = [...scoreMap.values()].sort((a, b) => b.score - a.score).slice(0, k)
  return merged
}

export function indexStats(workspacePath: string): { chunks: number; docs: number; hasVectors: boolean } {
  const chunks = loadIndex(workspacePath)
  const docs = new Set(chunks.map((c) => c.doc))
  return {
    chunks: chunks.length,
    docs: docs.size,
    hasVectors: chunks.some((c) => !!c.vector),
  }
}
