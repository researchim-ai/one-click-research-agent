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

// mammoth (CJS) is required in-process so the bundler externalizes it and it resolves from the
// packaged node_modules (Electron's require reads app.asar). A spawned `node -e` subprocess runs
// as plain Node WITHOUT asar support, which is why the previous subprocess approach threw
// "Cannot find module 'mammoth'/'unpdf'" in packaged AppImage/deb builds. unpdf is ESM-only and
// is loaded via dynamic import() below (and asarUnpack'd so the ESM file loads from disk).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth') as any

/** Parse PDF via `unpdf` in-process (ESM-only package loaded through dynamic import). */
async function parsePdf(filePath: string, maxPages?: number): Promise<ParsedDocument> {
  const unpdf: any = await import('unpdf')
  const buf = fs.readFileSync(filePath)
  const doc = await unpdf.getDocumentProxy(new Uint8Array(buf))
  const meta = await unpdf.getMeta(doc).catch(() => ({}))
  const max = Number(maxPages ?? 0)
  let totalPages: number
  let text: string
  if (max > 0) {
    const res = await unpdf.extractText(doc, { mergePages: false })
    totalPages = res.totalPages
    const arr = Array.isArray(res.text) ? res.text : [res.text]
    text = arr.slice(0, max).join('\n\n')
  } else {
    const res = await unpdf.extractText(doc, { mergePages: true })
    totalPages = res.totalPages
    text = typeof res.text === 'string' ? res.text : (res.text || []).join('\n\n')
  }
  return {
    text: String(text || '').trim(),
    pages: Number(totalPages) || undefined,
    metadata: meta || {},
    extension: '.pdf',
  }
}

async function parseDocx(filePath: string): Promise<ParsedDocument> {
  const res = await mammoth.extractRawText({ path: filePath })
  return {
    text: String(res.value || '').trim(),
    metadata: { warnings: res.messages || [] },
    extension: path.extname(filePath).toLowerCase(),
  }
}

/**
 * Parse a document file (PDF / DOCX) into plain text.
 * For plain-text/markdown files this should not be called — readFile handles them.
 */
export async function parseDocument(filePath: string, maxPages?: number): Promise<ParsedDocument> {
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
