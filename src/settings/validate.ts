import type { SmtpSettings, SmtpSecurity } from "../email/smtp.ts";
import type { ClamAvSettings } from "../scan/clamav.ts";
import type { GoogleOAuthSettings } from "../config.ts";
import type { Group, SecretMap } from "./types.ts";

/**
 * Checks what the owner typed into the settings page, and turns what is stored back into usable settings. The same
 * functions do both jobs on purpose: whatever is in the database is checked again, exactly as strictly, before the
 * server uses it, so a damaged or hand-edited row can never produce a half-working mail or scanner connection.
 *
 * Messages are written for the person at the form (no environment-variable names). They never contain a value that was
 * typed, so a mistyped password can't end up in a response or a log line through here.
 */
export class SettingsInputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "SettingsInputError";
  }
}

const fail = (field: string, message: string): never => { throw new SettingsInputError(message, field); };
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(raw: unknown, field: string, label: string, max: number, required: boolean): string | undefined {
  if (raw === undefined || raw === null) return required ? fail(field, `${label} is required.`) : undefined;
  if (typeof raw !== "string") return fail(field, `${label} must be text.`);
  const v = raw.trim();
  if (v === "") return required ? fail(field, `${label} is required.`) : undefined;
  if (v.length > max) return fail(field, `${label} is too long (at most ${max} characters).`);
  if (CONTROL.test(v)) return fail(field, `${label} can't contain line breaks or control characters.`);
  return v;
}

function whole(raw: unknown, field: string, label: string, min: number, max: number, fallback?: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback ?? fail(field, `${label} is required.`);
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return fail(field, `${label} must be a whole number between ${min} and ${max}.`);
  return n;
}

const HOSTNAME = /^[A-Za-z0-9_]([A-Za-z0-9_.-]{0,251}[A-Za-z0-9_])?$/;
const IPV6 = /^(?=(?:[^:]*:){2,})[0-9A-Fa-f:.]{2,45}$/;
function host(raw: unknown, field: string, label: string): string {
  const v = text(raw, field, label, 253, true)!;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v) || v.includes("/")) {
    return fail(field, `${label} should be just a server name like mail.example.com, without http:// or smtp:// or a path.`);
  }
  if (!HOSTNAME.test(v) && !IPV6.test(v)) {
    return fail(field, `${label} should be a server name like mail.example.com or an IP address, with no spaces, port or other symbols.`);
  }
  return v;
}

// ---- email ----------------------------------------------------------------------------------------------------------

export interface EmailConfig { host: string; port: number; security: SmtpSecurity; user?: string; from: string }

export function parseEmail(input: Record<string, unknown>, existing: SecretMap): { config: EmailConfig; secrets: SecretMap; settings: SmtpSettings } {
  const hostName = host(input.host, "host", "The mail server");
  const security = text(input.security, "security", "Encryption", 10, true) as string;
  if (security !== "starttls" && security !== "tls" && security !== "none") {
    return fail("security", "Encryption must be STARTTLS, TLS or none.");
  }
  const defaultPort = { starttls: 587, tls: 465, none: 25 }[security];
  const port = whole(input.port, "port", "The port", 1, 65535, defaultPort);
  const user = text(input.user, "user", "The username", 256, false);
  const from = text(input.from, "from", "The From address", 320, true)!;
  if (!from.includes("@")) return fail("from", "The From address must be an email address, optionally with a name: Evidence Portal <noreply@yourfirm.example>.");

  const typed = input.password;
  if (typed !== undefined && typed !== null && typeof typed !== "string") return fail("password", "The password must be text.");
  const typedPassword = typeof typed === "string" && typed !== "" ? typed : undefined;
  if (typedPassword !== undefined && (typedPassword.length > 1024 || /[\r\n\0]/.test(typedPassword))) {
    return fail("password", "The password is too long or contains a line break.");
  }

  const secrets: SecretMap = {};
  if (user === undefined) {
    if (typedPassword !== undefined) return fail("password", "A password needs a username. Leave both empty if the mail server needs no login.");
  } else {
    if (security === "none") {
      return fail("security", "Encryption can't be 'none' when a username and password are used: the password would travel unencrypted. Choose STARTTLS or TLS.");
    }
    const password = typedPassword ?? existing.password;
    if (password === undefined) return fail("password", "Enter the password for the mail account.");
    secrets.password = password;
  }

  const config: EmailConfig = { host: hostName, port, security, ...(user !== undefined ? { user } : {}), from };
  const settings: SmtpSettings = { host: hostName, port, security, from, ...(user !== undefined ? { user, password: secrets.password } : {}) };
  return { config, secrets, settings };
}

// ---- scanner --------------------------------------------------------------------------------------------------------

export interface ScannerConfig { host: string; port: number; timeoutSeconds: number; maxFileMb: number }

export function parseScanner(input: Record<string, unknown>): { config: ScannerConfig; secrets: SecretMap; settings: ClamAvSettings } {
  const hostName = host(input.host, "host", "The scanner's host");
  const port = whole(input.port, "port", "The port", 1, 65535, 3310);
  const timeoutSeconds = whole(input.timeoutSeconds, "timeoutSeconds", "The time limit", 1, 600, 60);
  const maxFileMb = whole(input.maxFileMb, "maxFileMb", "The largest file", 1, 4096, 25);
  return {
    config: { host: hostName, port, timeoutSeconds, maxFileMb },
    secrets: {},
    settings: { host: hostName, port, timeoutMs: timeoutSeconds * 1000, maxBytes: maxFileMb * 1024 * 1024 },
  };
}

// ---- google ---------------------------------------------------------------------------------------------------------

export interface GoogleConfig { clientId: string; redirectUri: string }
const CALLBACK_PATH = "/oauth/google/callback";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseGoogle(input: Record<string, unknown>, existing: SecretMap): { config: GoogleConfig; secrets: SecretMap; settings: GoogleOAuthSettings } {
  const clientId = text(input.clientId, "clientId", "The client ID", 300, true)!;
  if (/\s/.test(clientId)) return fail("clientId", "The client ID can't contain spaces.");

  const redirectUri = text(input.redirectUri, "redirectUri", "The redirect address", 500, true)!;
  let url: URL;
  try { url = new URL(redirectUri); } catch { return fail("redirectUri", "The redirect address must be a full web address, like https://portal.example.com/oauth/google/callback."); }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return fail("redirectUri", "The redirect address must start with https:// (http:// is only allowed for localhost).");
  }
  if (url.username || url.password || url.search || url.hash) return fail("redirectUri", "The redirect address can't contain a login, a ? query or a # fragment.");
  if (!url.pathname.endsWith(CALLBACK_PATH)) return fail("redirectUri", `The redirect address must end with ${CALLBACK_PATH}.`);

  const typed = input.clientSecret;
  if (typed !== undefined && typed !== null && typeof typed !== "string") return fail("clientSecret", "The client secret must be text.");
  const typedSecret = typeof typed === "string" && typed.trim() !== "" ? typed.trim() : undefined;
  if (typedSecret !== undefined && (typedSecret.length > 300 || CONTROL.test(typedSecret) || /\s/.test(typedSecret))) {
    return fail("clientSecret", "The client secret looks wrong: it is too long or contains spaces or line breaks.");
  }
  const clientSecret = typedSecret ?? existing.clientSecret;
  if (clientSecret === undefined) return fail("clientSecret", "Enter the client secret from Google Cloud Console.");

  return {
    config: { clientId, redirectUri },
    secrets: { clientSecret },
    settings: { clientId, clientSecret, redirectUri },
  };
}

// ---- common ---------------------------------------------------------------------------------------------------------

export type ParsedGroup = { config: object; secrets: SecretMap; settings: SmtpSettings | ClamAvSettings | GoogleOAuthSettings };

/** Validates the owner's input for a group, using the secrets already stored for any secret field left blank. */
export function parseGroup(group: Group, input: Record<string, unknown>, existing: SecretMap): ParsedGroup {
  switch (group) {
    case "email": return parseEmail(input, existing);
    case "scanner": return parseScanner(input);
    case "google": return parseGoogle(input, existing);
  }
}

/** The non-secret values to show on the settings page, whatever their source. */
export function describeSettings(group: Group, s: SmtpSettings | ClamAvSettings | GoogleOAuthSettings): Record<string, string | number | null> {
  switch (group) {
    case "email": { const e = s as SmtpSettings; return { host: e.host, port: e.port, security: e.security, user: e.user ?? null, from: e.from }; }
    case "scanner": {
      const c = s as ClamAvSettings;
      return { host: c.host, port: c.port, timeoutSeconds: Math.round((c.timeoutMs ?? 60_000) / 1000), maxFileMb: Math.round((c.maxBytes ?? 25 * 1024 * 1024) / (1024 * 1024)) };
    }
    case "google": { const g = s as GoogleOAuthSettings; return { clientId: g.clientId, redirectUri: g.redirectUri }; }
  }
}
