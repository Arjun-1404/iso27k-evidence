import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import { hashPassword, verifyPassword, checkPasswordStrength } from "../auth/password.ts";
import { confirmPassword, sessionFor, type LoginResult } from "./auth.ts";
import { getStatus, verifySecondStep } from "./mfa.ts";
import type { Notifier } from "./notices.ts";

export interface ChangePasswordInput { currentPassword: string; newPassword: string; code?: string }

/**
 * The moment (whole seconds) to stamp the fresh session with: the later of this server's clock and the instant the
 * database revoked the old sessions. Sessions are revoked by comparing their issue time to that instant, so a server
 * whose clock runs a little behind the database's would otherwise hand back a session that is already revoked.
 */
export function issuedAtAfter(revokedAt: Date, nowMs: number = Date.now()): number {
  return Math.max(Math.floor(nowMs / 1000), Math.floor(revokedAt.getTime() / 1000));
}

/**
 * Changes the signed-in person's own password. Asks for everything a borrowed session could not supply: the current
 * password (wrong guesses count toward the same lock-out as the sign-in page) and, if two-step sign-in is on, a code.
 * The cheap checks that cannot use anything up (is the new password acceptable, is it different) come BEFORE the code
 * is checked, so a typo in the new password never costs the person a one-time code.
 *
 * Every other session the person has is ended (the database revokes everything issued before this moment); the
 * one fresh session returned is the one they carry on with. Someone who knew the old password, or was holding a
 * stolen session, is signed out.
 */
export async function changePassword(
  pool: Pool, jwtSecret: string, store: SecretStore | undefined, userId: string, input: ChangePasswordInput, notify?: Notifier,
): Promise<LoginResult> {
  const strength = checkPasswordStrength(input.newPassword);
  if (!strength.ok) throw new AppError(strength.reason!, 422, "WEAK_PASSWORD");

  const twoStep = (await getStatus(pool, store, userId)).enabled;
  if (twoStep && !input.code) {
    throw new AppError("Enter a code from your authenticator app (or one of your recovery codes) to change your password.", 400, "MFA_CODE_REQUIRED");
  }

  const account = await confirmPassword(pool, userId, input.currentPassword); // 403 for a wrong password, 423 if locked
  if (await verifyPassword(input.newPassword, account.password_hash!)) {
    throw new AppError("Choose a password that is different from your current one.", 422, "SAME_PASSWORD");
  }
  if (twoStep) await verifySecondStep(pool, store, userId, input.code!, 403, notify);

  const newHash = await hashPassword(input.newPassword);
  let revokedAt: Date | null;
  try {
    revokedAt = await withUser(pool, userId, (c) =>
      c.query("SELECT auth_change_password($1,$2) AS at", [account.password_hash, newHash]).then((r) => r.rows[0].at as Date | null));
  } catch (e) {
    throw e instanceof AppError ? e : mapDbError(e);
  }
  if (!revokedAt) throw new AppError("Your password was changed somewhere else a moment ago. Please check and try again.", 409, "PASSWORD_CHANGED_ELSEWHERE");

  notify?.notify(userId, "password_changed");
  return sessionFor(account, jwtSecret, issuedAtAfter(revokedAt));
}
