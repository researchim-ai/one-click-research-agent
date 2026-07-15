import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { buildResumeMessageWindow, buildResearchTailMessage, primaryNextAction } from '../electron/research-context'
import { decideResearchCommandIntent, extractResearchOutputDirFromText } from '../electron/research-resume'

describe('primaryNextAction (single authoritative next step)', () => {
  const base = {
    state: 'READING',
    reportExists: false,
    blockers: null as string | null,
    selectedRead: 0,
    unreadSelected: 0,
    failedSelected: 0,
    evidenceSupported: 0,
    stalled: false,
    researchKind: 'academic',
    corpusTotal: 20,
    gatheredSources: 0,
  }

  it('the dead-end case (some read, most failed, nothing unread) points to extracting from what read — not listing', () => {
    // Exactly the hung run: 12 selected = 2 read + 10 failed, 0 unread, 0 evidence.
    const action = primaryNextAction({ ...base, selectedRead: 2, failedSelected: 10, unreadSelected: 0 })
    expect(action).toMatch(/extract_evidence_from_corpus_item|record_evidence/)
    expect(action).toMatch(/UNAVAILABLE|do not retry/i)
  })

  it('prefers reading when selected items are still unread', () => {
    expect(primaryNextAction({ ...base, unreadSelected: 5 })).toMatch(/read_full_text_batch/)
  })

  it('runs quality gates once evidence exists and nothing is left to read', () => {
    expect(primaryNextAction({ ...base, selectedRead: 6, evidenceSupported: 5, unreadSelected: 0 })).toMatch(/run_quality_gates/)
  })

  it('tells the user it is done when report.md exists and no blockers', () => {
    expect(primaryNextAction({ ...base, reportExists: true })).toMatch(/complete|final summary/i)
  })

  it('a genuine stall with no readable data recommends one new search, not looping', () => {
    const action = primaryNextAction({ ...base, stalled: true, selectedRead: 0, failedSelected: 4 })
    expect(action).toMatch(/search_openalex|search_arxiv|new search/i)
  })

  it('a plan_section_coverage blocker steers to evidence (or an honest downgrade) — never update_plan_status', () => {
    const action = primaryNextAction({
      ...base,
      state: 'GATES_FAILED',
      blockers: 'Q3: needs selected+read sources and 2 evidence row(s).',
      selectedRead: 8,
      evidenceSupported: 10,
    })
    expect(action).toMatch(/extract_evidence_from_corpus_item|record_evidence|assign_corpus_to_plan/)
    expect(action).toMatch(/never call update_plan_status/i)
    expect(action).toMatch(/run_quality_gates/)
  })
})

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
