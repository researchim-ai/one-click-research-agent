import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { buildResumeMessageWindow, buildResearchTailMessage, primaryNextAction, resolveResearchOutputDir, resolveResearchContextMode } from '../electron/research-context'
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

describe('resolveResearchOutputDir does not leak a previous run into a fresh chat', () => {
  // Reproduces the "напиши проект по RL" bug: a brand-new chat in a workspace that already had a
  // deep-research run must NOT auto-attach that run via the workspace-global fallbacks.
  function seedWorkspaceWithRun(): { ws: string; runDir: string } {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'res-ctx-'))
    const runDir = '.research/2026-07-28_20-59-31_reasoning-i-rl-b-llm'
    fs.mkdirSync(path.join(ws, runDir), { recursive: true })
    fs.writeFileSync(path.join(ws, '.research', 'run-state.json'), JSON.stringify({ outputDir: runDir, phase: 'report_generated', updatedAt: Date.now() }))
    return { ws, runDir }
  }

  it('returns null for an unrelated new-chat message even when a prior run exists', () => {
    const { ws } = seedWorkspaceWithRun()
    expect(resolveResearchOutputDir(ws, [], 'напиши проект по RL')).toBeNull()
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('still resumes the last run on an explicit resume message', () => {
    const { ws, runDir } = seedWorkspaceWithRun()
    expect(resolveResearchOutputDir(ws, [], 'continue')).toBe(runDir)
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('honors an explicit run dir in the current message (New Research kickoff)', () => {
    const { ws, runDir } = seedWorkspaceWithRun()
    const kickoff = `Run this as a managed deep-research.\nResearch artifact directory: ${runDir}`
    expect(resolveResearchOutputDir(ws, [], kickoff)).toBe(runDir)
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('honors a run dir found in the current session history', () => {
    const { ws, runDir } = seedWorkspaceWithRun()
    const history = [{ role: 'user', content: `output_dir: "${runDir}/run.json"` }]
    expect(resolveResearchOutputDir(ws, history, 'дай ещё источников')).toBe(runDir)
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('does NOT activate managed mode from a run dir the model itself produced (tool/assistant messages)', () => {
    // The MCTS-AlphaZero bug: a plain chat where the model spontaneously called build_corpus /
    // search with an output_dir. The `.research/...` path then lived only in tool/assistant
    // messages — it must NOT retro-activate the guarded deep-research workflow.
    const { ws, runDir } = seedWorkspaceWithRun()
    const history = [
      { role: 'user', content: 'сделай mcts alphazero для шахмат' },
      { role: 'assistant', content: `Собираю корпус в ${runDir}` },
      { role: 'tool', content: `build_corpus ok\noutput_dir: "${runDir}"\n24 rows` },
    ]
    expect(resolveResearchOutputDir(ws, history, 'добавь функцию оценки позиции')).toBeNull()
    fs.rmSync(ws, { recursive: true, force: true })
  })
})

describe('resolveResearchContextMode requires an explicit trigger', () => {
  it('is off for a normal chat message with no run dir', () => {
    expect(resolveResearchContextMode({ userMessage: 'напиши проект по RL', outputDir: null })).toBe('off')
  })
  it('a globally-saved deep-research preset alone does NOT activate managed mode', () => {
    expect(resolveResearchContextMode({ userMessage: 'напиши проект по RL', presetId: 'deep-research', outputDir: null })).toBe('off')
  })
  it('activates when a run dir is in play', () => {
    expect(resolveResearchContextMode({ userMessage: 'go', outputDir: '.research/2026-07-28_20-59-31_x' })).toBe('active')
  })
  it('is resume for an explicit continue message', () => {
    expect(resolveResearchContextMode({ userMessage: 'continue', outputDir: null })).toBe('resume')
  })
})
