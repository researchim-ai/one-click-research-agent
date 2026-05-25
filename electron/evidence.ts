import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { getSourceTracker } from './sources'

export interface EvidenceClaim {
  id: string
  topic?: string
  claim: string
  sourceIdxs: number[]
  quote?: string
  confidence: 'high' | 'medium' | 'low' | 'speculative'
  support: 'supports' | 'contradicts' | 'background' | 'weak'
  status: 'supported' | 'contested' | 'unsupported' | 'needs_review'
  notes?: string
  createdAt: number
}

function evidencePath(workspace: string): string {
  return path.join(workspace, '.research', 'evidence.jsonl')
}

function claimsPath(workspace: string): string {
  return path.join(workspace, '.research', 'claims.jsonl')
}

function makeId(): string {
  return `C-${crypto.randomUUID().slice(0, 8)}`
}

export function loadEvidence(workspace: string): EvidenceClaim[] {
  const p = evidencePath(workspace)
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvidenceClaim)
  } catch { return [] }
}

export function saveEvidence(workspace: string, rows: EvidenceClaim[]): void {
  const p = evidencePath(workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  try {
    fs.writeFileSync(claimsPath(workspace), rows.map((row) => JSON.stringify({
      id: row.id,
      claim: row.claim,
      status: row.status,
      confidence: row.confidence,
      sources: row.sourceIdxs,
    })).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  } catch {}
}

function normalizeConfidence(value: string | undefined): EvidenceClaim['confidence'] {
  return ['high', 'medium', 'low', 'speculative'].includes(String(value)) ? value as EvidenceClaim['confidence'] : 'medium'
}

function normalizeSupport(value: string | undefined): EvidenceClaim['support'] {
  return ['supports', 'contradicts', 'background', 'weak'].includes(String(value)) ? value as EvidenceClaim['support'] : 'supports'
}

export function recordEvidence(
  workspace: string,
  claim: string,
  sourceRefs: string | number[] | undefined,
  opts?: { quote?: string; confidence?: string; support?: string; topic?: string; notes?: string; sessionId?: string },
): string {
  const trimmed = String(claim ?? '').trim()
  if (!trimmed) return 'Error: claim is required.'
  const sourceIdxs = Array.isArray(sourceRefs)
    ? sourceRefs.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : String(sourceRefs ?? '').split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const support = normalizeSupport(opts?.support)
  const row: EvidenceClaim = {
    id: makeId(),
    topic: opts?.topic,
    claim: trimmed,
    sourceIdxs,
    quote: opts?.quote,
    confidence: normalizeConfidence(opts?.confidence),
    support,
    status: support === 'contradicts' ? 'contested' : sourceIdxs.length > 0 ? 'supported' : 'needs_review',
    notes: opts?.notes,
    createdAt: Date.now(),
  }
  const rows = loadEvidence(workspace)
  rows.push(row)
  saveEvidence(workspace, rows)
  if (opts?.sessionId && sourceIdxs.length > 0) {
    const tracker = getSourceTracker(opts.sessionId)
    for (const idx of sourceIdxs) tracker.find(idx)
  }
  return `Recorded evidence ${row.id}: ${row.status}, confidence=${row.confidence}, sources=[${row.sourceIdxs.join(', ')}].`
}

export function listEvidence(workspace: string, status?: string, max = 30): string {
  let rows = loadEvidence(workspace)
  if (status) rows = rows.filter((row) => row.status === status)
  rows = rows.slice(0, Math.max(1, Math.min(100, max)))
  if (rows.length === 0) return 'No evidence claims recorded yet.'
  return rows.map((row, i) => [
    `${i + 1}. ${row.id}: ${row.claim}`,
    `   Status: ${row.status} | support=${row.support} | confidence=${row.confidence}`,
    row.sourceIdxs.length ? `   Sources: [${row.sourceIdxs.join('], [')}]` : '   Sources: none',
    row.quote ? `   Quote: "${row.quote.slice(0, 300)}${row.quote.length > 300 ? '…' : ''}"` : null,
    row.notes ? `   Notes: ${row.notes}` : null,
  ].filter(Boolean).join('\n')).join('\n\n')
}

export function evidenceMatrix(workspace: string): string {
  const rows = loadEvidence(workspace)
  if (rows.length === 0) return 'No evidence matrix yet. Use record_evidence first.'
  const lines = [
    '| Claim ID | Claim | Sources | Confidence | Status |',
    '|---|---|---:|---|---|',
  ]
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.claim.replace(/\|/g, '\\|')} | ${row.sourceIdxs.map((idx) => `[${idx}]`).join(', ') || '-'} | ${row.confidence} | ${row.status} |`)
  }
  return lines.join('\n')
}

export function evidenceStats(workspace: string) {
  const rows = loadEvidence(workspace)
  return {
    total: rows.length,
    supported: rows.filter((r) => r.status === 'supported').length,
    contested: rows.filter((r) => r.status === 'contested').length,
    unsupported: rows.filter((r) => r.status === 'unsupported').length,
    needsReview: rows.filter((r) => r.status === 'needs_review').length,
  }
}

export function verifyClaims(workspace: string, sessionId?: string): string {
  const rows = loadEvidence(workspace)
  if (rows.length === 0) return 'No claims to verify.'
  const tracker = sessionId ? getSourceTracker(sessionId) : null
  const lines = ['# Claim verification\n']
  let blockers = 0
  for (const row of rows) {
    const missingSources = row.sourceIdxs.length === 0 || (tracker && row.sourceIdxs.some((idx) => !tracker.find(idx)))
    const weak = row.confidence === 'low' || row.confidence === 'speculative' || row.support === 'weak'
    const ok = !missingSources && !weak && row.status === 'supported'
    if (!ok) blockers++
    lines.push([
      `- ${ok ? 'PASS' : 'REVIEW'} ${row.id}: ${row.claim}`,
      missingSources ? '  - Missing or unresolved source reference.' : null,
      weak ? `  - Weak confidence/support (${row.confidence}/${row.support}).` : null,
      row.status !== 'supported' ? `  - Status is ${row.status}.` : null,
    ].filter(Boolean).join('\n'))
  }
  lines.unshift(`Result: ${rows.length - blockers}/${rows.length} claims pass basic verification.\n`)
  return lines.join('\n')
}
