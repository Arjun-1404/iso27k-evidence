import { Router } from "express";
import { z } from "zod";
import { DEFAULT_AUTH_LIMITS, type AppDeps } from "../app.ts";
import { h, parse } from "./shared.ts";
import { rateLimit } from "../middleware/rateLimit.ts";
import * as account from "../../services/account.ts";
import { createNotifier } from "../../services/notices.ts";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
  code: z.string().min(1).max(64).optional(),
});

/** The signed-in person's own account (mounted AFTER the auth middleware). */
export function accountRouter(deps: AppDeps): Router {
  const r = Router();
  const notify = createNotifier(deps.pool, deps.email, deps.appBaseUrl);
  const limits = { ...DEFAULT_AUTH_LIMITS, ...deps.authLimits };

  // Re-checks the password, so it gets the same per-address flood limit as sign-in (its own counter).
  r.post("/auth/change-password", rateLimit({ windowMs: limits.windowMs, max: limits.signIn }), h(async (req, res) => {
    const b = parse(changePasswordSchema, req.body);
    res.set("Cache-Control", "no-store");
    // The reply is the person's new session: every OTHER session they had has just been ended.
    res.json(await account.changePassword(deps.pool, deps.jwtSecret, deps.secretStore, req.userId!, b, notify));
  }));

  return r;
}
