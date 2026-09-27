/**
 * Simple in-memory cache for stream URL requests to avoid duplicate API calls.
 * Caches responses with a TTL to prevent excessive requests to the same endpoint.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class StreamUrlsCache {
  private cache = new Map<string, CacheEntry<any>>();
  private inflight = new Map<string, Promise<any>>();
  private readonly defaultTtlMs = 60_000;

  /**
   * Get a cached value if it exists and hasn't expired.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Set a value in the cache with a TTL.
   */
  set<T>(key: string, data: T, ttlMs: number = this.defaultTtlMs): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Clear a specific cache entry.
   */
  clear(key: string): void {
    this.cache.delete(key);
    this.inflight.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  clearAll(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /**
   * Get or set a value using a factory function.
   * Useful for preventing the "thundering herd" problem.
   */
  async getOrFetch<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) return cached;

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const request = factory()
      .then((data) => {
        if (this.inflight.get(key) === request) this.set(key, data, ttlMs);
        return data;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });

    this.inflight.set(key, request);
    return request;
  }
}

// Export singleton instance
export const streamUrlsCache = new StreamUrlsCache();
