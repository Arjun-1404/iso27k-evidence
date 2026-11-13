import { describe, it, expect, vi } from "vitest";
import { GoogleOAuthClient } from "../src/storage/googleOAuth.ts";
import { FakeGoogleOAuthApi } from "../src/storage/fakeGoogleOAuthApi.ts";
import { AccessTokenCache } from "../src/storage/accessTokenCache.ts";
import { LazyStorageProvider } from "../src/storage/lazyProvider.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { StorageAuthRevokedError, StorageError } from "../src/storage/types.ts";

const CFG = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://api.example/oauth/google/callback" };
const client = (api: FakeGoogleOAuthApi) => new GoogleOAuthClient(CFG, api.fetcher);

async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}

describe("GoogleOAuthClient.refreshAccessToken", () => {
  it("trades a refresh token for an access token and says how long it lasts", async () => {
    const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("rt-1");
    const t = await client(api).refreshAccessToken("rt-1");
    expect(t.accessToken).toBe("access-rt-1-1");
    expect(t.expiresInSeconds).toBe(3600);
  });

  it("sends exactly what Google's refresh grant requires (and nothing it shouldn't)", async () => {
    const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("rt-1");
    await client(api).refreshAccessToken("rt-1");
    const body = new URLSearchParams(api.calls[0].body);
    expect(api.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    expect(body.get("code")).toBeNull();
  });

  it("each refresh yields a fresh access token", async () => {
    const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("rt-1");
    const a = await client(api).refreshAccessToken("rt-1");
    const b = await client(api).refreshAccessToken("rt-1");
    expect(a.accessToken).not.toBe(b.accessToken);
  });

  it("recognises a revoked/expired refresh token as its own, non-retryable condition", async () => {
    const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("rt-1"); api.revokeRefreshToken("rt-1");
    const e = await caught(client(api).refreshAccessToken("rt-1"));
    expect(e).toBeInstanceOf(StorageAuthRevokedError);
    expect(e).toBeInstanceOf(StorageError); // so existing StorageError handling still applies
    expect((e as StorageError).retryable).toBe(false);
    expect((e as StorageError).code).toBe("PERMISSION_DENIED");
  });

  it("treats a token Google has never heard of the same way", async () => {
    const e = await caught(client(new FakeGoogleOAuthApi()).refreshAccessToken("unknown"));
    expect(e).toBeInstanceOf(StorageAuthRevokedError);
  });

  it("does NOT call a Google outage or rate limit 'revoked' — those are retryable", async () => {
    for (const status of [500, 503, 429]) {
      const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("rt-1"); api.queueRefreshFailure(status);
      const e = await caught(client(api).refreshAccessToken("rt-1"));
      expect(e, String(status)).not.toBeInstanceOf(StorageAuthRevokedError);
      expect((e as StorageError).retryable, String(status)).toBe(true);
      expect((e as StorageError).code, String(status)).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("a different client error (e.g. bad client secret) is a permanent, non-revoked failure", async () => {
    const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("rt-1");
    api.queueRefreshFailure(401, { error: "invalid_client" });
    const e = await caught(client(api).refreshAccessToken("rt-1"));
    expect(e).not.toBeInstanceOf(StorageAuthRevokedError);
    expect((e as StorageError).code).toBe("INVALID_REQUEST");
    expect((e as StorageError).retryable).toBe(false);
  });

  it("a network failure is retryable", async () => {
    const c = new GoogleOAuthClient(CFG, (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
    const e = await caught(c.refreshAccessToken("rt"));
    expect((e as StorageError).retryable).toBe(true);
    expect((e as StorageError).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("a 200 with a malformed body is treated as a transient provider problem, not accepted", async () => {
    for (const body of [{}, { access_token: "x" }, { expires_in: 3600 }, { access_token: "x", expires_in: "soon" }]) {
      const c = new GoogleOAuthClient(CFG, (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch);
      const e = await caught(c.refreshAccessToken("rt"));
      expect((e as StorageError).code, JSON.stringify(body)).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("never puts the refresh token or secret into an error message", async () => {
    const api = new FakeGoogleOAuthApi(); api.seedRefreshToken("super-secret-rt"); api.queueRefreshFailure(400, { error: "invalid_request" });
    const e = (await caught(client(api).refreshAccessToken("super-secret-rt"))) as Error;
    expect(e.message).not.toContain("super-secret-rt");
    expect(e.message).not.toContain("csecret");
  });
});

describe("AccessTokenCache", () => {
  const loader = (token: string, expiresInSeconds = 3600) => vi.fn(async () => ({ accessToken: token, expiresInSeconds }));

  it("loads once and then serves from memory", async () => {
    const cache = new AccessTokenCache();
    const load = loader("t1");
    expect(await cache.get("k", load)).toBe("t1");
    expect(await cache.get("k", load)).toBe("t1");
    expect(await cache.get("k", load)).toBe("t1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token that is inside the safety margin, before it actually expires", async () => {
    let now = 1_000_000;
    const cache = new AccessTokenCache(() => now, 60_000);
    const load = vi.fn().mockResolvedValueOnce({ accessToken: "old", expiresInSeconds: 3600 }).mockResolvedValueOnce({ accessToken: "new", expiresInSeconds: 3600 });
    expect(await cache.get("k", load)).toBe("old");
    now += 3_539_000; // 3539s in: still 61s of life left, outside the 60s margin
    expect(await cache.get("k", load)).toBe("old");
    now += 2_000;     // 3541s in: only 59s left, inside the margin
    expect(await cache.get("k", load)).toBe("new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a token that expires sooner than the margin is never served at all", async () => {
    const cache = new AccessTokenCache(() => 0, 60_000);
    const load = loader("short", 30);
    await cache.get("k", load); await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers for one key share a single in-flight load", async () => {
    const cache = new AccessTokenCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const load = vi.fn(async () => { await gate; return { accessToken: "shared", expiresInSeconds: 3600 }; });
    const calls = Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load), cache.get("k", load)]);
    release();
    expect(await calls).toEqual(["shared", "shared", "shared", "shared"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure — the next caller tries again", async () => {
    const cache = new AccessTokenCache();
    const load = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ accessToken: "ok", expiresInSeconds: 3600 });
    await expect(cache.get("k", load)).rejects.toThrow("boom");
    expect(await cache.get("k", load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failure reaches every caller that was waiting on it", async () => {
    const cache = new AccessTokenCache();
    let fail!: () => void;
    const gate = new Promise<void>((_, rej) => { fail = () => rej(new Error("shared failure")); });
    const load = vi.fn(async () => { await gate; return { accessToken: "x", expiresInSeconds: 1 }; });
    const a = cache.get("k", load); const b = cache.get("k", load);
    fail();
    await expect(a).rejects.toThrow("shared failure");
    await expect(b).rejects.toThrow("shared failure");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps different credentials strictly apart", async () => {
    const cache = new AccessTokenCache();
    expect(await cache.get("org-a", loader("token-a"))).toBe("token-a");
    expect(await cache.get("org-b", loader("token-b"))).toBe("token-b");
    expect(await cache.get("org-a", loader("WRONG"))).toBe("token-a");
  });

  it("invalidate() forces the next call to load again", async () => {
    const cache = new AccessTokenCache();
    const load = vi.fn().mockResolvedValueOnce({ accessToken: "a", expiresInSeconds: 3600 }).mockResolvedValueOnce({ accessToken: "b", expiresInSeconds: 3600 });
    await cache.get("k", load);
    cache.invalidate("k");
    expect(await cache.get("k", load)).toBe("b");
  });

  it("is bounded: past the limit the oldest-stored entry is dropped", async () => {
    const cache = new AccessTokenCache(Date.now, 60_000, 3);
    for (const k of ["a", "b", "c"]) await cache.get(k, loader(`t-${k}`));
    await cache.get("d", loader("t-d"));    // pushes the oldest ("a") out
    expect(cache.size).toBe(3);
    const reload = loader("t-a-again");
    expect(await cache.get("a", reload)).toBe("t-a-again");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("LazyStorageProvider", () => {
  it("does nothing — and fetches no credentials — until a storage method is actually used", () => {
    const resolve = vi.fn(async () => new InMemoryStorageProvider());
    new LazyStorageProvider(resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves once and reuses the provider across calls", async () => {
    const real = new InMemoryStorageProvider();
    const resolve = vi.fn(async () => real);
    const lazy = new LazyStorageProvider(resolve);
    const root = await lazy.createRootFolder("Root");
    const sub = await lazy.findOrCreateFolder(root.id, "A.5.1");
    const again = await lazy.findOrCreateFolder(root.id, "A.5.1");
    expect(sub.id).toBe(again.id);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("concurrent first calls share one resolution", async () => {
    let n = 0;
    const real = new InMemoryStorageProvider();
    const lazy = new LazyStorageProvider(async () => { n++; await new Promise((r) => setTimeout(r, 10)); return real; });
    await Promise.all([lazy.createRootFolder("a"), lazy.createRootFolder("b"), lazy.createRootFolder("c")]);
    expect(n).toBe(1);
  });

  it("passes the real provider's errors straight through", async () => {
    const lazy = new LazyStorageProvider(async () => new InMemoryStorageProvider());
    await expect(lazy.getFileMetadata("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a failed resolution is not remembered: after the cause is fixed, the next call works", async () => {
    let healthy = false;
    const lazy = new LazyStorageProvider(async () => {
      if (!healthy) throw new Error("not connected yet");
      return new InMemoryStorageProvider();
    });
    await expect(lazy.createRootFolder("x")).rejects.toThrow("not connected yet");
    healthy = true;
    expect((await lazy.createRootFolder("x")).id).toBeTruthy();
  });

  it("delegates every method of the contract", async () => {
    const lazy = new LazyStorageProvider(async () => new InMemoryStorageProvider());
    const root = await lazy.createRootFolder("Root");
    const folder = await lazy.findOrCreateFolder(root.id, "A.8.5");
    const session = await lazy.createUploadSession(folder.id, "x.pdf", "application/pdf", 10);
    const meta = await lazy.getFileMetadata(session.providerFileId);
    expect(meta.name).toBe("x.pdf");
    expect((await lazy.listFiles(folder.id)).map((f) => f.name)).toEqual(["x.pdf"]);
    expect((await lazy.downloadFile(session.providerFileId)).mimeType).toBe("application/pdf");
  });
});
