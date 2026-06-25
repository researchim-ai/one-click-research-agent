// Pure, dependency-free circuit breaker for flaky external hosts (e.g. arXiv's
// export API, which throttles bursts with transient 400/429/500 but recovers in
// seconds). Kept separate from tools.ts so the policy is unit-testable.
//
// Policy: a single transient failure does NOT open the breaker — only a sustained
// streak does. This prevents one transient 500 from making a healthy host look
// dead for the agent. A success resets the streak and clears any cooldown.

export class HostBreaker {
  private readonly cooldownUntil = new Map<string, number>()
  private readonly streak = new Map<string, number>()

  constructor(
    private readonly failuresBeforeTrip = 2,
    private readonly cooldownMs = 20000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds remaining on the cooldown for `host` (0 if not cooling down). */
  coolingDownFor(host: string): number {
    return Math.max(0, (this.cooldownUntil.get(host) ?? 0) - this.now())
  }

  isOpen(host: string): boolean {
    return this.coolingDownFor(host) > 0
  }

  /** Record a transient failure. Returns true if the breaker is now open. */
  recordFailure(host: string): boolean {
    const next = (this.streak.get(host) ?? 0) + 1
    this.streak.set(host, next)
    if (next >= this.failuresBeforeTrip) {
      this.cooldownUntil.set(host, this.now() + this.cooldownMs)
      return true
    }
    return false
  }

  /** Record a successful contact: reset the streak and clear any cooldown. */
  recordSuccess(host: string): void {
    this.streak.set(host, 0)
    this.cooldownUntil.set(host, 0)
  }

  /** Current consecutive-failure streak for `host`. */
  failureStreak(host: string): number {
    return this.streak.get(host) ?? 0
  }
}

// Adaptive request spacing for a host. arXiv's export API rate-limits by per-IP
// volume (a burst of ~20-30 requests starts returning 429/500, then recovers).
// Instead of abandoning an important source, we slow down when it pushes back and
// speed back up when it accepts requests again. This keeps arXiv usable while
// staying under its limit, which is the optimal behavior for a primary source.
export class AdaptiveThrottle {
  private readonly delayMs = new Map<string, number>()

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly factor = 2,
  ) {}

  /** The spacing to enforce before the next request to `host`. */
  current(host: string): number {
    return this.delayMs.get(host) ?? this.baseMs
  }

  /** Host pushed back (429/500/timeout): widen the spacing (capped). */
  onRateLimited(host: string): number {
    const next = Math.min(this.maxMs, Math.max(this.baseMs, this.current(host)) * this.factor)
    this.delayMs.set(host, next)
    return next
  }

  /** Host accepted a request: decay the spacing back toward the base interval. */
  onSuccess(host: string): number {
    const next = Math.max(this.baseMs, Math.floor(this.current(host) / this.factor))
    this.delayMs.set(host, next)
    return next
  }
}
