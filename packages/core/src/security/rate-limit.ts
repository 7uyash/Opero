/**
 * Fixed-window rate limiter. The in-memory store is per process; a Redis-backed store
 * implementing the same interface is added with the queue layer.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    }
    return { ...bucket };
  }
}

export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async check(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const { count, resetAt } = await this.store.hit(key, this.windowMs);
    return { allowed: count <= this.limit, remaining: Math.max(0, this.limit - count), resetAt };
  }
}
