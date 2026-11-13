import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";
import { dbSessionCheck } from "../src/auth/sessionCheck.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import * as passwords from "../src/auth/password.ts";
import { issuedAtAfter } from "../src/services/account.ts";
import { totpAtStep, stepAt } from "../src/auth/totp.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const SECRET = "change-password-test-secret-long-enough";
const STORE = new AesSecretStore("33".repeat(32));
const PW = "a-perfectly-good-password-123";
const NEW_PW = "a-brand-new-password-6789";
const NEWER_PW = "yet-another-fresh-password-42";
let PW_HASH: string;

function setup(over: Partial<AppDeps> = {}) {
  return createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(),
    tokenVerifier: new JwtTokenVerifier(SECRET, dbSessionCheck(appPool)), jwtSecret: SECRET, appBaseUrl: "https://portal.example",
    secretStore: STORE, ...over,
  });
}
type App = ReturnType<typeof setup>;

// A clock we control only where a test needs it (codes change every 30 seconds; waiting is not an option).
let clock = 0;
function freeze() {
  clock = Math.ceil(Date.now() / 30_000) * 30_000 + 15_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
}
const freshCode = (secret: string) => { clock += 30_000; vi.setSystemTime(clock); return totpAtStep(secret, stepAt(Date.now())); };
function wrongCode(secret: string) {
  const ok = new Set([-1, 0, 1].map((o) => totpAtStep(secret, stepAt(Date.now()) + o)));
  for (let i = 0; ; i++) { const c = String(i).padStart(6, "0"); if (!ok.has(c)) return c; }
}

beforeAll(async () => { PW_HASH = await passwords.hashPassword(PW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (app: App, t: string, path: string) => request(app).get(path).set(bearer(t));
const post = (app: App, t: string, path: string, body: object = {}) => request(app).post(path).set(bearer(t)).send(body);
const login = (app: App, email: string, password = PW) => request(app).post("/auth/login").send({ email, password });
const change = (app: App, t: string, body: object) => post(app, t, "/auth/change-password", body);
/** A session token as it would have been issued a minute ago, i.e. before a change happening now. */
const oldSession = (userId: string) => jwt.sign({ sub: userId, iat: Math.floor(Date.now() / 1000) - 60 }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });

let seq = 0;
async function mkUser(w: World, role = "auditor", password: string | null = PW_HASH) {
  const email = `u${++seq}-${w.tag}@audit-a-${w.tag}.test`;
  const id = (await adminPool.query(
    "INSERT INTO users (org_id, email, full_name, role, status, password_hash) VALUES ($1,$2,'Test User',$3,'active',$4) RETURNING id", [w.orgA, email, role, password])).rows[0].id as string;
  return { id, email };
}
const userRow = async (id: string) => (await adminPool.query("SELECT password_hash, failed_login_count, locked_until, sessions_valid_after FROM users WHERE id=$1", [id])).rows[0];
const auditCount = async (org: string, action: string, actor: string) =>
  (await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND action=$2 AND actor_id=$3", [org, action, actor])).rows[0].n as number;
const mfaRow = async (id: string) => (await adminPool.query("SELECT * FROM user_mfa WHERE user_id=$1", [id])).rows[0];

/** Walks the real journey to turn two-step sign-in on. */
async function withTwoStep(app: App, w: World) {
  const u = await mkUser(w);
  const session = (await login(app, u.email)).body.token as string;
  const secret = (await post(app, session, "/auth/mfa/enroll", { password: PW })).body.secret as string;
  const done = await post(app, session, "/auth/mfa/enroll/confirm", { code: freshCode(secret) });
  expect(done.status).toBe(200);
  return { ...u, secret, recoveryCodes: done.body.recoveryCodes as string[] };
}
const twoStepSession = async (app: App, email: string, secret: string, password = PW) => {
  const first = await login(app, email, password);
  expect(first.body.mfaRequired).toBe(true);
  const second = await request(app).post("/auth/mfa/verify").send({ mfaToken: first.body.mfaToken, code: freshCode(secret) });
  expect(second.status).toBe(200);
  return second.body.token as string;
};

// ====================================================================================================================
describe("changing your password", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup(); });

  it("needs a signed-in session", async () => {
    expect((await request(app).post("/auth/change-password").send({ currentPassword: PW, newPassword: NEW_PW })).status).toBe(401);
    expect((await change(app, "not-a-token", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(401);
  });

  it("is refused for a session that has been ended", async () => {
    const u = await mkUser(w);
    const stale = oldSession(u.id);
    await adminPool.query("UPDATE users SET sessions_valid_after = now() WHERE id=$1", [u.id]);
    const r = await change(app, stale, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(401);
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
  });

  it("checks what it is given", async () => {
    const u = await mkUser(w);
    const s = (await login(app, u.email)).body.token as string;
    for (const body of [{}, { currentPassword: PW }, { newPassword: NEW_PW }, { currentPassword: "", newPassword: NEW_PW }, { currentPassword: PW, newPassword: "" },
      { currentPassword: PW, newPassword: NEW_PW, code: "" }, { currentPassword: PW, newPassword: NEW_PW, code: "x".repeat(65) },
      { currentPassword: "x".repeat(1025), newPassword: NEW_PW }, { currentPassword: PW, newPassword: "x".repeat(1025) }, { currentPassword: 1, newPassword: NEW_PW }]) {
      const r = await change(app, s, body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
  });

  it("changes the password: the new one signs in, the old one no longer does", async () => {
    const u = await mkUser(w);
    const s = (await login(app, u.email)).body.token as string;
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(r.body).sort()).toEqual(["role", "tenantId", "token", "userId"]);
    expect(r.body).toMatchObject({ userId: u.id, role: "auditor", tenantId: null });
    expect(JSON.stringify(r.body)).not.toContain(NEW_PW);

    const old = await login(app, u.email, PW);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe("INVALID_CREDENTIALS");
    expect((await login(app, u.email, NEW_PW)).status).toBe(200);
    expect(await passwords.verifyPassword(NEW_PW, (await userRow(u.id)).password_hash)).toBe(true);
  });

  it("ends every other session the person has — and hands back the one they carry on with", async () => {
    const u = await mkUser(w);
    const bystander = await mkUser(w);
    const thisDevice = oldSession(u.id);
    const otherDevice = oldSession(u.id);
    expect((await get(app, otherDevice, "/auth/mfa")).status).toBe(200);
    const r = await change(app, thisDevice, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(200);

    expect((await get(app, otherDevice, "/auth/mfa")).status).toBe(401); // the other device is signed out
    expect((await get(app, thisDevice, "/auth/mfa")).status).toBe(401); // and so is the old token of this one…
    expect((await get(app, r.body.token, "/auth/mfa")).status).toBe(200); // …but the fresh one works straight away
    expect((await get(app, oldSession(bystander.id), "/auth/mfa")).status).toBe(200); // nobody else is affected
  });

  it("the fresh session works even when this server's clock is behind the database's", async () => {
    const u = await mkUser(w);
    const s = oldSession(u.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 90_000); // this server thinks it is a minute and a half earlier than the database does
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(200);
    expect((await get(app, r.body.token, "/auth/mfa")).status).toBe(200);
  });

  it("stamps the fresh session with the later of this server's clock and the moment the others were ended", () => {
    const at = new Date("2026-01-01T00:00:10.900Z");
    expect(issuedAtAfter(at, Date.parse("2026-01-01T00:00:50.100Z"))).toBe(Date.parse("2026-01-01T00:00:50Z") / 1000); // server ahead: its own clock
    expect(issuedAtAfter(at, Date.parse("2026-01-01T00:00:03.000Z"))).toBe(Date.parse("2026-01-01T00:00:10Z") / 1000); // server behind: the revocation second
    expect(issuedAtAfter(at, Date.parse("2026-01-01T00:00:10.950Z"))).toBe(Date.parse("2026-01-01T00:00:10Z") / 1000); // same second
  });

  it("is written to the audit log", async () => {
    const u = await mkUser(w);
    const before = await auditCount(w.orgA, "user.password_changed", u.id);
    await change(app, oldSession(u.id), { currentPassword: PW, newPassword: NEW_PW });
    expect(await auditCount(w.orgA, "user.password_changed", u.id)).toBe(before + 1);
  });

  it("works for anyone, including a client's own people", async () => {
    await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [w.tLead, PW_HASH]);
    const s = (await login(app, `lead@a1-${w.tag}.test`)).body.token as string;
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ userId: w.tLead, role: "tenant_lead", tenantId: w.tA1 });
    expect((await get(app, r.body.token, "/auth/mfa")).status).toBe(200);
  });

  it("a person can change it again straight away with the session they were given", async () => {
    const u = await mkUser(w);
    const first = await change(app, oldSession(u.id), { currentPassword: PW, newPassword: NEW_PW });
    expect(first.status).toBe(200);
    const second = await change(app, first.body.token, { currentPassword: NEW_PW, newPassword: NEWER_PW });
    expect(second.status).toBe(200);
    expect((await login(app, u.email, NEWER_PW)).status).toBe(200);
    expect((await get(app, second.body.token, "/auth/mfa")).status).toBe(200); // and the session from the second change works too
  });

  it("an account that signs in through single sign-on (no password here) is told so", async () => {
    const sso = await mkUser(w, "auditor", null);
    const t = jwt.sign({ sub: sso.id }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });
    const r = await change(app, t, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NO_LOCAL_PASSWORD");
    expect((await userRow(sso.id)).password_hash).toBeNull();
  });
});

// ====================================================================================================================
describe("the checks on the way", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup(); });

  it("a wrong current password is a 403 (not a sign-out), changes nothing, and counts toward the lock-out", async () => {
    const u = await mkUser(w);
    const s = oldSession(u.id);
    const r = await change(app, s, { currentPassword: "not-the-password-99", newPassword: NEW_PW });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("INVALID_PASSWORD");
    const row = await userRow(u.id);
    expect(row.password_hash).toBe(PW_HASH);
    expect(row.failed_login_count).toBe(1);
    expect(row.sessions_valid_after).toBeNull();
    expect((await get(app, s, "/auth/mfa")).status).toBe(200); // still signed in
  });

  it("five wrong guesses lock the account — and then even the right password is refused", async () => {
    const u = await mkUser(w);
    const s = oldSession(u.id);
    for (let i = 0; i < 5; i++) expect((await change(app, s, { currentPassword: "wrong-password-1", newPassword: NEW_PW })).status).toBe(403);
    const locked = await change(app, s, { currentPassword: PW, newPassword: NEW_PW });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
  });

  it("a successful change clears earlier failed attempts", async () => {
    const u = await mkUser(w);
    await adminPool.query("UPDATE users SET failed_login_count=3 WHERE id=$1", [u.id]);
    expect((await change(app, oldSession(u.id), { currentPassword: PW, newPassword: NEW_PW })).status).toBe(200);
    expect((await userRow(u.id)).failed_login_count).toBe(0);
  });

  it("a weak new password is refused first, without touching the current password or counting a failure", async () => {
    const u = await mkUser(w);
    for (const weak of ["short", "password123", "x".repeat(257)]) {
      const r = await change(app, oldSession(u.id), { currentPassword: "wrong-password-1", newPassword: weak });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("WEAK_PASSWORD");
    }
    const row = await userRow(u.id);
    expect(row.failed_login_count).toBe(0);
    expect(row.password_hash).toBe(PW_HASH);
  });

  it("the new password has to be different from the current one", async () => {
    const u = await mkUser(w);
    const r = await change(app, oldSession(u.id), { currentPassword: PW, newPassword: PW });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("SAME_PASSWORD");
    const row = await userRow(u.id);
    expect(row.password_hash).toBe(PW_HASH);
    expect(row.sessions_valid_after).toBeNull();
    expect(row.failed_login_count).toBe(0);
  });

  it("is rate limited per address, with its own allowance", async () => {
    const limited = setup({ authLimits: { signIn: 2, windowMs: 60_000 } });
    const u = await mkUser(w);
    const s = oldSession(u.id);
    for (let i = 0; i < 2; i++) expect((await change(limited, s, { currentPassword: "wrong-password-1", newPassword: NEW_PW })).status).toBe(403);
    expect((await change(limited, s, { currentPassword: PW, newPassword: NEW_PW })).status).toBe(429);
  });

  it("if the password changed somewhere else while this was being checked, nothing is overwritten", async () => {
    const u = await mkUser(w);
    const elsewhere = await passwords.hashPassword("changed-somewhere-else-77");
    const real = passwords.hashPassword;
    vi.spyOn(passwords, "hashPassword").mockImplementation(async (plain: string) => {
      // the moment this request goes to hash the new password, a reset elsewhere lands
      await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [u.id, elsewhere]);
      return real(plain);
    });
    const r = await change(app, oldSession(u.id), { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PASSWORD_CHANGED_ELSEWHERE");
    expect((await userRow(u.id)).password_hash).toBe(elsewhere);
  });
});

// ====================================================================================================================
describe("with two-step sign-in on", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup(); });
  beforeEach(() => { freeze(); });

  it("asks for a code, and says so, without checking anything else first", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MFA_CODE_REQUIRED");
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
    expect((await userRow(u.id)).failed_login_count).toBe(0);
  });

  it("changes it with a current authenticator code", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code: freshCode(u.secret) });
    expect(r.status).toBe(200);
    expect((await get(app, r.body.token, "/auth/mfa")).body.enabled).toBe(true); // two-step stays on
    // and the new password is what signs in, with the second step still required
    const again = await login(app, u.email, NEW_PW);
    expect(again.body.mfaRequired).toBe(true);
  });

  it("accepts a recovery code too, which is then used up", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code: u.recoveryCodes[0] });
    expect(r.status).toBe(200);
    expect((await get(app, r.body.token, "/auth/mfa")).body.recoveryRemaining).toBe(u.recoveryCodes.length - 1);
  });

  it("a wrong code is a 403 (not a sign-out), counts toward the code lock, and nothing changes", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code: wrongCode(u.secret) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("INVALID_CODE");
    expect((await mfaRow(u.id)).failed_attempts).toBe(1);
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
    expect((await get(app, s, "/auth/mfa")).status).toBe(200);
  });

  it("a badly formatted code is refused up front, and nothing is counted", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const r = await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code: "12" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_CODE_FORMAT");
    expect((await mfaRow(u.id)).failed_attempts).toBe(0);
  });

  it("a code is not used up by a mistake in the new password, or a wrong current password", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const code = freshCode(u.secret);
    expect((await change(app, s, { currentPassword: PW, newPassword: "short", code })).body.error.code).toBe("WEAK_PASSWORD");
    expect((await change(app, s, { currentPassword: PW, newPassword: PW, code })).body.error.code).toBe("SAME_PASSWORD");
    expect((await change(app, s, { currentPassword: "wrong-password-1", newPassword: NEW_PW, code })).body.error.code).toBe("INVALID_PASSWORD");
    expect((await mfaRow(u.id)).failed_attempts).toBe(0);
    expect((await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code })).status).toBe(200); // the same code still works
  });

  it("a code works once: the same code cannot change the password a second time", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const code = freshCode(u.secret);
    const first = await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code });
    expect(first.status).toBe(200);
    const replay = await change(app, first.body.token, { currentPassword: NEW_PW, newPassword: NEWER_PW, code });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe("INVALID_CODE");
    expect(await passwords.verifyPassword(NEW_PW, (await userRow(u.id)).password_hash)).toBe(true);
  });

  it("five wrong codes lock it, and the right code is then refused as well", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const bad = wrongCode(u.secret);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code: bad })).status);
    expect(statuses).toEqual([403, 403, 403, 403, 423]);
    const locked = await change(app, s, { currentPassword: PW, newPassword: NEW_PW, code: freshCode(u.secret) });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("MFA_LOCKED");
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
  });

  it("when this server can't check authenticator codes it says so, and a recovery code still works", async () => {
    const u = await withTwoStep(app, w);
    const s = await twoStepSession(app, u.email, u.secret);
    const noKey = setup({ secretStore: undefined });
    const r = await change(noKey, s, { currentPassword: PW, newPassword: NEW_PW, code: freshCode(u.secret) });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MFA_NOT_CONFIGURED");
    expect((await userRow(u.id)).password_hash).toBe(PW_HASH);
    expect((await change(noKey, s, { currentPassword: PW, newPassword: NEW_PW, code: u.recoveryCodes[1] })).status).toBe(200);
  });
});
