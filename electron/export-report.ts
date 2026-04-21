import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { SourceTracker } from './sources'

/**
 * Minimal Markdown → HTML converter for PDF export.
 * Keeps it dependency-free; supports headings, bold/italic, code blocks, inline code, links, lists, blockquotes, paragraphs.
 */
function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let inList: 'ul' | 'ol' | null = null
  const flushList = () => { if (inList) { out.push(`</${inList}>`); inList = null } }
  const inlineFormat = (text: string): string => {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\[(\d+)\]/g, '<sup class="cit">[$1]</sup>')
  }

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) { out.push('</code></pre>'); inCode = false; codeLang = '' }
      else { flushList(); inCode = true; codeLang = raw.slice(3).trim(); out.push(`<pre><code class="lang-${codeLang}">`) }
      continue
    }
    if (inCode) { out.push(raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')); continue }

    const h = raw.match(/^(#{1,6})\s+(.+)$/)
    if (h) { flushList(); const level = h[1].length; out.push(`<h${level}>${inlineFormat(h[2])}</h${level}>`); continue }

    const olM = raw.match(/^\s*(\d+)\.\s+(.+)$/)
    if (olM) { if (inList !== 'ol') { flushList(); out.push('<ol>'); inList = 'ol' } out.push(`<li>${inlineFormat(olM[2])}</li>`); continue }
    const ulM = raw.match(/^\s*[-*+]\s+(.+)$/)
    if (ulM) { if (inList !== 'ul') { flushList(); out.push('<ul>'); inList = 'ul' } out.push(`<li>${inlineFormat(ulM[1])}</li>`); continue }

    if (raw.startsWith('> ')) { flushList(); out.push(`<blockquote>${inlineFormat(raw.slice(2))}</blockquote>`); continue }
    if (raw.trim() === '---' || raw.trim() === '***') { flushList(); out.push('<hr/>'); continue }
    if (raw.trim() === '') { flushList(); continue }
    flushList()
    out.push(`<p>${inlineFormat(raw)}</p>`)
  }
  if (inCode) out.push('</code></pre>')
  flushList()
  return out.join('\n')
}

function wrapHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${title.replace(/</g, '&lt;')}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; max-width: 780px; margin: 32px auto; padding: 0 24px; line-height: 1.55; }
  h1, h2, h3, h4 { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif; color: #0b1b3a; margin-top: 1.6em; }
  h1 { border-bottom: 2px solid #0b1b3a; padding-bottom: 6px; }
  h2 { border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  code, pre { font-family: 'SFMono-Regular', Menlo, Consolas, monospace; }
  pre { background: #f5f7fa; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.9em; }
  code { background: #eef2f7; padding: 1px 4px; border-radius: 4px; }
  blockquote { border-left: 4px solid #bbb; margin-left: 0; padding-left: 16px; color: #555; }
  a { color: #1155cc; text-decoration: none; }
  sup.cit { color: #9333ea; font-weight: 600; margin: 0 2px; }
  hr { border: none; border-top: 1px solid #ddd; margin: 28px 0; }
  ul, ol { padding-left: 1.4em; }
</style>
</head><body>
${body}
</body></html>`
}

export async function exportPdf(markdownContent: string, title: string, outPath: string): Promise<void> {
  const html = wrapHtml(title, markdownToHtml(markdownContent))
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: false },
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 1, bottom: 1, left: 0.8, right: 0.8 },
      pageSize: 'A4',
    })
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, buf)
  } finally {
    win.destroy()
  }
}

export async function exportDocx(markdownContent: string, title: string, outPath: string): Promise<void> {
  const docx = await import('docx')
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docx as any
  const paragraphs: any[] = []
  const addPara = (text: string, heading?: any) => {
    paragraphs.push(new Paragraph({
      heading,
      children: [new TextRun({ text })],
    }))
  }
  addPara(title, HeadingLevel.TITLE)
  const lines = markdownContent.split('\n')
  let inCode = false
  const codeBuf: string[] = []
  const flushCode = () => {
    if (codeBuf.length) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: codeBuf.join('\n'), font: 'Consolas' })] }))
      codeBuf.length = 0
    }
  }
  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false } else { inCode = true }
      continue
    }
    if (inCode) { codeBuf.push(raw); continue }
    const h = raw.match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
      addPara(h[2], levels[h[1].length - 1])
      continue
    }
    if (raw.trim() === '') { paragraphs.push(new Paragraph('')); continue }
    addPara(raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`([^`]+)`/g, '$1'))
  }
  flushCode()
  const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] })
  const buf = await Packer.toBuffer(doc)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, buf)
}

function sanitizeBibKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'ref'
}

export function exportBibTex(tracker: SourceTracker, outPath: string): number {
  const sources = tracker.getAll()
  if (sources.length === 0) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, '% No sources collected\n')
    return 0
  }
  const lines: string[] = []
  const used = new Set<string>()
  for (const s of sources) {
    const firstAuthor = (s.authors || '').split(',')[0].trim().split(/\s+/).pop() || 'anon'
    const year = s.date ? (s.date.match(/\d{4}/)?.[0] || '') : ''
    let baseKey = sanitizeBibKey(`${firstAuthor}${year}${sanitizeBibKey(s.title).slice(0, 10)}`)
    let key = baseKey
    let suffix = 1
    while (used.has(key)) { key = `${baseKey}${suffix++}` }
    used.add(key)

    const entryType = s.sourceTool.includes('arxiv') ? 'misc'
      : s.sourceTool.includes('openalex') || s.sourceTool.includes('crossref') || s.sourceTool.includes('semantic_scholar') || s.sourceTool.includes('pubmed') ? 'article'
      : 'online'
    const fields: string[] = []
    fields.push(`  title = {${s.title.replace(/[{}]/g, '')}}`)
    if (s.authors) fields.push(`  author = {${s.authors.replace(/[{}]/g, '')}}`)
    if (year) fields.push(`  year = {${year}}`)
    if (s.date) fields.push(`  date = {${s.date}}`)
    if (s.url) fields.push(`  url = {${s.url}}`)
    fields.push(`  note = {Retrieved via ${s.sourceTool}}`)
    lines.push(`@${entryType}{${key},\n${fields.join(',\n')}\n}`)
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, lines.join('\n\n') + '\n', 'utf-8')
  return sources.length
}
