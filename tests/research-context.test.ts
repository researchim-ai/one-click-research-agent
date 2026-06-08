import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { buildResumeMessageWindow, buildResearchTailMessage } from '../electron/research-context'
import { decideResearchCommandIntent } from '../electron/research-resume'

describe('buildResumeMessageWindow (stable prefix)', () => {
  it('keeps the system prompt frozen (no working-set mutation)', () => {
    const system = 'SYSTEM PROMPT — must stay byte-identical'
    const win = buildResumeMessageWindow(system, os.tmpdir(), '.research/does-not-exist', 'brief', 'continue')
    expect(win[0].role).toBe('system')
    expect(win[0].content).toBe(system)
    expect(win.map((m) => m.role)).toEqual(['system', 'user', 'user'])
  })
})

describe('buildResearchTailMessage', () => {
  it('returns null when the run directory has no artifacts', () => {
    const tail = buildResearchTailMessage(os.tmpdir(), path.join('.research', 'nope-' + Date.now()))
    expect(tail).toBeNull()
  })
})

describe('decideResearchCommandIntent', () => {
  it('lets an action-like resume command approve a pending plan before resume handling', () => {
    expect(decideResearchCommandIntent({
      resumeLike: true,
      approvalLike: true,
      approvalPromptPending: true,
      hasOutputDir: true,
      hasSavedPlan: true,
      contextModeOff: false,
    })).toEqual({ planApproved: true, planBootstrapApproved: false, researchResume: false })
  })

  it('bootstraps plan_research when the user approves a proposed plan that is not saved yet', () => {
    expect(decideResearchCommandIntent({
      resumeLike: false,
      approvalLike: true,
      approvalPromptPending: true,
      hasOutputDir: true,
      hasSavedPlan: false,
      contextModeOff: false,
    })).toEqual({ planApproved: false, planBootstrapApproved: true, researchResume: false })
  })

  it('treats \"делай\" as resume when no fresh approval prompt is pending', () => {
    expect(decideResearchCommandIntent({
      resumeLike: false,
      approvalLike: true,
      approvalPromptPending: false,
      hasOutputDir: true,
      hasSavedPlan: true,
      contextModeOff: false,
    })).toEqual({ planApproved: false, planBootstrapApproved: false, researchResume: true })
  })

  it('does not resume without a known research output directory', () => {
    expect(decideResearchCommandIntent({
      resumeLike: true,
      approvalLike: false,
      approvalPromptPending: false,
      hasOutputDir: false,
      hasSavedPlan: false,
      contextModeOff: false,
    })).toEqual({ planApproved: false, planBootstrapApproved: false, researchResume: false })
  })
})
