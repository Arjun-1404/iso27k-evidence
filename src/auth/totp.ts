import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238) as every authenticator app — Google Authenticator, Microsoft
 * Authenticator, Authy, 1Password, ... — implements them: HMAC-SHA1, 6 digits, a new code every 30 seconds.
 * Written against node:crypto alone (no dependency) and checked against the RFC's own test vectors.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** How many 30-second steps either side of "now" are accepted, to forgive a phone clock that is a little off. */
export const TOTP_WINDOW_STEPS = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 base32, forgiving case, spaces, dashes and padding (how people copy secrets by hand). */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh authenticator secret: 160 random bits, base32-encoded (what goes into the QR code). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 30-second step number a moment falls in. */
export function stepAt(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for a given step (RFC 4226 HOTP with the step as the counter). */
export function totpAtStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Which step does this code belong to? Looks at "now" and one step either side, comparing every candidate in
 * constant time, and returns the matching step — or null. The caller hands the step to the database, which
 * refuses a step it has already accepted (so a code works once).
 */
export function matchTotp(secretBase32: string, code: string, nowMs: number = Date.now(), window: number = TOTP_WINDOW_STEPS): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    if (timingSafeEqual(Buffer.from(totpAtStep(secretBase32, s)), given) && matched === null) matched = s;
  }
  return matched;
}

/** The otpauth:// address an authenticator app reads from the QR code. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, "%20")}`;
}

// ---- recovery codes ------------------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/** Ten single-use codes of 80 random bits each, shown as XXXX-XXXX-XXXX-XXXX. Only their hashes are stored. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => base32Encode(randomBytes(10)).replace(/(.{4})(?=.)/g, "$1-"));
}

/** The canonical form of a typed recovery code (case, spaces and dashes forgiven), or null if it isn't one. */
export function normalizeRecoveryCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z2-7]{16}$/.test(c) ? c : null;
}

/** What is stored in place of a recovery code. Salted with the account so equal codes never look alike. */
export function hashRecoveryCode(userId: string, normalizedCode: string): string {
  return createHash("sha256").update(`${userId}:${normalizedCode}`).digest("hex");
}

export type TypedCode = { kind: "totp"; code: string } | { kind: "recovery"; code: string } | null;

/** Tells an authenticator code (6 digits) from a recovery code (16 letters/digits) in whatever the person typed. */
export function classifyCode(input: string): TypedCode {
  const compact = input.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(compact)) return { kind: "totp", code: compact };
  const recovery = normalizeRecoveryCode(input);
  return recovery ? { kind: "recovery", code: recovery } : null;
}
