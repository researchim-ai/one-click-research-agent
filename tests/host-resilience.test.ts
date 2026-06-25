import { describe, it, expect } from 'vitest'
import { HostBreaker, AdaptiveThrottle } from '../electron/host-resilience'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('HostBreaker', () => {
  it('does NOT open on a single transient failure (stays retryable)', () => {
    const c = clock()
    const b = new HostBreaker(2, 20000, c.now)
    const opened = b.recordFailure('arxiv')
    expect(opened).toBe(false)
    expect(b.isOpen('arxiv')).toBe(false)
    expect(b.coolingDownFor('arxiv')).toBe(0)
    expect(b.failureStreak('arxiv')).toBe(1)
  })

  it('opens only after the second consecutive failure', () => {
    const c = clock()
    const b = new HostBreaker(2, 20000, c.now)
    expect(b.recordFailure('arxiv')).toBe(false)
    expect(b.recordFailure('arxiv')).toBe(true)
    expect(b.isOpen('arxiv')).toBe(true)
    expect(b.coolingDownFor('arxiv')).toBe(20000)
  })

  it('the cooldown expires after the configured window', () => {
    const c = clock()
    const b = new HostBreaker(2, 20000, c.now)
    b.recordFailure('arxiv')
    b.recordFailure('arxiv')
    c.advance(19999)
    expect(b.isOpen('arxiv')).toBe(true)
    c.advance(1)
    expect(b.isOpen('arxiv')).toBe(false)
    expect(b.coolingDownFor('arxiv')).toBe(0)
  })

  it('a success between failures resets the streak so it will not trip', () => {
    const c = clock()
    const b = new HostBreaker(2, 20000, c.now)
    b.recordFailure('arxiv')
    b.recordSuccess('arxiv')
    expect(b.failureStreak('arxiv')).toBe(0)
    expect(b.recordFailure('arxiv')).toBe(false)
    expect(b.isOpen('arxiv')).toBe(false)
  })

  it('a success clears an already-open breaker', () => {
    const c = clock()
    const b = new HostBreaker(2, 20000, c.now)
    b.recordFailure('arxiv')
    b.recordFailure('arxiv')
    expect(b.isOpen('arxiv')).toBe(true)
    b.recordSuccess('arxiv')
    expect(b.isOpen('arxiv')).toBe(false)
    expect(b.failureStreak('arxiv')).toBe(0)
  })

  it('tracks hosts independently', () => {
    const c = clock()
    const b = new HostBreaker(2, 20000, c.now)
    b.recordFailure('arxiv')
    b.recordFailure('arxiv')
    expect(b.isOpen('arxiv')).toBe(true)
    expect(b.isOpen('semantic-scholar')).toBe(false)
    expect(b.failureStreak('semantic-scholar')).toBe(0)
  })
})

describe('AdaptiveThrottle', () => {
  it('starts at the base interval', () => {
    const t = new AdaptiveThrottle(3000, 30000, 2)
    expect(t.current('arxiv')).toBe(3000)
  })

  it('widens by the factor on each rate-limit, capped at max', () => {
    const t = new AdaptiveThrottle(3000, 30000, 2)
    expect(t.onRateLimited('arxiv')).toBe(6000)
    expect(t.onRateLimited('arxiv')).toBe(12000)
    expect(t.onRateLimited('arxiv')).toBe(24000)
    expect(t.onRateLimited('arxiv')).toBe(30000) // capped (would be 48000)
    expect(t.onRateLimited('arxiv')).toBe(30000)
    expect(t.current('arxiv')).toBe(30000)
  })

  it('decays back toward the base interval on success', () => {
    const t = new AdaptiveThrottle(3000, 30000, 2)
    t.onRateLimited('arxiv') // 6000
    t.onRateLimited('arxiv') // 12000
    expect(t.onSuccess('arxiv')).toBe(6000)
    expect(t.onSuccess('arxiv')).toBe(3000)
    expect(t.onSuccess('arxiv')).toBe(3000) // floored at base
  })

  it('keeps spacing per host independent', () => {
    const t = new AdaptiveThrottle(3000, 30000, 2)
    t.onRateLimited('arxiv')
    expect(t.current('arxiv')).toBe(6000)
    expect(t.current('semantic-scholar')).toBe(3000)
  })
})
