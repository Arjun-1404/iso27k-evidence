import type { Pool } from "pg";
import { withoutUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { createOAuthState } from "./oauthState.ts";
import type { GoogleOAuth } from "../storage/googleOAuth.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import { StorageError } from "../storage/types.ts";
import { createHash } from "node:crypto";

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Step 1: builds the URL to send the browser to. Org admin only (createOAuthState enforces this via
 *  RLS). The state is recorded now so the callback leg — which has no session at all — can later
 *  prove this is a connection attempt this org genuinely started, not a forged or replayed request. */
export async function startGoogleDriveConnect(pool: Pool, userId: string, oauth: GoogleOAuth): Promise<string> {
  const state = await createOAuthState(pool, userId, "google_drive");
  return await oauth.buildAuthUrl(state);
}

export interface CompletedConnection { orgId: string; connectionId: string }

/**
 * Step 2: the callback. Exchanges the code for a refresh token, encrypts it, and completes the
 * connection — all gated by the single-use state value, since there is no authenticated session on
 * this leg (Google redirected the browser here directly). Returns null for an invalid/expired/already-
 * used state, exactly like consumeOAuthState — the caller cannot and should not try to tell those
 * apart from each other.
 */
export async function completeGoogleDriveConnect(
  pool: Pool, oauth: GoogleOAuth, secretStore: SecretStore, state: string, code: string,
): Promise<CompletedConnection | null> {
  let tokens;
  try {
    tokens = await oauth.exchangeCode(code);
  } catch (e) {
    if (e instanceof StorageError) throw new AppError(e.message, e.retryable ? 503 : 400, `OAUTH_${e.code}`);
    throw e;
  }
  const tokenRef = secretStore.encrypt(tokens.refreshToken);

  // oauth_complete_connection writes both the storage_connections row and its own audit log entry in
  // one atomic step (see the migration's comment for why that couldn't be split across two calls).
  const row = await withoutUser(pool, (c) =>
    c.query("SELECT * FROM oauth_complete_connection($1, $2, $3)", [hashState(state), tokenRef, null])
      .then((r) => r.rows[0] ?? null)
      .catch((e) => { throw mapDbError(e); }));
  if (!row) return null;
  return { orgId: row.out_org_id, connectionId: row.out_connection_id };
}
