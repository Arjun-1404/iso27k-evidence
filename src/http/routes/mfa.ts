import { Router, type Response } from "express";
import { z } from "zod";
import { DEFAULT_AUTH_LIMITS, type AppDeps } from "../app.ts";
import { h, parse, pid } from "./shared.ts";
import { rateLimit } from "../middleware/rateLimit.ts";
import * as mfa from "../../services/mfa.ts";
import { createNotifier } from "../../services/notices.ts";

const passwordSchema = z.object({ password: z.string().min(1).max(1024) });
const codeSchema = z.object({ code: z.string().min(1).max(64) });
const passwordAndCodeSchema = z.object({ password: z.string().min(1).max(1024), code: z.string().min(1).max(64) });
const uuidSchema = z.string().uuid();
const policySchema = z.object({ policy: z.enum(["off", "staff", "everyone"]) });

/** Secrets and recovery codes are for one reader: no browser or proxy cache may keep a copy. */
const noStore = (res: Response) => { res.set("Cache-Control", "no-store"); };

/**
 * Managing two-step sign-in for the signed-in person (mounted AFTER the auth middleware). The sign-in step itself,
 * POST /auth/mfa/verify, is in routes/auth.ts because the person isn't signed in yet.
 */
export function mfaRouter(deps: AppDeps): Router {
  const r = Router();
  const notify = createNotifier(deps.pool, deps.email, deps.appBaseUrl);
  const limits = { ...DEFAULT_AUTH_LIMITS, ...deps.authLimits };
  // These check the password again, so they get the same per-address flood limit as sign-in (separate counters).
  const guarded = () => rateLimit({ windowMs: limits.windowMs, max: limits.signIn });

  r.get("/auth/mfa", h(async (req, res) => {
    res.json(await mfa.getStatus(deps.pool, deps.secretStore, req.userId!));
  }));

  r.post("/auth/mfa/enroll", guarded(), h(async (req, res) => {
    const b = parse(passwordSchema, req.body);
    noStore(res);
    res.json(await mfa.beginEnrollment(deps.pool, deps.secretStore, req.userId!, b.password));
  }));

  r.post("/auth/mfa/enroll/confirm", guarded(), h(async (req, res) => {
    const b = parse(codeSchema, req.body);
    noStore(res);
    res.json(await mfa.confirmEnrollment(deps.pool, deps.secretStore, req.userId!, b.code, notify));
  }));

  r.post("/auth/mfa/disable", guarded(), h(async (req, res) => {
    const b = parse(passwordAndCodeSchema, req.body);
    res.json(await mfa.disable(deps.pool, deps.secretStore, req.userId!, b.password, b.code, notify));
  }));

  r.post("/auth/mfa/recovery-codes", guarded(), h(async (req, res) => {
    const b = parse(passwordAndCodeSchema, req.body);
    noStore(res);
    res.json(await mfa.regenerateRecoveryCodes(deps.pool, deps.secretStore, req.userId!, b.password, b.code, notify));
  }));

  // The organisation's policy: who must use two-step sign-in. Organisation admins only (the database decides).
  r.get("/org/mfa-policy", h(async (req, res) => {
    res.json(await mfa.getOrgPolicy(deps.pool, deps.secretStore, req.userId!));
  }));

  r.put("/org/mfa-policy", h(async (req, res) => {
    const b = parse(policySchema, req.body);
    res.json(await mfa.setOrgPolicy(deps.pool, deps.secretStore, req.userId!, b.policy));
  }));

  r.post("/users/:id/reset-mfa", h(async (req, res) => {
    const target = parse(uuidSchema, pid(req, "id"));
    res.json(await mfa.adminReset(deps.pool, req.userId!, target, notify));
  }));

  return r;
}
