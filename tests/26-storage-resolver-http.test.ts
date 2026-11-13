import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { adminPool, appPool, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { GoogleOAuthClient } from "../src/storage/googleOAuth.ts";
import { FakeGoogleOAuthApi } from "../src/storage/fakeGoogleOAuthApi.ts";
import { FakeDriveApi } from "../src/storage/fakeDriveApi.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { createStorageResolver, unavailableStorageResolver } from "../src/storage/resolver.ts";
import { AppError } from "../src/errors.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const OAUTH_CFG = { clientId: "id", clientSecret: "secret", redirectUri: "https://api.portal.example/oauth/google/callback" };
const NO_RETRY = { retries: 0, baseDelayMs: 0, sleep: async () => undefined };
const bearer = (auth: FakeTokenVerifier, userId: string) => `Bearer ${auth.issue(userId)}`;

/** A complete wiring of the real app + per-org resolver, against fake Google OAuth and fake Drive. */
function rig() {
  const auth = new FakeTokenVerifier();
  const googleApi = new FakeGoogleOAuthApi();
  const drive = new FakeDriveApi();
  const secretStore = new AesSecretStore(randomBytes(32).toString("hex"));
  const oauth = new GoogleOAuthClient(OAUTH_CFG, googleApi.fetcher);
  const app = createApp({
    pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth,
    jwtSecret: "test-jwt-secret", appBaseUrl: "https://portal.example",
    storageResolver: createStorageResolver({ pool: appPool, oauth, secretStore, jwtSecret: "test-jwt-secret-test-jwt-secret-1234", driveFetcher: drive.fetcher, driveRetry: NO_RETRY }),
  });
  /** Stores a connection for an org exactly as the OAuth callback does (encrypted refresh token). */
  const connect = async (orgId: string, refreshToken: string) => {
    googleApi.seedRefreshToken(refreshToken);
    const r = await adminPool.query(
      "INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,'google_drive',$2,'active') RETURNING id",
      [orgId, secretStore.encrypt(refreshToken)]);
    return r.rows[0].id as string;
  };
  const call = (method: "get" | "post", path: string, userId: string, body?: object) => {
    const r = request(app)[method](path).set("Authorization", bearer(auth, userId));
    return body ? r.send(body) : r;
  };
  const folderCreations = () => drive.calls.filter((c) => c.method === "POST" && c.url.startsWith("/drive/v3/files?"));
  return { app, auth, googleApi, drive, secretStore, connect, call, folderCreations };
}

const upload = { fileName: "mfa-settings.pdf", mimeType: "application/pdf", sizeBytes: 1000 };

describe("setting up a tenant's evidence folder", () => {
  it("an org admin creates it in the org's own Drive; it is recorded, audited, and can't be created twice", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");

    const res = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(w.tA1);
    expect(res.body.storageRootId).toBeTruthy();

    // It talked to Drive using THIS org's credential, after a single token refresh.
    expect(t.folderCreations()).toHaveLength(1);
    expect(t.folderCreations()[0].auth).toBe("Bearer access-rt-A-1");
    expect(t.googleApi.refreshCount).toBe(1);

    const row = await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1]);
    expect(row.rows[0].storage_root_id).toBe(res.body.storageRootId);
    const log = await adminPool.query("SELECT actor_id FROM audit_log WHERE org_id = $1 AND action = 'tenant.storage_root_created'", [w.orgA]);
    expect(log.rows.map((r) => r.actor_id)).toEqual([w.admin]);

    const again = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("STORAGE_ROOT_EXISTS");
    expect(t.folderCreations()).toHaveLength(1); // no second folder was made
  });

  it("two simultaneous clicks produce exactly one folder", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    const [a, b] = await Promise.all([
      t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin),
      t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(t.folderCreations()).toHaveLength(1);
  });

  it("is refused for everyone except an org admin, and nothing is created or even contacted", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    for (const u of [w.lead, w.auditor, w.readOnly, w.dash, w.tLead, w.contrib, w.viewer, w.tDash]) {
      const res = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, u);
      expect(res.status, u).toBe(403);
    }
    expect(t.drive.calls).toHaveLength(0);
    expect(t.googleApi.refreshCount).toBe(0);
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).toBeNull();
  });

  it("an admin of a DIFFERENT org can't touch this org's tenant, and no provider is contacted", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A"); await t.connect(w.orgB, "rt-B");
    const res = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.adminB);
    expect(res.status).toBe(404);
    expect(t.drive.calls).toHaveLength(0);
  });

  it("if Drive refuses, the tenant is left unchanged and the failure is reported cleanly", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    t.drive.queueFailure(403);
    const res = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("STORAGE_PERMISSION_DENIED");
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).toBeNull();
    const log = await adminPool.query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'tenant.storage_root_created'", [w.orgA]);
    expect(log.rowCount).toBe(0);
    // ...and trying again once Drive is healthy works.
    expect((await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin)).status).toBe(201);
  });

  it("when Google says its Drive API is switched off, the admin is told exactly that and how to fix it", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    t.drive.queueFailure(403, 1, { error: { code: 403, message: "Google Drive API has not been used in project 42 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=42 then retry.", errors: [{ reason: "accessNotConfigured" }] } });
    const res = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("STORAGE_PERMISSION_DENIED");
    expect(res.body.error.message).toMatch(/^Storage error: Drive permission denied \(403\): the Google Drive API is switched off/);
    expect(res.body.error.message).toContain("project=42");
  });
});

describe("evidence upload through the per-org resolver", () => {
  it("a contributor uploads and confirms a file; one token refresh serves the whole flow", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);

    const session = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(session.status).toBe(200);
    expect(session.body.providerFileId).toBeTruthy();

    const confirm = await t.call("post", `/controls/${c}/uploads/confirm`, w.contrib, { providerFileId: session.body.providerFileId });
    expect(confirm.status).toBe(201);
    expect(confirm.body.scanStatus).toBe("clean");

    // Creating the root, the control folder, the upload session, metadata, download: all one credential.
    expect(new Set(t.drive.calls.map((x) => x.auth))).toEqual(new Set(["Bearer access-rt-A-1"]));
    expect(t.googleApi.refreshCount).toBe(1);
  });

  it("tells Drive which page the browser is on, so Drive lets that page read its answer — but only for this portal's own pages", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);
    const init = () => t.drive.calls.filter((x) => x.method === "POST" && x.url.startsWith("/upload/drive/v3/files"));
    const ask = (origin?: string) => { const r = t.call("post", `/controls/${c}/upload-session`, w.contrib, upload); return origin ? r.set("Origin", origin) : r; };

    expect((await ask("https://portal.example")).status).toBe(200);
    expect(init().at(-1)!.origin).toBe("https://portal.example");
    expect((await ask("https://evil.example")).status).toBe(200);
    expect(init().at(-1)!.origin).toBeUndefined();            // a stranger's page is never named to Drive
    expect((await ask()).status).toBe(200);
    expect(init().at(-1)!.origin).toBeUndefined();
  });

  it("a Drive file that sits in a different control's folder can't be recorded against this control", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    const c1 = await controlId(w.auditA1, "A.8.5"); const c2 = await controlId(w.auditA1, "A.8.6");
    await assignContributor(w, c1); await assignContributor(w, c2);
    const one = await t.call("post", `/controls/${c1}/upload-session`, w.contrib, upload);
    const two = await t.call("post", `/controls/${c2}/upload-session`, w.contrib, upload);
    expect(two.status).toBe(200);
    const swapped = await t.call("post", `/controls/${c2}/uploads/confirm`, w.contrib, { providerFileId: one.body.providerFileId });
    expect(swapped.status).toBe(422);
    expect(swapped.body.error.code).toBe("FILE_NOT_IN_FOLDER");
    // a file id that exists nowhere in this org's Drive is simply not found
    const ghost = await t.call("post", `/controls/${c2}/uploads/confirm`, w.contrib, { providerFileId: "file-from-another-org" });
    expect(ghost.status).toBe(404);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM evidence_files WHERE audit_control_id = $1", [c2])).rows[0].n).toBe(0);
    // the right pairing still works
    expect((await t.call("post", `/controls/${c1}/uploads/confirm`, w.contrib, { providerFileId: one.body.providerFileId })).status).toBe(201);
  });

  it("a recorded Drive file can be downloaded through the portal by someone who may see it, and the download is logged", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A");
    await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);
    const session = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    t.drive.seedFileContent(session.body.providerFileId, new TextEncoder().encode("drive file body"));
    expect((await t.call("post", `/controls/${c}/uploads/confirm`, w.contrib, { providerFileId: session.body.providerFileId })).status).toBe(201);
    const id = (await t.call("get", `/controls/${c}/files`, w.contrib)).body[0].id;
    const dl = await t.call("get", `/evidence/${id}/download`, w.contrib).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).toString()).toBe("drive file body");
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="mfa-settings.pdf"/);
    expect((await t.call("get", `/evidence/${id}/download`, w.adminB)).status).toBe(404);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'evidence.downloaded' AND entity_id = $1", [id])).rows[0].n).toBe(1);
  });

  it("two organisations never use each other's credentials", async () => {
    const w = await makeWorld(); const t = rig();
    await t.connect(w.orgA, "rt-A"); await t.connect(w.orgB, "rt-B");

    await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    const afterA = t.drive.calls.length;
    await t.call("post", `/tenants/${w.tB1}/storage-root/create`, w.adminB);

    const aCalls = t.drive.calls.slice(0, afterA).map((x) => x.auth);
    const bCalls = t.drive.calls.slice(afterA).map((x) => x.auth);
    expect(aCalls.length).toBeGreaterThan(0);
    expect(bCalls.length).toBeGreaterThan(0);
    expect(aCalls.every((a) => a.includes("rt-A"))).toBe(true);
    expect(bCalls.every((a) => a.includes("rt-B"))).toBe(true);
    expect(t.googleApi.refreshCount).toBe(2); // one per org, not shared
  });

  it("a user who can't see the control gets the normal 'not found', not a storage error", async () => {
    // Org with NO connection at all: the existing access checks must still answer first.
    const w = await makeWorld(); const t = rig();
    const c = await controlId(w.auditA1, "A.8.5");
    const res = await t.call("post", `/controls/${c}/upload-session`, w.dash, upload);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(t.googleApi.refreshCount).toBe(0);
  });

  it("an org that never connected Drive gets a clear, actionable message", async () => {
    const w = await makeWorld(); const t = rig();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'some-folder' WHERE id = $1", [w.tA1]);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);
    const res = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STORAGE_NOT_CONNECTED");
    expect(res.body.error.message).toMatch(/Settings → Integrations/);
  });

  it("a Google outage during token refresh is a retryable 503 and does NOT disconnect the org", async () => {
    const w = await makeWorld(); const t = rig();
    const conn = await t.connect(w.orgA, "rt-A");
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root' WHERE id = $1", [w.tA1]);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);

    t.googleApi.queueRefreshFailure(503);
    const down = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("STORAGE_PROVIDER_UNAVAILABLE");
    expect((await adminPool.query("SELECT status FROM storage_connections WHERE id = $1", [conn])).rows[0].status).toBe("active");

    const ok = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(ok.status).toBe(200); // the very next attempt succeeds
  });
});

describe("when Google stops honouring the stored credential", () => {
  async function connectedWorld() {
    const w = await makeWorld(); const t = rig();
    t.googleApi.setAccessTokenLifetime(0); // never cached, so every call really asks Google
    const conn = await t.connect(w.orgA, "rt-A");
    await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);
    return { w, t, conn, c };
  }

  it("is detected, recorded in the audit log, and tells the user an admin must reconnect", async () => {
    const { w, t, conn, c } = await connectedWorld();
    t.googleApi.revokeRefreshToken("rt-A");

    const res = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STORAGE_RECONNECT_REQUIRED");
    expect(res.body.error.message).toMatch(/org admin/i);

    // The flag survives even though the failing request itself rolled back.
    expect((await adminPool.query("SELECT status FROM storage_connections WHERE id = $1", [conn])).rows[0].status).toBe("revoked");
    const log = await adminPool.query("SELECT actor_id FROM audit_log WHERE org_id = $1 AND action = 'org.storage_revoked'", [w.orgA]);
    expect(log.rows.map((r) => r.actor_id)).toEqual([w.contrib]);
  });

  it("afterwards stops bothering Google at all and keeps answering clearly", async () => {
    const { w, t, c } = await connectedWorld();
    t.googleApi.revokeRefreshToken("rt-A");
    await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    const before = t.googleApi.refreshCount;

    const next = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(next.status).toBe(409);
    expect(next.body.error.code).toBe("STORAGE_NOT_CONNECTED");
    expect(t.googleApi.refreshCount).toBe(before);
  });

  it("works again as soon as the org reconnects", async () => {
    const { w, t, conn, c } = await connectedWorld();
    t.googleApi.revokeRefreshToken("rt-A");
    await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);

    t.googleApi.seedRefreshToken("rt-A2"); // what a fresh OAuth connection would store
    await adminPool.query("UPDATE storage_connections SET status = 'active', token_ref = $2 WHERE id = $1", [conn, t.secretStore.encrypt("rt-A2")]);

    const res = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(res.status).toBe(200);
    expect(t.drive.calls.at(-1)!.auth).toContain("rt-A2");
  });

  it("credentials encrypted under a different key are reported as needing a reconnect, not marked revoked", async () => {
    const w = await makeWorld(); const t = rig();
    const foreign = new AesSecretStore(randomBytes(32).toString("hex"));
    const r = await adminPool.query(
      "INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,'google_drive',$2,'active') RETURNING id",
      [w.orgA, foreign.encrypt("rt-A")]);
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root' WHERE id = $1", [w.tA1]);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);

    const res = await t.call("post", `/controls/${c}/upload-session`, w.contrib, upload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STORAGE_RECONNECT_REQUIRED");
    expect(t.googleApi.refreshCount).toBe(0); // can't decrypt, so Google is never asked
    expect((await adminPool.query("SELECT status FROM storage_connections WHERE id = $1", [r.rows[0].id])).rows[0].status).toBe("active");
  });
});

describe("providers and configuration", () => {
  it("an org on a provider this server can't drive yet gets a clear 501", async () => {
    const w = await makeWorld(); const t = rig();
    await adminPool.query("UPDATE orgs SET storage_provider = 'sharepoint' WHERE id = $1", [w.orgA]);
    await adminPool.query("INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,'sharepoint','x','active')", [w.orgA]);
    const res = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("STORAGE_PROVIDER_UNSUPPORTED");
  });

  it("createApp refuses to start with no storage backend at all", () => {
    expect(() => createApp({
      pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: new FakeTokenVerifier(),
      jwtSecret: "x", appBaseUrl: "https://x.example",
    })).toThrow(/storage backend/);
  });

  it("with Drive unconfigured, storage actions give a clear 503 while everything else keeps working", async () => {
    const w: World = await makeWorld(); const auth = new FakeTokenVerifier();
    const app = createApp({
      pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth,
      jwtSecret: "x", appBaseUrl: "https://x.example",
      storageResolver: unavailableStorageResolver(new AppError("Drive isn't configured.", 503, "OAUTH_NOT_CONFIGURED")),
    });
    const blocked = await request(app).post(`/tenants/${w.tA1}/storage-root/create`).set("Authorization", bearer(auth, w.admin));
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe("OAUTH_NOT_CONFIGURED");
    const fine = await request(app).get("/tenants").set("Authorization", bearer(auth, w.admin));
    expect(fine.status).toBe(200);
  });

  it("a fixed `storage` still works for simple setups and tests, and the resolver wins when both are given", async () => {
    const w = await makeWorld(); const auth = new FakeTokenVerifier();
    const fixed = new InMemoryStorageProvider();
    const fixedOnly = createApp({ pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "x", appBaseUrl: "https://x.example", storage: fixed });
    const ok = await request(fixedOnly).post(`/tenants/${w.tA1}/storage-root/create`).set("Authorization", bearer(auth, w.admin));
    expect(ok.status).toBe(201);

    const w2 = await makeWorld();
    const both = createApp({
      pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "x", appBaseUrl: "https://x.example",
      storage: fixed, storageResolver: unavailableStorageResolver(new AppError("resolver was used", 503, "RESOLVER_USED")),
    });
    const res = await request(both).post(`/tenants/${w2.tA1}/storage-root/create`).set("Authorization", bearer(auth, w2.admin));
    expect(res.body.error.code).toBe("RESOLVER_USED");
  });
});
