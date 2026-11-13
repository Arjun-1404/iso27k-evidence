import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface PasswordCheck { ok: boolean; reason?: string }

/** Minimum bar for a self-hosted tool with no external identity provider backing it up. Length over
 *  complexity rules (NIST 800-63B) — no forced mix of symbols, just a reasonable minimum length. */
export function checkPasswordStrength(plain: string): PasswordCheck {
  if (plain.length < 12) return { ok: false, reason: "Password must be at least 12 characters." };
  if (plain.length > 256) return { ok: false, reason: "Password is too long." };
  const common = new Set(["password123", "123456789012", "qwertyuiop12", "letmein12345"]);
  if (common.has(plain.toLowerCase())) return { ok: false, reason: "That password is too common. Please choose another." };
  return { ok: true };
}
