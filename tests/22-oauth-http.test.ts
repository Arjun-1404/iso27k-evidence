import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { GoogleOAuthClient } from "../src/storage/googleOAuth.ts";
import { FakeGoogleOAuthApi } from "../src/storage/fakeGoogleOAuthApi.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const APP_BASE = "https://portal.example";
const OAUTH_CONFIG = { clientId: "id", clientSecret: "secret", redirectUri: "https://api.portal.example/oauth/google/callback" };

function setup(opts: { configured?: boolean } = { configured: true }) {
  const auth = new FakeTokenVerifier();
  const googleApi = new FakeGoogleOAuthApi();
  const secretStore = new AesSecretStore(randomBytes(32).toString("hex"));
  const app = createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(),
    tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: APP_BASE,
    ...(opts.configured !== false ? { secretStore, googleOAuth: new GoogleOAuthClient(OAUTH_CONFIG, googleApi.fetcher) } : {}),
  });
  return { app, auth, googleApi, secretStore };
}
const bearer = (auth: FakeTokenVerifier, userId: string) => `Bearer ${auth.issue(userId)}`;
const stateFromUrl = (url: string) => new URL(url).searchParams.get("state")!;

describe("POST /org/storage-connections/google/start", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an org admin gets a Google authorization URL", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/org/storage-connections/google/start").set("Authorization", bearer(auth, w.admin));
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.google.com");
    expect(stateFromUrl(res.body.url)).toBeTruthy();
  });

  it("nobody else can start a connection", async () => {
    const { app, auth } = setup();
    for (const u of [w.lead, w.auditor, w.tLead, w.contrib]) {
      const res = await request(app).post("/org/storage-connections/google/start").set("Authorization", bearer(auth, u));
      expect(res.status).toBe(403);
    }
  });

  it("requires authentication", async () => {
    const { app } = setup();
    const res = await request(app).post("/org/storage-connections/google/start");
    expect(res.status).toBe(401);
  });

  it("returns a clear 503 when Google OAuth isn't configured on this server", async () => {
    const { app, auth } = setup({ configured: false });
    const res = await request(app).post("/org/storage-connections/google/start").set("Authorization", bearer(auth, w.admin));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("OAUTH_NOT_CONFIGURED");
  });
});

describe("GET /oauth/google/callback", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  async function startFlow(app: ReturnType<typeof setup>["app"], auth: FakeTokenVerifier) {
    const res = await request(app).post("/org/storage-connections/google/start").set("Authorization", bearer(auth, w.admin));
    return stateFromUrl(res.body.url);
  }
  const storedCount = async () =>
    (await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n as number;

  it("completes the flow end to end, with no bearer token at all, and redirects to the frontend with a success marker", async () => {
    const { app, auth, googleApi, secretStore } = setup();
    const state = await startFlow(app, auth);
    googleApi.seedCode("auth-code-1", { refreshToken: "1//0g-the-real-refresh-token" });

    const res = await request(app).get("/oauth/google/callback").query({ code: "auth-code-1", state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_BASE}/settings/integrations?connected=google_drive`);

    const row = await adminPool.query("SELECT token_ref FROM storage_connections WHERE org_id = $1 AND provider = 'google_drive'", [w.orgA]);
    expect(secretStore.decrypt(row.rows[0].token_ref)).toBe("1//0g-the-real-refresh-token");
  });

  it("an invalid state redirects with an error and stores nothing, even with a code that would have exchanged fine", async () => {
    const { app, googleApi } = setup();
    googleApi.seedCode("perfectly-good-code", { refreshToken: "irrelevant" });
    const before = await storedCount();
    const res = await request(app).get("/oauth/google/callback").query({ code: "perfectly-good-code", state: "forged-state-value" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_BASE}/settings/integrations?error=invalid_or_expired_state`);
    expect(await storedCount()).toBe(before);
  });

  it("a replayed (already-used) state is rejected the second time", async () => {
    const { app, auth, googleApi } = setup();
    const state = await startFlow(app, auth);
    googleApi.seedCode("c1", { refreshToken: "r1" });
    googleApi.seedCode("c2", { refreshToken: "r2" });
    const first = await request(app).get("/oauth/google/callback").query({ code: "c1", state });
    expect(first.headers.location).toContain("connected=google_drive");
    const second = await request(app).get("/oauth/google/callback").query({ code: "c2", state });
    expect(second.headers.location).toContain("error=invalid_or_expired_state");
  });

  it("the user declining consent on Google's screen redirects with Google's own error code", async () => {
    const { app } = setup();
    const before = await storedCount();
    const res = await request(app).get("/oauth/google/callback").query({ error: "access_denied" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_BASE}/settings/integrations?error=access_denied`);
    expect(await storedCount()).toBe(before);
  });

  it("a callback with neither code nor state redirects with a clear error rather than crashing", async () => {
    const { app } = setup();
    const res = await request(app).get("/oauth/google/callback");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_BASE}/settings/integrations?error=missing_code_or_state`);
  });

  it("a malformed query (repeated params) redirects rather than returning a JSON error page", async () => {
    const { app } = setup();
    const res = await request(app).get("/oauth/google/callback?code=a&code=b&state=x");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`${APP_BASE}/settings/integrations?error=`);
  });

  it("a failed code exchange redirects with an error code and stores nothing", async () => {
    const { app, auth } = setup();
    const state = await startFlow(app, auth);
    const before = await storedCount();
    const res = await request(app).get("/oauth/google/callback").query({ code: "never-seeded-code", state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`${APP_BASE}/settings/integrations?error=`);
    expect(await storedCount()).toBe(before);
  });

  it("when OAuth isn't configured, redirects with not_configured instead of a raw 503 page", async () => {
    const { app } = setup({ configured: false });
    const res = await request(app).get("/oauth/google/callback").query({ code: "x", state: "y" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_BASE}/settings/integrations?error=not_configured`);
  });

  it("being public doesn't loosen anything else: a neighbouring route is still protected", async () => {
    const { app } = setup();
    const res = await request(app).get("/org/storage-connections");
    expect(res.status).toBe(401);
  });
});
