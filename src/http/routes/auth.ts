import { Router } from "express";
import { z } from "zod";
import { DEFAULT_AUTH_LIMITS, type AppDeps } from "../app.ts";
import { h, parse } from "./shared.ts";
import { rateLimit } from "../middleware/rateLimit.ts";
import * as auth from "../../services/auth.ts";
import * as reset from "../../services/passwordReset.ts";
import * as mfa from "../../services/mfa.ts";
import { createNotifier } from "../../services/notices.ts";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const acceptInviteSchema = z.object({ token: z.string().min(1), password: z.string().min(1) });
const verifySchema = z.object({ mfaToken: z.string().min(1).max(2048), code: z.string().min(1).max(64) });
const forgotSchema = z.object({ email: z.string().max(254).email() });
const resetSchema = z.object({ token: z.string().min(1).max(256), password: z.string().min(1).max(1024) });

/** The same answer however the request turned out, so it can't be used to find out who has an account. */
export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for that address, we've emailed a link to reset the password. It works once and expires in 1 hour.";

/** Mounted before the auth middleware in app.ts — these are the only endpoints a signed-out visitor
 *  can reach (apart from the Google OAuth callback). */
export function authRouter(deps: AppDeps): Router {
  const r = Router();
  const notify = createNotifier(deps.pool, deps.email, deps.appBaseUrl);
  const limits = { ...DEFAULT_AUTH_LIMITS, ...deps.authLimits };
  // One counter per endpoint, so a burst against one doesn't use up another's allowance.
  const signIn = () => rateLimit({ windowMs: limits.windowMs, max: limits.signIn });
  const resetLimit = () => rateLimit({ windowMs: limits.windowMs, max: limits.passwordReset });

  r.post("/auth/login", signIn(), h(async (req, res) => {
    const b = parse(loginSchema, req.body);
    const result = await auth.login(deps.pool, deps.jwtSecret, b.email, b.password);
    res.set("Cache-Control", "no-store");
    res.json(result); // a session, or { mfaRequired: true, mfaToken } for an account with two-step sign-in on
  }));

  // The second sign-in step: the token from the password step plus a code. Counted against the same per-address
  // limit as sign-in; the real brute-force defence (5 wrong codes lock it for 15 minutes) is in the database.
  r.post("/auth/mfa/verify", signIn(), h(async (req, res) => {
    const b = parse(verifySchema, req.body);
    const result = await mfa.completeMfaLogin(deps.pool, deps.jwtSecret, deps.secretStore, b.mfaToken, b.code, notify);
    res.set("Cache-Control", "no-store");
    res.json(result);
  }));

  r.post("/auth/accept-invite", signIn(), h(async (req, res) => {
    const b = parse(acceptInviteSchema, req.body);
    const result = await auth.acceptInvite(deps.pool, deps.jwtSecret, b.token, b.password);
    res.json(result);
  }));

  // Always 202 with the same body once the address looks like an address — whether or not an account
  // exists, was eligible, or was throttled, and whether or not the email could be sent.
  r.post("/auth/forgot-password", resetLimit(), h(async (req, res) => {
    const b = parse(forgotSchema, req.body);
    await reset.requestPasswordReset(deps.pool, b.email, { email: deps.email, appBaseUrl: deps.appBaseUrl });
    res.status(202).json({ message: FORGOT_PASSWORD_MESSAGE });
  }));

  // Deliberately does NOT sign the person in: they go back to the sign-in page with the new password, so
  // holding a reset link is never by itself enough to hold a session.
  r.post("/auth/reset-password", resetLimit(), h(async (req, res) => {
    const b = parse(resetSchema, req.body);
    await reset.resetPassword(deps.pool, b.token, b.password, notify);
    res.json({ ok: true });
  }));

  return r;
}
