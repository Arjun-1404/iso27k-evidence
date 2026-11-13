import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, controlId, type World } from "./helpers.ts";
import * as users from "../src/services/users.ts";
import * as review from "../src/services/review.ts";
import { AppError } from "../src/errors.ts";
import { EmailDeliveryError, FakeEmailSender, type EmailSender } from "../src/email/types.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";

/**
 * What happens when the mail server is down. With a real SMTP server this stops being hypothetical, and
 * each of the three emails the portal sends needs a deliberate answer:
 *   - a NEW invite: the user is created anyway (the saved invite is exactly what "Resend" works from),
 *     and the response says the email didn't go out;
 *   - a RESEND: all-or-nothing — the old link must keep working if the new one couldn't be delivered;
 *   - a REMINDER: all-or-nothing — a failed send must not use up the control's once-a-day allowance.
 */

afterAll(async () => { await adminPool.end(); await appPool.end(); });
afterEach(() => vi.restoreAllMocks());

class FailingEmail implements EmailSender {
  calls = 0;
  constructor(private readonly error: unknown = new EmailDeliveryError("Email not delivered: could not reach the mail server (ECONNREFUSED).", "unreachable")) {}
  async send(): Promise<never> { this.calls++; throw this.error; }
}

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const e = await p.then(() => { throw new Error("expected the call to fail"); }, (x) => x);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  expect((e as AppError).status).toBe(status);
}

const inviteState = async (email: string) =>
  (await adminPool.query("SELECT status, invite_token_hash, invite_token_expires_at FROM users WHERE email = $1", [email])).rows[0];

/** Captures everything the server would write to its logs while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const lines: string[] = [];
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  const result = await fn();
  return { result, logged: lines.join("\n") };
}

describe("a new invite when the email can't be sent", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("still creates the user, and says plainly that the email did not go out", async () => {
    const mail = new FailingEmail();
    const to = `down1@audit-a-${w.tag}.test`;
    const r = await users.inviteAuditorUser(appPool, w.admin, { email: to, role: "auditor" }, { email: mail, appBaseUrl: "https://x" });
    expect(r).toMatchObject({ email: to, status: "invited", emailSent: false });
    expect(mail.calls).toBe(1);
    const row = await inviteState(to);
    expect(row.status).toBe("invited");
    expect(row.invite_token_hash).toBeTruthy(); // a valid invite exists, ready to be re-sent
  });

  it("works the same for a tenant-side invite", async () => {
    const to = `down2@a1-${w.tag}.test`;
    const r = await users.inviteTenantUser(appPool, w.tLead, w.tA1, { email: to, role: "contributor" }, { email: new FailingEmail(), appBaseUrl: "https://x" });
    expect(r).toMatchObject({ email: to, emailSent: false });
    expect((await inviteState(to)).status).toBe("invited");
  });

  it("reports emailSent: true when it works, and says nothing about email when none is configured", async () => {
    const ok = await users.inviteAuditorUser(appPool, w.admin, { email: `up@audit-a-${w.tag}.test`, role: "auditor" }, { email: new FakeEmailSender(), appBaseUrl: "https://x" });
    expect(ok.emailSent).toBe(true);
    const none = await users.inviteAuditorUser(appPool, w.admin, { email: `none@audit-a-${w.tag}.test`, role: "auditor" });
    expect("emailSent" in none).toBe(false);
  });

  it("a mail failure never puts the invite link, or the address, in the server log", async () => {
    // A sender that throws a RAW error whose text contains everything sensitive — the worst case.
    const nasty = new FailingEmail(new Error("550 <leak@audit-a.test> rejected; body was: https://x/accept-invite?token=SECRETTOKEN"));
    const { result, logged } = await captureLogs(() =>
      users.inviteAuditorUser(appPool, w.admin, { email: `leak@audit-a-${w.tag}.test`, role: "auditor" }, { email: nasty, appBaseUrl: "https://x" }));
    expect(result.emailSent).toBe(false);
    expect(logged).not.toContain("accept-invite");
    expect(logged).not.toContain("SECRETTOKEN");
    expect(logged).not.toContain("leak@");
    expect(logged).toContain("[email]"); // but something IS logged, so an operator can tell it happened
  });

  it("only mail failures are absorbed: a database refusal still fails the request", async () => {
    await expectAppError(
      users.inviteAuditorUser(appPool, w.admin, { email: `spy@a1-${w.tag}.test`, role: "auditor" }, { email: new FailingEmail(), appBaseUrl: "https://x" }),
      "DOMAIN_NOT_ALLOWED", 422);
  });
});

describe("resending an invite when the email can't be sent", () => {
  let w: World; let to: string; let id: string;
  beforeAll(async () => {
    w = await makeWorld();
    to = `resend-down@audit-a-${w.tag}.test`;
    id = (await users.inviteAuditorUser(appPool, w.admin, { email: to, role: "auditor" })).id;
  });

  it("fails with a clear 502 and leaves the previous invite link working", async () => {
    const before = await inviteState(to);
    await expectAppError(users.resendInvite(appPool, w.admin, id, { email: new FailingEmail(), appBaseUrl: "https://x" }), "EMAIL_DELIVERY_FAILED", 502);
    const after = await inviteState(to);
    expect(after.invite_token_hash).toBe(before.invite_token_hash);
    expect(new Date(after.invite_token_expires_at).getTime()).toBe(new Date(before.invite_token_expires_at).getTime());
  });

  it("when the email does go out, the token is replaced and the new link is what was sent", async () => {
    const before = await inviteState(to);
    const mail = new FakeEmailSender();
    await users.resendInvite(appPool, w.admin, id, { email: mail, appBaseUrl: "https://portal.example" });
    expect((await inviteState(to)).invite_token_hash).not.toBe(before.invite_token_hash);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain("https://portal.example/accept-invite?token=");
  });
});

describe("a reminder when the email can't be sent", () => {
  let w: World; let c: string;
  const reminded = async () => (await adminPool.query("SELECT last_reminded_at FROM audit_controls WHERE id = $1", [c])).rows[0].last_reminded_at as Date | null;
  const remindAuditRows = async () => (await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'control.reminder_sent'", [c])).rows[0].n as number;
  beforeAll(async () => {
    w = await makeWorld();
    c = await controlId(w.auditA1, "A.8.5");
  });

  it("fails with 502, records nothing, and does not use up the 24-hour allowance", async () => {
    await expectAppError(review.remindForControl(appPool, w.auditor, new FailingEmail(), c), "EMAIL_DELIVERY_FAILED", 502);
    expect(await reminded()).toBeNull();
    expect(await remindAuditRows()).toBe(0);
  });

  it("so the very next attempt, once mail works, goes through — and THEN the rate limit applies", async () => {
    const mail = new FakeEmailSender();
    const ok = await review.remindForControl(appPool, w.auditor, mail, c);
    expect(ok.remindedCount).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(1);
    expect(await reminded()).not.toBeNull();
    expect(await remindAuditRows()).toBe(1);
    await expectAppError(review.remindForControl(appPool, w.auditor, mail, c), "REMINDER_RATE_LIMIT", 429);
    expect(mail.sent).toHaveLength(1); // the refused attempt sent nothing
  });

  it("a rate-limited attempt never even tries to send", async () => {
    const mail = new FailingEmail();
    await expectAppError(review.remindForControl(appPool, w.auditor, mail, c), "REMINDER_RATE_LIMIT", 429);
    expect(mail.calls).toBe(0);
  });
});

describe("the same behaviour over HTTP", () => {
  let w: World; let app: ReturnType<typeof createApp>; let auth: FakeTokenVerifier; let c: string;
  const bearer = (id: string) => `Bearer ${auth.issue(id)}`;
  beforeAll(async () => {
    w = await makeWorld();
    auth = new FakeTokenVerifier();
    app = createApp({ pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FailingEmail(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
    c = await controlId(w.auditA1, "A.8.5");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("POST /users: 201 with emailSent: false", async () => {
    const res = await request(app).post("/users").set("Authorization", bearer(w.admin)).send({ email: `http-down@audit-a-${w.tag}.test`, role: "auditor" });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.status).toBe("invited");
  });

  it("POST /users/:id/resend-invite: 502 EMAIL_DELIVERY_FAILED, with a message that is safe to show", async () => {
    const created = await request(app).post("/users").set("Authorization", bearer(w.admin)).send({ email: `http-resend@audit-a-${w.tag}.test`, role: "auditor" });
    const res = await request(app).post(`/users/${created.body.id}/resend-invite`).set("Authorization", bearer(w.admin));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("EMAIL_DELIVERY_FAILED");
    expect(res.body.error.message).toMatch(/could not be sent/i);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|accept-invite/);
  });

  it("POST /controls/:id/remind: 502, and the allowance is intact", async () => {
    const res = await request(app).post(`/controls/${c}/remind`).set("Authorization", bearer(w.auditor));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("EMAIL_DELIVERY_FAILED");
    const row = await adminPool.query("SELECT last_reminded_at FROM audit_controls WHERE id = $1", [c]);
    expect(row.rows[0].last_reminded_at).toBeNull();
  });
});
