import type { Pool } from "pg";
import { withoutUser } from "../db/pool.ts";
import { AppError } from "../errors.ts";
import { hashPassword, checkPasswordStrength } from "../auth/password.ts";
import { generateResetToken, hashResetToken } from "../auth/resetToken.ts";
import { EmailDeliveryError, type EmailSender } from "../email/types.ts";
import type { Notifier } from "./notices.ts";

export interface ResetDelivery { email: EmailSender; appBaseUrl: string }

/**
 * Starts a password reset for whoever owns `email` — if anyone does, and if they are allowed one. The
 * caller is told NOTHING about which: whether or not an email will go out, this resolves the same way, because
 * a "no such account" answer would let anyone test which addresses have accounts. (The database decides who
 * qualifies and applies the per-account limit; see 008_password_reset.sql.)
 *
 * The email is sent in the background: the promise returned here resolves as soon as the database step is
 * done, NOT when the mail server has answered — otherwise a slow SMTP round trip would make "this address
 * has an account" visible as a slower response. `settled` resolves (never rejects) once the mail attempt
 * has finished, which is what tests wait on. A mail failure is logged without the address or the link and
 * never surfaced: surfacing it would reveal that the account exists.
 */
export async function requestPasswordReset(pool: Pool, email: string, delivery: ResetDelivery): Promise<{ settled: Promise<void> }> {
  const { token, tokenHash } = generateResetToken();
  const rows = await withoutUser(pool, (c) =>
    c.query("SELECT out_email FROM password_reset_request($1,$2)", [email, tokenHash]).then((r) => r.rows as Array<{ out_email: string }>));
  if (rows.length === 0) return { settled: Promise.resolve() };

  const link = `${delivery.appBaseUrl}/reset-password?token=${token}`;
  const settled = delivery.email.send({
    to: [rows[0].out_email],
    subject: "Reset your Evidence Portal password",
    text: `Someone asked to reset the password for your Evidence Portal account. To choose a new one, open this link (it works once and expires in 1 hour):\n\n${link}\n\nIf you didn't ask for this, you can ignore this email — your password has not been changed.`,
  }).then(
    () => undefined,
    (e: unknown) => { console.error(e instanceof EmailDeliveryError ? `[email] password reset: ${e.message}` : "[email] password reset: sending failed unexpectedly"); },
  );
  return { settled };
}

/** Completes a reset with the secret from the email link. The new password is checked BEFORE the link is
 *  spent, so a too-weak password doesn't use up the link. Signs nobody in: the person goes back to the sign-in
 *  page with their new password. */
export async function resetPassword(pool: Pool, rawToken: string, newPassword: string, notify?: Notifier): Promise<void> {
  const check = checkPasswordStrength(newPassword);
  if (!check.ok) throw new AppError(check.reason!, 422, "WEAK_PASSWORD");

  const passwordHash = await hashPassword(newPassword);
  const userId = await withoutUser(pool, (c) =>
    c.query("SELECT password_reset_consume($1,$2) AS id", [hashResetToken(rawToken), passwordHash]).then((r) => r.rows[0].id as string | null));
  if (!userId) throw new AppError("This reset link is invalid or has expired. Request a new one.", 400, "INVALID_RESET");
  notify?.notify(userId, "password_reset");
}
