import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writePlan, planQuestion } from '../electron/planner'

let ws: string
const OUT = '.research/run'

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-title-'))
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('planQuestion', () => {
  it('returns the real research topic from plan.md (not the run-dir slug)', () => {
    writePlan(ws, 'RL в LLM: самые свежие статьи', ['Q1', 'Q2'], OUT)
    expect(planQuestion(ws, OUT)).toBe('RL в LLM: самые свежие статьи')
  })

  it('returns null when no plan exists', () => {
    expect(planQuestion(ws, OUT)).toBeNull()
  })
})
