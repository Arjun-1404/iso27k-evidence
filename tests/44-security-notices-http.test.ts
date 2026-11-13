import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { EmailDeliveryError, FakeEmailSender, type EmailMessage, type EmailSender } from "../src/email/types.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";
import { dbSessionCheck } from "../src/auth/sessionCheck.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { hashPassword } from "../src/auth/password.ts";
import { totpAtStep, stepAt } from "../src/auth/totp.ts";
import * as mfa from "../src/services/mfa.ts";
import { composeNotice, createNotifier, flushNotices, formatUtc, LOW_RECOVERY_CODES, type NoticeKind } from "../src/services/notices.ts";

/**
 * Security notice emails: the account's own address hears about a password change or reset, two-step sign-in being
 * turned on or off, recovery codes being made or used, and an administrator resetting two-step sign-in. These tests
 * pin down that each of those sends exactly one notice to the right person after the change really happened, that
 * a refused attempt sends nothing, that no notice holds a secret, and that a mail problem never reaches the person.
 */

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const SECRET = "security-notices-test-secret-value-long";
const STORE = new AesSecretStore("55".repeat(32));
const BASE = "https://portal.example";
const PW = "a-perfectly-good-password-123";
const NEW_PW = "a-brand-new-password-6789";
const OTHER_PW = "some-other-fresh-password-777";
let PW_HASH: string;

function setup(over: Partial<AppDeps> = {}) {
  const email = new FakeEmailSender();
  const app = createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email,
    tokenVerifier: new JwtTokenVerifier(SECRET, dbSessionCheck(appPool)), jwtSecret: SECRET, appBaseUrl: BASE,
    secretStore: STORE, ...over,
  });
  return { app, email };
}
type App = ReturnType<typeof setup>["app"];

// Codes change every 30 seconds and waiting is not an option, so the clock is ours.
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

beforeAll(async () => { PW_HASH = await hashPassword(PW); });
beforeEach(() => { freeze(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (app: App, t: string, path: string, body: object = {}) => request(app).post(path).set(bearer(t)).send(body);
const login = (app: App, email: string, password = PW) => request(app).post("/auth/login").send({ email, password });
const verify = (app: App, mfaToken: string, code: string) => request(app).post("/auth/mfa/verify").send({ mfaToken, code });

let seq = 0;
async function mkUser(w: World, role = "auditor", password: string | null = PW_HASH) {
  const addr = `n${++seq}-${w.tag}@audit-a-${w.tag}.test`;
  const id = (await adminPool.query(
    "INSERT INTO users (org_id, email, full_name, role, status, password_hash) VALUES ($1,$2,$3,$4,'active',$5) RETURNING id", [w.orgA, addr, `Notice Person ${seq}`, role, password])).rows[0].id as string;
  return { id, email: addr };
}
const sessionOf = async (app: App, addr: string) => {
  const r = await login(app, addr);
  expect(r.status).toBe(200);
  return r.body.token as string;
};
/** Walks the real journey to turn two-step sign-in on. The notice for turning it on is in `email` afterwards. */
async function withTwoStep(app: App, w: World) {
  const u = await mkUser(w);
  const session = await sessionOf(app, u.email);
  const secret = (await post(app, session, "/auth/mfa/enroll", { password: PW })).body.secret as string;
  const done = await post(app, session, "/auth/mfa/enroll/confirm", { code: freshCode(secret) });
  expect(done.status).toBe(200);
  return { ...u, secret, session, recoveryCodes: done.body.recoveryCodes as string[] };
}
async function twoStepSession(app: App, addr: string, secret: string) {
  const first = await login(app, addr);
  expect(first.body.mfaRequired).toBe(true);
  const second = await verify(app, first.body.mfaToken, freshCode(secret));
  expect(second.status).toBe(200);
  return second.body.token as string;
}

/** Waits for every queued notice, then returns what has been sent so far. */
async function sentNow(email: FakeEmailSender): Promise<EmailMessage[]> {
  await flushNotices(5_000);
  return [...email.sent];
}
/** Everything sent after `before` messages. */
async function sentSince(email: FakeEmailSender, before: number): Promise<EmailMessage[]> {
  return (await sentNow(email)).slice(before);
}
const subjects = (m: EmailMessage[]) => m.map((x) => x.subject);

const SUBJECT: Record<NoticeKind, string> = {
  password_changed: "Your Evidence Portal password was changed",
  password_reset: "Your Evidence Portal password was reset",
  mfa_enabled: "Two-step sign-in was turned on for your Evidence Portal account",
  mfa_disabled: "Two-step sign-in was turned off for your Evidence Portal account",
  mfa_recovery_regenerated: "New recovery codes were created for your Evidence Portal account",
  mfa_recovery_used: "A recovery code was used on your Evidence Portal account",
  mfa_reset_by_admin: "Your Evidence Portal two-step sign-in was reset",
};
const KINDS = Object.keys(SUBJECT) as NoticeKind[];

/** Nothing a notice says may be a secret, or let someone act as the person. */
function expectNoSecrets(msgs: EmailMessage[], secrets: Array<string | undefined>) {
  for (const m of msgs) {
    const all = `${m.subject}\n${m.text}`;
    for (const s of secrets) if (s) expect(all, `leaked ${s.slice(0, 4)}…`).not.toContain(s);
    expect(all).not.toMatch(/[0-9a-f]{64}/i); // no token-shaped string
    expect(all).not.toMatch(/\btoken=/);
    expect(all).not.toMatch(/[A-Z2-7]{16,}/); // no base32 authenticator secret
    expect(all).not.toMatch(/\b\d{6}\b/); // no six-digit code
    expect(all).not.toMatch(/\$2[aby]\$\d{2}\$/); // no password hash
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no internal account id
  }
}

// ====================================================================================================================
describe("the words of each notice", () => {
  const at = new Date(Date.UTC(2026, 10, 6, 17, 5, 9));
  const ctx = { appBaseUrl: BASE, at };

  it("formats the time in UTC and says so", () => {
    expect(formatUtc(at)).toBe("6 November 2026, 17:05 UTC");
    expect(formatUtc(new Date(Date.UTC(2027, 0, 31, 0, 0, 0)))).toBe("31 January 2027, 00:00 UTC");
    expect(formatUtc(new Date(Date.UTC(2026, 11, 1, 23, 59, 59)))).toBe("1 December 2026, 23:59 UTC");
  });

  it("has a fixed, specific subject for every kind", () => {
    for (const k of KINDS) expect(composeNotice(k, ctx).subject).toBe(SUBJECT[k]);
    expect(new Set(KINDS.map((k) => composeNotice(k, ctx).subject)).size).toBe(KINDS.length);
  });

  it("says when it happened, in every kind", () => {
    for (const k of KINDS) expect(composeNotice(k, ctx).text, k).toContain("6 November 2026, 17:05 UTC");
  });

  it("never prints a missing value", () => {
    for (const k of KINDS) {
      const { subject, text } = composeNotice(k, ctx);
      for (const bad of ["undefined", "null", "NaN", "[object", "{"]) {
        expect(text, `${k} text`).not.toContain(bad);
        expect(subject, `${k} subject`).not.toContain(bad);
      }
    }
  });

  it("tells the person what to do if it wasn't them, with a link they can trust", () => {
    for (const k of KINDS.filter((x) => x !== "mfa_reset_by_admin")) {
      const t = composeNotice(k, ctx).text;
      expect(t, k).toContain("If this was you, there is nothing to do.");
      expect(t, k).toContain("If it wasn't you");
      expect(t, k).toContain(`${BASE}/forgot-password`);
      expect(t, k).toContain("administrator of your organisation");
    }
    // The link is built from the configured base, not from anything a request supplied.
    expect(composeNotice("password_changed", { ...ctx, appBaseUrl: "https://other.example" }).text).toContain("https://other.example/forgot-password");
    expect(composeNotice("password_changed", { ...ctx, appBaseUrl: "https://other.example" }).text).not.toContain(BASE);
  });

  it("ends every notice by saying it is automatic and that no one will ask for a password or code by email", () => {
    for (const k of KINDS) {
      const t = composeNotice(k, ctx).text;
      expect(t, k).toContain("please don't reply");
      expect(t, k).toContain("We will never ask for your password or a code by email.");
    }
  });

  it("an administrator's reset names no one and offers no reset link", () => {
    const t = composeNotice("mfa_reset_by_admin", ctx).text;
    expect(t).toContain("An administrator of your organisation");
    expect(t).toContain("set up two-step sign-in again");
    expect(t).not.toContain("forgot-password");
  });

  it("says how many recovery codes are left, and nudges for a new set when few remain", () => {
    const many = composeNotice("mfa_recovery_used", { ...ctx, recoveryRemaining: LOW_RECOVERY_CODES + 1 }).text;
    expect(many).toContain(`You have ${LOW_RECOVERY_CODES + 1} left.`);
    expect(many).not.toContain("Get a new set");
    const few = composeNotice("mfa_recovery_used", { ...ctx, recoveryRemaining: LOW_RECOVERY_CODES }).text;
    expect(few).toContain(`You have ${LOW_RECOVERY_CODES} left.`);
    expect(few).toContain("Get a new set under Security");
    const none = composeNotice("mfa_recovery_used", { ...ctx, recoveryRemaining: 0 }).text;
    expect(none).toContain("You have 0 left.");
    expect(none).toContain("Get a new set under Security");
    const unknown = composeNotice("mfa_recovery_used", ctx).text;
    expect(unknown).not.toContain("You have");
  });

  it("mentions the count only for the recovery-used notice", () => {
    for (const k of KINDS.filter((x) => x !== "mfa_recovery_used")) {
      expect(composeNotice(k, { ...ctx, recoveryRemaining: 5 }).text, k).not.toContain("You have 5 left");
    }
  });

  it("is plain text with no markup", () => {
    for (const k of KINDS) expect(composeNotice(k, ctx).text, k).not.toMatch(/<[a-z/][^>]*>/i);
  });
});

// ====================================================================================================================
describe("changing your password", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("sends one notice to the account's own address, after the change", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    const r = await post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(200);

    const mails = await sentNow(email);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([u.email]);
    expect(mails[0].subject).toBe(SUBJECT.password_changed);
    expect(mails[0].text).toMatch(/was changed on \d{1,2} [A-Z][a-z]+ \d{4}, \d\d:\d\d UTC/);
    expect(mails[0].text).toContain(`${BASE}/forgot-password`);
    expectNoSecrets(mails, [PW, NEW_PW, s, r.body.token]);
  });

  it("is sent only once the new password is really in effect", async () => {
    const seen: Array<{ changed: boolean }> = [];
    const probe: EmailSender = {
      async send() {
        const h = (await adminPool.query("SELECT password_hash FROM users WHERE id=$1", [u.id])).rows[0].password_hash as string;
        seen.push({ changed: h !== PW_HASH });
      },
    };
    const { app } = setup({ email: probe });
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    expect((await post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(200);
    await flushNotices(5_000);
    expect(seen).toEqual([{ changed: true }]);
  });

  it("sends nothing when the attempt is refused", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    const before = email.sent.length;

    expect((await request(app).post("/auth/change-password").send({ currentPassword: PW, newPassword: NEW_PW })).status).toBe(401); // no session
    expect((await post(app, "not-a-token", "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(401);
    expect((await post(app, s, "/auth/change-password", { currentPassword: "wrong-password-entirely", newPassword: NEW_PW })).status).toBe(403); // wrong current
    expect((await post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: "short" })).status).toBe(422); // too weak
    expect((await post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: PW })).status).toBe(422); // same as now
    expect((await post(app, s, "/auth/change-password", { currentPassword: PW })).status).toBe(400); // missing field
    expect(await sentSince(email, before)).toEqual([]);
  });

  it("sends nothing to a locked account", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    await adminPool.query("UPDATE users SET locked_until = now() + interval '1 hour' WHERE id=$1", [u.id]);
    const before = email.sent.length;
    const r = await post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(423);
    expect(await sentSince(email, before)).toEqual([]);
  });

  it("with two-step on: a wrong or missing code sends nothing, a good code sends the one notice", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email); // the "turned on" notice
    const before = email.sent.length;

    expect((await post(app, u.session, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(400); // no code
    expect((await post(app, u.session, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW, code: wrongCode(u.secret) })).status).toBe(403);
    expect(await sentSince(email, before)).toEqual([]);

    const ok = await post(app, u.session, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW, code: freshCode(u.secret) });
    expect(ok.status).toBe(200);
    const mails = await sentSince(email, before);
    expect(subjects(mails)).toEqual([SUBJECT.password_changed]);
    expectNoSecrets(mails, [PW, NEW_PW, u.secret, ...u.recoveryCodes]);
  });

  it("with two-step on: confirming with a recovery code sends the recovery notice as well", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;

    const ok = await post(app, u.session, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW, code: u.recoveryCodes[0] });
    expect(ok.status).toBe(200);
    const mails = await sentSince(email, before);
    expect(subjects(mails).sort()).toEqual([SUBJECT.mfa_recovery_used, SUBJECT.password_changed].sort());
    expect(mails.every((m) => m.to[0] === u.email)).toBe(true);
    const used = mails.find((m) => m.subject === SUBJECT.mfa_recovery_used)!;
    expect(used.text).toContain(`You have ${u.recoveryCodes.length - 1} left.`);
    expectNoSecrets(mails, [PW, NEW_PW, u.secret, ...u.recoveryCodes]);
  });

  it("a recovery code that was refused (already used) sends nothing", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    expect((await post(app, u.session, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW, code: u.recoveryCodes[1] })).status).toBe(200);
    await sentNow(email);
    const before = email.sent.length;
    // The same code again, from the account's new session: it is spent, so nothing happens and nothing is sent.
    const again = await login(app, u.email, NEW_PW);
    expect(again.body.mfaRequired).toBe(true);
    expect((await verify(app, again.body.mfaToken, u.recoveryCodes[1])).status).toBe(401);
    expect(await sentSince(email, before)).toEqual([]);
  });
});

// ====================================================================================================================
describe("resetting a forgotten password by email link", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  const tokenIn = (m: EmailMessage) => m.text.match(/reset-password\?token=([0-9a-f]{64})/)![1];

  it("sends the link first, then a notice once the password has been reset", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    expect((await request(app).post("/auth/forgot-password").send({ email: u.email })).status).toBe(202);
    const linkMail = (await sentNow(email))[0];
    expect(linkMail.text).toContain("reset-password?token=");
    const token = tokenIn(linkMail);
    expect(email.sent).toHaveLength(1); // asking for a link is not itself a notice

    expect((await request(app).post("/auth/reset-password").send({ token, password: NEW_PW })).status).toBe(200);
    const mails = await sentNow(email);
    expect(mails).toHaveLength(2);
    const notice = mails[1];
    expect(notice.to).toEqual([u.email]);
    expect(notice.subject).toBe(SUBJECT.password_reset);
    expect(notice.text).toContain("using a link sent to this address");
    expectNoSecrets([notice], [PW, NEW_PW, token]);
  });

  it("sends nothing for a bad, used or expired link, or a weak password", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    await request(app).post("/auth/forgot-password").send({ email: u.email });
    const token = tokenIn((await sentNow(email))[0]);
    const before = email.sent.length;

    expect((await request(app).post("/auth/reset-password").send({ token: "0".repeat(64), password: NEW_PW })).status).toBe(400);
    expect((await request(app).post("/auth/reset-password").send({ token, password: "short" })).status).toBe(422);
    expect(await sentSince(email, before)).toEqual([]);

    expect((await request(app).post("/auth/reset-password").send({ token, password: NEW_PW })).status).toBe(200);
    expect(await sentSince(email, before)).toHaveLength(1); // the one notice for the one real reset
    expect((await request(app).post("/auth/reset-password").send({ token, password: OTHER_PW })).status).toBe(400); // the link is spent
    expect(await sentSince(email, before)).toHaveLength(1);
  });

  it("asking for a link for an address with no account sends no notice to anyone", async () => {
    const { app, email } = setup();
    expect((await request(app).post("/auth/forgot-password").send({ email: `nobody-${w.tag}@audit-a-${w.tag}.test` })).status).toBe(202);
    expect(await sentNow(email)).toEqual([]);
  });
});

// ====================================================================================================================
describe("turning two-step sign-in on", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("sends nothing until it is actually switched on, then one notice", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);

    const begun = await post(app, s, "/auth/mfa/enroll", { password: PW });
    expect(begun.status).toBe(200);
    expect(await sentNow(email)).toEqual([]); // starting is not turning it on

    expect((await post(app, s, "/auth/mfa/enroll", { password: "wrong-password-entirely" })).status).toBe(403);
    expect((await post(app, s, "/auth/mfa/enroll/confirm", { code: wrongCode(begun.body.secret) })).status).toBe(403);
    expect(await sentNow(email)).toEqual([]);

    const done = await post(app, s, "/auth/mfa/enroll/confirm", { code: freshCode(begun.body.secret) });
    expect(done.status).toBe(200);
    const mails = await sentNow(email);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([u.email]);
    expect(mails[0].subject).toBe(SUBJECT.mfa_enabled);
    expectNoSecrets(mails, [PW, begun.body.secret, ...done.body.recoveryCodes]);
  });

  it("confirming when set-up was never started is refused and sends nothing", async () => {
    const { app, email } = setup();
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    const r = await post(app, s, "/auth/mfa/enroll/confirm", { code: "123456" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NO_ENROLLMENT");
    expect(await sentNow(email)).toEqual([]);
  });

  it("if the set-up vanishes between the check and the switch-on, it is refused and sends nothing", async () => {
    const email = new FakeEmailSender();
    const notify = createNotifier(appPool, email, BASE);
    const { app } = setup();
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    const begun = await post(app, s, "/auth/mfa/enroll", { password: PW });
    expect(begun.status).toBe(200);

    // The pending set-up is removed (as a second tab finishing or cancelling would) at the moment of switching on.
    const racing = {
      connect: async () => {
        const c = await appPool.connect();
        const run = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: unknown }).query = async (text: unknown, ...rest: unknown[]) => {
          if (typeof text === "string" && text.includes("mfa_confirm_enrollment")) await adminPool.query("DELETE FROM user_mfa WHERE user_id=$1", [u.id]);
          return run(text, ...rest);
        };
        return c;
      },
    } as unknown as Pool;

    await expect(mfa.confirmEnrollment(racing, STORE, u.id, freshCode(begun.body.secret), notify))
      .rejects.toMatchObject({ code: "NO_ENROLLMENT", status: 409 });
    expect(await sentNow(email)).toEqual([]);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL", [u.id])).rows[0].n).toBe(0);
  });

  it("confirming again once it is on sends nothing more", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;
    const again = await post(app, u.session, "/auth/mfa/enroll/confirm", { code: freshCode(u.secret) });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await sentSince(email, before)).toEqual([]);
  });
});

// ====================================================================================================================
describe("turning two-step sign-in off", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("sends one notice after it is really off, and nothing for refused attempts", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;

    expect((await post(app, u.session, "/auth/mfa/disable", { password: "wrong-password-entirely", code: freshCode(u.secret) })).status).toBe(403);
    expect((await post(app, u.session, "/auth/mfa/disable", { password: PW, code: wrongCode(u.secret) })).status).toBe(403);
    expect((await request(app).post("/auth/mfa/disable").send({ password: PW, code: freshCode(u.secret) })).status).toBe(401);
    expect(await sentSince(email, before)).toEqual([]);

    const ok = await post(app, u.session, "/auth/mfa/disable", { password: PW, code: freshCode(u.secret) });
    expect(ok.status).toBe(200);
    const mails = await sentSince(email, before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([u.email]);
    expect(mails[0].subject).toBe(SUBJECT.mfa_disabled);
    expectNoSecrets(mails, [PW, u.secret, ...u.recoveryCodes]);
  });

  it("is sent only once it really is off", async () => {
    const seen: boolean[] = [];
    const probe: EmailSender = {
      async send(m: EmailMessage) {
        if (m.subject !== SUBJECT.mfa_disabled) return;
        const row = (await adminPool.query("SELECT 1 FROM user_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL", [u.id])).rows;
        seen.push(row.length === 0);
      },
    };
    const { app } = setup({ email: probe });
    const u = await withTwoStep(app, w);
    expect((await post(app, u.session, "/auth/mfa/disable", { password: PW, code: freshCode(u.secret) })).status).toBe(200);
    await flushNotices(5_000);
    expect(seen).toEqual([true]);
  });

  it("disabling with a recovery code sends the recovery notice as well as the 'off' notice", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;
    expect((await post(app, u.session, "/auth/mfa/disable", { password: PW, code: u.recoveryCodes[2] })).status).toBe(200);
    const mails = await sentSince(email, before);
    expect(subjects(mails).sort()).toEqual([SUBJECT.mfa_disabled, SUBJECT.mfa_recovery_used].sort());
    expectNoSecrets(mails, [PW, u.secret, ...u.recoveryCodes]);
  });

  it("a refusal because the organisation requires two-step sends nothing", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await adminPool.query("UPDATE orgs SET mfa_policy='staff' WHERE id=$1", [w.orgA]);
    try {
      await sentNow(email);
      const before = email.sent.length;
      const r = await post(app, u.session, "/auth/mfa/disable", { password: PW, code: freshCode(u.secret) });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("MFA_REQUIRED_BY_POLICY");
      expect(await sentSince(email, before)).toEqual([]);
    } finally {
      await adminPool.query("UPDATE orgs SET mfa_policy='off' WHERE id=$1", [w.orgA]);
    }
  });
});

// ====================================================================================================================
describe("recovery codes", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("making a new set sends one notice, after a good password and code only", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;

    expect((await post(app, u.session, "/auth/mfa/recovery-codes", { password: "wrong-password-entirely", code: freshCode(u.secret) })).status).toBe(403);
    expect((await post(app, u.session, "/auth/mfa/recovery-codes", { password: PW, code: wrongCode(u.secret) })).status).toBe(403);
    expect(await sentSince(email, before)).toEqual([]);

    const ok = await post(app, u.session, "/auth/mfa/recovery-codes", { password: PW, code: freshCode(u.secret) });
    expect(ok.status).toBe(200);
    const mails = await sentSince(email, before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([u.email]);
    expect(mails[0].subject).toBe(SUBJECT.mfa_recovery_regenerated);
    expectNoSecrets(mails, [PW, u.secret, ...u.recoveryCodes, ...ok.body.recoveryCodes]);
  });

  it("signing in with an authenticator code sends nothing", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;
    await twoStepSession(app, u.email, u.secret);
    expect(await sentSince(email, before)).toEqual([]);
  });

  it("signing in with a recovery code sends one notice, saying how many are left", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;

    const first = await login(app, u.email);
    const ok = await verify(app, first.body.mfaToken, u.recoveryCodes[0]);
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodeUsed).toBe(true);
    const mails = await sentSince(email, before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([u.email]);
    expect(mails[0].subject).toBe(SUBJECT.mfa_recovery_used);
    expect(mails[0].text).toContain(`You have ${u.recoveryCodes.length - 1} left.`);
    expectNoSecrets(mails, [PW, u.secret, ...u.recoveryCodes, ok.body.token]);
  });

  it("the count goes down with each one used, and the nudge appears when few remain", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const total = u.recoveryCodes.length;
    const before = email.sent.length;
    for (let i = 0; i < total - 1; i++) {
      const first = await login(app, u.email);
      expect((await verify(app, first.body.mfaToken, u.recoveryCodes[i])).status).toBe(200);
    }
    const mails = await sentSince(email, before);
    expect(mails).toHaveLength(total - 1);
    const lefts = mails.map((m) => Number(m.text.match(/You have (\d+) left/)![1])).sort((a, b) => b - a);
    expect(lefts).toEqual(Array.from({ length: total - 1 }, (_, i) => total - 1 - i));
    for (const m of mails) {
      const left = Number(m.text.match(/You have (\d+) left/)![1]);
      expect(m.text.includes("Get a new set"), `left=${left}`).toBe(left <= LOW_RECOVERY_CODES);
    }
  });

  it("a wrong or already-used recovery code sends nothing", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    const first = await login(app, u.email);
    expect((await verify(app, first.body.mfaToken, u.recoveryCodes[0])).status).toBe(200);
    await sentNow(email);
    const before = email.sent.length;

    const second = await login(app, u.email);
    expect((await verify(app, second.body.mfaToken, u.recoveryCodes[0])).status).toBe(401); // spent
    expect((await verify(app, second.body.mfaToken, "aaaa-bbbb-cccc")).status).toBe(400); // not a code at all
    expect((await verify(app, "not-a-token", u.recoveryCodes[1])).status).toBe(401);
    expect(await sentSince(email, before)).toEqual([]);
  });
});

// ====================================================================================================================
describe("an administrator resetting someone's two-step sign-in", () => {
  let w: World; let adminSession: string;
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [w.admin, PW_HASH]);
  });
  beforeEach(async () => { const { app } = setup(); adminSession = await sessionOf(app, (await adminPool.query("SELECT email FROM users WHERE id=$1", [w.admin])).rows[0].email); });

  it("tells the person it happened to, and only them", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;
    const adminEmail = (await adminPool.query("SELECT email, full_name FROM users WHERE id=$1", [w.admin])).rows[0];

    const r = await post(app, adminSession, `/users/${u.id}/reset-mfa`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ reset: true });
    const mails = await sentSince(email, before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([u.email]);
    expect(mails[0].subject).toBe(SUBJECT.mfa_reset_by_admin);
    expectNoSecrets(mails, [PW, u.secret, ...u.recoveryCodes]);
    // It says "an administrator", not which one.
    expect(mails[0].text).not.toContain(adminEmail.email);
    expect(mails[0].text).not.toContain(adminEmail.full_name);
    expect(email.sent.some((m) => m.to.includes(adminEmail.email))).toBe(false);
  });

  it("sends nothing when there was nothing to reset, or the person isn't allowed to", async () => {
    const { app, email } = setup();
    const plain = await mkUser(w); // never turned two-step on
    const v = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;

    expect((await post(app, adminSession, `/users/${plain.id}/reset-mfa`)).body).toEqual({ reset: false });
    expect((await post(app, adminSession, `/users/${randomUUID()}/reset-mfa`)).status).toBeLessThan(500);
    expect((await request(app).post(`/users/${v.id}/reset-mfa`)).status).toBe(401);
    const notAdmin = await mkUser(w, "lead_auditor");
    const t = await sessionOf(app, notAdmin.email);
    expect((await post(app, t, `/users/${v.id}/reset-mfa`)).status).toBe(403);
    expect((await post(app, adminSession, "/users/not-a-uuid/reset-mfa")).status).toBe(400);
    expect(await sentSince(email, before)).toEqual([]);
  });

  it("resetting the same person twice sends only the one notice", async () => {
    const { app, email } = setup();
    const u = await withTwoStep(app, w);
    await sentNow(email);
    const before = email.sent.length;
    expect((await post(app, adminSession, `/users/${u.id}/reset-mfa`)).body).toEqual({ reset: true });
    expect((await post(app, adminSession, `/users/${u.id}/reset-mfa`)).body).toEqual({ reset: false });
    expect(subjects(await sentSince(email, before))).toEqual([SUBJECT.mfa_reset_by_admin]);
  });
});

// ====================================================================================================================
describe("who a notice goes to", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("goes to the address on file, and to no one else", async () => {
    const { app, email } = setup();
    const a = await mkUser(w); const b = await mkUser(w);
    const sa = await sessionOf(app, a.email);
    await sessionOf(app, b.email);
    expect((await post(app, sa, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(200);
    const mails = await sentNow(email);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([a.email]);
    expect(mails.flatMap((m) => m.to)).not.toContain(b.email);
  });

  it("is never sent to a disabled, invited or unknown account", async () => {
    const email = new FakeEmailSender();
    const notify = createNotifier(appPool, email, BASE);
    const disabled = await mkUser(w);
    const invited = await mkUser(w);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [disabled.id]);
    await adminPool.query("UPDATE users SET status='invited' WHERE id=$1", [invited.id]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const k of KINDS) {
      notify.notify(disabled.id, k);
      notify.notify(invited.id, k);
      notify.notify(randomUUID(), k);
    }
    await flushNotices(5_000);
    expect(email.sent).toEqual([]);
  });

  it("an active account does get each kind", async () => {
    const email = new FakeEmailSender();
    const notify = createNotifier(appPool, email, BASE);
    const u = await withTwoStep(setup().app, w);
    for (const k of KINDS) notify.notify(u.id, k);
    await flushNotices(5_000);
    expect(subjects(email.sent).sort()).toEqual(KINDS.map((k) => SUBJECT[k]).sort());
    expect(email.sent.every((m) => m.to[0] === u.email)).toBe(true);
  });
});

// ====================================================================================================================
describe("a mail problem never reaches the person", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  /** What the server would write to its logs while `fn` runs. */
  async function captureLogs<T>(fn: () => Promise<T>) {
    const lines: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const result = await fn();
    await flushNotices(5_000);
    return { result, logged: lines.join("\n") };
  }
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  beforeAll(() => { process.on("unhandledRejection", onUnhandled); });
  afterAll(() => { process.off("unhandledRejection", onUnhandled); });

  it("a mail server that refuses the message changes nothing, and the log names the kind but not the address", async () => {
    const send = vi.fn(async () => { throw new EmailDeliveryError("Email not delivered: could not reach the mail server (ECONNREFUSED).", "unreachable"); });
    const { app } = setup({ email: { send } });
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);

    const { result: r, logged } = await captureLogs(() => post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW }));
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(logged).toContain("security notice (password_changed)");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain(u.email);
    expect(logged).not.toContain(u.id);
    expect(logged).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no account id of any kind
    // The change stood, and the new password works.
    expect((await login(app, u.email, NEW_PW)).status).toBe(200);
    expect((await login(app, u.email, PW)).status).toBe(401);
  });

  it("an unexpected error is logged as 'not sent' with nothing from the error in it", async () => {
    const { app } = setup({ email: { send: async () => { throw new Error("boom: secret-detail for someone@example.test"); } } });
    const u = await withTwoStep(app, w);
    const { result: r, logged } = await captureLogs(() => post(app, u.session, "/auth/mfa/recovery-codes", { password: PW, code: freshCode(u.secret) }));
    expect(r.status).toBe(200);
    expect(logged).toContain("security notice (mfa_recovery_regenerated): not sent");
    expect(logged).not.toContain("secret-detail");
    expect(logged).not.toContain("someone@example.test");
    expect(logged).not.toContain(u.email);
    expect(logged).not.toContain(u.id);
    expect(logged).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("a sender that throws before returning a promise is handled the same way", async () => {
    const { app } = setup({ email: { send: (() => { throw new TypeError("not a promise"); }) as unknown as EmailSender["send"] } });
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);
    const { result: r, logged } = await captureLogs(() => post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW }));
    expect(r.status).toBe(200);
    expect(logged).toContain("security notice (password_changed): not sent");
  });

  it("a database error while preparing a notice is swallowed too", async () => {
    const broken = { query: () => Promise.reject(new Error("db down")), connect: () => Promise.reject(new Error("db down")) } as unknown as Pool;
    const email = new FakeEmailSender();
    const notify = createNotifier(broken, email, BASE);
    const { logged } = await captureLogs(async () => { expect(() => notify.notify(randomUUID(), "mfa_enabled")).not.toThrow(); });
    expect(email.sent).toEqual([]);
    expect(logged).toContain("security notice (mfa_enabled): not sent");
    expect(logged).not.toContain("db down");
  });

  it("a malformed account id doesn't throw into the caller", async () => {
    const email = new FakeEmailSender();
    const notify = createNotifier(appPool, email, BASE);
    const { logged } = await captureLogs(async () => { expect(() => notify.notify("not-a-uuid", "password_changed")).not.toThrow(); });
    expect(email.sent).toEqual([]);
    expect(logged).toContain("security notice (password_changed): not sent");
  });

  it("a mail server that never answers does not hold up the response", { timeout: 20_000 }, async () => {
    const release: Array<() => void> = [];
    const sent: EmailMessage[] = [];
    const hanging: EmailSender = { send: (m) => new Promise<void>((resolve) => { release.push(() => { sent.push(m); resolve(); }); }) };
    const { app } = setup({ email: hanging });
    const u = await mkUser(w);
    const s = await sessionOf(app, u.email);

    const t0 = performance.now(); // the page clock is frozen in these tests; this one is not
    const r = await post(app, s, "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW });
    expect(r.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(5_000);

    // Shutdown doesn't wait for it forever either.
    const f0 = performance.now();
    await flushNotices(100);
    expect(performance.now() - f0).toBeLessThan(3_000);
    expect(sent).toEqual([]);

    // When the server finally answers, the notice goes out normally.
    while (release.length === 0) await new Promise((res) => setTimeout(res, 10));
    release.forEach((f) => f());
    await flushNotices(5_000);
    expect(subjects(sent)).toEqual([SUBJECT.password_changed]);
  });

  it("flushNotices returns at once when nothing is waiting, and waits for notices queued while it waits", async () => {
    const t0 = performance.now();
    await flushNotices(10_000);
    expect(performance.now() - t0).toBeLessThan(1_000);

    const email = new FakeEmailSender();
    const notify = createNotifier(appPool, email, BASE);
    const u = await mkUser(w);
    notify.notify(u.id, "password_changed");
    notify.notify(u.id, "mfa_enabled");
    await flushNotices(5_000);
    expect(email.sent).toHaveLength(2);
  });

  it("leaves no unhandled rejection behind", async () => {
    await flushNotices(5_000);
    expect(unhandled).toEqual([]);
  });
});
