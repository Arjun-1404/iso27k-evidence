/**
 * Refuses secrets that are still the example text from .env.example, or too weak to protect anything.
 *
 * The risk is a copied-and-forgotten file: someone copies .env.example to .env, starts the portal, and the database
 * password and the key that signs every sign-in are the same "change-me" values published in the repository. Anyone who
 * has read the repository could then sign in as anyone. Better that the portal refuses to start and says what to do.
 */

const PLACEHOLDER = /change[-_ ]?me|replace[-_ ]?me|your[-_ ]?(secret|password|key)|placeholder|example|^(secret|password|test|default|todo|xxx+)$/i;

const HOW_TO_FIX = "Generate real ones with `npm run setup` (or the Docker command in the README's \"Installation\" section), which writes strong random values into .env.";

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/** The key that signs sign-in tokens: anyone who learns it can sign in as anyone, so it must be long and unguessable. */
export function assertUsableJwtSecret(value: string): void {
  if (isPlaceholder(value)) throw new Error(`JWT_SECRET is still the example text. ${HOW_TO_FIX}`);
  if (value.length < 32) throw new Error(`JWT_SECRET is too short (${value.length} characters; at least 32 are needed). ${HOW_TO_FIX}`);
  if (new Set(value).size < 8) throw new Error(`JWT_SECRET is too repetitive to be a secret. ${HOW_TO_FIX}`);
}

/** A password that is still the example text, in a database address or on its own. */
export function assertNotPlaceholderPassword(name: string, password: string | undefined): void {
  if (password && isPlaceholder(password)) throw new Error(`${name} is still the example text from .env.example. ${HOW_TO_FIX}`);
}

/** The password inside a postgres://user:password@host/db address ("" if none or if the address can't be read). */
export function passwordInDatabaseUrl(url: string): string {
  try { return decodeURIComponent(new URL(url).password); } catch { return ""; }
}
