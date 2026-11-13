import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { EmailDeliveryError, type EmailSender } from "../email/types.ts";
import { lookupAccount } from "./auth.ts";

/**
 * Security notices: a plain email to the account's own address whenever something that could be the first sign of a
 * takeover happens — the password changed or was reset, two-step sign-in was turned on or off, recovery codes were
 * made or used, or an admin reset someone's two-step sign-in. The point is that the real owner finds out even if
 * the person who did it was not them.
 *
 * Rules these notices keep:
 *  - They say THAT something happened and WHEN, never WHAT: no password, code, secret, link token or recovery code
 *    is ever in one, and none names another person (an admin's reset says "an administrator", not who).
 *  - They are sent only after the change has actually been made. A refused or failed attempt sends nothing.
 *  - They are best-effort and in the background. A mail server that is slow, down or rejecting the message never
 *    slows down, fails or changes the answer to the person's request — the change has already happened and
 *    cannot be undone by a mail problem. A failure is logged with the kind of notice but never the address.
 *  - They go to the address on file for an active account only.
 */
export type NoticeKind =
  | "password_changed"
  | "password_reset"
  | "mfa_enabled"
  | "mfa_disabled"
  | "mfa_recovery_regenerated"
  | "mfa_recovery_used"
  | "mfa_reset_by_admin";

export interface Notifier {
  /** Queues a notice for the account and returns at once; delivery happens in the background. */
  notify(userId: string, kind: NoticeKind): void;
}

/** Notices still being worked on, so a graceful shutdown (and a test) can wait for them. */
const pending = new Set<Promise<void>>();

/** Resolves once every queued notice has been delivered or has failed (never rejects), or after `timeoutMs`
 *  if a mail server hangs — shutdown must not wait forever for one. */
export async function flushNotices(timeoutMs = 10_000): Promise<void> {
  // One timer for the whole wait, and no reading of the clock: the wait ends when everything has settled or the timer
  // fires, whichever is first. Notices queued while waiting are waited for too.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); });
  try {
    while (pending.size > 0 && !timedOut) await Promise.race([Promise.allSettled([...pending]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number) => String(n).padStart(2, "0");

/** "6 November 2026, 17:20 UTC" — a fixed zone, said out loud, because the reader's own zone isn't known here. */
export function formatUtc(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** Recovery codes left at or below which the notice also tells the person to get a new set. */
export const LOW_RECOVERY_CODES = 3;

export interface NoticeContext { appBaseUrl: string; at: Date; recoveryRemaining?: number }

const FOOTER = "\n\nThis message was sent automatically; please don't reply to it. We will never ask for your password or a code by email.";

/** The words of one notice. Pure, so its wording is tested directly. The subject is a fixed line. */
export function composeNotice(kind: NoticeKind, ctx: NoticeContext): { subject: string; text: string } {
  const when = formatUtc(ctx.at);
  const reset = `${ctx.appBaseUrl}/forgot-password`;
  const ifNotYou = (what: string) =>
    `\n\nIf this was you, there is nothing to do.\n\nIf it wasn't you, ${what}`;
  const secure = `reset your password now at ${reset} and tell the administrator of your organisation.`;

  switch (kind) {
    case "password_changed":
      return {
        subject: "Your Evidence Portal password was changed",
        text: `The password for your Evidence Portal account was changed on ${when}. You were signed out on your other devices.${ifNotYou(`someone else may have access to your account: ${secure}`)}${FOOTER}`,
      };
    case "password_reset":
      return {
        subject: "Your Evidence Portal password was reset",
        text: `The password for your Evidence Portal account was reset, using a link sent to this address, on ${when}. Any sessions that were open were signed out.${ifNotYou(`someone may have access to this mailbox. Reset your password again at ${reset}, secure your email account, and tell the administrator of your organisation.`)}${FOOTER}`,
      };
    case "mfa_enabled":
      return {
        subject: "Two-step sign-in was turned on for your Evidence Portal account",
        text: `Two-step sign-in was turned on for your Evidence Portal account on ${when}. From now on, signing in asks for a code from an authenticator app.${ifNotYou(`someone who knows your password may have set it up with their own phone, which could lock you out. Tell the administrator of your organisation straight away: they can reset it. Then ${secure}`)}${FOOTER}`,
      };
    case "mfa_disabled":
      return {
        subject: "Two-step sign-in was turned off for your Evidence Portal account",
        text: `Two-step sign-in was turned off for your Evidence Portal account on ${when}. Signing in now needs only your password.${ifNotYou(`someone may have access to your account: ${secure}`)}${FOOTER}`,
      };
    case "mfa_recovery_regenerated":
      return {
        subject: "New recovery codes were created for your Evidence Portal account",
        text: `A new set of recovery codes was created for your Evidence Portal account on ${when}. The previous codes no longer work.${ifNotYou(`someone may have access to your account: ${secure}`)}${FOOTER}`,
      };
    case "mfa_recovery_used": {
      const left = ctx.recoveryRemaining;
      const count = left === undefined ? "" : ` You have ${left} left.${left <= LOW_RECOVERY_CODES ? " Get a new set under Security in the portal so you aren't locked out if you lose your phone." : ""}`;
      return {
        subject: "A recovery code was used on your Evidence Portal account",
        text: `One of your recovery codes was used on your Evidence Portal account on ${when}. Each recovery code works once.${count}${ifNotYou(`someone has your password and one of your recovery codes: ${secure}`)}${FOOTER}`,
      };
    }
    case "mfa_reset_by_admin":
      return {
        subject: "Your Evidence Portal two-step sign-in was reset",
        text: `An administrator of your organisation reset two-step sign-in for your Evidence Portal account on ${when}, and you were signed out on all devices. Sign in with your password, then set up two-step sign-in again under Security.\n\nIf you did not ask for this, tell the administrator of your organisation.${FOOTER}`,
      };
  }
}

/** The notifier the routes use. One per app; it holds no state of its own beyond the shared in-flight set. */
export function createNotifier(pool: Pool, email: EmailSender, appBaseUrl: string): Notifier {
  return {
    notify(userId, kind) {
      const work: Promise<void> = (async () => {
        const who = await lookupAccount(pool, userId);
        if (!who || who.status !== "active") return;
        const recoveryRemaining = kind === "mfa_recovery_used" ? await recoveryCodesLeft(pool, userId) : undefined;
        const { subject, text } = composeNotice(kind, { appBaseUrl, at: new Date(), recoveryRemaining });
        await email.send({ to: [who.email], subject, text });
      })().catch((e: unknown) => {
        // The kind is a fixed word; the address, the message and any account detail stay out of the log.
        console.error(e instanceof EmailDeliveryError ? `[email] security notice (${kind}): ${e.message}` : `[email] security notice (${kind}): not sent`);
      }).finally(() => { pending.delete(work); });
      pending.add(work);
    },
  };
}

const recoveryCodesLeft = (pool: Pool, userId: string) =>
  withUser(pool, userId, (c) => c.query("SELECT recovery_remaining FROM mfa_status()").then((r) => r.rows[0]?.recovery_remaining as number | undefined));
