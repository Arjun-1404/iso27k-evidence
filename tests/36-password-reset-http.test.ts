import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender, EmailDeliveryError, type EmailMessage, type EmailSender } from "../src/email/types.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";
import { dbSessionCheck } from "../src/auth/sessionCheck.ts";
import { hashPassword } from "../src/auth/password.ts";
import { FORGOT_PASSWORD_MESSAGE } from "../src/http/routes/auth.ts";
import { requestPasswordReset } from "../src/services/passwordReset.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });
afterEach(() => { vi.restoreAllMocks(); });

const SECRET = "reset-http-test-secret-value-long-enough";
const OLD_PW = "the-old-password-12345";
const NEW_PW = "a-brand-new-password-6789";

function setup(over: Partial<AppDeps> = {}) {
  const email = new FakeEmailSender();
  const app = createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email,
    tokenVerifier: new JwtTokenVerifier(SECRET, dbSessionCheck(appPool)), jwtSecret: SECRET, appBaseUrl: "https://portal.example",
    ...over,
  });
  return { app, email };
}

async function setPassword(userId: string, pw = OLD_PW) {
  await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [userId, await hashPassword(pw)]);
}
const emailOf = async (id: string) => (await adminPool.query("SELECT email FROM users WHERE id=$1", [id])).rows[0].email as string;
const tokenFrom = (m: EmailMessage) => m.text.match(/reset-password\?token=([0-9a-f]{64})/)![1];
const forgot = (app: ReturnType<typeof setup>["app"], address: string) => request(app).post("/auth/forgot-password").send({ email: address });
const reset = (app: ReturnType<typeof setup>["app"], token: string, password: string) => request(app).post("/auth/reset-password").send({ token, password });
const login = (app: ReturnType<typeof setup>["app"], address: string, password: string) => request(app).post("/auth/login").send({ email: address, password });
/** A session token as it would have been issued a minute ago (before any reset happening now). */
const tokenIssuedMinutesAgo = (userId: string) => jwt.sign({ sub: userId, iat: Math.floor(Date.now() / 1000) - 60 }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });

describe("forgot password -> email -> reset -> sign in, over HTTP", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("the whole journey: the emailed link sets a new password, the old one stops working, nobody is signed in by it", async () => {
    await setPassword(w.auditor);
    const { app, email } = setup();
    const address = await emailOf(w.auditor);

    const asked = await forgot(app, address);
    expect(asked.status).toBe(202);
    expect(asked.body.message).toBe(FORGOT_PASSWORD_MESSAGE);

    expect(email.sent).toHaveLength(1);
    const msg = email.sent[0];
    expect(msg.to).toEqual([address]);
    expect(msg.subject).toMatch(/reset your .*password/i);
    expect(msg.text).toContain("https://portal.example/reset-password?token=");
    expect(msg.text).toMatch(/expires in 1 hour/i);
    expect(msg.text).toMatch(/if you didn't ask/i);

    const done = await reset(app, tokenFrom(msg), NEW_PW);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ ok: true }); // no token, no user id: the person signs in themselves
    expect(JSON.stringify(done.body)).not.toMatch(/token|jwt/i);

    expect((await login(app, address, OLD_PW)).status).toBe(401);
    const fresh = await login(app, address, NEW_PW);
    expect(fresh.status).toBe(200);
    expect(fresh.body.role).toBe("auditor");
  });

  it("the link works once: using it again, even with a different password, is refused", async () => {
    await setPassword(w.lead);
    const { app, email } = setup();
    await forgot(app, await emailOf(w.lead));
    const token = tokenFrom(email.sent[0]);

    expect((await reset(app, token, NEW_PW)).status).toBe(200);
    const again = await reset(app, token, "another-fresh-password-1");
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_RESET");
    expect((await login(app, await emailOf(w.lead), NEW_PW)).status).toBe(200); // the first password stands
  });

  it("a password that is too weak is refused WITHOUT using up the link", async () => {
    await setPassword(w.readOnly);
    const { app, email } = setup();
    await forgot(app, await emailOf(w.readOnly));
    const token = tokenFrom(email.sent[0]);

    const weak = await reset(app, token, "short");
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe("WEAK_PASSWORD");

    expect((await reset(app, token, NEW_PW)).status).toBe(200); // the same link still works
  });

  it("an invented, truncated or empty link is a clean 400 / 400 / 400", async () => {
    const { app } = setup();
    for (const token of ["f".repeat(64), "abc", "not even hex!"]) {
      const res = await reset(app, token, NEW_PW);
      expect(res.status, token).toBe(400);
      expect(res.body.error.code).toBe("INVALID_RESET");
    }
    expect((await reset(app, "", NEW_PW)).status).toBe(400);
    expect((await request(app).post("/auth/reset-password").send({ password: NEW_PW })).status).toBe(400);
    expect((await request(app).post("/auth/forgot-password").send({})).status).toBe(400);
    expect((await forgot(app, "not-an-email")).status).toBe(400);
  });

  it("the link is not valid for a different account's password, and does not touch anyone else's", async () => {
    await setPassword(w.dash); await setPassword(w.tDash);
    const { app, email } = setup();
    await forgot(app, await emailOf(w.dash));
    await reset(app, tokenFrom(email.sent[0]), NEW_PW);
    expect((await login(app, await emailOf(w.tDash), OLD_PW)).status).toBe(200); // untouched
    expect((await login(app, await emailOf(w.dash), NEW_PW)).status).toBe(200);
  });

  it("a successful reset ends an account lockout", async () => {
    await setPassword(w.viewer);
    const { app, email } = setup();
    const address = await emailOf(w.viewer);
    for (let i = 0; i < 6; i++) await login(app, address, "wrong-password-entirely");
    expect((await login(app, address, OLD_PW)).status).toBe(423);

    await forgot(app, address);
    await reset(app, tokenFrom(email.sent[0]), NEW_PW);
    expect((await login(app, address, NEW_PW)).status).toBe(200);
  });
});

describe("the forgot-password answer reveals nothing about who has an account", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("a real account, an unknown address, a never-signed-up invitee, a disabled account and a throttled request all get the same answer", async () => {
    await setPassword(w.auditor);
    await setPassword(w.contrib);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.contrib]);
    await adminPool.query("UPDATE users SET status='invited', password_hash=NULL WHERE id=$1", [w.tLead]);
    const { app, email } = setup();

    const real = await emailOf(w.auditor);
    const answers = [
      await forgot(app, real),
      await forgot(app, `ghost@audit-a-${w.tag}.test`),
      await forgot(app, await emailOf(w.tLead)),
      await forgot(app, await emailOf(w.contrib)),
    ];
    // exhaust the real account's three-per-hour allowance; the fourth ask is throttled
    await forgot(app, real); await forgot(app, real);
    answers.push(await forgot(app, real));

    for (const a of answers) {
      expect(a.status).toBe(202);
      expect(a.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    }
    // ...while the only email sent went to the real account, three times at most
    expect(email.sent.every((m) => m.to[0] === real)).toBe(true);
    expect(email.sent).toHaveLength(3);
  });

  it("an address in different capitals still reaches the account", async () => {
    await setPassword(w.admin);
    const { app, email } = setup();
    const stored = await emailOf(w.admin);
    await forgot(app, stored.toUpperCase());
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toEqual([stored]); // mailed to the address on file, not the spelling typed
  });

  it("does not wait for the mail server: the answer comes back while the email is still being sent", async () => {
    await setPassword(w.lead);
    let release!: () => void; let started = false;
    const slow: EmailSender = { send: () => { started = true; return new Promise<void>((res) => { release = res; }); } };
    const { app } = setup({ email: slow });

    const res = await forgot(app, await emailOf(w.lead));
    expect(res.status).toBe(202);
    expect(started).toBe(true); // the send was begun...
    release(); // ...and had NOT finished when the answer went out (it only finishes now)
  });
});

describe("when the email cannot be sent", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("the visitor still gets the usual answer, and the log has neither the address nor the link", async () => {
    await setPassword(w.auditor);
    const address = await emailOf(w.auditor);
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    const failing: EmailSender = { send: async () => { throw new EmailDeliveryError("The mail server refused the message.", "rejected"); } };
    const { app } = setup({ email: failing });

    const res = await forgot(app, address);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    await new Promise((r) => setTimeout(r, 20));
    expect(logged.join("\n")).toContain("The mail server refused the message.");
    expect(logged.join("\n")).not.toContain(address);
    expect(logged.join("\n")).not.toMatch(/reset-password|token=/);
  });

  it("an unexpected error from a sender is logged generically — whatever it said (an address, a link) stays out of the log", async () => {
    await setPassword(w.lead);
    const address = await emailOf(w.lead);
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    const odd: EmailSender = { send: async (m) => { throw new Error(`boom delivering to ${m.to[0]}: ${m.text}`); } };

    const deps = setup({ email: odd });
    const out = await requestPasswordReset(appPool, address, { email: odd, appBaseUrl: "https://portal.example" });
    await out.settled; // never rejects
    expect((await forgot(deps.app, address)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const text = logged.join("\n");
    expect(text).toMatch(/sending failed unexpectedly/);
    expect(text).not.toContain(address);
    expect(text).not.toMatch(/boom|token=/);
  });
});

describe("a reset signs out every session issued before it", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  const asksForControls = (app: ReturnType<typeof setup>["app"], token: string) =>
    request(app).get(`/audits/${w.auditA1}/controls`).set("Authorization", `Bearer ${token}`);

  it("a session that worked before the reset is refused after it; signing in again gives a working one", async () => {
    await setPassword(w.auditor);
    const { app, email } = setup();
    const address = await emailOf(w.auditor);
    const stolen = tokenIssuedMinutesAgo(w.auditor);
    expect((await asksForControls(app, stolen)).status).toBe(200);

    await forgot(app, address);
    // merely ASKING for a reset changes nothing for existing sessions
    expect((await asksForControls(app, stolen)).status).toBe(200);
    await reset(app, tokenFrom(email.sent[0]), NEW_PW);

    const after = await asksForControls(app, stolen);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("UNAUTHENTICATED");

    const fresh = (await login(app, address, NEW_PW)).body.token;
    expect((await asksForControls(app, fresh)).status).toBe(200);
  });

  it("other accounts' sessions are unaffected", async () => {
    await setPassword(w.lead); await setPassword(w.readOnly);
    const { app, email } = setup();
    await forgot(app, await emailOf(w.lead));
    await reset(app, tokenFrom(email.sent[0]), NEW_PW);
    expect((await asksForControls(app, tokenIssuedMinutesAgo(w.readOnly))).status).toBe(200);
  });

  it("a disabled account's session stops working at once, even though its token has not expired", async () => {
    const { app } = setup();
    const token = tokenIssuedMinutesAgo(w.tLead);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.tLead]);
    const res = await request(app).get(`/audits/${w.auditA1}/controls`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("JwtTokenVerifier with a session check", () => {
  const good = (sub: string, extra: object = {}) => jwt.sign({ sub, ...extra }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });

  it("asks the check about this user and the moment the token was issued, and obeys the answer", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const v = new JwtTokenVerifier(SECRET, check);
    const iat = Math.floor(Date.now() / 1000) - 90;
    expect(await v.verify(good("user-1", { iat }))).toEqual({ userId: "user-1" });
    expect(check).toHaveBeenCalledWith("user-1", new Date(iat * 1000));

    check.mockResolvedValue(false);
    expect(await v.verify(good("user-1"))).toBeNull();
  });

  it("never reaches the check for a token that fails on signature, issuer or expiry", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const v = new JwtTokenVerifier(SECRET, check);
    expect(await v.verify(jwt.sign({ sub: "u" }, "some-other-secret-entirely-1234", { issuer: "evidence-portal" }))).toBeNull();
    expect(await v.verify(jwt.sign({ sub: "u" }, SECRET, { issuer: "somebody-else" }))).toBeNull();
    expect(await v.verify(jwt.sign({ sub: "u", iat: 1000 }, SECRET, { issuer: "evidence-portal", expiresIn: 5 }))).toBeNull();
    expect(await v.verify("garbage")).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses a token that carries no issue time when a check is in force (it could not be compared)", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const noIat = jwt.sign({ sub: "u" }, SECRET, { issuer: "evidence-portal", expiresIn: 3600, noTimestamp: true });
    expect(await new JwtTokenVerifier(SECRET, check).verify(noIat)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("without a check, behaves as before (signature and expiry only)", async () => {
    expect(await new JwtTokenVerifier(SECRET).verify(good("user-9"))).toEqual({ userId: "user-9" });
  });

  it("a failing check is an error, not a silent 'not signed in' (so a database outage is visible, not a mass sign-out)", async () => {
    const v = new JwtTokenVerifier(SECRET, async () => { throw new Error("db down"); });
    await expect(v.verify(good("u"))).rejects.toThrow("db down");
  });

  it("dbSessionCheck answers 'no' for anything that is not a user id, without asking the database", async () => {
    const spy = vi.spyOn(appPool, "connect");
    expect(await dbSessionCheck(appPool)("not-a-uuid", new Date())).toBe(false);
    expect(await dbSessionCheck(appPool)("'; DROP TABLE users;--", new Date())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dbSessionCheck says 'no' for an account that does not exist", async () => {
    expect(await dbSessionCheck(appPool)("00000000-0000-4000-8000-000000000000", new Date())).toBe(false);
  });
});

describe("request limits on the public endpoints", () => {
  const limits = { windowMs: 60_000, passwordReset: 2, signIn: 3 };

  it("forgot-password and reset-password each stop answering after their allowance, with a 429 and Retry-After", async () => {
    const { app } = setup({ authLimits: limits });
    expect((await forgot(app, "a@nowhere.test")).status).toBe(202);
    expect((await forgot(app, "b@nowhere.test")).status).toBe(202);
    const blocked = await forgot(app, "c@nowhere.test");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // reset-password has its own counter: flooding forgot-password does not lock out someone completing a reset
    expect((await reset(app, "f".repeat(64), NEW_PW)).status).toBe(400);
    expect((await reset(app, "e".repeat(64), NEW_PW)).status).toBe(400);
    // ...but is limited itself, so links cannot be guessed at speed
    const guessing = await reset(app, "d".repeat(64), NEW_PW);
    expect(guessing.status).toBe(429);
    expect(guessing.body.error.code).toBe("RATE_LIMITED");
  });

  it("login and accept-invite are limited too (with a bigger allowance), each on its own counter", async () => {
    const { app } = setup({ authLimits: limits });
    for (let i = 0; i < 3; i++) expect((await login(app, "x@nowhere.test", "whatever-pass-1234")).status).toBe(401);
    expect((await login(app, "x@nowhere.test", "whatever-pass-1234")).status).toBe(429);
    // accept-invite has its own counter (login being used up did not touch it), and is limited too
    const invite = () => request(app).post("/auth/accept-invite").send({ token: "t", password: NEW_PW });
    for (let i = 0; i < 3; i++) expect((await invite()).status).toBe(400);
    const blocked = await invite();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("the default allowances are generous enough for a normal shared office address", async () => {
    const { app } = setup();
    for (let i = 0; i < 20; i++) expect((await login(app, "x@nowhere.test", "whatever-pass-1234")).status).toBe(401);
  });

  it("trusts X-Forwarded-For only when told how many proxies there are", async () => {
    const spoofed = setup({ authLimits: { ...limits, passwordReset: 1 } }).app;
    await forgot(spoofed, "a@nowhere.test").set("X-Forwarded-For", "203.0.113.1");
    expect((await forgot(spoofed, "a@nowhere.test").set("X-Forwarded-For", "203.0.113.2")).status).toBe(429);

    const proxied = setup({ authLimits: { ...limits, passwordReset: 1 }, trustProxy: 1 }).app;
    await forgot(proxied, "a@nowhere.test").set("X-Forwarded-For", "203.0.113.1");
    expect((await forgot(proxied, "a@nowhere.test").set("X-Forwarded-For", "203.0.113.2")).status).toBe(202);
    expect((await forgot(proxied, "a@nowhere.test").set("X-Forwarded-For", "203.0.113.1")).status).toBe(429);
  });
});
