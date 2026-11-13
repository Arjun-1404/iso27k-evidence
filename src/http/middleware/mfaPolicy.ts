import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { withoutUser } from "../../db/pool.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only things someone who still has to set up two-step sign-in can do: look at their status and set it up. */
const SETUP_ENDPOINTS = new Set(["GET /auth/mfa", "POST /auth/mfa/enroll", "POST /auth/mfa/enroll/confirm"]);

export const MFA_SETUP_REQUIRED_MESSAGE = "Your organisation requires two-step sign-in. Set it up in Security settings to carry on.";

/**
 * Enforces the organisation's two-step policy on every signed-in request (mounted straight after the auth middleware).
 * If the policy covers the caller and they haven't set two-step sign-in up, everything except setting it up is refused
 * with 403 MFA_SETUP_REQUIRED, which the web app turns into "go to Security settings". The database decides who is
 * covered (mfa_requirement, migration 011); a database failure is passed on as a server error, never as "let them
 * through", so an outage cannot be used to skip the policy.
 */
export function enforceMfaPolicy(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (SETUP_ENDPOINTS.has(`${req.method} ${req.path}`)) return next();
      const userId = req.userId;
      if (!userId || !UUID.test(userId)) return next(); // no such account can exist: nothing for a policy to say
      const row = await withoutUser(pool, (c) => c.query("SELECT required, enabled FROM mfa_requirement($1)", [userId]).then((r) => r.rows[0] as { required: boolean; enabled: boolean } | undefined));
      if (row?.required === true && row.enabled !== true) {
        return res.status(403).json({ error: { code: "MFA_SETUP_REQUIRED", message: MFA_SETUP_REQUIRED_MESSAGE } });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
