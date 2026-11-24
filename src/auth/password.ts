import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface PasswordCheck { ok: boolean; reason?: string }

/** bcrypt only reads the first 72 bytes of what it is given. Anything longer would be accepted but silently cut, so two
 *  different long passwords sharing a start would be the same password — better to say so than to pretend. */
export const MAX_PASSWORD_BYTES = 72;

/** The bare words people build a "password" from. A password whose letters, once look-alike characters are undone
 *  (p@ssw0rd → password), are one of these — alone or with up to three more letters — is refused, whatever digits or
 *  symbols are added around it. This is a short list of the commonest; it is not a substitute for a password manager. */
const COMMON_WORDS = [
  "password", "passwd", "passphrase", "letmein", "welcome", "qwerty", "qwertyuiop", "qwertz", "azerty", "asdfghjkl", "zxcvbnm",
  "iloveyou", "admin", "administrator", "changeme", "secret", "login", "master", "monkey", "dragon", "shadow", "sunshine",
  "princess", "football", "baseball", "superman", "batman", "trustno", "starwars", "whatever", "freedom", "abcdefgh",
  "portal", "evidence", "auditor", "iso", "demo", "test", "temp", "default", "guest", "root", "user",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "spring", "summer", "autumn", "winter",
];

const LOOK_ALIKES: Record<string, string> = { "@": "a", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s" };
const SEQUENCES = ["01234567890123456789", "abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba", "qwertyuiopasdfghjklzxcvbnm", "9876543210987654321"];

/** Minimum bar for a self-hosted tool with no external identity provider backing it up. Length over complexity rules
 *  (NIST 800-63B) — no forced mix of symbols — plus a refusal of the passwords an attacker tries first: a common word
 *  with digits after it, a run of the keyboard or the alphabet, and a few characters repeated. */
export function checkPasswordStrength(plain: string): PasswordCheck {
  if (plain.length < 12) return { ok: false, reason: "Password must be at least 12 characters." };
  if (plain.length > 256 || Buffer.byteLength(plain, "utf8") > MAX_PASSWORD_BYTES) {
    return { ok: false, reason: `Password is too long: the most that can be used is ${MAX_PASSWORD_BYTES} characters.` };
  }
  const lower = plain.toLowerCase();
  // Two readings of the same password: just its letters ("p@ssw0rd2024" → "pssw" + "rd"), and with look-alike characters
  // turned back into letters ("p@ssw0rd" → "password"). Either one being a common word, give or take a few letters, is enough.
  const lettersOnly = lower.replace(/[^a-z]/g, "");
  const unLeeted = [...lower].map((ch) => LOOK_ALIKES[ch] ?? ch).filter((ch) => ch >= "a" && ch <= "z").join("");
  const isCommon = (word: string) => COMMON_WORDS.some((w) => word === w || (word.startsWith(w) && word.length - w.length <= 3) || (word.endsWith(w) && word.length - w.length <= 3));
  const common = isCommon(lettersOnly) || isCommon(unLeeted);
  if (common || SEQUENCES.some((s) => s.includes(lower))) return { ok: false, reason: "That password is too common. Please choose another." };
  if (new Set(lower).size < 5) return { ok: false, reason: "That password is too simple (it repeats just a few characters). Please choose another." };
  return { ok: true };
}
