import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveResearchDir } from '../research-paths'

let ws: string

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rpaths-'))
})
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('resolveResearchDir', () => {
  it('returns an existing run dir that holds artifacts', () => {
    const run = path.join(ws, '.research', '2026-06-06_12-00-00_topic')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(path.join(run, 'run.json'), '{}')
    const resolved = resolveResearchDir(ws, '.research/2026-06-06_12-00-00_topic')
    expect(resolved).toBe(run)
  })

  it('returns the canonical candidate path when nothing exists yet', () => {
    const resolved = resolveResearchDir(ws, '.research/2026-06-06_12-00-00_New Topic')
    expect(resolved).toBe(path.join(ws, '.research', '2026-06-06_12-00-00_new-topic'))
  })

  it('falls back to .research for an absolute path outside the workspace', () => {
    const resolved = resolveResearchDir(ws, '/etc')
    expect(resolved).toBe(path.join(ws, '.research'))
  })

  it('defaults to the .research root when no outputDir is given', () => {
    const resolved = resolveResearchDir(ws)
    expect(resolved).toBe(path.join(ws, '.research'))
  })
})
