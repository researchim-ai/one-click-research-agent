import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { getSourceTracker } from './sources'
import { loadCorpus } from './corpus'
import { resolveResearchDir } from '../research-paths'

export interface EvidenceClaim {
  id: string
  topic?: string
  claim: string
  sourceIdxs: number[]
  corpusIds?: string[]
  sourceUrls?: string[]
  passageId?: string
  localPath?: string
  quoteStart?: number
  quoteEnd?: number
  planItemId?: string
  evidenceType?: 'primary_result' | 'survey_statement' | 'benchmark' | 'safety_claim' | 'background'
  quote?: string
  confidence: 'high' | 'medium' | 'low' | 'speculative'
  support: 'supports' | 'contradicts' | 'background' | 'weak'
  status: 'supported' | 'contested' | 'unsupported' | 'needs_review'
  notes?: string
  createdAt: number
}

function researchDir(workspace: string, outputDir?: string): string {
  return resolveResearchDir(workspace, outputDir)
}

function evidencePath(workspace: string, outputDir?: string): string {
  return path.join(researchDir(workspace, outputDir), 'evidence.jsonl')
}

function claimsPath(workspace: string, outputDir?: string): string {
  return path.join(researchDir(workspace, outputDir), 'claims.jsonl')
}

function makeId(): string {
  return `C-${crypto.randomUUID().slice(0, 8)}`
}

export function loadEvidence(workspace: string, outputDir?: string): EvidenceClaim[] {
  const p = evidencePath(workspace, outputDir)
  if (!fs.existsSync(p)) return []
  try {
    const rows: EvidenceClaim[] = []
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(normalizeEvidenceClaim(JSON.parse(line) as EvidenceClaim))
      } catch {
        // Keep the evidence store usable even if one JSONL row was truncated.
      }
    }
    return rows
  } catch { return [] }
}

function normalizeEvidenceClaim(row: EvidenceClaim): EvidenceClaim {
  const sourceIdxs = Array.isArray(row.sourceIdxs) ? row.sourceIdxs : []
  const corpusIds = Array.isArray(row.corpusIds) ? row.corpusIds : []
  const sourceUrls = Array.isArray(row.sourceUrls) ? row.sourceUrls : []
  const support = normalizeSupport(row.support)
  return {
    ...row,
    sourceIdxs,
    corpusIds,
    sourceUrls,
    support,
    confidence: normalizeConfidence(row.confidence),
    status: row.status === 'needs_review' && support !== 'weak'
      ? supportedStatus(support, sourceIdxs, corpusIds, sourceUrls)
      : row.status,
  }
}

export function saveEvidence(workspace: string, rows: EvidenceClaim[], outputDir?: string): void {
  const p = evidencePath(workspace, outputDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  try {
    fs.writeFileSync(claimsPath(workspace, outputDir), rows.map((row) => JSON.stringify({
      id: row.id,
      claim: row.claim,
      status: row.status,
      confidence: row.confidence,
      sources: row.sourceIdxs,
      corpusIds: row.corpusIds ?? [],
      planItemId: row.planItemId,
      evidenceType: row.evidenceType,
    })).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  } catch {}
}

function normalizeConfidence(value: string | undefined): EvidenceClaim['confidence'] {
  return ['high', 'medium', 'low', 'speculative'].includes(String(value)) ? value as EvidenceClaim['confidence'] : 'medium'
}

function normalizeSupport(value: string | undefined): EvidenceClaim['support'] {
  return ['supports', 'contradicts', 'background', 'weak'].includes(String(value)) ? value as EvidenceClaim['support'] : 'supports'
}

function normalizeClaimKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').trim().replace(/\s+/g, ' ').slice(0, 240)
}

function supportedStatus(support: EvidenceClaim['support'], sourceIdxs: number[], corpusIds: string[], sourceUrls: string[]): EvidenceClaim['status'] {
  if (support === 'contradicts') return 'contested'
  if (support === 'weak') return 'needs_review'
  return sourceIdxs.length > 0 || corpusIds.length > 0 || sourceUrls.length > 0 ? 'supported' : 'needs_review'
}

export function recordEvidence(
  workspace: string,
  claim: string,
  sourceRefs: string | number[] | undefined,
  opts?: { quote?: string; confidence?: string; support?: string; topic?: string; notes?: string; sessionId?: string; outputDir?: string },
): string {
  const trimmed = String(claim ?? '').trim()
  if (!trimmed) return 'Error: claim is required.'
  const sourceIdxs = Array.isArray(sourceRefs)
    ? sourceRefs.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : String(sourceRefs ?? '').split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const support = normalizeSupport(opts?.support)
  const corpusIds = parseStringList((opts as any)?.corpusIds)
  const sourceUrls = parseStringList((opts as any)?.sourceUrls)
  const row: EvidenceClaim = {
    id: makeId(),
    topic: opts?.topic,
    claim: trimmed,
    sourceIdxs,
    corpusIds,
    sourceUrls,
    localPath: (opts as any)?.localPath,
    passageId: (opts as any)?.passageId,
    planItemId: (opts as any)?.planItemId,
    evidenceType: normalizeEvidenceType((opts as any)?.evidenceType),
    quote: opts?.quote,
    confidence: normalizeConfidence(opts?.confidence),
    support,
    status: supportedStatus(support, sourceIdxs, corpusIds, sourceUrls),
    notes: opts?.notes,
    createdAt: Date.now(),
  }
  const rows = loadEvidence(workspace, opts?.outputDir)
  const key = normalizeClaimKey(row.claim)
  const existingIdx = rows.findIndex((prev) =>
    normalizeClaimKey(prev.claim) === key
    && (row.planItemId ? prev.planItemId === row.planItemId : true)
    && arraysOverlap(prev.corpusIds ?? [], row.corpusIds ?? [])
  )
  if (existingIdx >= 0) {
    const prev = rows[existingIdx]
    rows[existingIdx] = {
      ...prev,
      ...row,
      id: prev.id,
      sourceIdxs: [...new Set([...(prev.sourceIdxs ?? []), ...row.sourceIdxs])],
      corpusIds: [...new Set([...(prev.corpusIds ?? []), ...(row.corpusIds ?? [])])],
      sourceUrls: [...new Set([...(prev.sourceUrls ?? []), ...(row.sourceUrls ?? [])])],
      quote: row.quote || prev.quote,
      notes: [prev.notes, row.notes].filter(Boolean).join(' '),
      createdAt: prev.createdAt,
      status: supportedStatus(row.support, [...new Set([...(prev.sourceIdxs ?? []), ...row.sourceIdxs])], [...new Set([...(prev.corpusIds ?? []), ...(row.corpusIds ?? [])])], [...new Set([...(prev.sourceUrls ?? []), ...(row.sourceUrls ?? [])])]),
    }
  } else {
    rows.push(row)
  }
  saveEvidence(workspace, rows, opts?.outputDir)
  if (opts?.sessionId && sourceIdxs.length > 0) {
    const tracker = getSourceTracker(opts.sessionId)
    for (const idx of sourceIdxs) tracker.find(idx)
  }
  const savedId = existingIdx >= 0 ? rows[existingIdx].id : row.id
  return `${existingIdx >= 0 ? 'Updated' : 'Recorded'} evidence ${savedId}: ${existingIdx >= 0 ? rows[existingIdx].status : row.status}, confidence=${row.confidence}, sources=[${row.sourceIdxs.join(', ')}], corpus=[${row.corpusIds?.join(', ')}].`
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  return String(value ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
}

function arraysOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length
  const set = new Set(a)
  return b.some((x) => set.has(x))
}

function normalizeEvidenceType(value: string | undefined): EvidenceClaim['evidenceType'] {
  return ['primary_result', 'survey_statement', 'benchmark', 'safety_claim', 'background'].includes(String(value))
    ? value as EvidenceClaim['evidenceType']
    : undefined
}

export function listEvidence(workspace: string, status?: string, max = 30, outputDir?: string): string {
  let rows = loadEvidence(workspace, outputDir)
  if (status) rows = rows.filter((row) => row.status === status)
  rows = rows.slice(0, Math.max(1, Math.min(100, max)))
  if (rows.length === 0) return 'No evidence claims recorded yet.'
  return rows.map((row, i) => [
    `${i + 1}. ${row.id}: ${row.claim}`,
    `   Status: ${row.status} | support=${row.support} | confidence=${row.confidence}`,
    row.sourceIdxs.length ? `   Sources: [${row.sourceIdxs.join('], [')}]` : '   Sources: none',
    row.corpusIds?.length ? `   Corpus: ${row.corpusIds.join(', ')}` : null,
    row.planItemId ? `   Plan item: ${row.planItemId}` : null,
    row.localPath ? `   Local: ${row.localPath}` : null,
    row.quote ? `   Quote: "${row.quote.slice(0, 300)}${row.quote.length > 300 ? '…' : ''}"` : null,
    row.notes ? `   Notes: ${row.notes}` : null,
  ].filter(Boolean).join('\n')).join('\n\n')
}

export function evidenceMatrix(workspace: string, outputDir?: string): string {
  const rows = loadEvidence(workspace, outputDir)
  if (rows.length === 0) return 'No evidence matrix yet. Use record_evidence first.'
  const lines = [
    '| Claim ID | Plan | Claim | Sources | Corpus | Confidence | Status |',
    '|---|---|---|---:|---|---|---|',
  ]
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.planItemId ?? '-'} | ${row.claim.replace(/\|/g, '\\|')} | ${row.sourceIdxs.map((idx) => `[${idx}]`).join(', ') || '-'} | ${row.corpusIds?.join(', ') || '-'} | ${row.confidence} | ${row.status} |`)
  }
  return lines.join('\n')
}

export function evidenceStats(workspace: string, outputDir?: string) {
  const rows = loadEvidence(workspace, outputDir)
  return {
    total: rows.length,
    supported: rows.filter((r) => r.status === 'supported').length,
    contested: rows.filter((r) => r.status === 'contested').length,
    unsupported: rows.filter((r) => r.status === 'unsupported').length,
    needsReview: rows.filter((r) => r.status === 'needs_review').length,
    withCorpus: rows.filter((r) => r.corpusIds && r.corpusIds.length > 0).length,
    withQuotes: rows.filter((r) => !!r.quote).length,
  }
}

function tokenizeForQuoteMatch(text: string): string[] {
  return [...new Set(String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5)
    .slice(0, 40))]
}

function candidatePassages(text: string): string[] {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 80 && s.length <= 900)
    .slice(0, 2000)
}

function bestQuoteForClaim(text: string, claim: string): string | null {
  const terms = tokenizeForQuoteMatch(claim)
  if (terms.length === 0) return null
  let best = ''
  let bestScore = 0
  for (const passage of candidatePassages(text)) {
    const lower = passage.toLowerCase()
    const hits = terms.filter((t) => lower.includes(t)).length
    const score = hits / Math.sqrt(Math.max(1, passage.length / 160))
    if (score > bestScore) {
      bestScore = score
      best = passage
    }
  }
  if (bestScore <= 0) return null
  return best.length > 500 ? best.slice(0, 497) + '...' : best
}

function readLocalText(workspace: string, localPath?: string): string {
  if (!localPath) return ''
  const root = path.resolve(workspace)
  const resolved = path.resolve(workspace, localPath)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return ''
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return ''
    return fs.readFileSync(resolved, 'utf-8').slice(0, 500_000)
  } catch {
    return ''
  }
}

export function repairEvidenceQuotes(workspace: string, outputDir?: string, maxItems = 40): string {
  const rows = loadEvidence(workspace, outputDir)
  if (rows.length === 0) return 'No evidence claims recorded yet.'

  const corpus = loadCorpus(workspace, outputDir)
  const corpusById = new Map(corpus.map((item) => [item.id, item]))
  const limit = Math.max(1, Math.min(100, Number(maxItems) || 40))
  let repaired = 0
  let alreadyQuoted = 0
  const unresolved: string[] = []
  const changedIds: string[] = []

  for (const row of rows) {
    if (row.quote || row.notes?.toLowerCase().includes('abstract')) {
      alreadyQuoted++
      continue
    }
    if (repaired >= limit) break

    const linked = (row.corpusIds || []).map((id) => corpusById.get(id)).filter(Boolean)
    let quote: string | null = null
    let quoteSource = ''

    for (const item of linked) {
      if (!item) continue
      const fullText = readLocalText(workspace, item.localPath)
      quote = fullText ? bestQuoteForClaim(fullText, row.claim) : null
      if (quote) {
        quoteSource = item.localPath || item.id
        break
      }
      quote = bestQuoteForClaim([item.title, item.snippet, item.screeningReason].filter(Boolean).join('. '), row.claim)
      if (quote) {
        quoteSource = `${item.id} metadata/abstract`
        row.notes = [row.notes, 'abstract-only caveat: quote repaired from metadata/snippet because full text passage was unavailable.'].filter(Boolean).join(' ')
        break
      }
    }

    if (!quote) {
      unresolved.push(`${row.id}: ${row.claim.slice(0, 90)}`)
      continue
    }

    row.quote = quote
    row.localPath = row.localPath || quoteSource
    changedIds.push(row.id)
    repaired++
  }

  if (repaired > 0) saveEvidence(workspace, rows, outputDir)

  return [
    `Repaired evidence quotes: ${repaired}.`,
    `Already had quotes/abstract caveats: ${alreadyQuoted}.`,
    unresolved.length ? `Still missing quote/caveat (${unresolved.length}):\n${unresolved.slice(0, 20).map((s) => `- ${s}`).join('\n')}` : 'No unresolved quote gaps in processed batch.',
    changedIds.length ? `Updated claim ids: ${changedIds.join(', ')}` : null,
    'Next: run verify_claims, then run_quality_gates with the same output_dir.',
  ].filter(Boolean).join('\n')
}

export function verifyClaims(workspace: string, sessionId?: string, outputDir?: string): string {
  const rows = loadEvidence(workspace, outputDir)
  if (rows.length === 0) return 'No claims to verify.'
  const tracker = sessionId ? getSourceTracker(sessionId) : null
  const lines = ['# Claim verification\n']
  let blockers = 0
  for (const row of rows) {
    const hasCorpusLink = Boolean(row.corpusIds?.length || row.sourceUrls?.length)
    const missingSources = !hasCorpusLink && (row.sourceIdxs.length === 0 || (tracker && row.sourceIdxs.some((idx) => !tracker.find(idx))))
    const missingCorpus = !row.corpusIds || row.corpusIds.length === 0
    const weak = row.confidence === 'low' || row.confidence === 'speculative' || row.support === 'weak'
    const ok = !missingSources && !missingCorpus && !weak && row.status === 'supported'
    if (!ok) blockers++
    lines.push([
      `- ${ok ? 'PASS' : 'REVIEW'} ${row.id}: ${row.claim}`,
      missingSources ? '  - Missing or unresolved source reference.' : null,
      missingCorpus ? '  - Missing stable corpus id link.' : null,
      weak ? `  - Weak confidence/support (${row.confidence}/${row.support}).` : null,
      row.status !== 'supported' ? `  - Status is ${row.status}.` : null,
    ].filter(Boolean).join('\n'))
  }
  lines.unshift(`Result: ${rows.length - blockers}/${rows.length} claims pass basic verification.\n`)
  return lines.join('\n')
}

export function evidenceCoverageByPlan(workspace: string, outputDir?: string): string {
  const rows = loadEvidence(workspace, outputDir)
  if (rows.length === 0) return 'No evidence claims recorded yet.'
  const byPlan = new Map<string, EvidenceClaim[]>()
  for (const row of rows) {
    const key = row.planItemId || row.topic || 'unassigned'
    byPlan.set(key, [...(byPlan.get(key) || []), row])
  }
  const lines = ['# Evidence coverage by plan item', '']
  for (const [plan, items] of [...byPlan.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const corpusLinked = items.filter((i) => i.corpusIds?.length).length
    const quoted = items.filter((i) => i.quote).length
    lines.push(`- ${plan}: ${items.length} claim(s), ${corpusLinked} corpus-linked, ${quoted} with quote`)
  }
  return lines.join('\n')
}
