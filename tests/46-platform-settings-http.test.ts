import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import net from "node:net";
import request from "supertest";
import { SMTPServer } from "smtp-server";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeClamd } from "../src/scan/fakeClamd.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";
import { dbSessionCheck } from "../src/auth/sessionCheck.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { hashPassword } from "../src/auth/password.ts";
import { totpAtStep, stepAt } from "../src/auth/totp.ts";
import { flushNotices } from "../src/services/notices.ts";
import { createRuntimeSettings } from "../src/settings/runtime.ts";

/**
 * Server settings over HTTP: who may see and change them, what saving asks for, what is never sent back, what is
 * locked by the server's environment, and that the two "check it works" buttons really talk to the mail server and the
 * scanner.
 */

const SECRET = "platform-settings-test-secret-value-long";
const STORE = new AesSecretStore("66".repeat(32));
const PW = "a-perfectly-good-password-123";
const MAIL_PW = "the-mail-account-password-XyZ-9";
const GOOGLE_SECRET = "GOCSPX-super-secret-client-value";
let PW_HASH: string;

function setup(over: Partial<AppDeps> = {}) {
  const email = new FakeEmailSender();
  const app = createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email,
    tokenVerifier: new JwtTokenVerifier(SECRET, dbSessionCheck(appPool)), jwtSecret: SECRET, appBaseUrl: "https://portal.example",
    secretStore: STORE, ...over,
  });
  return { app, email };
}
type App = ReturnType<typeof setup>["app"];

let clock = 0;
function freeze() {
  clock = Math.ceil(Date.now() / 30_000) * 30_000 + 15_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
}
const freshCode = (secret: string) => { clock += 30_000; vi.setSystemTime(clock); return totpAtStep(secret, stepAt(Date.now())); };
function wrongCode(secret: string) {
  const ok = new Set([-2, -1, 0, 1, 2].map((o) => totpAtStep(secret, stepAt(Date.now()) + o)));
  for (let i = 0; ; i++) { const c = String(i).padStart(6, "0"); if (!ok.has(c)) return c; }
}

let w: World; let ownerEmail: string;
beforeAll(async () => {
  PW_HASH = await hashPassword(PW);
  w = await makeWorld();
  await adminPool.query("UPDATE users SET password_hash=$2, is_platform_owner=true WHERE id=$1", [w.admin, PW_HASH]);
  await adminPool.query("UPDATE users SET password_hash=$2 WHERE id = ANY($1)", [[w.lead, w.adminB, w.tLead], PW_HASH]);
  ownerEmail = (await adminPool.query("SELECT email FROM users WHERE id=$1", [w.admin])).rows[0].email;
});
beforeEach(async () => { freeze(); await adminPool.query("DELETE FROM platform_settings"); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  await adminPool.query("DELETE FROM platform_settings");
  await adminPool.query("UPDATE users SET is_platform_owner=false WHERE id=$1", [w.admin]);
  await adminPool.end(); await appPool.end();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = (app: App, email: string) => request(app).post("/auth/login").send({ email, password: PW });
const emailOf = async (id: string) => (await adminPool.query("SELECT email FROM users WHERE id=$1", [id])).rows[0].email as string;
const tokenOf = async (app: App, id: string) => {
  const r = await login(app, await emailOf(id));
  expect(r.status).toBe(200);
  return r.body.token as string;
};
const get = (app: App, t: string, path = "/platform/settings") => request(app).get(path).set(bearer(t));
const put = (app: App, t: string, group: string, settings: object, extra: object = { password: PW }) =>
  request(app).put(`/platform/settings/${group}`).set(bearer(t)).send({ settings, ...extra });
const clearG = (app: App, t: string, group: string, body: object = { password: PW }) =>
  request(app).post(`/platform/settings/${group}/clear`).set(bearer(t)).send(body);
const post = (app: App, t: string, path: string, body: object = {}) => request(app).post(path).set(bearer(t)).send(body);

const EMAIL = { host: "mail.example.test", port: 587, security: "starttls", user: "mailer", password: MAIL_PW, from: "Evidence Portal <noreply@firm.example>" };
const SCANNER = { host: "clamav", port: 3310 };
const GOOGLE = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: GOOGLE_SECRET, redirectUri: "https://portal.example.com/oauth/google/callback" };

const rows = async () => (await adminPool.query("SELECT * FROM platform_settings ORDER BY key")).rows as Array<Record<string, unknown>>;
const group = (body: { groups: Array<{ group: string }> }, name: string) => body.groups.find((g) => g.group === name) as Record<string, unknown>;
const failedCount = async (id: string) => (await adminPool.query("SELECT failed_login_count AS n FROM users WHERE id=$1", [id])).rows[0].n as number;
const audits = async (action: string) =>
  (await adminPool.query("SELECT actor_id, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 ORDER BY seq", [w.orgA, action])).rows as Array<Record<string, unknown>>;

/** An owner who also uses two-step sign-in (a second owner, so the first stays simple). */
let seq = 0;
async function ownerWithTwoStep(app: App) {
  const addr = `owner2-${++seq}-${w.tag}@audit-a-${w.tag}.test`;
  const id = (await adminPool.query(
    "INSERT INTO users (org_id, email, role, status, password_hash, is_platform_owner) VALUES ($1,$2,'org_admin','active',$3,true) RETURNING id", [w.orgA, addr, PW_HASH])).rows[0].id as string;
  const session = (await login(app, addr)).body.token as string;
  const secret = (await post(app, session, "/auth/mfa/enroll", { password: PW })).body.secret as string;
  const done = await post(app, session, "/auth/mfa/enroll/confirm", { code: freshCode(secret) });
  expect(done.status).toBe(200);
  return { id, email: addr, secret, session, recoveryCodes: done.body.recoveryCodes as string[] };
}

// ====================================================================================================================
describe("who can use the server settings", () => {
  it("asks whether you are the owner: yes for the owner, no for everyone else, and it needs a sign-in", async () => {
    const { app } = setup();
    expect((await request(app).get("/platform/owner")).status).toBe(401);
    expect((await get(app, await tokenOf(app, w.admin), "/platform/owner")).body).toEqual({ owner: true });
    for (const u of [w.lead, w.adminB, w.tLead]) expect((await get(app, await tokenOf(app, u), "/platform/owner")).body, u).toEqual({ owner: false });
  });

  it("nobody but the owner can see, save, remove or test anything — not even another organisation admin", async () => {
    const { app } = setup();
    for (const u of [w.lead, w.adminB, w.tLead]) {
      const t = await tokenOf(app, u);
      const expectForbidden = (r: request.Response) => { expect(r.status, u).toBe(403); expect(r.body.error.code).toBe("FORBIDDEN_ROLE"); };
      expectForbidden(await get(app, t));
      expectForbidden(await put(app, t, "scanner", SCANNER));
      expectForbidden(await put(app, t, "email", EMAIL));
      expectForbidden(await clearG(app, t, "email"));
      expectForbidden(await post(app, t, "/platform/settings/email/test"));
      expectForbidden(await post(app, t, "/platform/settings/scanner/test"));
    }
    expect(await rows()).toEqual([]);
  });

  it("nothing is reachable without signing in", async () => {
    const { app } = setup();
    expect((await request(app).get("/platform/settings")).status).toBe(401);
    expect((await request(app).put("/platform/settings/scanner").send({ settings: SCANNER, password: PW })).status).toBe(401);
    expect((await request(app).post("/platform/settings/scanner/clear").send({ password: PW })).status).toBe(401);
    expect((await request(app).post("/platform/settings/email/test")).status).toBe(401);
    expect((await get(app, "not-a-token")).status).toBe(401);
  });

  it("a refused attempt leaves no mark in the audit log", async () => {
    const { app } = setup();
    const before = (await audits("platform.setting_saved")).length;
    await put(app, await tokenOf(app, w.adminB), "scanner", SCANNER);
    expect((await audits("platform.setting_saved")).length).toBe(before);
  });

  it("an unknown group is not found", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    expect((await put(app, t, "smtp", SCANNER)).status).toBe(404);
    expect((await clearG(app, t, "everything")).status).toBe(404);
  });
});

// ====================================================================================================================
describe("reading the settings", () => {
  it("starts with nothing set up, and says whether secrets can be stored", async () => {
    const { app } = setup();
    const r = await get(app, await tokenOf(app, w.admin));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.canStoreSecrets).toBe(true);
    expect(r.body.needsCode).toBe(false);
    expect(r.body.groups.map((g: { group: string }) => g.group)).toEqual(["email", "scanner", "google"]);
    for (const g of r.body.groups) {
      expect(g).toMatchObject({ source: "none", locked: false, values: null, secretsSet: [], updatedAt: null, updatedBy: null, problem: null });
    }
  });

  it("says when the server has no encryption key", async () => {
    const { app } = setup({ secretStore: undefined });
    expect((await get(app, await tokenOf(app, w.admin))).body.canStoreSecrets).toBe(false);
  });
});

// ====================================================================================================================
describe("saving the email settings", () => {
  it("saves them, keeps the password encrypted, and never sends it back", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const r = await put(app, t, "email", EMAIL);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const e = group(r.body, "email");
    expect(e).toMatchObject({ source: "panel", locked: false, secretsSet: ["password"], updatedBy: ownerEmail, problem: null });
    expect(e.values).toEqual({ host: "mail.example.test", port: 587, security: "starttls", user: "mailer", from: "Evidence Portal <noreply@firm.example>" });
    expect(typeof e.updatedAt).toBe("string");
    expect(JSON.stringify(r.body)).not.toContain(MAIL_PW);
    expect(JSON.stringify((await get(app, t)).body)).not.toContain(MAIL_PW);

    const [row] = await rows();
    expect(JSON.stringify(row)).not.toContain(MAIL_PW);
    expect(row.config).toEqual({ host: "mail.example.test", port: 587, security: "starttls", user: "mailer", from: "Evidence Portal <noreply@firm.example>" });
    expect(row.secrets_set).toEqual(["password"]);
    expect(JSON.parse(STORE.decrypt(row.secret_enc as string))).toEqual({ password: MAIL_PW });
  });

  it("defaults the port from the encryption choice", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const r = await put(app, t, "email", { host: "mail.example.test", security: "tls", from: "noreply@firm.example" });
    expect(r.status).toBe(200);
    expect((group(r.body, "email").values as { port: number }).port).toBe(465);
    expect(group(r.body, "email").secretsSet).toEqual([]);
  });

  it("writes the field names, never the values, to the audit log", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "email", EMAIL);
    const a = (await audits("platform.setting_saved")).filter((x) => x.entity_id === "email");
    expect(a.length).toBeGreaterThan(0);
    const last = a[a.length - 1];
    expect(last.actor_id).toBe(w.admin);
    expect((last.change as { fields: string[] }).fields.sort()).toEqual(["from", "host", "password", "port", "security", "user"]);
    const text = JSON.stringify(a);
    for (const v of [MAIL_PW, "mail.example.test", "mailer", "noreply@firm.example"]) expect(text).not.toContain(v);
  });

  it("a second save lists only what changed", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "email", EMAIL);
    await put(app, t, "email", { ...EMAIL, password: undefined, host: "smtp.other.test" });
    const a = (await audits("platform.setting_saved")).filter((x) => x.entity_id === "email");
    expect((a[a.length - 1].change as { fields: string[] }).fields).toEqual(["host"]);
  });

  it("a blank password keeps the stored one; a typed one replaces it; removing the username drops it", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "email", EMAIL);

    for (const blank of [undefined, "", null]) {
      expect((await put(app, t, "email", { ...EMAIL, host: "smtp2.example.test", password: blank })).status).toBe(200);
      expect(JSON.parse(STORE.decrypt((await rows())[0].secret_enc as string))).toEqual({ password: MAIL_PW });
    }
    expect((await put(app, t, "email", { ...EMAIL, password: "a-new-mail-password-42" })).status).toBe(200);
    expect(JSON.parse(STORE.decrypt((await rows())[0].secret_enc as string))).toEqual({ password: "a-new-mail-password-42" });

    const r = await put(app, t, "email", { host: "mail.example.test", port: 25, security: "starttls", from: "noreply@firm.example" });
    expect(r.status).toBe(200);
    expect(group(r.body, "email").secretsSet).toEqual([]);
    const [row] = await rows();
    expect(row.secret_enc).toBeNull();
    expect((row.config as Record<string, unknown>).user).toBeUndefined();
  });

  it("asks for the password the first time a username is entered", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const r = await put(app, t, "email", { ...EMAIL, password: undefined });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION");
    expect(r.body.error.message).toMatch(/password for the mail account/);
    expect(await rows()).toEqual([]);
  });

  it("refuses mistakes, says what is wrong, and saves nothing", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const bad: Array<[object, RegExp]> = [
      [{ ...EMAIL, host: "" }, /mail server is required/],
      [{ ...EMAIL, host: "smtp://mail.example.test" }, /without http:\/\/ or smtp:\/\/ or a path/],
      [{ ...EMAIL, host: "mail.example.test/relay" }, /without http:\/\/ or smtp:\/\/ or a path/],
      [{ ...EMAIL, host: "mail example.test" }, /no spaces, port or other symbols/],
      [{ ...EMAIL, host: "mail.example.test:587" }, /no spaces, port or other symbols/],
      [{ ...EMAIL, host: "mail.example.test\r\nBcc: x" }, /control characters|no spaces/],
      [{ ...EMAIL, host: 5 }, /must be text/],
      [{ ...EMAIL, port: 0 }, /port must be a whole number between 1 and 65535/],
      [{ ...EMAIL, port: 70000 }, /port must be a whole number/],
      [{ ...EMAIL, port: "abc" }, /port must be a whole number/],
      [{ ...EMAIL, port: 25.5 }, /port must be a whole number/],
      [{ ...EMAIL, security: "ssl" }, /STARTTLS, TLS or none/],
      [{ ...EMAIL, security: "" }, /Encryption is required/],
      [{ ...EMAIL, security: "none" }, /would travel unencrypted/],
      [{ ...EMAIL, from: "" }, /From address is required/],
      [{ ...EMAIL, from: "no-at-sign" }, /must be an email address/],
      [{ ...EMAIL, from: "a@b.test\nBcc: evil@x.test" }, /control characters/],
      [{ ...EMAIL, user: "u".repeat(300) }, /too long/],
      [{ ...EMAIL, password: "line\nbreak" }, /line break/],
      [{ ...EMAIL, password: 12345 }, /must be text/],
      [{ host: "mail.example.test", security: "starttls", from: "a@b.test", password: "orphan" }, /needs a username/],
    ];
    for (const [body, message] of bad) {
      const r = await put(app, t, "email", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
      expect(r.body.error.message).toMatch(message);
    }
    expect(await rows()).toEqual([]);
  });

  it("allows 'none' for a local mail catcher when there is no login", async () => {
    const { app } = setup();
    const r = await put(app, await tokenOf(app, w.admin), "email", { host: "mailpit", port: 1025, security: "none", from: "noreply@portal.local" });
    expect(r.status).toBe(200);
  });

  it("checks the shape of the request", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    for (const body of [{}, { password: PW }, { settings: "x", password: PW }, { settings: [], password: PW }, { settings: EMAIL }, { settings: EMAIL, password: "" },
      { settings: EMAIL, password: PW, code: "" }, { settings: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, 1])), password: PW }]) {
      const r = await request(app).put("/platform/settings/email").set(bearer(t)).send(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await rows()).toEqual([]);
  });
});

// ====================================================================================================================
describe("the running server uses what was saved straight away", () => {
  it("even though settings are normally remembered for a while", async () => {
    const runtime = createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {}, ttlMs: 3_600_000, warn: () => undefined });
    const { app } = setup({ settings: runtime });
    const t = await tokenOf(app, w.admin);
    expect((await runtime.current()).scanner.source).toBe("none"); // remembered: nothing is set up
    await put(app, t, "scanner", SCANNER);
    expect((await runtime.current()).scanner).toMatchObject({ source: "panel", settings: { host: "clamav", port: 3310 } });
    await clearG(app, t, "scanner");
    expect((await runtime.current()).scanner.source).toBe("none");
  });

  it("and the settings page shows what is true now, not what was remembered", async () => {
    const runtime = createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {}, ttlMs: 3_600_000, warn: () => undefined });
    const { app } = setup({ settings: runtime });
    const t = await tokenOf(app, w.admin);
    expect(group((await get(app, t)).body, "scanner").source).toBe("none");
    await adminPool.query(`INSERT INTO platform_settings (key, config) VALUES ('scanner', '{"host":"clamav","port":3310,"timeoutSeconds":60,"maxFileMb":25}')`);
    expect(group((await get(app, t)).body, "scanner").source).toBe("panel");
  });
});

describe("saving the scanner and Google settings", () => {
  it("saves the scanner with sensible defaults and no secrets", async () => {
    const { app } = setup();
    const r = await put(app, await tokenOf(app, w.admin), "scanner", SCANNER);
    expect(r.status).toBe(200);
    expect(group(r.body, "scanner")).toMatchObject({ source: "panel", secretsSet: [], values: { host: "clamav", port: 3310, timeoutSeconds: 60, maxFileMb: 25 } });
    expect((await rows())[0].secret_enc).toBeNull();
  });

  it("refuses scanner values out of range", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    for (const body of [{ ...SCANNER, host: "" }, { ...SCANNER, port: 0 }, { ...SCANNER, timeoutSeconds: 0 }, { ...SCANNER, timeoutSeconds: 601 }, { ...SCANNER, maxFileMb: 0 }, { ...SCANNER, maxFileMb: 5000 }, { ...SCANNER, host: "http://clamav" }]) {
      const r = await put(app, t, "scanner", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await rows()).toEqual([]);
  });

  it("saves the Google app details with the client secret encrypted and never returned", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const r = await put(app, t, "google", GOOGLE);
    expect(r.status).toBe(200);
    expect(group(r.body, "google")).toMatchObject({
      source: "panel", secretsSet: ["clientSecret"],
      values: { clientId: GOOGLE.clientId, redirectUri: GOOGLE.redirectUri },
    });
    expect(JSON.stringify(r.body)).not.toContain(GOOGLE_SECRET);
    expect(JSON.stringify(await rows())).not.toContain(GOOGLE_SECRET);
    expect(JSON.parse(STORE.decrypt((await rows())[0].secret_enc as string))).toEqual({ clientSecret: GOOGLE_SECRET });
    // Leaving the secret blank when editing keeps it.
    expect((await put(app, t, "google", { ...GOOGLE, clientSecret: "", clientId: "999-new.apps.googleusercontent.com" })).status).toBe(200);
    expect(JSON.parse(STORE.decrypt((await rows())[0].secret_enc as string))).toEqual({ clientSecret: GOOGLE_SECRET });
  });

  it("needs the client secret the first time, and checks the redirect address", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const bad: Array<[object, RegExp]> = [
      [{ ...GOOGLE, clientSecret: undefined }, /Enter the client secret/],
      [{ ...GOOGLE, clientId: "" }, /client ID is required/],
      [{ ...GOOGLE, clientId: "has space" }, /can't contain spaces/],
      [{ ...GOOGLE, clientSecret: "two words" }, /looks wrong/],
      [{ ...GOOGLE, redirectUri: "portal.example.com/oauth/google/callback" }, /full web address/],
      [{ ...GOOGLE, redirectUri: "http://portal.example.com/oauth/google/callback" }, /must start with https/],
      [{ ...GOOGLE, redirectUri: "ftp://portal.example.com/oauth/google/callback" }, /must start with https/],
      [{ ...GOOGLE, redirectUri: "https://portal.example.com/callback" }, /must end with \/oauth\/google\/callback/],
      [{ ...GOOGLE, redirectUri: "https://portal.example.com/oauth/google/callback?x=1" }, /can't contain a login, a \? query or a # fragment/],
      [{ ...GOOGLE, redirectUri: "https://portal.example.com/oauth/google/callback#frag" }, /can't contain a login/],
      [{ ...GOOGLE, redirectUri: "https://user:pw@portal.example.com/oauth/google/callback" }, /can't contain a login/],
    ];
    for (const [body, message] of bad) {
      const r = await put(app, t, "google", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.message).toMatch(message);
    }
    expect(await rows()).toEqual([]);
    // Plain http is fine for a machine you are sitting at.
    expect((await put(app, t, "google", { ...GOOGLE, redirectUri: "http://localhost:3000/oauth/google/callback" })).status).toBe(200);
  });
});

// ====================================================================================================================
describe("confirming it is you", () => {
  it("a wrong password saves nothing and counts toward the lock-out", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const before = await failedCount(w.admin);
    const r = await put(app, t, "scanner", SCANNER, { password: "wrong-password-entirely" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("INVALID_PASSWORD");
    expect(await rows()).toEqual([]);
    expect(await failedCount(w.admin)).toBe(before + 1);
    await adminPool.query("UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1", [w.admin]);
  });

  it("a typing mistake is reported before the password is checked, so it never counts as a wrong password", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const before = await failedCount(w.admin);
    const r = await put(app, t, "scanner", { host: "", port: 3310 }, { password: "wrong-password-entirely" });
    expect(r.status).toBe(400);
    expect(await failedCount(w.admin)).toBe(before);
  });

  it("removing a group also asks for the password", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "scanner", SCANNER);
    const r = await clearG(app, t, "scanner", { password: "wrong-password-entirely" });
    expect(r.status).toBe(403);
    expect(await rows()).toHaveLength(1);
    expect((await clearG(app, t, "scanner", {})).status).toBe(400);
    await adminPool.query("UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1", [w.admin]);
  });

  it("an owner who uses two-step sign-in must give a code too, and a good one works", async () => {
    const { app } = setup();
    const o = await ownerWithTwoStep(app);
    expect((await get(app, o.session)).body.needsCode).toBe(true);

    const none = await put(app, o.session, "scanner", SCANNER);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("MFA_CODE_REQUIRED");
    const wrong = await put(app, o.session, "scanner", SCANNER, { password: PW, code: wrongCode(o.secret) });
    expect(wrong.status).toBe(403);
    expect(await rows()).toEqual([]);

    const ok = await put(app, o.session, "scanner", SCANNER, { password: PW, code: freshCode(o.secret) });
    expect(ok.status).toBe(200);
    expect(group(ok.body, "scanner").source).toBe("panel");
    expect((await clearG(app, o.session, "scanner", { password: PW })).status).toBe(400); // removing needs it too
    expect((await clearG(app, o.session, "scanner", { password: PW, code: freshCode(o.secret) })).status).toBe(200);
    expect(await rows()).toEqual([]);
  });

  it("a recovery code is accepted, is used up, and the owner is told by email", async () => {
    const { app, email } = setup();
    const o = await ownerWithTwoStep(app);
    await flushNotices(5_000);
    const before = email.sent.length;
    expect((await put(app, o.session, "scanner", SCANNER, { password: PW, code: o.recoveryCodes[0] })).status).toBe(200);
    expect((await put(app, o.session, "scanner", SCANNER, { password: PW, code: o.recoveryCodes[0] })).status).toBe(403); // spent
    await flushNotices(5_000);
    const mails = email.sent.slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([o.email]);
    expect(mails[0].subject).toBe("A recovery code was used on your Evidence Portal account");
  });
});

// ====================================================================================================================
describe("removing a group", () => {
  it("puts it back to not set up, and records it", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "email", EMAIL);
    const before = (await audits("platform.setting_cleared")).length;
    const r = await clearG(app, t, "email");
    expect(r.status).toBe(200);
    expect(group(r.body, "email")).toMatchObject({ source: "none", values: null, secretsSet: [] });
    expect(await rows()).toEqual([]);
    expect((await audits("platform.setting_cleared")).length - before).toBe(1);
    // Removing what isn't there is harmless and not recorded again.
    expect((await clearG(app, t, "email")).status).toBe(200);
    expect((await audits("platform.setting_cleared")).length - before).toBe(1);
  });
});

// ====================================================================================================================
describe("settings the server's environment provides", () => {
  const ENV_EMAIL = { host: "env-mail.example.test", port: 587, security: "starttls" as const, user: "envuser", password: "env-secret-password", from: "noreply@env.example" };

  it("are shown (without secrets) as locked, and cannot be changed or removed here", async () => {
    const { app } = setup({ envSettings: { email: ENV_EMAIL } });
    const t = await tokenOf(app, w.admin);
    const v = await get(app, t);
    expect(group(v.body, "email")).toMatchObject({
      source: "environment", locked: true, secretsSet: [],
      values: { host: "env-mail.example.test", port: 587, security: "starttls", user: "envuser", from: "noreply@env.example" },
    });
    expect(JSON.stringify(v.body)).not.toContain("env-secret-password");
    expect(group(v.body, "scanner").locked).toBe(false);

    const p = await put(app, t, "email", EMAIL);
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("SETTING_LOCKED");
    expect((await clearG(app, t, "email")).body.error.code).toBe("SETTING_LOCKED");
    expect(await rows()).toEqual([]);
    expect((await put(app, t, "scanner", SCANNER)).status).toBe(200); // the others are still editable
  });

  it("win over anything saved in the web app earlier", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "email", EMAIL);
    const { app: locked } = setup({ envSettings: { email: ENV_EMAIL } });
    const v = await get(locked, t);
    expect(group(v.body, "email")).toMatchObject({ source: "environment", values: { host: "env-mail.example.test" } });
  });

  it("don't show what an earlier web-app save left behind (its secrets, who saved it, when)", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "email", EMAIL);
    // Sanity: before the environment takes over, the page does show them.
    expect(group((await get(app, t)).body, "email")).toMatchObject({ source: "panel", secretsSet: ["password"] });
    const { app: locked } = setup({ envSettings: { email: ENV_EMAIL } });
    const e = group((await get(locked, t)).body, "email");
    expect(e.source).toBe("environment");
    expect(e.secretsSet).toEqual([]);
    expect(e.updatedBy).toBeNull();
    expect(e.updatedAt).toBeNull();
    // The old row is still there (the environment only hides it), so removing the environment's settings brings it back.
    expect(await rows()).toHaveLength(1);
  });
});

// ====================================================================================================================
describe("a server without an encryption key", () => {
  it("can't store passwords or secrets, but can still save the scanner", async () => {
    const { app } = setup({ secretStore: undefined });
    const t = await tokenOf(app, w.admin);
    const e = await put(app, t, "email", { host: "mailpit", port: 1025, security: "none", from: "a@b.test" });
    expect(e.status).toBe(503);
    expect(e.body.error.code).toBe("SETTINGS_NEED_ENCRYPTION_KEY");
    expect((await put(app, t, "google", GOOGLE)).body.error.code).toBe("SETTINGS_NEED_ENCRYPTION_KEY");
    expect(await rows()).toEqual([]);
    expect((await put(app, t, "scanner", SCANNER)).status).toBe(200);
  });
});

// ====================================================================================================================
describe("saved settings that can't be used", () => {
  it("are reported, ignored, and can be entered again", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    // Saved under a different key, as after the server's key changed.
    const other = new AesSecretStore("77".repeat(32));
    await adminPool.query(
      "INSERT INTO platform_settings (key, config, secret_enc, secrets_set) VALUES ('email', $1::jsonb, $2, ARRAY['password'])",
      [JSON.stringify({ host: "mail.example.test", port: 587, security: "starttls", user: "mailer", from: "a@b.test" }), other.encrypt(JSON.stringify({ password: "old" }))]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = await get(app, t);
    expect(group(v.body, "email")).toMatchObject({ source: "none", values: null });
    expect(group(v.body, "email").problem).toMatch(/encryption key/);

    const r = await put(app, t, "email", EMAIL); // typing it all again repairs it
    expect(r.status).toBe(200);
    expect(group(r.body, "email")).toMatchObject({ source: "panel", problem: null });
  });

  it("includes a row whose values are no longer valid", async () => {
    const { app } = setup();
    await adminPool.query(`INSERT INTO platform_settings (key, config) VALUES ('scanner', '{"host":"bad host","port":3310}')`);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = await get(app, await tokenOf(app, w.admin));
    expect(group(v.body, "scanner")).toMatchObject({ source: "none", values: null });
    expect(group(v.body, "scanner").problem).toMatch(/no longer valid/);
  });
});

// ====================================================================================================================
describe("flood protection", () => {
  it("limits how often the settings can be saved or tested", async () => {
    const { app } = setup({ authLimits: { signIn: 3 } });
    const t = await tokenOf(app, w.admin);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await put(app, t, "scanner", SCANNER, { password: "wrong-password-entirely" })).status);
    expect(codes.slice(0, 3)).toEqual([403, 403, 403]);
    expect(codes.slice(3)).toEqual([429, 429]);
    await adminPool.query("UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1", [w.admin]);
  });

  it("limits how often a setting can be removed", async () => {
    const { app } = setup({ authLimits: { signIn: 2 } });
    const t = await tokenOf(app, w.admin);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await clearG(app, t, "scanner", { password: "wrong-password-entirely" })).status);
    expect(codes).toEqual([403, 403, 429, 429]);
    await adminPool.query("UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1", [w.admin]);
  });

  it("limits how often the test email can be sent, and how often the scanner can be checked", async () => {
    const { app } = setup({ authLimits: { signIn: 2 } });
    const t = await tokenOf(app, w.admin);
    // Nothing is set up, so each answers "not configured" until the limit is reached.
    for (const path of ["/platform/settings/email/test", "/platform/settings/scanner/test"]) {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await post(app, t, path)).status);
      expect(codes, path).toEqual([409, 409, 429, 429]);
    }
  });
});

// ====================================================================================================================
describe("checking that email really works", () => {
  let smtp: SMTPServer; let port: number;
  const received: Array<{ to: string[]; text: string }> = [];
  beforeAll(async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    smtp = new SMTPServer({
      authOptional: true, disabledCommands: ["STARTTLS"],
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on("data", (d: Buffer) => chunks.push(d));
        stream.on("end", () => { received.push({ to: session.envelope.rcptTo.map((r) => r.address), text: Buffer.concat(chunks).toString("utf8") }); cb(); });
      },
    });
    smtp.on("error", () => undefined);
    await new Promise<void>((res) => smtp.listen(0, "127.0.0.1", res));
    port = (smtp.server.address() as net.AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((res) => smtp.close(() => res())); });
  beforeEach(() => { received.length = 0; });

  it("says so when no mail server is set up", async () => {
    const { app } = setup();
    const r = await post(app, await tokenOf(app, w.admin), "/platform/settings/email/test");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NOT_CONFIGURED");
    expect(received).toEqual([]);
  });

  it("sends a message through the saved mail server, to the owner's own address and nobody else", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    expect((await put(app, t, "email", { host: "127.0.0.1", port, security: "none", from: "Portal <noreply@portal.local>" })).status).toBe(200);
    const r = await post(app, t, "/platform/settings/email/test");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, sentTo: ownerEmail });
    expect(received).toHaveLength(1);
    expect(received[0].to).toEqual([ownerEmail]);
    expect(received[0].text).toContain("Evidence Portal: test email");
    // Nothing in the request can choose another recipient.
    await post(app, t, "/platform/settings/email/test", { to: "someone-else@example.test", email: "x@example.test" });
    expect(received.every((m) => m.to.length === 1 && m.to[0] === ownerEmail)).toBe(true);
  });

  it("works for settings that come from the server's environment too", async () => {
    const { app } = setup({ envSettings: { email: { host: "127.0.0.1", port, security: "none", from: "noreply@portal.local" } } });
    const r = await post(app, await tokenOf(app, w.admin), "/platform/settings/email/test");
    expect(r.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("reports a mail server it can't reach, without saying anything about the password", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const dead = await new Promise<number>((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
    await put(app, t, "email", { host: "127.0.0.1", port: dead, security: "starttls", user: "mailer", password: MAIL_PW, from: "noreply@portal.local" });
    const r = await post(app, t, "/platform/settings/email/test");
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("EMAIL_TEST_FAILED");
    expect(r.body.error.message).toMatch(/could not reach the mail server/);
    expect(JSON.stringify(r.body)).not.toContain(MAIL_PW);
  });
});

// ====================================================================================================================
describe("checking that the malware scanner really works", () => {
  let clamd: FakeClamd;
  beforeAll(async () => { clamd = await FakeClamd.start(); });
  afterAll(async () => { await clamd.close(); });

  it("says so when no scanner is set up", async () => {
    const { app } = setup();
    const r = await post(app, await tokenOf(app, w.admin), "/platform/settings/scanner/test");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("passes when the scanner answers and flags the standard test file as a virus", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    await put(app, t, "scanner", { host: "127.0.0.1", port: clamd.port });
    const before = clamd.scans.length;
    const r = await post(app, t, "/platform/settings/scanner/test");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(clamd.scans.length).toBe(before + 1);
  });

  it("fails clearly when the scanner can't be reached", async () => {
    const { app } = setup();
    const t = await tokenOf(app, w.admin);
    const dead = await new Promise<number>((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
    await put(app, t, "scanner", { host: "127.0.0.1", port: dead, timeoutSeconds: 2 });
    const r = await post(app, t, "/platform/settings/scanner/test");
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("SCANNER_TEST_FAILED");
  });

  it("fails when something answers but does not flag the test file (signatures not loaded, or not a scanner at all)", async () => {
    const lax = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("error", () => undefined);
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.toString("latin1").startsWith("zPING")) sock.end("PONG\0");
        else if (buf.length >= 4 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) sock.end("stream: OK\0");
      });
    });
    await new Promise<void>((res) => lax.listen(0, "127.0.0.1", res));
    try {
      const { app } = setup();
      const t = await tokenOf(app, w.admin);
      await put(app, t, "scanner", { host: "127.0.0.1", port: (lax.address() as net.AddressInfo).port });
      const r = await post(app, t, "/platform/settings/scanner/test");
      expect(r.status).toBe(502);
      expect(r.body.error.code).toBe("SCANNER_TEST_WEAK");
      expect(r.body.error.message).toMatch(/did not report the standard antivirus test file/);
    } finally {
      await new Promise<void>((res) => lax.close(() => res()));
    }
  });
});
