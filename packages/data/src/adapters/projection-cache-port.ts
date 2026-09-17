/**
 * Redis-class projection cache port (DATA-LIFECYCLE store classes: "leases,
 * presence, bounded cache and revocation cache — TTL mandatory, no content
 * authority — fall back to authority or fail closed"). Projections are
 * disposable and never authoritative; every entry is TTL-bounded by
 * construction. The real Redis client arrives with G4 provisioning; the
 * in-memory double implements the same contract for tests and the retention
 * evidence.
 */
export class MissingTtlError extends Error {
  constructor() {
    super("a projection-cache entry requires a positive TTL — caches are bounded, never authority");
    this.name = "MissingTtlError";
  }
}

export interface ProjectionCachePort {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): string | null;
  /** Remove every projection of the tenant. Failure must be retryable; it can never restore access. */
  purgeTenantProjections(tenantId: string): Promise<void>;
}

export class InMemoryProjectionCache implements ProjectionCachePort {
  private readonly entries = new Map<string, string>();
  private failuresToInject = 0;
  purgeAttempts = 0;

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new MissingTtlError();
    }
    this.entries.set(key, value);
  }

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  failNextPurges(count: number): void {
    this.failuresToInject = count;
  }

  async purgeTenantProjections(tenantId: string): Promise<void> {
    this.purgeAttempts += 1;
    if (this.failuresToInject > 0) {
      this.failuresToInject -= 1;
      throw new Error("injected cache failure");
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${tenantId}:`)) {
        this.entries.delete(key);
      }
    }
  }
}
