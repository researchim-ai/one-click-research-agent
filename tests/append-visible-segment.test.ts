import { describe, it, expect } from 'vitest'
import { appendVisibleSegment } from '../electron/agent'

describe('appendVisibleSegment', () => {
  it('appends distinct segments with a blank-line separator', () => {
    expect(appendVisibleSegment('Hello', 'World')).toBe('Hello\n\nWorld')
  })

  it('starts from an empty accumulator', () => {
    expect(appendVisibleSegment('', 'First')).toBe('First')
  })

  it('skips an exact duplicate segment (model repeated its checkpoint prose)', () => {
    const prose = 'Корпус собран. Что делать? ✅ Утвердить'
    expect(appendVisibleSegment(prose, prose)).toBe(prose)
  })

  it('skips a duplicate that differs only by whitespace', () => {
    const a = 'Корпус собран.\nЧто делать?'
    const b = 'Корпус   собран.   Что делать?'
    expect(appendVisibleSegment(a, b)).toBe(a)
  })

  it('skips a segment already contained in the accumulator', () => {
    const acc = 'Intro.\n\nКорпус собран. Что делать?'
    expect(appendVisibleSegment(acc, 'Корпус собран. Что делать?')).toBe(acc)
  })

  it('replaces the accumulator when the new segment is a superset', () => {
    const acc = 'Корпус собран.'
    const fuller = 'Корпус собран. Что делать? ✅ Утвердить'
    expect(appendVisibleSegment(acc, fuller)).toBe(fuller)
  })

  it('ignores empty / whitespace-only segments', () => {
    expect(appendVisibleSegment('Hello', '   ')).toBe('Hello')
  })
})
