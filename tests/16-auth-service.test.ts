import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { AppError } from "../src/errors.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { JwtTokenVerifier, signSessionToken } from "../src/auth/jwt.ts";
import { hashInviteToken } from "../src/auth/inviteToken.ts";
import * as auth from "../src/services/auth.ts";
import * as users from "../src/services/users.ts";

const SECRET = "test-secret-at-least-32-bytes-long-ok";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

async function expectAppError(p: Promise<unknown>, code?: string, status?: number) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(AppError);
  const ae = err as AppError;
  if (code) expect(ae.code).toBe(code);
  if (status) expect(ae.status).toBe(status);
  return ae;
}

describe("invite -> accept -> login, end to end", () => {
  let w: World; let email: FakeEmailSender;
  beforeAll(async () => { w = await makeWorld(); email = new FakeEmailSender(); });

  it("inviting a user emails a link containing a usable token", async () => {
    const invited = await users.inviteAuditorUser(appPool, w.admin, { email: `new@audit-a-${w.tag}.test`, role: "auditor" },
      { email, appBaseUrl: "https://portal.example" });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toEqual([`new@audit-a-${w.tag}.test`]);
    const match = email.sent[0].text.match(/token=([0-9a-f]+)/);
    expect(match).toBeTruthy();
    const rawToken = match![1];

    const stored = await adminPool.query("SELECT invite_token_hash, status FROM users WHERE id = $1", [invited.id]);
    expect(stored.rows[0].invite_token_hash).toBe(hashInviteToken(rawToken));
    expect(stored.rows[0].status).toBe("invited");

    const completed = await auth.acceptInvite(appPool, SECRET, rawToken, "a-genuinely-long-password-123");
    expect(completed.userId).toBe(invited.id);
    expect(completed.token).toBeTruthy();

    const verifier = new JwtTokenVerifier(SECRET);
    const session = await verifier.verify(completed.token);
    expect(session?.userId).toBe(invited.id);

    const loggedIn = await auth.login(appPool, SECRET, `new@audit-a-${w.tag}.test`, "a-genuinely-long-password-123");
    if (auth.isMfaChallenge(loggedIn)) throw new Error("expected a session, got a two-step challenge");
    expect(loggedIn.userId).toBe(invited.id);
    expect(loggedIn.role).toBe("auditor");
  });

  it("rejects a weak password at accept-invite, before anything is written", async () => {
    const invited = await users.inviteAuditorUser(appPool, w.admin, { email: `weak@audit-a-${w.tag}.test`, role: "auditor" }, { email, appBaseUrl: "https://x" });
    const rawToken = email.sent.at(-1)!.text.match(/token=([0-9a-f]+)/)![1];
    await expectAppError(auth.acceptInvite(appPool, SECRET, rawToken, "short"), "WEAK_PASSWORD", 422);
    const row = await adminPool.query("SELECT password_hash, status FROM users WHERE id = $1", [invited.id]);
    expect(row.rows[0]).toEqual({ password_hash: null, status: "invited" });
  });

  it("an invite token can only ever be used once", async () => {
    const invited = await users.inviteAuditorUser(appPool, w.admin, { email: `once@audit-a-${w.tag}.test`, role: "auditor" }, { email, appBaseUrl: "https://x" });
    const rawToken = email.sent.at(-1)!.text.match(/token=([0-9a-f]+)/)![1];
    await auth.acceptInvite(appPool, SECRET, rawToken, "a-genuinely-long-password-123");
    await expectAppError(auth.acceptInvite(appPool, SECRET, rawToken, "another-long-password-456"), "INVALID_INVITE", 400);
    void invited;
  });

  it("a made-up or garbage token is rejected the same way as an expired one", async () => {
    await expectAppError(auth.acceptInvite(appPool, SECRET, "not-a-real-token", "a-genuinely-long-password-123"), "INVALID_INVITE", 400);
  });

  it("resendInvite issues a fresh token that works, and cannot target an already-active user", async () => {
    const invited = await users.inviteAuditorUser(appPool, w.admin, { email: `resend@audit-a-${w.tag}.test`, role: "auditor" });
    await users.resendInvite(appPool, w.admin, invited.id, { email, appBaseUrl: "https://x" });
    const rawToken = email.sent.at(-1)!.text.match(/token=([0-9a-f]+)/)![1];
    const completed = await auth.acceptInvite(appPool, SECRET, rawToken, "a-genuinely-long-password-123");
    expect(completed.userId).toBe(invited.id);
    await expectAppError(users.resendInvite(appPool, w.admin, invited.id, { email, appBaseUrl: "https://x" }), "NOT_FOUND", 404);
  });
});

describe("login: wrong password, lockout, and disabled accounts", () => {
  let w: World; let email: FakeEmailSender; let userEmail: string; let userId: string;
  beforeAll(async () => {
    w = await makeWorld();
    email = new FakeEmailSender();
    userEmail = `locktest@audit-a-${w.tag}.test`;
    const invited = await users.inviteAuditorUser(appPool, w.admin, { email: userEmail, role: "auditor" }, { email, appBaseUrl: "https://x" });
    userId = invited.id;
    const rawToken = email.sent.at(-1)!.text.match(/token=([0-9a-f]+)/)![1];
    await auth.acceptInvite(appPool, SECRET, rawToken, "correct-horse-battery-staple");
  });

  it("the wrong password is rejected with a generic message", async () => {
    await expectAppError(auth.login(appPool, SECRET, userEmail, "totally-wrong-password"), "INVALID_CREDENTIALS", 401);
  });

  it("an unknown email gets the exact same generic message (no account enumeration)", async () => {
    const err = await expectAppError(auth.login(appPool, SECRET, "nobody@nowhere.test", "whatever-password-123"));
    expect(err.status).toBe(401);
    expect(err.code).toBe("INVALID_CREDENTIALS");
    const real = await expectAppError(auth.login(appPool, SECRET, userEmail, "wrong-again-password"));
    expect(real.message).toBe(err.message);
  });

  it("locks the account after 5 failed attempts and blocks further attempts, even with the right password", async () => {
    // Its own freshly-invited user, independent of the shared one above — this test needs the failed-
    // attempt counter to genuinely start at zero, not whatever an earlier test in this file left it at.
    const freshEmail = `lockout-${Math.random().toString(36).slice(2)}@audit-a-${w.tag}.test`;
    const invited = await users.inviteAuditorUser(appPool, w.admin, { email: freshEmail, role: "auditor" }, { email, appBaseUrl: "https://x" });
    const rawToken = email.sent.at(-1)!.text.match(/token=([0-9a-f]+)/)![1];
    await auth.acceptInvite(appPool, SECRET, rawToken, "correct-horse-battery-staple");
    void invited;

    for (let i = 0; i < 5; i++) await expectAppError(auth.login(appPool, SECRET, freshEmail, "nope"), "INVALID_CREDENTIALS", 401);
    await expectAppError(auth.login(appPool, SECRET, freshEmail, "correct-horse-battery-staple"), "ACCOUNT_LOCKED", 423);
  });

  it("a disabled account cannot log in even with the correct password", async () => {
    await users.disableUser(appPool, w.admin, userId);
    await expectAppError(auth.login(appPool, SECRET, userEmail, "correct-horse-battery-staple"), "INVALID_CREDENTIALS", 401);
  });
});

describe("JwtTokenVerifier", () => {
  it("rejects a token signed with a different secret, and a malformed token", async () => {
    const w = await makeWorld();
    const verifier = new JwtTokenVerifier(SECRET);
    const other = new JwtTokenVerifier("a-completely-different-secret-value");
    const tokenFromOther = signSessionToken(w.admin, "a-completely-different-secret-value");
    expect(await verifier.verify(tokenFromOther)).toBeNull();
    expect(await other.verify(tokenFromOther)).toEqual({ userId: w.admin });
    expect(await verifier.verify("not.a.jwt")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const w = await makeWorld();
    const verifier = new JwtTokenVerifier(SECRET);
    const expired = signSessionToken(w.admin, SECRET, -10); // already expired
    expect(await verifier.verify(expired)).toBeNull();
  });
});
