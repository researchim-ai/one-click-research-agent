import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { buildResumeMessageWindow, buildResearchTailMessage } from '../electron/research-context'
import { decideResearchCommandIntent, extractResearchOutputDirFromText } from '../electron/research-resume'

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

  it('treats "делай" as saved-plan approval even when backend lost the visible prompt', () => {
    expect(decideResearchCommandIntent({
      resumeLike: false,
      approvalLike: true,
      approvalPromptPending: false,
      hasOutputDir: true,
      hasSavedPlan: true,
      contextModeOff: false,
    })).toEqual({ planApproved: true, planBootstrapApproved: false, researchResume: false })
  })

  it('bootstraps plan_research from "давай" even when the visible checkpoint was not persisted', () => {
    expect(decideResearchCommandIntent({
      resumeLike: false,
      approvalLike: true,
      approvalPromptPending: false,
      hasOutputDir: true,
      hasSavedPlan: false,
      contextModeOff: false,
    })).toEqual({ planApproved: false, planBootstrapApproved: true, researchResume: false })
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

describe('extractResearchOutputDirFromText', () => {
  it('normalizes artifact file paths back to the run directory', () => {
    expect(extractResearchOutputDirFromText('Plan saved to .research/2026-06-12_16-44-28_rl-b-llm/plan.md')).toBe('.research/2026-06-12_16-44-28_rl-b-llm')
    expect(extractResearchOutputDirFromText('output_dir: ".research/2026-06-12_16-44-28_rl-b-llm/run.json"')).toBe('.research/2026-06-12_16-44-28_rl-b-llm')
  })
})
