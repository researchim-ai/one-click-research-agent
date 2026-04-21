import { execFileSync } from 'child_process'

export type UrlHealthStatus = 'live' | 'archived' | 'dead' | 'unknown' | 'hallucinated'

export interface UrlHealth {
  url: string
  status: UrlHealthStatus
  httpStatus?: number
  archivedUrl?: string
  error?: string
}

function runScript(source: string, args: string[], timeoutMs = 15000): string {
  return execFileSync(process.execPath, ['-e', source, ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 5,
    env: { ...process.env, FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1' },
  })
}

const HEALTH_SCRIPT = `
(async () => {
  const url = process.argv[1]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    let resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'one-click-research-agent/0.1 URLHealth' } }).catch(() => null)
    if (!resp || resp.status === 405 || resp.status === 501) {
      resp = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'one-click-research-agent/0.1 URLHealth', Range: 'bytes=0-1023' } }).catch(() => null)
    }
    if (resp && resp.status >= 200 && resp.status < 400) {
      process.stdout.write(JSON.stringify({ status: 'live', httpStatus: resp.status }))
    } else {
      process.stdout.write(JSON.stringify({ status: 'dead', httpStatus: resp ? resp.status : 0 }))
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: 'dead', error: String(e && e.message || e) }))
  } finally {
    clearTimeout(timer)
  }
})()
`

const WAYBACK_SCRIPT = `
(async () => {
  const url = 'https://archive.org/wayback/available?url=' + encodeURIComponent(process.argv[1])
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'one-click-research-agent/0.1 Wayback' } })
    if (!r.ok) { process.stdout.write(JSON.stringify({ archived: null })); return }
    const j = await r.json()
    const snap = j?.archived_snapshots?.closest
    if (snap && snap.available && snap.url) {
      process.stdout.write(JSON.stringify({ archived: snap.url }))
    } else {
      process.stdout.write(JSON.stringify({ archived: null }))
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ archived: null }))
  } finally { clearTimeout(timer) }
})()
`

const healthCache = new Map<string, UrlHealth>()

export function clearHealthCache(): void {
  healthCache.clear()
}

export function checkUrlHealth(url: string, useWaybackOnFail = true): UrlHealth {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { url, status: 'hallucinated', error: 'not an http(s) url' }
  }
  const cached = healthCache.get(url)
  if (cached) return cached

  let primary: { status: UrlHealthStatus; httpStatus?: number; error?: string } = { status: 'unknown' }
  try {
    const out = runScript(HEALTH_SCRIPT, [url])
    primary = JSON.parse(out)
  } catch (e: any) {
    primary = { status: 'dead', error: String(e?.message || e) }
  }

  let archivedUrl: string | undefined
  if (primary.status !== 'live' && useWaybackOnFail) {
    try {
      const out = runScript(WAYBACK_SCRIPT, [url])
      const parsed = JSON.parse(out)
      if (parsed?.archived) {
        archivedUrl = String(parsed.archived)
        primary.status = 'archived'
      }
    } catch {}
  }

  const record: UrlHealth = {
    url,
    status: primary.status,
    httpStatus: primary.httpStatus,
    archivedUrl,
    error: primary.error,
  }
  healthCache.set(url, record)
  return record
}

export function formatHealthBadge(h: UrlHealth): string {
  switch (h.status) {
    case 'live': return 'LIVE'
    case 'archived': return 'ARCHIVED'
    case 'dead': return 'DEAD'
    case 'hallucinated': return 'HALLUCINATED'
    default: return 'UNKNOWN'
  }
}
