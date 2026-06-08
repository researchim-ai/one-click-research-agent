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

describe('extractTextToolCalls (empty)', () => {
  it('returns nothing for plain prose', () => {
    expect(extractTextToolCalls('Just some analysis with no tool calls.')).toEqual([])
  })
  it('returns nothing for empty input', () => {
    expect(extractTextToolCalls('')).toEqual([])
  })
})
