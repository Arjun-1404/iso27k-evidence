import type { Pool } from "pg";
import { withoutUser } from "../db/pool.ts";

/** Answers: is a session token issued to `userId` at `issuedAt` still good? */
export type SessionCheck = (userId: string, issuedAt: Date) => Promise<boolean>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The database's answer (auth_session_valid, migration 008): no if the account is gone or disabled, or if its
 * password was reset after the token was issued. A database failure is thrown, not turned into "invalid", so an
 * outage shows up as a server error instead of signing everyone out.
 */
export function dbSessionCheck(pool: Pool): SessionCheck {
  return async (userId, issuedAt) => {
    if (!UUID.test(userId)) return false;
    return withoutUser(pool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [userId, issuedAt]).then((r) => r.rows[0].ok === true));
  };
}
