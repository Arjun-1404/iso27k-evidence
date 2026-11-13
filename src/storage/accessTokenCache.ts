export interface LoadedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Keeps short-lived access tokens in memory so a burst of Drive calls (list a folder, create it, open an
 * upload session, read metadata, download for scanning) costs ONE token refresh, not one each.
 *
 * Three rules worth knowing:
 *  - A token is treated as expired a safety margin BEFORE it really is, so a call never starts with a
 *    token that dies mid-flight.
 *  - Concurrent callers for the same key share one in-flight refresh instead of each firing their own.
 *  - Failures are never cached — the next caller simply tries again.
 *
 * Tokens live only in this process's memory: never logged, never written to the database. The key is
 * whatever uniquely identifies the credential (the encrypted refresh-token reference), so reconnecting
 * an org naturally produces a new key and the old entry is simply never asked for again.
 */
export class AccessTokenCache {
  private entries = new Map<string, { token: string; expiresAt: number }>();
  private inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly safetyMarginMs = 60_000,
    private readonly maxEntries = 500,
  ) {}

  async get(key: string, load: () => Promise<LoadedAccessToken>): Promise<string> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt - this.safetyMarginMs > this.now()) return hit.token;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const loaded = await load();
        this.remember(key, loaded.accessToken, this.now() + loaded.expiresInSeconds * 1000);
        return loaded.accessToken;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, p);
    return p;
  }

  /** Forget a credential's token, e.g. after the provider rejected it. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private remember(key: string, token: string, expiresAt: number): void {
    this.entries.delete(key); // re-insert so Map order tracks recency
    this.entries.set(key, { token, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
