import { execFileSync } from 'child_process'

export interface FetchedPage {
  url: string
  finalUrl: string
  title: string
  byline?: string
  excerpt?: string
  publishedTime?: string
  siteName?: string
  content: string
  contentType: string
  length: number
  format: 'markdown' | 'text' | 'html'
}

function runScript(source: string, args: string[], timeoutMs = 30000): string {
  return execFileSync(process.execPath, ['-e', source, ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 30,
    env: { ...process.env, FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1' },
  })
}

const FETCH_SCRIPT = `
const url = process.argv[1]
const format = process.argv[2] || 'markdown'
;(async () => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; one-click-research-agent/0.1)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
    })
    const finalUrl = res.url || url
    const contentType = String(res.headers.get('content-type') || '')
    if (!res.ok) {
      process.stdout.write(JSON.stringify({ error: 'HTTP ' + res.status, finalUrl, contentType }))
      return
    }
    const ctLower = contentType.toLowerCase()
    if (ctLower.includes('application/pdf') || ctLower.includes('application/octet-stream')) {
      process.stdout.write(JSON.stringify({ finalUrl, contentType, isBinary: true, contentTypeHint: 'pdf' }))
      return
    }
    const html = await res.text()
    const { JSDOM } = require('jsdom')
    const { Readability, isProbablyReaderable } = require('@mozilla/readability')
    const dom = new JSDOM(html, { url: finalUrl })
    const readable = isProbablyReaderable(dom.window.document)
    let article = null
    try {
      const reader = new Readability(dom.window.document)
      article = reader.parse()
    } catch {}
    const title = article?.title || dom.window.document.title || ''
    const byline = article?.byline || ''
    const excerpt = article?.excerpt || ''
    const siteName = article?.siteName || ''
    const publishedTime = article?.publishedTime || ''
    let content
    if (format === 'html') {
      content = article?.content || dom.window.document.body.innerHTML || ''
    } else if (format === 'text') {
      content = article?.textContent || dom.window.document.body.textContent || ''
    } else {
      const TurndownService = require('turndown')
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      const innerHtml = article?.content || dom.window.document.body.innerHTML || ''
      content = td.turndown(innerHtml)
    }
    process.stdout.write(JSON.stringify({
      finalUrl, contentType, readable, title, byline, excerpt, siteName, publishedTime,
      content, length: (content || '').length,
    }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }))
  } finally { clearTimeout(timer) }
})()
`

export function fetchUrl(url: string, format: 'markdown' | 'text' | 'html' = 'markdown'): FetchedPage | { error: string; contentTypeHint?: string; finalUrl?: string; contentType?: string; isBinary?: boolean } {
  const out = runScript(FETCH_SCRIPT, [url, format])
  let parsed: any
  try { parsed = JSON.parse(out) } catch (e: any) { return { error: 'fetch_url: failed to parse worker output' } }
  if (parsed?.error && !parsed?.isBinary) return { error: parsed.error, finalUrl: parsed.finalUrl, contentType: parsed.contentType }
  if (parsed?.isBinary) {
    return {
      error: 'binary content',
      finalUrl: parsed.finalUrl,
      contentType: parsed.contentType,
      contentTypeHint: parsed.contentTypeHint,
      isBinary: true,
    }
  }
  return {
    url,
    finalUrl: String(parsed.finalUrl || url),
    title: String(parsed.title || ''),
    byline: parsed.byline || undefined,
    excerpt: parsed.excerpt || undefined,
    publishedTime: parsed.publishedTime || undefined,
    siteName: parsed.siteName || undefined,
    content: String(parsed.content || ''),
    contentType: String(parsed.contentType || ''),
    length: Number(parsed.length || (parsed.content || '').length || 0),
    format,
  }
}

export function classifyUrl(url: string): 'arxiv-abs' | 'arxiv-pdf' | 'pdf' | 'html' {
  const lower = url.toLowerCase()
  if (/arxiv\.org\/abs\//.test(lower)) return 'arxiv-abs'
  if (/arxiv\.org\/pdf\//.test(lower) || lower.endsWith('.pdf')) return 'arxiv-pdf'
  return 'html'
}

export function extractArxivId(url: string): string | null {
  const m = url.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+)/i)
  if (!m) return null
  return m[1].replace(/\.pdf$/i, '')
}
