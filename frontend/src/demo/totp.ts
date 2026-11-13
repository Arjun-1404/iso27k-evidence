// Two-step sign-in codes (RFC 6238), the way every authenticator app does them: HMAC-SHA1, 6 digits, a new code every
// 30 seconds. Uses the browser's own Web Crypto, so the demo's two-step sign-in works with a real authenticator app.
// (Same behaviour as the real server's auth/totp.ts; both are checked against the RFC's test vectors.)

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** How many 30-second steps either side of "now" are accepted, to forgive a phone clock that is a little off. */
export const TOTP_WINDOW_STEPS = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

/** The code for one 30-second step (RFC 4226 HOTP with the step as the counter). */
export async function totpAtStep(secretBase32: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey("raw", base32Decode(secretBase32) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Which step does this code belong to ("now" and one either side are tried)? Null when it matches none. */
export async function matchTotp(secretBase32: string, code: string, nowMs: number, window: number = TOTP_WINDOW_STEPS): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    if ((await totpAtStep(secretBase32, s)) === code && matched === null) matched = s;
  }
  return matched;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** The otpauth:// address an authenticator app reads from the QR code. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, "%20")}`;
}

// ---- recovery codes --------------------------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/** Ten single-use codes of 80 random bits each, shown as XXXX-XXXX-XXXX-XXXX. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => base32Encode(randomBytes(10)).replace(/(.{4})(?=.)/g, "$1-"));
}

export function normalizeRecoveryCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z2-7]{16}$/.test(c) ? c : null;
}

export type TypedCode = { kind: "totp"; code: string } | { kind: "recovery"; code: string } | null;

/** Tells an authenticator code (6 digits) from a recovery code (16 letters/digits) in whatever the person typed. */
export function classifyCode(input: string): TypedCode {
  const compact = input.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(compact)) return { kind: "totp", code: compact };
  const recovery = normalizeRecoveryCode(input);
  return recovery ? { kind: "recovery", code: recovery } : null;
}
