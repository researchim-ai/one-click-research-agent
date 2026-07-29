import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  SEARCH_SOURCE_IDS,
  normalizeAllowedSearchTools,
  filterToolNamesByPolicy,
} from '../search-sources'
import { sanitizeResearchPatch } from '../electron/research-intake-parse'
import { ensureResearchRunSpec, readResearchRunSpec } from '../electron/research-workflow'

describe('normalizeAllowedSearchTools', () => {
  it('treats undefined/empty/full lists as no restriction (null)', () => {
    expect(normalizeAllowedSearchTools(undefined)).toBeNull()
    expect(normalizeAllowedSearchTools(null)).toBeNull()
    expect(normalizeAllowedSearchTools([])).toBeNull()
    expect(normalizeAllowedSearchTools([...SEARCH_SOURCE_IDS])).toBeNull()
  })

  it('keeps a genuine subset and drops unknown ids', () => {
    expect(normalizeAllowedSearchTools(['search_arxiv'])).toEqual(['search_arxiv'])
    expect(normalizeAllowedSearchTools(['search_arxiv', 'bogus_tool'])).toEqual(['search_arxiv'])
    expect(normalizeAllowedSearchTools(['bogus_only'])).toBeNull()
  })
})

describe('filterToolNamesByPolicy', () => {
  const tools = ['search_arxiv', 'search_openalex', 'search_web', 'smart_search', 'build_corpus', 'read_full_text_batch']

  it('is a no-op when unrestricted', () => {
    expect(filterToolNamesByPolicy(tools, null)).toEqual(tools)
    expect(filterToolNamesByPolicy(tools, [...SEARCH_SOURCE_IDS])).toEqual(tools)
  })

  it('drops disallowed search engines and the router, keeps non-search tools', () => {
    const out = filterToolNamesByPolicy(tools, ['search_arxiv'])
    expect(out).toContain('search_arxiv')
    expect(out).toContain('build_corpus')
    expect(out).toContain('read_full_text_batch')
    expect(out).not.toContain('search_openalex')
    expect(out).not.toContain('search_web')
    expect(out).not.toContain('smart_search')
  })
})

describe('sanitizeResearchPatch — allowedSearchTools', () => {
  it('keeps a valid subset and filters unknown ids', () => {
    const out = sanitizeResearchPatch({ allowedSearchTools: ['search_arxiv', 'search_openalex', 'nope'] })
    expect(out.allowedSearchTools).toEqual(['search_arxiv', 'search_openalex'])
  })

  it('omits the key entirely when absent (means all sources)', () => {
    const out = sanitizeResearchPatch({ topic: 'x' })
    expect('allowedSearchTools' in out).toBe(false)
  })

  it('omits the key when no valid id remains', () => {
    const out = sanitizeResearchPatch({ allowedSearchTools: ['unknown'] })
    expect('allowedSearchTools' in out).toBe(false)
  })
})

describe('run spec persists allowedSearchTools across updates', () => {
  let ws: string
  const OUT = '.research/run'

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'src-policy-'))
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('does not lose the whitelist on a later unrelated patch', () => {
    ensureResearchRunSpec(ws, OUT, { allowedSearchTools: ['search_arxiv'], state: 'PLANNED' })
    // A later patch (e.g. a state change) must not drop the previously stored policy.
    ensureResearchRunSpec(ws, OUT, { state: 'CORPUS_READY' })
    const spec = readResearchRunSpec(ws, OUT)
    expect(spec?.allowedSearchTools).toEqual(['search_arxiv'])
  })
})
