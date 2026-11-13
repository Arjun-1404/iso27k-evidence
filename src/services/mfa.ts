import type { Pool } from "pg";
import { withUser, withoutUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import {
  generateTotpSecret, matchTotp, otpauthUri, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode, classifyCode,
} from "../auth/totp.ts";
import { verifyMfaToken } from "../auth/mfaToken.ts";
import { confirmPassword, lookupAccount, sessionFor, type LoginResult } from "./auth.ts";
import type { Notifier } from "./notices.ts";

/**
 * Two-step sign-in with an authenticator app, plus one-time recovery codes. The rules that matter — a code works
 * once, five wrong tries lock it for 15 minutes, recovery codes are single-use, only an org admin can reset
 * someone else — are enforced in the database (migration 010); this layer works out WHICH time step a typed code
 * matches (the database never sees the authenticator secret, only its encrypted form) and shapes the answers.
 *
 * Fails closed: if two-step sign-in is on for an account but the server can't check codes (no
 * SECRET_ENCRYPTION_KEY, or one that no longer matches), the answer is an error — never a way in.
 */

export const MFA_ISSUER = "Evidence Portal";

const FORMAT_HELP = "Enter the 6-digit code from your authenticator app, or one of your recovery codes.";
const expired = () => new AppError("Your sign-in has expired. Please enter your password again.", 401, "INVALID_MFA_TOKEN");
const locked = () => new AppError("Too many incorrect codes. Two-step sign-in is locked for this account for 15 minutes.", 423, "MFA_LOCKED");
const notConfigured = () => new AppError(
  "This server isn't set up to check authenticator codes (SECRET_ENCRYPTION_KEY is not set). Use a recovery code, or ask your administrator.", 503, "MFA_NOT_CONFIGURED");
const unavailable = () => new AppError(
  "Authenticator codes can't be checked right now. Use a recovery code, or ask your administrator.", 503, "MFA_UNAVAILABLE");

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof AppError) throw e; throw mapDbError(e); }
}

const loginState = (pool: Pool, userId: string) =>
  withoutUser(pool, (c) => c.query("SELECT * FROM mfa_login_state($1)", [userId]).then((r) => r.rows[0] as { secret_enc: string; locked: boolean } | undefined));

/**
 * Checks a typed code (authenticator or recovery) for an account that has two-step sign-in on, and records the
 * outcome in the database. `failStatus` is 401 at sign-in and 403 for a signed-in person confirming a change
 * (a 401 there would sign them out for a typo). A badly formatted code is refused up front and NOT counted: it
 * can't be a guess at anything. Using up a recovery code (wherever it is typed) sends the account a notice.
 */
export async function verifySecondStep(
  pool: Pool, store: SecretStore | undefined, userId: string, rawCode: string, failStatus: 401 | 403, notify?: Notifier,
) {
  const typed = classifyCode(rawCode);
  if (!typed) throw new AppError(FORMAT_HELP, 400, "INVALID_CODE_FORMAT");

  const state = await loginState(pool, userId);
  if (!state) throw new AppError("Two-step sign-in is not turned on for this account.", 409, "MFA_NOT_ENABLED");
  if (state.locked) throw locked();

  let step: number | null = null;
  let recoveryHash: string | null = null;
  if (typed.kind === "totp") {
    if (!store) throw notConfigured();
    let secret: string;
    try {
      secret = store.decrypt(state.secret_enc);
    } catch {
      // Say what is wrong without printing anything that belongs to the account.
      console.error("Two-step sign-in: an account's authenticator secret could not be decrypted — has SECRET_ENCRYPTION_KEY changed?");
      throw unavailable();
    }
    step = matchTotp(secret, typed.code);
  } else {
    recoveryHash = hashRecoveryCode(userId, typed.code);
  }

  const ok = await withoutUser(pool, (c) =>
    c.query("SELECT mfa_complete_login($1, $2::bigint, $3::text) AS ok", [userId, step, recoveryHash]).then((r) => r.rows[0].ok as boolean));
  if (ok) {
    if (typed.kind === "recovery") notify?.notify(userId, "mfa_recovery_used");
    return { usedRecoveryCode: typed.kind === "recovery" };
  }

  // The attempt that tips it over the limit should already say "locked".
  if ((await loginState(pool, userId))?.locked) throw locked();
  throw new AppError("That code isn't right. Check the latest code in your authenticator app, or use a recovery code.", failStatus, "INVALID_CODE");
}

/** The second sign-in step: trades the challenge token from the password step plus a code for a session. */
export async function completeMfaLogin(
  pool: Pool, jwtSecret: string, store: SecretStore | undefined, mfaToken: string, code: string, notify?: Notifier,
): Promise<LoginResult & { recoveryCodeUsed?: true }> {
  const userId = verifyMfaToken(mfaToken, jwtSecret);
  if (!userId) throw expired();
  const row = await lookupAccount(pool, userId);
  if (!row || row.status !== "active" || !row.password_hash) throw expired();
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw new AppError("Too many failed attempts. Please try again in a few minutes.", 423, "ACCOUNT_LOCKED");
  }

  let used: { usedRecoveryCode: boolean };
  try {
    used = await verifySecondStep(pool, store, userId, code, 401, notify);
  } catch (e) {
    // Two-step sign-in was switched off (an admin reset) after the password step: start again from the top.
    if (e instanceof AppError && e.code === "MFA_NOT_ENABLED") throw expired();
    throw e;
  }
  await withoutUser(pool, (c) => c.query("SELECT auth_record_login_success($1)", [userId]));
  const session = sessionFor(row, jwtSecret);
  return used.usedRecoveryCode ? { ...session, recoveryCodeUsed: true } : session;
}

// ---- managing two-step sign-in while signed in ---------------------------------------------------------------

export interface MfaStatus { enabled: boolean; recoveryRemaining: number; available: boolean; required: boolean }

/** `available` is false when this server can't do two-step sign-in at all (no encryption key) so the page can say so.
 *  `required` is true when the organisation's policy covers this person: they can't turn it off, and if it isn't on
 *  yet they can't use the rest of the portal until it is. */
export async function getStatus(pool: Pool, store: SecretStore | undefined, userId: string): Promise<MfaStatus> {
  const r = await run(() => withUser(pool, userId, (c) =>
    c.query("SELECT enabled, recovery_remaining, (SELECT required FROM mfa_requirement($1)) AS required FROM mfa_status()", [userId]).then((x) => x.rows[0])));
  return { enabled: r.enabled, recoveryRemaining: r.recovery_remaining, available: !!store, required: r.required === true };
}

function requireStore(store: SecretStore | undefined): SecretStore {
  if (!store) throw new AppError("Two-step sign-in isn't available: this server has no SECRET_ENCRYPTION_KEY set. Ask your administrator.", 503, "MFA_NOT_CONFIGURED");
  return store;
}

const newRecoverySet = (userId: string) => {
  const codes = generateRecoveryCodes();
  return { codes, hashes: codes.map((c) => hashRecoveryCode(userId, normalizeRecoveryCode(c)!)) };
};

/** Step 1 of turning it on: new secret, kept (encrypted) as "pending" until the first code proves the phone has it. */
export async function beginEnrollment(pool: Pool, store: SecretStore | undefined, userId: string, password: string) {
  const s = requireStore(store);
  const account = await confirmPassword(pool, userId, password);
  const secret = generateTotpSecret();
  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_begin_enrollment($1)", [s.encrypt(secret)])));
  return { secret, otpauthUri: otpauthUri({ secret, account: account.email, issuer: MFA_ISSUER }) };
}

/** Step 2: the first code from the phone turns it on, and the recovery codes are shown — this once. */
export async function confirmEnrollment(pool: Pool, store: SecretStore | undefined, userId: string, rawCode: string, notify?: Notifier) {
  const s = requireStore(store);
  const typed = classifyCode(rawCode);
  if (!typed || typed.kind !== "totp") throw new AppError("Enter the 6-digit code from your authenticator app.", 400, "INVALID_CODE_FORMAT");
  const pending = await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_enrollment_secret() AS s").then((r) => r.rows[0].s as string | null)));
  if (!pending) throw new AppError("Start setting up two-step sign-in first.", 409, "NO_ENROLLMENT");

  let secret: string;
  try { secret = s.decrypt(pending); } catch { console.error("Two-step sign-in: a pending authenticator secret could not be decrypted."); throw unavailable(); }
  const step = matchTotp(secret, typed.code);
  if (step === null) throw new AppError("That code didn't match. Check the latest code in your authenticator app (and that your phone's clock is automatic), then try again.", 403, "INVALID_CODE");

  const { codes, hashes } = newRecoverySet(userId);
  const done = await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_confirm_enrollment($1::bigint, $2::text[]) AS ok", [step, hashes]).then((r) => r.rows[0].ok as boolean)));
  if (!done) throw new AppError("Start setting up two-step sign-in first.", 409, "NO_ENROLLMENT");
  notify?.notify(userId, "mfa_enabled");
  return { recoveryCodes: codes };
}

async function requireEnabled(pool: Pool, store: SecretStore | undefined, userId: string): Promise<MfaStatus> {
  const st = await getStatus(pool, store, userId);
  if (!st.enabled) throw new AppError("Two-step sign-in is not turned on for this account.", 409, "MFA_NOT_ENABLED");
  return st;
}

/** Turn it off. Needs the password AND a code, so a borrowed session alone can't strip the protection. */
export async function disable(pool: Pool, store: SecretStore | undefined, userId: string, password: string, rawCode: string, notify?: Notifier) {
  const st = await requireEnabled(pool, store, userId);
  // Refuse up front, before a password is checked or a one-time code is spent. (The database refuses too: this is only
  // so the person isn't made to prove who they are for something that cannot happen.)
  if (st.required) throw new AppError("Your organisation requires two-step sign-in, so it cannot be turned off.", 403, "MFA_REQUIRED_BY_POLICY");
  await confirmPassword(pool, userId, password);
  await verifySecondStep(pool, store, userId, rawCode, 403, notify);
  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_disable()")));
  notify?.notify(userId, "mfa_disabled");
  return { ok: true as const };
}

/** A fresh set of recovery codes (the old ones stop working). Same two proofs as turning it off. */
export async function regenerateRecoveryCodes(pool: Pool, store: SecretStore | undefined, userId: string, password: string, rawCode: string, notify?: Notifier) {
  await requireEnabled(pool, store, userId);
  await confirmPassword(pool, userId, password);
  await verifySecondStep(pool, store, userId, rawCode, 403, notify);
  const { codes, hashes } = newRecoverySet(userId);
  await run(() => withUser(pool, userId, (c) => c.query("SELECT mfa_replace_recovery_codes($1::text[])", [hashes])));
  notify?.notify(userId, "mfa_recovery_regenerated");
  return { recoveryCodes: codes };
}

/** An org admin switches off someone else's two-step sign-in (lost phone, no recovery codes). The database
 *  allows only org admins, never on themselves, only within their organisation, and ends the person's sessions. */
export async function adminReset(pool: Pool, actorId: string, targetUserId: string, notify?: Notifier) {
  const reset = await run(() => withUser(pool, actorId, (c) => c.query("SELECT mfa_admin_reset($1) AS reset", [targetUserId]).then((r) => r.rows[0].reset as boolean)));
  if (reset) notify?.notify(targetUserId, "mfa_reset_by_admin"); // the person it happened to, never the admin
  return { reset };
}

// ---- the organisation's policy -----------------------------------------------------------------------------------

export type MfaPolicy = "off" | "staff" | "everyone";
export interface PolicyCounts { total: number; enrolled: number }
export interface OrgMfaPolicy { policy: MfaPolicy; available: boolean; staff: PolicyCounts; everyone: PolicyCounts }

/** The policy and how many people have set two-step sign-in up (numbers only). Organisation admins only. */
export async function getOrgPolicy(pool: Pool, store: SecretStore | undefined, userId: string): Promise<OrgMfaPolicy> {
  const r = await run(() => withUser(pool, userId, (c) => c.query("SELECT * FROM mfa_policy_get()").then((x) => x.rows[0])));
  if (!r) throw new AppError("Only an organisation admin can see or change the two-step sign-in policy.", 403, "FORBIDDEN_ROLE");
  return {
    policy: r.out_policy as MfaPolicy,
    available: !!store,
    staff: { total: r.out_staff_total, enrolled: r.out_staff_enrolled },
    everyone: { total: r.out_all_total, enrolled: r.out_all_enrolled },
  };
}

/** Sets the policy. Asking people to set up something this server cannot do would lock them out, so anything but
 *  "off" needs the encryption key; the database adds its own rule (the admin must have it on for themselves first). */
export async function setOrgPolicy(pool: Pool, store: SecretStore | undefined, userId: string, policy: MfaPolicy): Promise<OrgMfaPolicy> {
  if (policy !== "off") requireStore(store);
  await run(() => withUser(pool, userId, (c) => c.query("SELECT org_set_mfa_policy($1)", [policy])));
  return getOrgPolicy(pool, store, userId);
}
