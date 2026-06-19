import { describe, it, expect } from 'vitest'
import { extractTextToolCalls, coerceRecoveredToolValue } from '../electron/tool-call-parser'

describe('coerceRecoveredToolValue', () => {
  it('parses integers', () => {
    expect(coerceRecoveredToolValue('12')).toBe(12)
    expect(coerceRecoveredToolValue('-3')).toBe(-3)
  })
  it('parses booleans', () => {
    expect(coerceRecoveredToolValue('true')).toBe(true)
    expect(coerceRecoveredToolValue('False')).toBe(false)
  })
  it('parses JSON arrays and objects', () => {
    expect(coerceRecoveredToolValue('["a", "b"]')).toEqual(['a', 'b'])
    expect(coerceRecoveredToolValue('{"k": 1}')).toEqual({ k: 1 })
  })
  it('keeps plain strings', () => {
    expect(coerceRecoveredToolValue('hello world')).toBe('hello world')
  })
})

describe('extractTextToolCalls (XML)', () => {
  it('parses a single XML tool call with typed params', () => {
    const xml = '<tool_call><function=screen_corpus><parameter=output_dir>.research/x</parameter><parameter=max_selected>12</parameter><parameter=sub_questions>["q1","q2"]</parameter></function></tool_call>'
    const calls = extractTextToolCalls(xml)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('screen_corpus')
    expect(calls[0].args.output_dir).toBe('.research/x')
    expect(calls[0].args.max_selected).toBe(12)
    expect(calls[0].args.sub_questions).toEqual(['q1', 'q2'])
  })

  it('parses multiple XML tool calls', () => {
    const xml = '<tool_call><function=a></function></tool_call> mid <tool_call><function=b></function></tool_call>'
    expect(extractTextToolCalls(xml).map((c) => c.name)).toEqual(['a', 'b'])
  })
})

describe('extractTextToolCalls (JSON)', () => {
  it('parses a JSON tool call', () => {
    const json = 'noise {"name": "run_quality_gates", "arguments": {"min_selected": 12}} tail'
    const calls = extractTextToolCalls(json)
    expect(calls[0].name).toBe('run_quality_gates')
    expect(calls[0].args.min_selected).toBe(12)
  })
})

describe('extractTextToolCalls (reasoning-channel recovery payloads)', () => {
  // The runtime recovers the LAST committed tool call emitted inside the reasoning
  // channel when the model produced no visible content or native tool call. These
  // payloads mirror what Qwen3 actually wrote in the bug report.
  it('parses the exact evidence_coverage_by_plan call the model wrote inside reasoning', () => {
    const reasoning = 'Состояние: 16 доказательств. Проверю покрытие по планам.' +
      '<tool_call><function=evidence_coverage_by_plan><parameter=output_dir>.research/2026-06-17_23-47-50_rl-b-llm</parameter></function></tool_call>'
    const calls = extractTextToolCalls(reasoning)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('evidence_coverage_by_plan')
    expect(calls[0].args.output_dir).toBe('.research/2026-06-17_23-47-50_rl-b-llm')
  })

  it('returns calls in order so the runtime can pick the LAST committed one', () => {
    const reasoning = 'First I might inspect…' +
      '<tool_call><function=evidence_coverage_by_plan><parameter=output_dir>.research/x</parameter></function></tool_call>' +
      ' …but actually the right move is to run gates.' +
      '<tool_call><function=run_quality_gates><parameter=output_dir>.research/x</parameter></function></tool_call>'
    const calls = extractTextToolCalls(reasoning)
    expect(calls.map((c) => c.name)).toEqual(['evidence_coverage_by_plan', 'run_quality_gates'])
    const last = calls[calls.length - 1]
    expect(last.name).toBe('run_quality_gates')
  })
})

describe('extractTextToolCalls (empty)', () => {
  it('returns nothing for plain prose', () => {
    expect(extractTextToolCalls('Just some analysis with no tool calls.')).toEqual([])
  })
  it('returns nothing for empty input', () => {
    expect(extractTextToolCalls('')).toEqual([])
  })
})
