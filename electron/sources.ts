import type { UrlHealth } from './url-health'

export interface Source {
  idx: number
  title: string
  url: string
  authors?: string
  date?: string
  sourceTool: string
  snippet?: string
  health?: UrlHealth
}

/**
 * Per-session tracker that collects sources from search tool results.
 * Sources survive context compression and are injected into the system
 * prompt so the agent can reference them with [1], [2], etc.
 */
export class SourceTracker {
  private sources: Source[] = []
  private urlSet = new Set<string>()

  clear(): void {
    this.sources = []
    this.urlSet.clear()
  }

  add(src: Omit<Source, 'idx'>): number {
    const url = src.url.trim()
    if (!url) return -1
    if (this.urlSet.has(url)) {
      return this.sources.findIndex((s) => s.url === url)
    }
    const idx = this.sources.length + 1
    this.sources.push({ ...src, idx, url })
    this.urlSet.add(url)
    return idx
  }

  addMany(items: Omit<Source, 'idx'>[]): void {
    for (const item of items) this.add(item)
  }

  getAll(): Source[] {
    return this.sources
  }

  find(urlOrIdx: string | number): Source | undefined {
    if (typeof urlOrIdx === 'number') return this.sources.find((s) => s.idx === urlOrIdx)
    return this.sources.find((s) => s.url === urlOrIdx)
  }

  updateHealth(url: string, health: UrlHealth): void {
    const found = this.sources.find((s) => s.url === url)
    if (found) found.health = health
  }

  count(): number {
    return this.sources.length
  }

  formatForSystemPrompt(maxChars: number): string {
    if (this.sources.length === 0) return ''
    const lines: string[] = ['## Collected Sources\n']
    let total = lines[0].length
    for (const s of this.sources) {
      const healthTag = s.health?.status && s.health.status !== 'live' ? ` [${s.health.status.toUpperCase()}]` : ''
      const line = `[${s.idx}] ${s.title}${s.date ? ` (${s.date})` : ''}${healthTag} — ${s.url}`
      if (total + line.length + 1 > maxChars) {
        lines.push(`... and ${this.sources.length - lines.length + 1} more sources`)
        break
      }
      lines.push(line)
      total += line.length + 1
    }
    return lines.join('\n')
  }

  formatForReport(): string {
    if (this.sources.length === 0) return ''
    const lines = this.sources.map((s) => {
      const parts = [`[${s.idx}]`]
      if (s.authors) parts.push(s.authors + '.')
      parts.push(`"${s.title}."`)
      if (s.date) parts.push(`(${s.date}).`)
      parts.push(s.url)
      if (s.health?.archivedUrl) parts.push(`(archived: ${s.health.archivedUrl})`)
      return parts.join(' ')
    })
    return lines.join('\n')
  }

  /** Safe snapshot for sending over IPC. */
  exportForIpc(): Source[] {
    return this.sources.map((s) => ({ ...s }))
  }
}

const trackersBySession = new Map<string, SourceTracker>()

export function getSourceTracker(sessionId: string): SourceTracker {
  if (!trackersBySession.has(sessionId)) {
    trackersBySession.set(sessionId, new SourceTracker())
  }
  return trackersBySession.get(sessionId)!
}

export function clearSourceTracker(sessionId: string): void {
  trackersBySession.delete(sessionId)
}

// ---------------------------------------------------------------------------
// Parsing helpers: extract structured sources from search tool result strings
// ---------------------------------------------------------------------------

function splitBlocks(text: string): string[] {
  return text.split(/\n\n(?=\d+\.\s)/)
}

export function parseArxivResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const url = block.match(/Abstract:\s+(https:\/\/\S+)/)?.[1]?.trim()
    const authors = block.match(/Authors:\s+(.+)/)?.[1]?.trim()
    const date = block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const summary = block.match(/Summary:\s+(.+)/s)?.[1]?.trim()?.slice(0, 200)
    if (title && url) {
      items.push({ title, url, authors, date, sourceTool: 'search_arxiv', snippet: summary })
    }
  }
  return items
}

export function parseOpenAlexResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const doi = block.match(/DOI:\s+(https:\/\/\S+)/)?.[1]?.trim()
    const landing = block.match(/Landing Page:\s+(https:\/\/\S+)/)?.[1]?.trim()
    const url = doi || landing || block.match(/OpenAlex:\s+(https:\/\/\S+)/)?.[1]?.trim()
    const authors = block.match(/Authors:\s+(.+)/)?.[1]?.trim()
    const date = block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const abstract = block.match(/Abstract:\s+(.+)/s)?.[1]?.trim()?.slice(0, 200)
    if (title && url) {
      items.push({ title, url, authors, date, sourceTool: 'search_openalex', snippet: abstract })
    }
  }
  return items
}

export function parseHuggingFaceResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const hfUrl = block.match(/Hugging Face:\s+(https:\/\/\S+)/)?.[1]?.trim()
    const arxivUrl = block.match(/arXiv:\s+(https:\/\/\S+)/)?.[1]?.trim()
    const url = hfUrl || arxivUrl
    const authors = block.match(/Authors:\s+(.+)/)?.[1]?.trim()
    const date = block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const summary = block.match(/Summary:\s+(.+)/s)?.[1]?.trim()?.slice(0, 200)
    if (title && url) {
      items.push({ title, url, authors, date, sourceTool: 'search_huggingface_papers', snippet: summary })
    }
  }
  return items
}

export function parseWebResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const url = block.match(/URL:\s+(https?:\/\/\S+)/)?.[1]?.trim()
    const date = block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const snippet = block.match(/Snippet:\s+(.+)/s)?.[1]?.trim()?.slice(0, 200)
    if (title && url) {
      items.push({ title, url, date, sourceTool: 'search_web', snippet })
    }
  }
  return items
}

export function parseCrossrefResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const doi = block.match(/DOI:\s+(https?:\/\/\S+)/)?.[1]?.trim()
    const url = block.match(/URL:\s+(https?:\/\/\S+)/)?.[1]?.trim() || doi
    const authors = block.match(/Authors:\s+(.+)/)?.[1]?.trim()
    const date = block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const snippet = block.match(/Journal:\s+(.+)/)?.[1]?.trim()
    if (title && url) items.push({ title, url, authors, date, sourceTool: 'search_crossref', snippet })
  }
  return items
}

export function parseSemanticScholarResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const url = block.match(/URL:\s+(https?:\/\/\S+)/)?.[1]?.trim()
    const authors = block.match(/Authors:\s+(.+)/)?.[1]?.trim()
    const date = block.match(/Year:\s+(\d+)/)?.[1]?.trim() || block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const snippet = block.match(/Abstract:\s+(.+)/s)?.[1]?.trim()?.slice(0, 200)
    if (title && url) items.push({ title, url, authors, date, sourceTool: 'search_semantic_scholar', snippet })
  }
  return items
}

export function parsePubMedResults(text: string): Omit<Source, 'idx'>[] {
  const items: Omit<Source, 'idx'>[] = []
  for (const block of splitBlocks(text)) {
    const title = block.match(/^\d+\.\s+(.+)/m)?.[1]?.trim()
    const url = block.match(/URL:\s+(https?:\/\/\S+)/)?.[1]?.trim()
      || block.match(/DOI:\s+(https?:\/\/\S+)/)?.[1]?.trim()
    const authors = block.match(/Authors:\s+(.+)/)?.[1]?.trim()
    const date = block.match(/Published:\s+(.+)/)?.[1]?.trim()
    const snippet = block.match(/Abstract:\s+(.+)/s)?.[1]?.trim()?.slice(0, 200)
    if (title && url) items.push({ title, url, authors, date, sourceTool: 'search_pubmed', snippet })
  }
  return items
}

export function parseFetchUrlResult(text: string): Omit<Source, 'idx'>[] {
  const title = text.match(/^Title:\s+(.+)$/m)?.[1]?.trim()
  const url = text.match(/^URL:\s+(https?:\/\/\S+)$/m)?.[1]?.trim()
  const date = text.match(/^Published:\s+(.+)$/m)?.[1]?.trim()
  const byline = text.match(/^Byline:\s+(.+)$/m)?.[1]?.trim()
  if (title && url) {
    return [{ title, url, date, authors: byline, sourceTool: 'fetch_url' }]
  }
  return []
}

const PARSERS: Record<string, (text: string) => Omit<Source, 'idx'>[]> = {
  search_arxiv: parseArxivResults,
  search_openalex: parseOpenAlexResults,
  search_huggingface_papers: parseHuggingFaceResults,
  search_web: parseWebResults,
  search_crossref: parseCrossrefResults,
  search_semantic_scholar: parseSemanticScholarResults,
  search_pubmed: parsePubMedResults,
  fetch_url: parseFetchUrlResult,
  smart_search: (text: string) => {
    // smart_search aggregates sub-sections; parse all known headers
    const all: Omit<Source, 'idx'>[] = []
    all.push(...parseArxivResults(text))
    all.push(...parseOpenAlexResults(text))
    all.push(...parseHuggingFaceResults(text))
    all.push(...parseWebResults(text))
    all.push(...parseCrossrefResults(text))
    all.push(...parseSemanticScholarResults(text))
    all.push(...parsePubMedResults(text))
    return all
  },
}

export function extractSourcesFromToolResult(toolName: string, result: string): Omit<Source, 'idx'>[] {
  const parser = PARSERS[toolName]
  if (!parser) return []
  try { return parser(result) } catch { return [] }
}
