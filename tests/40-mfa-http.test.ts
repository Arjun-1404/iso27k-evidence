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
import { hashPassword } from "../src/auth/password.ts";
import { signMfaToken } from "../src/auth/mfaToken.ts";
import { totpAtStep, stepAt, normalizeRecoveryCode, hashRecoveryCode, base32Decode } from "../src/auth/totp.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const SECRET = "mfa-http-test-secret-value-long-enough";
const STORE = new AesSecretStore("11".repeat(32));
const OTHER_STORE = new AesSecretStore("22".repeat(32));
const PW = "a-perfectly-good-password-123";
const NEW_PW = "a-brand-new-password-6789";
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

// ---- a clock we control: codes change every 30 s, and waiting that long in a test is not an option ------------
let clock = 0;
function freeze() {
  // Mid-step, and a little ahead of the real clock, so no test straddles a step boundary.
  clock = Math.ceil(Date.now() / 30_000) * 30_000 + 15_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
}
const nextStep = () => { clock += 30_000; vi.setSystemTime(clock); };
/** The code the app shows right now. */
const codeNow = (secret: string) => totpAtStep(secret, stepAt(Date.now()));
/** The code for the NEXT 30 seconds — always newer than anything used so far. */
const freshCode = (secret: string) => { nextStep(); return codeNow(secret); };
/** Six digits that are definitely not valid right now. */
function wrongCode(secret: string) {
  const ok = new Set([-1, 0, 1].map((o) => totpAtStep(secret, stepAt(Date.now()) + o)));
  for (let i = 0; ; i++) { const c = String(i).padStart(6, "0"); if (!ok.has(c)) return c; }
}

beforeAll(async () => { PW_HASH = await hashPassword(PW); });
beforeEach(() => { freeze(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ---- helpers ---------------------------------------------------------------------------------------------------
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (app: App, t: string, path: string) => request(app).get(path).set(bearer(t));
const post = (app: App, t: string, path: string, body: object = {}) => request(app).post(path).set(bearer(t)).send(body);
const login = (app: App, email: string, password = PW) => request(app).post("/auth/login").send({ email, password });
const verify = (app: App, mfaToken: string, code: string) => request(app).post("/auth/mfa/verify").send({ mfaToken, code });

let seq = 0;
async function mkUser(w: World, role = "auditor", password = PW_HASH) {
  const email = `u${++seq}-${w.tag}@audit-a-${w.tag}.test`;
  const id = (await adminPool.query(
    "INSERT INTO users (org_id, email, full_name, role, status, password_hash) VALUES ($1,$2,'Test User',$3,'active',$4) RETURNING id", [w.orgA, email, role, password])).rows[0].id as string;
  return { id, email };
}
const mfaRow = async (id: string) => (await adminPool.query("SELECT * FROM user_mfa WHERE user_id=$1", [id])).rows[0];
const userRow = async (id: string) => (await adminPool.query("SELECT failed_login_count, locked_until FROM users WHERE id=$1", [id])).rows[0];
const auditCount = async (org: string, action: string, actor?: string) =>
  (await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND action=$2" + (actor ? " AND actor_id=$3" : ""), actor ? [org, action, actor] : [org, action])).rows[0].n as number;

/** Signs a user in (before they have two-step on) and returns a session token. */
async function plainSession(app: App, email: string, password = PW) {
  const r = await login(app, email, password);
  expect(r.status).toBe(200);
  return r.body.token as string;
}

/** Walks the real journey to turn two-step sign-in on. Returns what a person would be holding afterwards. */
async function enrolled(app: App, w: World, role = "auditor") {
  const u = await mkUser(w, role);
  const session = await plainSession(app, u.email);
  const begun = await post(app, session, "/auth/mfa/enroll", { password: PW });
  expect(begun.status).toBe(200);
  const secret = begun.body.secret as string;
  const done = await post(app, session, "/auth/mfa/enroll/confirm", { code: freshCode(secret) });
  expect(done.status).toBe(200);
  return { ...u, secret, recoveryCodes: done.body.recoveryCodes as string[], session };
}

/** Both sign-in steps, with a fresh code. */
async function signInTwoStep(app: App, email: string, secret: string, password = PW) {
  const first = await login(app, email, password);
  expect(first.body.mfaRequired).toBe(true);
  const second = await verify(app, first.body.mfaToken, freshCode(secret));
  expect(second.status).toBe(200);
  return second.body.token as string;
}

// ====================================================================================================================
describe("turning two-step sign-in on", () => {
  let w: World; let app: App; let u: { id: string; email: string }; let session: string; let secret: string;
  beforeAll(async () => { w = await makeWorld(); app = setup().app; u = await mkUser(w); });
  beforeEach(async () => { session ||= await plainSession(app, u.email); });

  it("starts off, and says whether this server is able to do it", async () => {
    const r = await get(app, session, "/auth/mfa");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, recoveryRemaining: 0, available: true, required: false });
    const without = setup({ secretStore: undefined }).app;
    expect((await get(without, session, "/auth/mfa")).body).toEqual({ enabled: false, recoveryRemaining: 0, available: false, required: false });
  });

  it("needs the signed-in session, and the password again", async () => {
    expect((await request(app).get("/auth/mfa")).status).toBe(401);
    expect((await request(app).post("/auth/mfa/enroll").send({ password: PW })).status).toBe(401);
    expect((await post(app, session, "/auth/mfa/enroll", {})).status).toBe(400);
    const wrong = await post(app, session, "/auth/mfa/enroll", { password: "not-the-password" });
    expect(wrong.status).toBe(403); // 403, not 401: a 401 would sign the person out of the app for a typo
    expect(wrong.body.error.code).toBe("INVALID_PASSWORD");
    expect(await mfaRow(u.id)).toBeUndefined(); // nothing was started
  });

  it("a wrong password here counts toward the same lock-out as the sign-in page", async () => {
    const v = await mkUser(w);
    const s = await plainSession(app, v.email);
    for (let i = 0; i < 5; i++) expect((await post(app, s, "/auth/mfa/enroll", { password: "wrong-password-1" })).status).toBe(403);
    expect((await userRow(v.id)).failed_login_count).toBe(5);
    const locked = await post(app, s, "/auth/mfa/enroll", { password: PW }); // even the right one is refused now
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(await mfaRow(v.id)).toBeUndefined();
  });

  it("starting hands back a secret and a QR address, never cached, and stores only the encrypted secret", async () => {
    const r = await post(app, session, "/auth/mfa/enroll", { password: PW });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    secret = r.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = new URL(r.body.otpauthUri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(secret);
    expect(decodeURIComponent(uri.pathname)).toContain(u.email);

    const stored = await mfaRow(u.id);
    expect(stored.enabled_at).toBeNull(); // pending: not on until a code proves the phone has it
    expect(stored.secret_enc).not.toContain(secret);
    expect(STORE.decrypt(stored.secret_enc)).toBe(secret);
    expect((await get(app, session, "/auth/mfa")).body.enabled).toBe(false);
  });

  it("while it is only pending, signing in does not ask for a code", async () => {
    const r = await login(app, u.email);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.mfaRequired).toBeUndefined();
  });

  it("a wrong first code does not turn it on; a malformed one is a 400", async () => {
    const bad = await post(app, session, "/auth/mfa/enroll/confirm", { code: wrongCode(secret) });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe("INVALID_CODE");
    for (const code of ["12345", "abcdef", "ABCD-EFGH-IJKL-MNOP"]) {
      const r = await post(app, session, "/auth/mfa/enroll/confirm", { code });
      expect(r.status, code).toBe(400);
      expect(r.body.error.code).toBe("INVALID_CODE_FORMAT"); // a recovery code can't confirm enrolment either
    }
    expect((await mfaRow(u.id)).enabled_at).toBeNull();
  });

  it("the right code turns it on and shows ten recovery codes, once, stored only as hashes", async () => {
    const r = await post(app, session, "/auth/mfa/enroll/confirm", { code: codeNow(secret) });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const codes = r.body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(new Set(codes).size).toBe(10);

    const status = await get(app, session, "/auth/mfa");
    expect(status.body).toEqual({ enabled: true, recoveryRemaining: 10, available: true, required: false });

    const stored = (await adminPool.query("SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1", [u.id])).rows.map((x) => x.code_hash as string).sort();
    expect(stored).toEqual(codes.map((c) => hashRecoveryCode(u.id, normalizeRecoveryCode(c)!)).sort());
    for (const c of codes) expect(stored.join()).not.toContain(normalizeRecoveryCode(c)!);
    expect(await auditCount(w.orgA, "user.mfa_enabled", u.id)).toBe(1);
  });

  it("confirming again, with nothing pending, is a clear 409; starting again while it is on is refused", async () => {
    const again = await post(app, session, "/auth/mfa/enroll/confirm", { code: freshCode(secret) });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("NO_ENROLLMENT");
    const restart = await post(app, session, "/auth/mfa/enroll", { password: PW });
    expect(restart.status).toBe(409);
    expect(restart.body.error.code).toBe("MFA_ALREADY_ENABLED");
    expect(STORE.decrypt((await mfaRow(u.id)).secret_enc)).toBe(secret); // the working secret was not replaced
  });

  it("confirming with nothing ever started is a 409 too", async () => {
    const v = await mkUser(w);
    const s = await plainSession(app, v.email);
    const r = await post(app, s, "/auth/mfa/enroll/confirm", { code: "123456" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NO_ENROLLMENT");
  });

  it("starting over before confirming replaces the pending secret (an abandoned QR code is useless)", async () => {
    const v = await mkUser(w);
    const s = await plainSession(app, v.email);
    const first = (await post(app, s, "/auth/mfa/enroll", { password: PW })).body.secret as string;
    const second = (await post(app, s, "/auth/mfa/enroll", { password: PW })).body.secret as string;
    expect(second).not.toBe(first);
    expect((await post(app, s, "/auth/mfa/enroll/confirm", { code: codeNow(first) })).status).toBe(403);
    expect((await post(app, s, "/auth/mfa/enroll/confirm", { code: codeNow(second) })).status).toBe(200);
  });

  it("without an encryption key on the server it says so (503) instead of storing secrets in the clear", async () => {
    const v = await mkUser(w);
    const s = await plainSession(app, v.email);
    const bare = setup({ secretStore: undefined }).app;
    const r = await post(bare, s, "/auth/mfa/enroll", { password: PW });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MFA_NOT_CONFIGURED");
    expect(await mfaRow(v.id)).toBeUndefined();
    expect((await post(bare, s, "/auth/mfa/enroll/confirm", { code: "123456" })).status).toBe(503);
  });

  it("the endpoints that re-check the password are limited per address, each with its own count", async () => {
    const limited = setup({ authLimits: { signIn: 2, windowMs: 60_000 } }).app;
    const v = await mkUser(w);
    const s = await plainSession(limited, v.email);
    for (let i = 0; i < 2; i++) expect((await post(limited, s, "/auth/mfa/enroll", { password: "wrong-password-1" })).status).toBe(403);
    expect((await post(limited, s, "/auth/mfa/enroll", { password: PW })).status).toBe(429);
    // confirm, disable and regenerate each have their own allowance
    for (const path of ["/auth/mfa/enroll/confirm", "/auth/mfa/disable", "/auth/mfa/recovery-codes"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await post(limited, s, path, { password: PW, code: "123456" })).status);
      expect(statuses[2], path).toBe(429);
      expect(statuses[0], path).not.toBe(429);
    }
  });

  it("an account that signs in through single sign-on (no password here) is told so, not given a false start", async () => {
    const sso = await mkUser(w, "auditor", null as unknown as string);
    // it has no local password, so it has no local session either: use a session token minted for it directly
    const t = jwt.sign({ sub: sso.id }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });
    const r = await post(app, t, "/auth/mfa/enroll", { password: PW });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NO_LOCAL_PASSWORD");
  });
});

// ====================================================================================================================
describe("signing in with two-step sign-in on", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup().app; });

  it("the password step hands back a challenge, not a session", async () => {
    const u = await enrolled(app, w);
    const r = await login(app, u.email);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.mfaRequired).toBe(true);
    expect(typeof r.body.mfaToken).toBe("string");
    expect(Object.keys(r.body).sort()).toEqual(["mfaRequired", "mfaToken"]); // no session token, no role, no ids
  });

  it("the challenge cannot be used as a session anywhere", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    for (const path of ["/users", "/auth/mfa", "/controls", "/orgs"]) expect((await get(app, mfaToken, path)).status, path).toBe(401);
  });

  it("the right code completes it: a working session, and the failure count is cleared only now", async () => {
    const u = await enrolled(app, w, "org_admin");
    await adminPool.query("UPDATE users SET failed_login_count = 2 WHERE id=$1", [u.id]);
    const first = await login(app, u.email);
    expect((await userRow(u.id)).failed_login_count).toBe(2); // a correct password alone clears nothing
    const second = await verify(app, first.body.mfaToken, freshCode(u.secret));
    expect(second.status).toBe(200);
    expect(second.headers["cache-control"]).toBe("no-store");
    expect(second.body).toMatchObject({ userId: u.id, role: "org_admin" });
    expect(second.body.recoveryCodeUsed).toBeUndefined();
    expect((await userRow(u.id)).failed_login_count).toBe(0);
    expect((await get(app, second.body.token, "/users")).status).toBe(200);
  });

  it("a code works once: the same code again is refused, even though it is still within its 30 seconds", async () => {
    const u = await enrolled(app, w);
    const code = freshCode(u.secret);
    const { mfaToken } = (await login(app, u.email)).body;
    expect((await verify(app, mfaToken, code)).status).toBe(200);
    const replay = await verify(app, mfaToken, code);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("INVALID_CODE");
    expect(replay.body.token).toBeUndefined();
  });

  it("codes typed with spaces or a dash are understood", async () => {
    const u = await enrolled(app, w);
    const code = freshCode(u.secret);
    const { mfaToken } = (await login(app, u.email)).body;
    expect((await verify(app, mfaToken, `${code.slice(0, 3)} ${code.slice(3)}`)).status).toBe(200);
  });

  it("a wrong code is a 401 and counts; a badly formatted one is a 400 and does not", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    const wrong = await verify(app, mfaToken, wrongCode(u.secret));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CODE");
    expect((await mfaRow(u.id)).failed_attempts).toBe(1);
    for (const code of ["", "12345", "1234567", "hello", "ABCD-EFGH"]) {
      const r = await verify(app, mfaToken, code || " ");
      expect([400]).toContain(r.status);
    }
    expect((await mfaRow(u.id)).failed_attempts).toBe(1);
  });

  it("five wrong codes lock it for 15 minutes — the fifth already says so — and then even the right code is refused", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    const bad = wrongCode(u.secret);
    for (let i = 0; i < 4; i++) expect((await verify(app, mfaToken, bad)).status).toBe(401);
    const fifth = await verify(app, mfaToken, bad);
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe("MFA_LOCKED");
    const right = await verify(app, mfaToken, freshCode(u.secret));
    expect(right.status).toBe(423);
    expect(right.body.token).toBeUndefined();
    const until = new Date((await mfaRow(u.id)).locked_until).getTime();
    expect(until - Date.now()).toBeGreaterThan(10 * 60_000);
    expect(await auditCount(w.orgA, "user.mfa_locked", u.id)).toBe(1);
  });

  it("an expired, forged, wrong-kind or missing challenge is refused the same way", async () => {
    const u = await enrolled(app, w);
    const code = freshCode(u.secret);
    const expired = signMfaToken(u.id, SECRET, -1);
    const forged = signMfaToken(u.id, "some-other-secret-entirely-xyz");
    const session = await signInTwoStep(app, u.email, u.secret); // a real SESSION token is not a challenge either
    for (const t of [expired, forged, session, "garbage"]) {
      const r = await verify(app, t, code);
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("INVALID_MFA_TOKEN");
    }
    expect((await request(app).post("/auth/mfa/verify").send({ code })).status).toBe(400);
    expect((await request(app).post("/auth/mfa/verify").send({ mfaToken: "x" })).status).toBe(400);
  });

  it("a challenge for someone else's account, with your own code, gets nowhere", async () => {
    const a = await enrolled(app, w); const b = await enrolled(app, w);
    const { mfaToken } = (await login(app, a.email)).body;
    const r = await verify(app, mfaToken, freshCode(b.secret));
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  it("a wrong password on a two-step account looks exactly like a wrong password anywhere else", async () => {
    const u = await enrolled(app, w);
    const plain = await mkUser(w);
    const a = await login(app, u.email, "wrong-password-xyz");
    const b = await login(app, plain.email, "wrong-password-xyz");
    const c = await login(app, "nobody@nowhere.test", "wrong-password-xyz");
    for (const r of [a, b, c]) expect(r.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual(c.body);
    expect((await mfaRow(u.id)).failed_attempts).toBe(0); // a wrong PASSWORD never touches the code counter
  });

  it("if the account is locked for too many wrong passwords, the second step is refused too", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    await adminPool.query("UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id=$1", [u.id]);
    const r = await verify(app, mfaToken, freshCode(u.secret));
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("an account disabled between the two steps does not get in", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [u.id]);
    const r = await verify(app, mfaToken, freshCode(u.secret));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("INVALID_MFA_TOKEN");
  });

  it("two-step switched off between the two steps means start again — never a session for free", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    await adminPool.query("DELETE FROM user_mfa WHERE user_id=$1", [u.id]);
    const r = await verify(app, mfaToken, freshCode(u.secret));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("INVALID_MFA_TOKEN");
    expect(r.body.token).toBeUndefined();
  });

  it("the second step is limited per address like sign-in is", async () => {
    const limited = setup({ authLimits: { signIn: 3, windowMs: 60_000 } }).app;
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    const codes = [wrongCode(u.secret), wrongCode(u.secret), wrongCode(u.secret)];
    for (const c of codes) expect((await verify(limited, mfaToken, c)).status).toBe(401);
    const blocked = await verify(limited, mfaToken, wrongCode(u.secret));
    expect(blocked.status).toBe(429);
    expect((await mfaRow(u.id)).failed_attempts).toBe(3); // the blocked request never reached the account
  });
});

// ====================================================================================================================
describe("recovery codes", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup().app; });

  it("work in place of a code — once — however they are typed; the app says one was used", async () => {
    const u = await enrolled(app, w);
    const code = u.recoveryCodes[0];
    const typed = code.toLowerCase().replace(/-/g, " ");
    const first = await verify(app, (await login(app, u.email)).body.mfaToken, typed);
    expect(first.status).toBe(200);
    expect(first.body.recoveryCodeUsed).toBe(true);
    expect((await get(app, first.body.token, "/auth/mfa")).body.recoveryRemaining).toBe(9);
    expect(await auditCount(w.orgA, "user.mfa_recovery_code_used", u.id)).toBe(1);

    const again = await verify(app, (await login(app, u.email)).body.mfaToken, code);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("INVALID_CODE");
    expect((await mfaRow(u.id)).failed_attempts).toBe(1); // reusing a spent code is a failed attempt
  });

  it("belong to one account: someone else's code is just a wrong code", async () => {
    const a = await enrolled(app, w); const b = await enrolled(app, w);
    const r = await verify(app, (await login(app, a.email)).body.mfaToken, b.recoveryCodes[0]);
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  it("a made-up one counts as a wrong attempt too, so they cannot be guessed at leisure", async () => {
    const u = await enrolled(app, w);
    const { mfaToken } = (await login(app, u.email)).body;
    for (let i = 0; i < 4; i++) expect((await verify(app, mfaToken, "AAAA-BBBB-CCCC-DDDD")).status).toBe(401);
    expect((await verify(app, mfaToken, "AAAA-BBBB-CCCC-DDDD")).status).toBe(423);
    expect((await verify(app, mfaToken, u.recoveryCodes[1])).status).toBe(423); // locked: a real one is refused too
  });

  it("can be regenerated with the password and a code: ten new ones, and the old ones stop working", async () => {
    const u = await enrolled(app, w);
    const session = await signInTwoStep(app, u.email, u.secret);
    expect((await post(app, session, "/auth/mfa/recovery-codes", { code: freshCode(u.secret) })).status).toBe(400); // password missing
    expect((await post(app, session, "/auth/mfa/recovery-codes", { password: PW })).status).toBe(400); // code missing
    const wrongPw = await post(app, session, "/auth/mfa/recovery-codes", { password: "nope-nope-nope-1", code: freshCode(u.secret) });
    expect(wrongPw.status).toBe(403);
    const wrongCodeR = await post(app, session, "/auth/mfa/recovery-codes", { password: PW, code: wrongCode(u.secret) });
    expect(wrongCodeR.status).toBe(403); // 403, so the app doesn't sign the person out
    expect(wrongCodeR.body.error.code).toBe("INVALID_CODE");

    const r = await post(app, session, "/auth/mfa/recovery-codes", { password: PW, code: freshCode(u.secret) });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.recoveryCodes).toHaveLength(10);
    expect(r.body.recoveryCodes.filter((c: string) => u.recoveryCodes.includes(c))).toEqual([]);
    expect((await get(app, session, "/auth/mfa")).body.recoveryRemaining).toBe(10);
    expect(await auditCount(w.orgA, "user.mfa_recovery_codes_regenerated", u.id)).toBe(1);

    const old = await verify(app, (await login(app, u.email)).body.mfaToken, u.recoveryCodes[0]);
    expect(old.status).toBe(401);
    const fresh = await verify(app, (await login(app, u.email)).body.mfaToken, r.body.recoveryCodes[0]);
    expect(fresh.status).toBe(200);
  });

  it("regenerating when two-step is not on is a 409", async () => {
    const v = await mkUser(w);
    const s = await plainSession(app, v.email);
    const r = await post(app, s, "/auth/mfa/recovery-codes", { password: PW, code: "123456" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MFA_NOT_ENABLED");
  });
});

// ====================================================================================================================
describe("turning two-step sign-in off", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup().app; });

  it("needs the password AND a code; then sign-in is back to password only", async () => {
    const u = await enrolled(app, w);
    const session = await signInTwoStep(app, u.email, u.secret);
    expect((await post(app, session, "/auth/mfa/disable", { code: freshCode(u.secret) })).status).toBe(400);
    expect((await post(app, session, "/auth/mfa/disable", { password: PW })).status).toBe(400);
    expect((await post(app, session, "/auth/mfa/disable", { password: "wrong-pw-9999999", code: freshCode(u.secret) })).status).toBe(403);
    const badCode = await post(app, session, "/auth/mfa/disable", { password: PW, code: wrongCode(u.secret) });
    expect(badCode.status).toBe(403);
    expect(badCode.body.error.code).toBe("INVALID_CODE");
    expect((await get(app, session, "/auth/mfa")).body.enabled).toBe(true); // nothing so far changed it

    const ok = await post(app, session, "/auth/mfa/disable", { password: PW, code: freshCode(u.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect((await get(app, session, "/auth/mfa")).body).toEqual({ enabled: false, recoveryRemaining: 0, available: true, required: false });
    expect(await mfaRow(u.id)).toBeUndefined();
    expect((await adminPool.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1", [u.id])).rows[0].n).toBe(0);
    expect(await auditCount(w.orgA, "user.mfa_disabled", u.id)).toBe(1);

    const plain = await login(app, u.email);
    expect(plain.body.token).toBeTruthy();
    expect(plain.body.mfaRequired).toBeUndefined();
  });

  it("a recovery code is enough of a second proof (a lost phone), and it can be turned on again afterwards", async () => {
    const u = await enrolled(app, w);
    const session = await signInTwoStep(app, u.email, u.secret);
    const ok = await post(app, session, "/auth/mfa/disable", { password: PW, code: u.recoveryCodes[3] });
    expect(ok.status).toBe(200);
    const begun = await post(app, session, "/auth/mfa/enroll", { password: PW });
    expect(begun.status).toBe(200);
    expect(begun.body.secret).not.toBe(u.secret); // a new secret, not a revival of the old one
    expect((await post(app, session, "/auth/mfa/enroll/confirm", { code: freshCode(begun.body.secret) })).status).toBe(200);
  });

  it("wrong codes here are counted and lock it like they do at sign-in", async () => {
    const u = await enrolled(app, w);
    const session = await signInTwoStep(app, u.email, u.secret);
    const bad = wrongCode(u.secret);
    for (let i = 0; i < 4; i++) expect((await post(app, session, "/auth/mfa/disable", { password: PW, code: bad })).status).toBe(403);
    const fifth = await post(app, session, "/auth/mfa/disable", { password: PW, code: bad });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe("MFA_LOCKED");
    expect((await post(app, session, "/auth/mfa/disable", { password: PW, code: freshCode(u.secret) })).status).toBe(423);
    expect((await get(app, session, "/auth/mfa")).body.enabled).toBe(true);
  });

  it("when it is not on, there is nothing to turn off (409)", async () => {
    const v = await mkUser(w);
    const s = await plainSession(app, v.email);
    const r = await post(app, s, "/auth/mfa/disable", { password: PW, code: "123456" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MFA_NOT_ENABLED");
  });

  it("someone who only has a session cannot strip the protection from an account (no password, or no code, no change)", async () => {
    const u = await enrolled(app, w);
    const stolen = await signInTwoStep(app, u.email, u.secret);
    const attempts = [
      { code: freshCode(u.secret) }, { password: PW }, { password: "guessing-1234567", code: wrongCode(u.secret) },
    ];
    for (const body of attempts) expect((await post(app, stolen, "/auth/mfa/disable", body)).status).toBeGreaterThanOrEqual(400);
    expect((await get(app, stolen, "/auth/mfa")).body.enabled).toBe(true);
  });
});

// ====================================================================================================================
describe("the server is not set up for it: fail closed", () => {
  let w: World; let app: App;
  beforeAll(async () => { w = await makeWorld(); app = setup().app; });

  it("with no key, an authenticator code gets an error — never a session — and is not counted against the account", async () => {
    const u = await enrolled(app, w);
    const bare = setup({ secretStore: undefined }).app;
    const { mfaToken } = (await login(bare, u.email)).body;
    expect(mfaToken).toBeTruthy(); // the password step still says "second step needed"
    const r = await verify(bare, mfaToken, freshCode(u.secret));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MFA_NOT_CONFIGURED");
    expect(r.body.token).toBeUndefined();
    expect((await mfaRow(u.id)).failed_attempts).toBe(0);
  });

  it("with a key that no longer matches, the same: an error, no session, nothing counted, and what is logged says nothing about the account", async () => {
    const u = await enrolled(app, w);
    const wrongKey = setup({ secretStore: OTHER_STORE }).app;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await verify(wrongKey, (await login(wrongKey, u.email)).body.mfaToken, freshCode(u.secret));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MFA_UNAVAILABLE");
    expect(r.body.token).toBeUndefined();
    expect((await mfaRow(u.id)).failed_attempts).toBe(0);
    const text = JSON.stringify(logged.mock.calls);
    expect(text).toMatch(/SECRET_ENCRYPTION_KEY/);
    expect(text).not.toContain(u.secret);
    expect(text).not.toContain(u.id);
    expect(text).not.toContain(u.email);
  });

  it("a recovery code is a real second proof that needs no key, so it still works — the way back in for a lost key", async () => {
    const u = await enrolled(app, w);
    const bare = setup({ secretStore: undefined }).app;
    const r = await verify(bare, (await login(bare, u.email)).body.mfaToken, u.recoveryCodes[0]);
    expect(r.status).toBe(200);
    expect(r.body.recoveryCodeUsed).toBe(true);
  });
});

// ====================================================================================================================
describe("it cannot be sidestepped", () => {
  it("resetting the password by email does not skip the second step", async () => {
    const w = await makeWorld(); const { app, email } = setup();
    const u = await enrolled(app, w);
    expect((await request(app).post("/auth/forgot-password").send({ email: u.email })).status).toBe(202);
    // Turning two-step on above also sent its own notice, so pick the reset-link mail by what it holds, not by position.
    const resetMail = email.sent.find((m) => /reset-password\?token=/.test(m.text))!;
    const token = resetMail.text.match(/reset-password\?token=([0-9a-f]{64})/)![1];
    expect((await request(app).post("/auth/reset-password").send({ token, password: NEW_PW })).status).toBe(200);

    const r = await login(app, u.email, NEW_PW);
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBe(true);
    expect(r.body.token).toBeUndefined();
    expect((await verify(app, r.body.mfaToken, freshCode(u.secret))).status).toBe(200);
  });

  it("accepting an invite creates no two-step state, and an account without it signs in as before", async () => {
    const w = await makeWorld(); const { app } = setup();
    const u = await mkUser(w);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1", [u.id])).rows[0].n).toBe(0);
    const r = await login(app, u.email);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
  });
});

// ====================================================================================================================
describe("an administrator resetting someone else's two-step sign-in", () => {
  let w: World; let app: App; let adminToken: string;
  const adminEmail = () => `admin@audit-a-${w.tag}.test`;
  beforeAll(async () => {
    w = await makeWorld(); app = setup().app;
    await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=ANY($1)", [[w.admin, w.lead, w.adminB], PW_HASH]);
    adminToken = await plainSession(app, adminEmail());
  });

  it("switches it off for the person, ends the sessions they already had, and is audited with the admin as actor", async () => {
    const u = await enrolled(app, w);
    // a session the person held a minute ago (a lost phone's browser, say)
    const old = jwt.sign({ sub: u.id, iat: Math.floor(Date.now() / 1000) - 600 }, SECRET, { issuer: "evidence-portal", expiresIn: 7200 });
    vi.useRealTimers(); // the revocation compares against the database's own clock
    expect((await get(app, old, "/auth/mfa")).status).toBe(200);

    const r = await post(app, adminToken, `/users/${u.id}/reset-mfa`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ reset: true });
    expect(await mfaRow(u.id)).toBeUndefined();
    expect((await get(app, old, "/auth/mfa")).status).toBe(401); // the old session is gone
    expect(await auditCount(w.orgA, "user.mfa_reset", w.admin)).toBeGreaterThanOrEqual(1);

    const back = await login(app, u.email); // password alone again, until they set it up once more
    expect(back.body.token).toBeTruthy();
  });

  it("says so when there was nothing to reset", async () => {
    const v = await mkUser(w);
    expect((await post(app, adminToken, `/users/${v.id}/reset-mfa`)).body).toEqual({ reset: false });
  });

  it("is for organisation admins only, never on oneself, and never across organisations", async () => {
    const u = await enrolled(app, w);
    const leadToken = await plainSession(app, `lead@audit-a-${w.tag}.test`);
    const asLead = await post(app, leadToken, `/users/${u.id}/reset-mfa`);
    expect(asLead.status).toBe(403);
    const self = await post(app, adminToken, `/users/${w.admin}/reset-mfa`);
    expect(self.status).toBe(403);
    const otherAdmin = await plainSession(app, `admin@audit-b-${w.tag}.test`);
    expect((await post(app, otherAdmin, `/users/${u.id}/reset-mfa`)).status).toBe(403);
    expect(await mfaRow(u.id)).toBeDefined(); // none of that changed anything
    expect((await request(app).post(`/users/${u.id}/reset-mfa`)).status).toBe(401);
  });

  it("refuses an id that isn't one", async () => {
    expect((await post(app, adminToken, "/users/not-a-uuid/reset-mfa")).status).toBe(400);
  });

  it("only an admin is told who has two-step on; everyone else's list is unchanged", async () => {
    const u = await enrolled(app, w);
    const seen = await get(app, adminToken, "/users");
    expect(seen.status).toBe(200);
    const mine = seen.body.find((x: { id: string }) => x.id === u.id);
    expect(mine.mfaEnabled).toBe(true);
    expect(seen.body.find((x: { id: string }) => x.id === w.lead).mfaEnabled).toBe(false);
    for (const row of seen.body) expect(Object.keys(row).sort()).toEqual(["email", "fullName", "id", "mfaEnabled", "role", "status"]);

    const leadToken = await plainSession(app, `lead@audit-a-${w.tag}.test`);
    const theirs = await get(app, leadToken, "/users");
    expect(theirs.status).toBe(200);
    for (const row of theirs.body) expect("mfaEnabled" in row).toBe(false);
  });
});

// ====================================================================================================================
describe("nothing secret leaks", () => {
  it("not into the logs, not into a status or list response", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const w = await makeWorld(); const { app } = setup();
    await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [w.admin, PW_HASH]);
    const u = await enrolled(app, w);
    const first = await login(app, u.email);
    await verify(app, first.body.mfaToken, wrongCode(u.secret));
    await verify(app, first.body.mfaToken, freshCode(u.secret));
    const session = await signInTwoStep(app, u.email, u.secret);
    const status = await get(app, session, "/auth/mfa");
    const list = await get(app, await plainSession(app, `admin@audit-a-${w.tag}.test`), "/users");

    const everything = JSON.stringify(spies.map((s) => s.mock.calls));
    const secrets = [u.secret, base32Decode(u.secret).toString("hex"), ...u.recoveryCodes, ...u.recoveryCodes.map((c) => normalizeRecoveryCode(c)!), PW, first.body.mfaToken];
    for (const s of secrets) expect(everything).not.toContain(s);
    for (const s of [u.secret, ...u.recoveryCodes]) {
      expect(JSON.stringify(status.body)).not.toContain(s);
      expect(JSON.stringify(list.body)).not.toContain(s);
    }
    expect(Object.keys(status.body).sort()).toEqual(["available", "enabled", "recoveryRemaining", "required"]);
  });

  it("the audit log records that things happened, never the codes or secrets", async () => {
    const w = await makeWorld(); const { app } = setup();
    const u = await enrolled(app, w);
    await verify(app, (await login(app, u.email)).body.mfaToken, u.recoveryCodes[0]);
    const rows = (await adminPool.query("SELECT action, change, entity_id FROM audit_log WHERE org_id=$1 AND action LIKE 'user.mfa%'", [w.orgA])).rows;
    expect(rows.map((r) => r.action).sort()).toEqual(["user.mfa_enabled", "user.mfa_recovery_code_used"]);
    const text = JSON.stringify(rows);
    for (const s of [u.secret, ...u.recoveryCodes, ...u.recoveryCodes.map((c) => normalizeRecoveryCode(c)!)]) expect(text).not.toContain(s);
    expect((await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA])).rows[0].bad).toBeNull();
  });
});
