// In-memory per-instance counter: resets on cold start and is not shared across instances.
export class DailyLimiter {
  private readonly limit: number;
  private day = '';
  private counts = new Map<string, number>();

  constructor(limit: number) {
    this.limit = limit;
  }

  remaining(key: string, now: number): number {
    this.rollover(now);
    return Math.max(0, this.limit - (this.counts.get(key) ?? 0));
  }

  take(key: string, now: number): { allowed: boolean; remaining: number } {
    this.rollover(now);
    const used = this.counts.get(key) ?? 0;
    if (used >= this.limit) return { allowed: false, remaining: 0 };
    this.counts.set(key, used + 1);
    return { allowed: true, remaining: this.limit - used - 1 };
  }

  private rollover(now: number): void {
    const day = shanghaiDay(now);
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
    }
  }
}

function shanghaiDay(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
