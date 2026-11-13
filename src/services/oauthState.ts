import type { Pool } from "pg";
import { randomBytes, createHash } from "node:crypto";
import { withUser, withoutUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — this is a browser round trip, not an email link

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Starts an OAuth connect flow: generates a CSRF state value, records it against the caller's org,
 *  and returns the raw value to embed in the authorization URL. Org admin only, enforced by RLS. */
export async function createOAuthState(pool: Pool, userId: string, provider: "google_drive" | "sharepoint"): Promise<string> {
  const state = randomBytes(24).toString("hex");
  await withUser(pool, userId, async (c) => {
    try {
      await c.query(
        "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) SELECT org_id, $1, $2, $3, $4 FROM users WHERE id = $1",
        [userId, provider, hashState(state), new Date(Date.now() + STATE_TTL_MS)],
      );
    } catch (e) {
      throw mapDbError(e);
    }
  });
  return state;
}

export interface ConsumedState { orgId: string; actorId: string; provider: "google_drive" | "sharepoint" }

/** Consumes a state value from the callback leg (no session exists at this point — the browser was
 *  just redirected back by the provider). Returns null for an unknown, expired, or already-used state;
 *  the caller cannot and should not try to tell those apart. */
export async function consumeOAuthState(pool: Pool, state: string): Promise<ConsumedState | null> {
  const row = await withoutUser(pool, (c) =>
    c.query("SELECT * FROM oauth_state_consume($1)", [hashState(state)]).then((r) => r.rows[0]));
  if (!row) return null;
  return { orgId: row.org_id, actorId: row.actor_id, provider: row.provider };
}

export function missingStateError(): AppError {
  return new AppError("This connection link is invalid or has expired. Please try connecting again.", 400, "INVALID_OAUTH_STATE");
}
