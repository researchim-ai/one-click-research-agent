import { execFileSync } from 'child_process'

// These libraries are imported at module scope so the Vite/Rollup electron bundler INLINES
// them into the bundled main/worker output. Packaged builds ship no node_modules on disk, so
// they can only be reached in-process from the bundle — a spawned `node -e` subprocess cannot
// require them (that produced "Cannot find module 'jsdom'" for every HTML read in the AppImage).
// require() (not import) keeps this working without @types for jsdom/turndown.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as { JSDOM: any }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Readability, isProbablyReaderable } = require('@mozilla/readability') as { Readability: any; isProbablyReaderable: (doc: any) => boolean }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TurndownService = require('turndown') as any

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

// Network fetch ONLY. This runs in a spawned `node -e` process for timeout/crash isolation and
// uses just the global `fetch` + built-ins — NO external module require — so it works in packaged
// builds where node_modules are not on disk. Readability/jsdom/turndown parsing happens in-process
// afterwards (see fetchUrl) against the bundled libraries.
const FETCH_HTML_SCRIPT = `
const url = process.argv[1]
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
    let html = await res.text()
    // Cap so JSON.stringify stays under the parent's maxBuffer; full articles fit comfortably.
    if (html.length > 8000000) html = html.slice(0, 8000000)
    process.stdout.write(JSON.stringify({ finalUrl, contentType, html }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }))
  } finally { clearTimeout(timer) }
})()
`

// Parse fetched HTML into a readable page in-process using the bundled Readability/jsdom/turndown.
function htmlToPage(html: string, finalUrl: string, contentType: string, format: 'markdown' | 'text' | 'html', originalUrl: string): FetchedPage {
  const dom = new JSDOM(html, { url: finalUrl })
  const doc = dom.window.document
  const readable = isProbablyReaderable(doc)
  let article: any = null
  try { article = new Readability(doc).parse() } catch {}
  const body = doc.body
  let content: string
  if (format === 'html') {
    content = article?.content || body?.innerHTML || ''
  } else if (format === 'text') {
    content = article?.textContent || body?.textContent || ''
  } else {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    content = td.turndown(article?.content || body?.innerHTML || '')
  }
  return {
    url: originalUrl,
    finalUrl,
    title: String(article?.title || doc.title || ''),
    byline: article?.byline || undefined,
    excerpt: article?.excerpt || undefined,
    publishedTime: article?.publishedTime || undefined,
    siteName: article?.siteName || undefined,
    content: String(content || ''),
    contentType,
    length: (content || '').length,
    format,
  }
}

export function fetchUrl(url: string, format: 'markdown' | 'text' | 'html' = 'markdown'): FetchedPage | { error: string; contentTypeHint?: string; finalUrl?: string; contentType?: string; isBinary?: boolean } {
  const out = runScript(FETCH_HTML_SCRIPT, [url])
  let parsed: any
  try { parsed = JSON.parse(out) } catch (e: any) { return { error: 'fetch_url: failed to parse fetch output' } }
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
  try {
    return htmlToPage(String(parsed.html || ''), String(parsed.finalUrl || url), String(parsed.contentType || ''), format, url)
  } catch (e: any) {
    return { error: `fetch_url: HTML parse failed — ${String(e?.message || e)}`, finalUrl: parsed.finalUrl, contentType: parsed.contentType }
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
