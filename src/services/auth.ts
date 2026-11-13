import type { Pool } from "pg";
import { withoutUser } from "../db/pool.ts";
import { AppError } from "../errors.ts";
import { hashPassword, verifyPassword, checkPasswordStrength } from "../auth/password.ts";
import { signSessionToken } from "../auth/jwt.ts";
import { hashInviteToken } from "../auth/inviteToken.ts";
import { signMfaToken } from "../auth/mfaToken.ts";

export interface LoginResult { token: string; userId: string; role: string; tenantId: string | null }

/** What sign-in returns for an account with two-step sign-in on: not a session, only a short-lived token that
 *  the second step (POST /auth/mfa/verify) trades, together with a code, for the session. */
export interface MfaChallenge { mfaRequired: true; mfaToken: string }
export type LoginOutcome = LoginResult | MfaChallenge;
export const isMfaChallenge = (o: LoginOutcome): o is MfaChallenge => "mfaRequired" in o;

const GENERIC_LOGIN_ERROR = "Incorrect email or password.";

/**
 * Verifies an email/password pair and issues a session token — or, if the account has two-step sign-in on, a
 * challenge to be completed with a code instead (and NOT counted as a successful sign-in yet: the failure
 * counter is only cleared when the second step succeeds). Deliberately gives the same generic
 * error for "no such account", "wrong password", and "account has no password set" (an account meant
 * for external SSO only) — telling those apart would let an attacker enumerate valid emails. A locked
 * account gets its own message; that one's an accepted, common trade-off (GitHub and others do the
 * same), not an oversight.
 */
export async function login(pool: Pool, jwtSecret: string, email: string, password: string): Promise<LoginOutcome> {
  const row = await withoutUser(pool, (c) => c.query("SELECT * FROM auth_lookup_by_email($1)", [email]).then((r) => r.rows[0]));

  if (!row || !row.password_hash || row.status !== "active") {
    throw new AppError(GENERIC_LOGIN_ERROR, 401, "INVALID_CREDENTIALS");
  }
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw new AppError("Too many failed attempts. Please try again in a few minutes.", 423, "ACCOUNT_LOCKED");
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    await withoutUser(pool, (c) => c.query("SELECT auth_record_login_failure($1)", [row.id]));
    throw new AppError(GENERIC_LOGIN_ERROR, 401, "INVALID_CREDENTIALS");
  }

  const mfaOn = await withoutUser(pool, (c) => c.query("SELECT mfa_is_enabled($1) AS enabled", [row.id]).then((r) => r.rows[0].enabled as boolean));
  if (mfaOn) return { mfaRequired: true, mfaToken: signMfaToken(row.id, jwtSecret) };

  await withoutUser(pool, (c) => c.query("SELECT auth_record_login_success($1)", [row.id]));
  return sessionFor(row, jwtSecret);
}

interface AccountRow { id: string; role: string; tenant_id: string | null }
export const sessionFor = (row: AccountRow, jwtSecret: string, issuedAt?: number): LoginResult =>
  ({ token: signSessionToken(row.id, jwtSecret, undefined, issuedAt), userId: row.id, role: row.role, tenantId: row.tenant_id });

export const lookupAccount = (pool: Pool, userId: string) =>
  withoutUser(pool, (c) => c.query("SELECT * FROM auth_lookup_by_id($1)", [userId]).then((r) => r.rows[0] as
    | { id: string; org_id: string; tenant_id: string | null; email: string; role: string; status: string; password_hash: string | null; failed_login_count: number; locked_until: Date | null }
    | undefined));

/**
 * "Confirm it's you": re-checks the signed-in person's password before something sensitive (turning two-step
 * sign-in on or off, new recovery codes, changing the password). Wrong passwords count toward the same lock-out as the sign-in page —
 * a stolen session can't be used to guess the password — and a locked account is refused. Fails with 403, not
 * 401: the person IS signed in, and a 401 would make the app sign them out for a typo.
 */
export async function confirmPassword(pool: Pool, userId: string, password: string) {
  const row = await lookupAccount(pool, userId);
  if (!row || row.status !== "active") throw new AppError("You don't have access to do that.", 403, "FORBIDDEN");
  if (!row.password_hash) {
    throw new AppError("This account signs in through your organisation's single sign-on, so its password and two-step sign-in are managed there.", 409, "NO_LOCAL_PASSWORD");
  }
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw new AppError("Too many failed attempts. Please try again in a few minutes.", 423, "ACCOUNT_LOCKED");
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    await withoutUser(pool, (c) => c.query("SELECT auth_record_login_failure($1)", [userId]));
    throw new AppError("Incorrect password.", 403, "INVALID_PASSWORD");
  }
  return row;
}

export interface AcceptInviteResult { token: string; userId: string }

/** Completes an invite: sets a first password for a user who was invited but has never signed in,
 *  via the raw token from their invite email, and immediately signs them in. */
export async function acceptInvite(pool: Pool, jwtSecret: string, rawToken: string, password: string): Promise<AcceptInviteResult> {
  const check = checkPasswordStrength(password);
  if (!check.ok) throw new AppError(check.reason!, 422, "WEAK_PASSWORD");

  const passwordHash = await hashPassword(password);
  const tokenHash = hashInviteToken(rawToken);
  const userId = await withoutUser(pool, (c) =>
    c.query("SELECT auth_complete_invite($1,$2) AS id", [tokenHash, passwordHash]).then((r) => r.rows[0].id as string | null));

  if (!userId) throw new AppError("This invite link is invalid or has expired. Ask your administrator to resend it.", 400, "INVALID_INVITE");
  return { token: signSessionToken(userId, jwtSecret), userId };
}
