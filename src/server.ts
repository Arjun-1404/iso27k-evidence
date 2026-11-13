import { loadConfig } from "./config.ts";
import { isMainModule } from "./isMainModule.ts";
import { createAppPool } from "./db/pool.ts";
import { createApp } from "./http/app.ts";
import type { TokenVerifier } from "./auth/types.ts";
import { JwtTokenVerifier } from "./auth/jwt.ts";
import { dbSessionCheck } from "./auth/sessionCheck.ts";
import { AesSecretStore } from "./auth/secretStore.ts";
import { createRuntimeSettings } from "./settings/runtime.ts";
import { LiveEmailSender, LiveGoogleOAuth, LiveScanner } from "./settings/live.ts";
import type { EnvSettings } from "./settings/types.ts";
import { createStorageResolver } from "./storage/resolver.ts";
import { flushNotices } from "./services/notices.ts";

/**
 * Production wiring: where each real implementation plugs into the app. Sign-in, the Google Drive
 * connection, per-organisation storage access, email (SMTP) and malware scanning (ClamAV) are all real and
 * tested; each of the last two switches on only when configured, and says so loudly at startup when not.
 * What can't be tested from the build sandbox is a live round trip to Google, a real mail provider and a
 * real ClamAV daemon — see the README for how to check those once deployed. External OIDC (Auth0) is the
 * remaining optional piece, behind the TokenVerifier interface.
 */

export function startServer() {
  const config = loadConfig();
  const pool = createAppPool(config.databaseUrl);
  const tokenVerifier: TokenVerifier = new JwtTokenVerifier(config.jwtSecret, dbSessionCheck(pool));
  const secretStore = config.secretEncryptionKey ? new AesSecretStore(config.secretEncryptionKey) : undefined;

  // The mail server, malware scanner and Google app come from the server's environment if it provides them, and
  // otherwise from what the owner saved under Server settings. All three are looked up when used, not once at startup,
  // so a change made in the web app takes effect without a restart.
  const envSettings: EnvSettings = { email: config.smtp, scanner: config.clamav, google: config.googleOAuth };
  const settings = createRuntimeSettings({ pool, secretStore, env: envSettings });
  const googleOAuth = new LiveGoogleOAuth(settings);
  // Each organisation keeps its evidence in the storage it chose: Google Drive, a folder on this server's disk, or an
  // S3-compatible service. What a storage needs that this server hasn't been given is reported when that storage is used.
  const storageResolver = createStorageResolver({
    pool, oauth: googleOAuth, secretStore, jwtSecret: config.jwtSecret,
    localStorageDir: config.localStorageDir, allowPrivateAddresses: config.allowPrivateStorageAddresses,
  });

  const email = new LiveEmailSender(settings);
  const scanner = new LiveScanner(settings);
  void email.prepare(); // say in the log right away whether mail and scanning are set up
  void scanner.prepare();

  const app = createApp({
    pool, storageResolver, scanner, email, tokenVerifier, jwtSecret: config.jwtSecret, appBaseUrl: config.appBaseUrl,
    secretStore, googleOAuth, settings, envSettings, corsAllowedOrigins: config.corsAllowedOrigins, trustProxy: config.trustProxy,
    storageOptions: { localStorageDir: config.localStorageDir, allowPrivateAddresses: config.allowPrivateStorageAddresses },
  });
  const server = app.listen(config.port, () => console.log(`Evidence portal API listening on :${(server.address() as { port: number }).port}`));
  // Closing the server also releases its database connections, so a graceful shutdown (or a test) can exit cleanly.
  // Let security notices still on their way go out (bounded) before the database connections are closed.
  server.on("close", () => { void flushNotices(5_000).finally(() => pool.end()); });
  return server;
}

if (isMainModule(import.meta.url)) startServer();
