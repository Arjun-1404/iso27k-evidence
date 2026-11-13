import path from "node:path";
import { normalizeOrigin } from "./http/middleware/cors.ts";
import type { SmtpSettings, SmtpSecurity } from "./email/smtp.ts";
import type { ClamAvSettings } from "./scan/clamav.ts";

export interface GoogleOAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Config {
  databaseUrl: string;
  port: number;
  /** Signs/verifies session tokens for the built-in email+password login. Must be a long, random,
   *  secret value in production (e.g. `openssl rand -hex 32`) — anyone who has it can forge a session
   *  for any user. */
  jwtSecret: string;
  /** Used to build links in invite emails and the post-OAuth redirect, e.g. "https://portal.example"
   *  (no trailing slash). */
  appBaseUrl: string;
  /** Encrypts OAuth refresh tokens at rest — 32 bytes, hex-encoded (`openssl rand -hex 32`). Optional:
   *  only needed once an org connects Google Drive. Changing it later makes every already-stored
   *  refresh token undecryptable, so treat it like a database password, not a per-deploy setting. */
  secretEncryptionKey?: string;
  /** Present only when ALL of GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI are set. */
  googleOAuth?: GoogleOAuthSettings;
  /** Browser origins allowed to call the API cross-origin. Defaults to just APP_BASE_URL's origin, which
   *  is what you want when the frontend lives there. Override with a comma-separated CORS_ALLOWED_ORIGINS
   *  (e.g. to add a staging frontend). Set it to an empty value to disable cross-origin access entirely
   *  (use this when a reverse proxy serves frontend and API from one origin). */
  corsAllowedOrigins: string[];
  /** Present only when SMTP_HOST is set. Without it, emails are printed to the server log instead of sent. */
  smtp?: SmtpSettings;
  /** Present only when CLAMD_HOST is set. Without it, uploads are recorded as "skipped" (not scanned). */
  clamav?: ClamAvSettings;
  /** How many reverse proxies sit in front of the API (0 = none, the browser connects directly). Needed so
   *  the per-address request limits see the real visitor instead of the proxy. A count, never "trust all":
   *  trusting every X-Forwarded-For value would let anyone pick their own address. */
  trustProxy: number;
  /** A folder on this server's disk where organisations may choose to keep their evidence (LOCAL_STORAGE_DIR). Absent = that choice is
   *  not offered. Each organisation gets its own sub-folder inside it. An absolute path, set by whoever runs the server. */
  localStorageDir?: string;
  /** Whether an organisation may point its S3-compatible storage at an address on a private network (STORAGE_ALLOW_PRIVATE_ADDRESSES=true).
   *  Off by default: on a shared installation that would let an organisation's administrator make the server talk to its own network.
   *  Turn it on when the installation is your own organisation's and your storage (MinIO, Ceph…) is inside your network. */
  allowPrivateStorageAddresses: boolean;
}

/** An environment variable's value, treating empty (which is what `docker compose` passes for an unset
 *  `${VAR:-}`) the same as not set. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function intSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

function loadSmtp(): SmtpSettings | undefined {
  const host = env("SMTP_HOST");
  const others = ["SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM"].filter((n) => env(n) !== undefined);
  if (!host) {
    if (others.length > 0) throw new Error(`${others.join(", ")} is set but SMTP_HOST is not — set SMTP_HOST to turn email sending on, or remove these.`);
    return undefined;
  }
  const security = (env("SMTP_SECURITY") ?? "starttls").toLowerCase();
  if (security !== "starttls" && security !== "tls" && security !== "none") {
    throw new Error(`SMTP_SECURITY must be starttls, tls or none (got "${security}").`);
  }
  const defaultPort = { starttls: 587, tls: 465, none: 25 }[security];
  const user = env("SMTP_USER");
  const password = env("SMTP_PASSWORD");
  if ((user === undefined) !== (password === undefined)) throw new Error("Set both SMTP_USER and SMTP_PASSWORD, or neither.");
  if (security === "none" && user !== undefined) {
    throw new Error("SMTP_SECURITY=none would send the mail-server password unencrypted. Use starttls or tls, or remove SMTP_USER/SMTP_PASSWORD.");
  }
  const from = env("EMAIL_FROM");
  if (!from) throw new Error("EMAIL_FROM is required when SMTP_HOST is set, e.g. EMAIL_FROM=\"Evidence Portal <noreply@yourfirm.example>\".");
  if (/[\r\n]/.test(from) || !from.includes("@")) throw new Error("EMAIL_FROM must be a single email address, optionally with a display name.");
  return { host, port: intSetting("SMTP_PORT", defaultPort, 1, 65535), security: security as SmtpSecurity, user, password, from };
}

function loadClamAv(): ClamAvSettings | undefined {
  const host = env("CLAMD_HOST");
  const others = ["CLAMD_PORT", "CLAMD_TIMEOUT_SECONDS", "CLAMD_MAX_FILE_MB"].filter((n) => env(n) !== undefined);
  if (!host) {
    if (others.length > 0) throw new Error(`${others.join(", ")} is set but CLAMD_HOST is not — set CLAMD_HOST to turn malware scanning on, or remove these.`);
    return undefined;
  }
  return {
    host,
    port: intSetting("CLAMD_PORT", 3310, 1, 65535),
    timeoutMs: intSetting("CLAMD_TIMEOUT_SECONDS", 60, 1, 600) * 1000,
    maxBytes: intSetting("CLAMD_MAX_FILE_MB", 25, 1, 4096) * 1024 * 1024,
  };
}

function loadLocalStorageDir(): string | undefined {
  const dir = env("LOCAL_STORAGE_DIR");
  if (dir === undefined) return undefined;
  const isAbsolute = path.isAbsolute(dir) || path.win32.isAbsolute(dir);
  if (!isAbsolute) throw new Error(`LOCAL_STORAGE_DIR must be a full path (for example /srv/evidence or C:\\evidence-data), not "${dir}".`);
  if (path.parse(dir).root === dir || path.win32.parse(dir).root === dir) throw new Error("LOCAL_STORAGE_DIR must be a folder of its own, not the top of a drive.");
  if (dir.split(/[\\/]/).includes("..")) throw new Error('LOCAL_STORAGE_DIR must not contain "..".');
  return dir;
}

function boolSetting(name: string): boolean {
  const raw = env(name);
  if (raw === undefined) return false;
  if (/^(true|yes|1|on)$/i.test(raw)) return true;
  if (/^(false|no|0|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false (got "${raw}").`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const anyGoogle = [clientId, clientSecret, redirectUri].some(Boolean);
  const allGoogle = [clientId, clientSecret, redirectUri].every(Boolean);
  // All-or-nothing: a half-configured Google client is worse than none, since it would fail
  // confusingly at the moment an admin clicks "Connect" instead of clearly at startup.
  if (anyGoogle && !allGoogle) {
    throw new Error("Google OAuth is only partly configured — set all of GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI, or none of them.");
  }
  if (allGoogle && !process.env.SECRET_ENCRYPTION_KEY) {
    throw new Error("GOOGLE_OAUTH_* is set but SECRET_ENCRYPTION_KEY is not — refresh tokens can't be stored without it. Generate one with: openssl rand -hex 32");
  }

  const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");

  // Distinguish "not set" (use the safe default) from "set to empty" (the operator explicitly wants no
  // cross-origin access). Every entry must be a real http(s) origin — a typo should stop the server at
  // startup, not silently leave the frontend blocked in the browser with a cryptic error.
  let corsAllowedOrigins: string[];
  const corsRaw = process.env.CORS_ALLOWED_ORIGINS;
  if (corsRaw === undefined) {
    const own = normalizeOrigin(appBaseUrl);
    corsAllowedOrigins = own ? [own] : [];
  } else {
    corsAllowedOrigins = corsRaw.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
      const o = normalizeOrigin(entry);
      if (!o) throw new Error(`CORS_ALLOWED_ORIGINS contains an invalid origin: "${entry}". Use full origins like https://portal.example (scheme + host, optional port).`);
      return o;
    });
  }

  return {
    databaseUrl: required("DATABASE_URL"),
    port: Number(process.env.PORT ?? "3000"),
    jwtSecret: required("JWT_SECRET"),
    appBaseUrl,
    corsAllowedOrigins,
    secretEncryptionKey: process.env.SECRET_ENCRYPTION_KEY || undefined,
    googleOAuth: allGoogle ? { clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! } : undefined,
    smtp: loadSmtp(),
    clamav: loadClamAv(),
    trustProxy: intSetting("TRUST_PROXY", 0, 0, 10),
    localStorageDir: loadLocalStorageDir(),
    allowPrivateStorageAddresses: boolSetting("STORAGE_ALLOW_PRIVATE_ADDRESSES"),
  };
}
