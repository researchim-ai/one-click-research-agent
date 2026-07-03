import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ensureResearchRunSpec, updateResearchWorkflowAfterTool } from '../electron/research-workflow'
import { updateResearchRunState } from '../electron/research-context'

let ws: string
const OUT = '.research/run'

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'state-sync-'))
  fs.mkdirSync(path.join(ws, OUT), { recursive: true })
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('updateResearchRunState does not clobber the authoritative FSM state', () => {
  // Regression: the coarse phase→state mapping used to force state back to CORPUS_READY on
  // every corpus-phase tool (screen_corpus, read_full_text_batch, assign_corpus_to_plan…),
  // wiping EVIDENCE/GATES_FAILED and making the Research-state tail contradict its blockers.
  it('keeps EVIDENCE when a corpus-phase tool reports in', () => {
    ensureResearchRunSpec(ws, OUT, { state: 'EVIDENCE' })
    updateResearchRunState(ws, { outputDir: OUT, phase: 'corpus', lastTool: 'screen_corpus' })
    expect(ensureResearchRunSpec(ws, OUT).state).toBe('EVIDENCE')
  })

  it('keeps GATES_FAILED when a corpus-phase tool reports in', () => {
    ensureResearchRunSpec(ws, OUT, { state: 'GATES_FAILED' })
    updateResearchRunState(ws, { outputDir: OUT, phase: 'corpus', lastTool: 'read_full_text_batch' })
    expect(ensureResearchRunSpec(ws, OUT).state).toBe('GATES_FAILED')
  })

  it('still records the coarse phase/lastTool for the UI', () => {
    ensureResearchRunSpec(ws, OUT, { state: 'EVIDENCE' })
    const runState = updateResearchRunState(ws, { outputDir: OUT, phase: 'corpus', lastTool: 'screen_corpus' })
    expect(runState.phase).toBe('corpus')
    expect(runState.lastTool).toBe('screen_corpus')
  })
})

describe('generate_evidence_report never fakes REPORT_READY without a report on disk', () => {
  // Regression: a generate_evidence_report call BLOCKED by failing gates returns an error
  // and writes nothing, yet the FSM used to jump to REPORT_READY unconditionally — the run
  // then terminated believing it had produced a report that never existed.
  it('stays in GATES_FAILED when report.md is absent', () => {
    ensureResearchRunSpec(ws, OUT, { state: 'GATES_FAILED' })
    const spec = updateResearchWorkflowAfterTool(ws, OUT, 'generate_evidence_report')
    expect(spec.state).not.toBe('REPORT_READY')
  })

  it('advances to REPORT_READY only once report.md is written', () => {
    ensureResearchRunSpec(ws, OUT, { state: 'GATES_FAILED' })
    fs.writeFileSync(path.join(ws, OUT, 'report.md'), '# Report\n')
    const spec = updateResearchWorkflowAfterTool(ws, OUT, 'generate_evidence_report')
    expect(spec.state).toBe('REPORT_READY')
  })
})
