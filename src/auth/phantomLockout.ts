import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * Makes "no such account" look exactly like "real account" at the sign-in page.
 *
 * Without this, two differences let anyone with the list of addresses they are curious about find out which have
 * accounts here, without ever knowing a password:
 *  1. Time. Checking a real account's password takes a few hundred milliseconds (that is what makes it hard to guess);
 *     answering "no such account" took two.
 *  2. The lock. A real account is locked after 5 wrong passwords and then answers "too many attempts"; an address with no
 *     account never counted anything, so it just kept saying "incorrect".
 *
 * Both are closed the same way: an address with no usable account (none, disabled, or one with no password) goes through
 * the same motions — a password check against a made-up hash, and a failure count with the same limit and the same
 * lock time — kept in this process's memory (nothing about it is stored, and it is forgotten when the server restarts).
 */

/** Same numbers as the real lock-out in the database (migration 004): 5 wrong passwords lock for 15 minutes. */
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_FOR_MS = 15 * 60 * 1000;
const MAX_REMEMBERED = 10_000;

/** A bcrypt hash (cost 12, like every real one) of a random string nobody has. Compared against so the time spent matches. */
const DUMMY_HASH = "$2b$12$GmcB1H4dh5U1ylYzdPV0U.MMMZZXU.6T/B1FJSFOGwllAxUoXyaZG";

/** Takes as long as checking a real password, and always says no. */
export async function spendPasswordCheckTime(password: string): Promise<void> {
  await bcrypt.compare(password, DUMMY_HASH);
}

export class PhantomLockout {
  private readonly seen = new Map<string, { failures: number; lockedUntil: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Addresses are compared without regard to capitals, and kept only as a hash. */
  private key(email: string): string {
    return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  }

  isLocked(email: string): boolean {
    const e = this.seen.get(this.key(email));
    return !!e && e.lockedUntil > this.now();
  }

  /** One more wrong password for an address that has no account. */
  recordFailure(email: string): void {
    const k = this.key(email);
    const t = this.now();
    let e = this.seen.get(k);
    if (!e || (e.lockedUntil !== 0 && e.lockedUntil <= t)) e = { failures: 0, lockedUntil: 0 };   // a finished lock starts over
    this.seen.delete(k);                                   // re-inserting puts it last, so the first entry is the longest ago
    e.failures++;
    if (e.failures >= LOCK_AFTER_FAILURES) e.lockedUntil = t + LOCK_FOR_MS;
    while (this.seen.size >= MAX_REMEMBERED) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.seen.set(k, e);
  }
}

/** The one the running server uses. */
export const phantomLockout = new PhantomLockout();
