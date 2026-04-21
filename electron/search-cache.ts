import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

const CACHE_DIR = path.join(os.homedir(), '.one-click-agent')
const CACHE_PATH = path.join(CACHE_DIR, 'search-cache.jsonl')
const MAX_ENTRIES = 500

interface CacheEntry {
  key: string
  tool: string
  value: string
  ts: number
  ttlMs: number
}

let memCache: Map<string, CacheEntry> | null = null

function load(): Map<string, CacheEntry> {
  if (memCache) return memCache
  memCache = new Map()
  try {
    if (!fs.existsSync(CACHE_PATH)) return memCache
    const lines = fs.readFileSync(CACHE_PATH, 'utf-8').split('\n').filter(Boolean)
    const now = Date.now()
    for (const line of lines) {
      try {
        const e: CacheEntry = JSON.parse(line)
        if (now - e.ts <= e.ttlMs) {
          memCache.set(e.key, e)
          if (memCache.size > MAX_ENTRIES) {
            const firstKey = memCache.keys().next().value
            if (firstKey !== undefined) memCache.delete(firstKey)
          }
        }
      } catch {}
    }
  } catch {}
  return memCache!
}

function persist(entry: CacheEntry): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.appendFileSync(CACHE_PATH, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {}
}

export function makeKey(tool: string, params: Record<string, any>): string {
  const normalized: Record<string, any> = {}
  const keys = Object.keys(params || {}).sort()
  for (const k of keys) {
    const v = params[k]
    if (v === undefined || v === null || v === '') continue
    normalized[k] = typeof v === 'string' ? v.trim().toLowerCase() : v
  }
  const serialized = `${tool}::${JSON.stringify(normalized)}`
  return crypto.createHash('sha1').update(serialized).digest('hex')
}

/** Default TTL per tool type. Web: 1 hour. Academic: 24 hours. */
export function defaultTtlMs(tool: string): number {
  if (tool === 'search_web' || tool === 'fetch_url') return 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

export function get(tool: string, params: Record<string, any>): string | null {
  const cache = load()
  const key = makeKey(tool, params)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > entry.ttlMs) {
    cache.delete(key)
    return null
  }
  return entry.value
}

export function set(tool: string, params: Record<string, any>, value: string, ttlMs?: number): void {
  const cache = load()
  const key = makeKey(tool, params)
  const entry: CacheEntry = {
    key,
    tool,
    value,
    ts: Date.now(),
    ttlMs: ttlMs ?? defaultTtlMs(tool),
  }
  cache.set(key, entry)
  if (cache.size > MAX_ENTRIES) {
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) cache.delete(firstKey)
  }
  persist(entry)
}

/** Wrap a synchronous search function so results are cached. */
export function withCache<T extends (...args: any[]) => string>(
  tool: string,
  fn: T,
  keyBuilder: (...args: Parameters<T>) => Record<string, any>,
  ttlMs?: number,
): T {
  return ((...args: Parameters<T>) => {
    const params = keyBuilder(...args)
    const cached = get(tool, params)
    if (cached !== null) return `[cached]\n${cached}`
    const out = fn(...args)
    // Do not cache errors
    if (typeof out === 'string' && !out.startsWith('Error:')) {
      set(tool, params, out, ttlMs)
    }
    return out
  }) as T
}

export function clearCache(): void {
  memCache = new Map()
  try { fs.unlinkSync(CACHE_PATH) } catch {}
}
