/** Spread overdue upkeep across ticks, leaving startup and wake time to the user. */
export class NightlyAdmission {
  private lastTickAt: number;
  private settleUntil: number;
  private tick = -1;
  private claimed = false;
  private attempts = new Map<string, number>();
  constructor(now = Date.now(), private readonly settleMs = 10 * 60_000) {
    this.lastTickAt = now;
    this.settleUntil = now + settleMs;
  }
  begin(tick: number, now = Date.now()): void {
    if (tick === this.tick) return;
    // A long gap is a wake or a stalled loop. Neither should trigger a burst.
    if (now - this.lastTickAt > 90_000) this.settleUntil = now + this.settleMs;
    this.lastTickAt = now;
    this.tick = tick;
    this.claimed = false;
  }
  claim(job: string, now = Date.now()): boolean {
    if (this.claimed || now < this.settleUntil) return false;
    // Failed jobs retry, but cannot monopolize every tick and starve later jobs.
    if (now - (this.attempts.get(job) ?? -Infinity) < 5 * 60_000) return false;
    this.claimed = true;
    this.attempts.set(job, now);
    return true;
  }
}
export const nightlyAdmission = new NightlyAdmission();
