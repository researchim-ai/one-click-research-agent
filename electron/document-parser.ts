import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface ParsedDocument {
  text: string
  pages?: number
  metadata?: Record<string, any>
  extension: string
}

const PARSER_SUPPORTED = new Set(['.pdf', '.docx', '.doc'])

export function isDocumentExtension(ext: string): boolean {
  return PARSER_SUPPORTED.has(ext.toLowerCase())
}

function runSubprocess(source: string, args: string[], timeoutMs = 90000): string {
  return execFileSync(process.execPath, ['-e', source, ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 60,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
}

/** Parse PDF via `unpdf` in a child Node process (handles ESM-only packages). */
function parsePdf(filePath: string, maxPages?: number): ParsedDocument {
  const script = `
(async () => {
  const unpdf = await import('unpdf')
  const buf = require('fs').readFileSync(process.argv[1])
  const max = Number(process.argv[2] || '0')
  const doc = await unpdf.getDocumentProxy(new Uint8Array(buf))
  const meta = await unpdf.getMeta(doc).catch(() => ({}))
  let result
  if (max > 0) {
    const { totalPages, text } = await unpdf.extractText(doc, { mergePages: false })
    const sliced = (Array.isArray(text) ? text : [text]).slice(0, max)
    result = { totalPages, text: sliced.join('\\n\\n'), metadata: meta }
  } else {
    const { totalPages, text } = await unpdf.extractText(doc, { mergePages: true })
    result = { totalPages, text: typeof text === 'string' ? text : (text || []).join('\\n\\n'), metadata: meta }
  }
  process.stdout.write(JSON.stringify(result))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  const out = runSubprocess(script, [filePath, String(maxPages ?? 0)])
  const parsed = JSON.parse(out)
  return {
    text: String(parsed.text || '').trim(),
    pages: Number(parsed.totalPages) || undefined,
    metadata: parsed.metadata || {},
    extension: '.pdf',
  }
}

function parseDocx(filePath: string): ParsedDocument {
  const script = `
(async () => {
  const mammoth = require('mammoth')
  const res = await mammoth.extractRawText({ path: process.argv[1] })
  process.stdout.write(JSON.stringify({ text: res.value, messages: res.messages }))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  const out = runSubprocess(script, [filePath])
  const parsed = JSON.parse(out)
  return {
    text: String(parsed.text || '').trim(),
    metadata: { warnings: parsed.messages || [] },
    extension: path.extname(filePath).toLowerCase(),
  }
}

/**
 * Parse a document file (PDF / DOCX) into plain text.
 * For plain-text/markdown files this should not be called — readFile handles them.
 */
export function parseDocument(filePath: string, maxPages?: number): ParsedDocument {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') return parsePdf(filePath, maxPages)
  if (ext === '.docx' || ext === '.doc') return parseDocx(filePath)
  throw new Error(`Unsupported document extension: ${ext}`)
}

export function summarizeParsedForPrompt(result: ParsedDocument, maxChars = 20000): string {
  const header: string[] = []
  if (result.pages) header.push(`Pages: ${result.pages}`)
  const md = result.metadata?.info || result.metadata || {}
  if (md?.Title) header.push(`Title: ${md.Title}`)
  if (md?.Author) header.push(`Author: ${md.Author}`)
  if (md?.CreationDate) header.push(`Created: ${md.CreationDate}`)
  const head = header.length ? header.join(' | ') + '\n\n' : ''
  const text = result.text
  if (text.length <= maxChars) return head + text
  return head + text.slice(0, maxChars) + `\n… [truncated, total ${text.length} chars]`
}
