import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { AppError } from "../src/errors.ts";
import { GoogleOAuthClient } from "../src/storage/googleOAuth.ts";
import { FakeGoogleOAuthApi } from "../src/storage/fakeGoogleOAuthApi.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { startGoogleDriveConnect, completeGoogleDriveConnect } from "../src/services/driveConnect.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const OAUTH_CONFIG = { clientId: "id", clientSecret: "secret", redirectUri: "https://portal.example/oauth/google/callback" };
const secretStore = new AesSecretStore(randomBytes(32).toString("hex"));

function stateFromUrl(url: string): string {
  return new URL(url).searchParams.get("state")!;
}

describe("Drive connect: start", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an org admin gets a real Google authorization URL carrying a fresh state", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    const url = await startGoogleDriveConnect(appPool, w.admin, oauth);
    expect(url).toContain("accounts.google.com");
    expect(stateFromUrl(url)).toBeTruthy();
  });

  it("anyone else gets a clean, mapped error, not a raw database error", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    let err: unknown;
    try { await startGoogleDriveConnect(appPool, w.lead, oauth); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
  });
});

describe("Drive connect: complete", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("completes the connection end to end: the stored reference decrypts to the real refresh token", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    const url = await startGoogleDriveConnect(appPool, w.admin, oauth);
    const state = stateFromUrl(url);
    api.seedCode("real-auth-code", { refreshToken: "1//0g-the-real-refresh-token" });

    const result = await completeGoogleDriveConnect(appPool, oauth, secretStore, state, "real-auth-code");
    expect(result).toEqual({ orgId: w.orgA, connectionId: expect.any(String) });

    const row = await adminPool.query("SELECT token_ref FROM storage_connections WHERE id = $1", [result!.connectionId]);
    expect(secretStore.decrypt(row.rows[0].token_ref)).toBe("1//0g-the-real-refresh-token");
    // the raw refresh token is never stored in the clear
    expect(row.rows[0].token_ref).not.toContain("1//0g-the-real-refresh-token");
  });

  it("records an audit log entry attributed to whoever started the flow", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    const url = await startGoogleDriveConnect(appPool, w.admin, oauth);
    const state = stateFromUrl(url);
    api.seedCode("code-for-log", { refreshToken: "refresh-for-log" });
    await completeGoogleDriveConnect(appPool, oauth, secretStore, state, "code-for-log");

    const entry = await adminPool.query("SELECT actor_id, action FROM audit_log WHERE org_id = $1 AND action = 'org.storage_connected' ORDER BY seq DESC LIMIT 1", [w.orgA]);
    expect(entry.rows[0]).toEqual({ actor_id: w.admin, action: "org.storage_connected" });
  });

  it("an invalid state returns null even with a code that would otherwise exchange successfully — the write is gated on the state, not the code", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    api.seedCode("a-perfectly-valid-code", { refreshToken: "would-have-worked" });
    const before = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA]);
    const result = await completeGoogleDriveConnect(appPool, oauth, secretStore, "made-up-state-value", "a-perfectly-valid-code");
    expect(result).toBeNull();
    const after = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("an already-consumed state cannot be completed a second time", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    const url = await startGoogleDriveConnect(appPool, w.admin, oauth);
    const state = stateFromUrl(url);
    api.seedCode("code-1", { refreshToken: "refresh-1" });
    api.seedCode("code-2", { refreshToken: "refresh-2" });
    await completeGoogleDriveConnect(appPool, oauth, secretStore, state, "code-1");
    const second = await completeGoogleDriveConnect(appPool, oauth, secretStore, state, "code-2");
    expect(second).toBeNull();
  });

  it("a failed code exchange (Google rejects the code) surfaces as a clean AppError, and nothing is stored", async () => {
    const api = new FakeGoogleOAuthApi();
    const oauth = new GoogleOAuthClient(OAUTH_CONFIG, api.fetcher);
    const url = await startGoogleDriveConnect(appPool, w.admin, oauth);
    const state = stateFromUrl(url);
    // code is never seeded in the fake, so the exchange fails
    const before = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA]);
    let err: unknown;
    try { await completeGoogleDriveConnect(appPool, oauth, secretStore, state, "bad-code"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    const after = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
