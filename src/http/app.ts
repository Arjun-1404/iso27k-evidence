import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import { authMiddleware } from "./middleware/auth.ts";
import { enforceMfaPolicy } from "./middleware/mfaPolicy.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { securityHeaders } from "./middleware/securityHeaders.ts";
import { warnIfProxyUnconfigured } from "./middleware/rateLimit.ts";
import { camelCaseJson } from "./middleware/camelCase.ts";
import type { TokenVerifier } from "../auth/types.ts";
import type { StorageProvider } from "../storage/types.ts";
import type { StorageResolver } from "../storage/resolver.ts";
import type { Scanner } from "../scan/types.ts";
import type { EmailSender } from "../email/types.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import type { GoogleOAuth } from "../storage/googleOAuth.ts";
import { AppError, mapDbError } from "../errors.ts";
import { controlsRouter } from "./routes/controls.ts";
import { orgsRouter } from "./routes/orgs.ts";
import { usersRouter } from "./routes/users.ts";
import { rolesRouter } from "./routes/roles.ts";
import { authRouter } from "./routes/auth.ts";
import { mfaRouter } from "./routes/mfa.ts";
import { accountRouter } from "./routes/account.ts";
import { googleStartRouter, googleCallbackRouter } from "./routes/oauth.ts";
import { uploadsRouter } from "./routes/uploads.ts";
import { storageRouter } from "./routes/storage.ts";
import { platformRouter } from "./routes/platform.ts";
import { createRuntimeSettings, type RuntimeSettings } from "../settings/runtime.ts";
import type { EnvSettings } from "../settings/types.ts";

export interface AppDeps {
  pool: Pool;
  /** One fixed storage backend for every request. Used by tests and simple single-backend setups. */
  storage?: StorageProvider;
  /** Per-organisation storage: picks each request's backend from the caller's own org's connection.
   *  This is what production uses (see src/server.ts). Takes precedence over `storage` when both are set. */
  storageResolver?: StorageResolver;
  scanner: Scanner;
  email: EmailSender;
  tokenVerifier: TokenVerifier;
  /** Signs/verifies this project's own session tokens for the built-in email+password login. Required
   *  even when Auth0/OIDC is also enabled, since /auth/login and /auth/accept-invite always use it. */
  jwtSecret: string;
  /** Used to build the link inside invite emails (e.g. "https://portal.example"), no trailing slash. */
  appBaseUrl: string;
  /** Encrypts OAuth refresh tokens and authenticator-app secrets at rest. Optional: when absent, the "Connect
   *  Google Drive" routes and turning on two-step sign-in return a clear 503 instead of being wired in — a
   *  deployment that only uses SharePoint, or hasn't configured Drive yet, doesn't need this set. */
  secretStore?: SecretStore;
  /** Absent when Google OAuth isn't configured for this deployment (same 503 behaviour as above). */
  googleOAuth?: GoogleOAuth;
  /** The settings in force (mail server, malware scanner, Google app). Production shares one of these with the live mail
   *  sender, scanner and Google client, so a change saved on the settings page takes effect at once. When absent, the app
   *  makes its own (for the settings page only). */
  settings?: RuntimeSettings;
  /** What the server's own environment provides. Those groups are locked on the settings page. */
  envSettings?: EnvSettings;
  /** Browser origins allowed to call this API from a different origin (e.g. ["https://portal.example"]).
   *  Empty/absent = no cross-origin access, which is right when a reverse proxy serves the frontend and
   *  the API from the same origin. */
  corsAllowedOrigins?: string[];
  /** Number of reverse proxies in front of this API (default 0). Express then reads the visitor's address
   *  from X-Forwarded-For instead of the proxy's own, which the per-address request limits depend on. */
  trustProxy?: number;
  /** What this server offers for keeping evidence besides Google Drive (see src/config.ts). Absent = neither the disk option nor
   *  private-network S3 services are on offer. */
  storageOptions?: { localStorageDir?: string; allowPrivateAddresses?: boolean };
  /** Per-address limits on the signed-out endpoints (flood protection; the real per-account protections —
   *  login lockout, the reset-link limit — live in the database). Defaults are in DEFAULT_AUTH_LIMITS. */
  authLimits?: Partial<AuthLimits>;
}

export interface AuthLimits {
  /** Length of each counting window, in milliseconds. */
  windowMs: number;
  /** Requests per address per window to forgot-password and, separately, to reset-password. */
  passwordReset: number;
  /** Requests per address per window to login and, separately, to accept-invite. Generous: a shared office
   *  address must not be locked out by a few typos; the account lockout is the real brute-force defence. */
  signIn: number;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = { windowMs: 15 * 60 * 1000, passwordReset: 10, signIn: 60 };

/**
 * Builds the Express app from its dependencies. Every dependency is injected (see AppDeps), so the
 * same app runs unchanged against real services in production or fakes in tests — see src/server.ts
 * for real wiring and tests/08-http-api.test.ts / tests/10-org-user-http.test.ts for fake wiring.
 * Routes themselves are thin: parse input, call a service function, return its result. All the rules
 * live in the database (stage 1) and the service layer (stage 2), not here.
 */
export function createApp(deps: AppDeps): Express {
  if (!deps.storage && !deps.storageResolver) {
    throw new Error("createApp needs a storage backend: pass `storage` (fixed) or `storageResolver` (per organisation).");
  }
  const app = express();
  app.set("trust proxy", deps.trustProxy ?? 0);
  app.disable("x-powered-by");              // don't announce which framework (and so which known weaknesses) to look for
  app.use(securityHeaders());               // first of all, so every answer carries them — errors and downloads included
  app.use(warnIfProxyUnconfigured());
  // First, before body parsing and auth: a browser's preflight OPTIONS request carries no bearer token,
  // so it must be answered before authMiddleware ever sees it.
  app.use(corsMiddleware(deps.corsAllowedOrigins ?? []));
  // The link a file is sent to when evidence is kept on this server's disk or in S3. Before the JSON reader: it takes raw bytes.
  app.use(uploadsRouter(deps));
  app.use(express.json({ limit: "256kb" }));
  app.use(camelCaseJson);

  // Public: must come before authMiddleware. Nothing else in the app is reachable signed out — the
  // OAuth callback is the one other exception, for the same reason /auth/* is: Google redirects the
  // browser here directly, with no bearer token to check.
  app.use(authRouter(deps));
  app.use(googleCallbackRouter(deps));

  app.use(authMiddleware(deps.tokenVerifier));
  // Right after "who is calling": if the organisation requires two-step sign-in and this person hasn't set it up,
  // nothing but setting it up is reachable (see middleware/mfaPolicy.ts).
  app.use(enforceMfaPolicy(deps.pool));

  app.use(controlsRouter(deps));
  app.use(orgsRouter(deps));
  app.use(storageRouter(deps));
  app.use(usersRouter(deps));
  app.use(rolesRouter(deps));
  app.use(mfaRouter(deps));
  app.use(accountRouter(deps));
  app.use(googleStartRouter(deps));
  app.use(platformRouter({ ...deps, settings: deps.settings ?? createRuntimeSettings({ pool: deps.pool, secretStore: deps.secretStore, env: deps.envSettings ?? {} }) }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const known = err instanceof AppError ? err : requestFault(err) ?? databaseFault(err);
    if (known) {
      res.status(known.status).json({ error: { code: known.code, message: known.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL", message: "Unexpected error." } });
  });

  return app;
}

/**
 * A problem with the request itself, found by the body reader before any route ran (malformed JSON, a body over the
 * size limit, an unsupported encoding): the caller's mistake, so a 4xx with a fixed message — never a 500, and never
 * the parser's own text (which can quote part of what was sent).
 */
function requestFault(err: unknown): AppError | null {
  const e = err as { status?: unknown; type?: unknown } | null;
  if (!e || typeof e !== "object" || typeof e.status !== "number" || e.status < 400 || e.status > 499) return null;
  switch (e.type) {
    case "entity.too.large": return new AppError("That request is too large.", 413, "PAYLOAD_TOO_LARGE");
    case "entity.parse.failed": return new AppError("The request body is not valid JSON.", 400, "BAD_REQUEST");
    case "encoding.unsupported": case "charset.unsupported": return new AppError("That request's encoding is not supported.", 415, "UNSUPPORTED_MEDIA_TYPE");
    default: return new AppError("The request could not be read.", e.status, "BAD_REQUEST");
  }
}

/** A raw database error that a service didn't translate itself (a path id that isn't an id, a refused row, …) still gets its
 *  proper 4xx here rather than a 500; anything unrecognised stays a 500, which is the caller's cue that it is ours to fix. */
function databaseFault(err: unknown): AppError | null {
  const mapped = mapDbError(err);
  return mapped.status === 500 ? null : mapped;
}
