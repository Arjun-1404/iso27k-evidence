import { Router } from "express";
import { z } from "zod";
import { DEFAULT_AUTH_LIMITS, type AppDeps } from "../app.ts";
import { h, parse } from "./shared.ts";
import { rateLimit } from "../middleware/rateLimit.ts";
import { AppError } from "../../errors.ts";
import { createNotifier } from "../../services/notices.ts";
import * as platform from "../../services/platformSettings.ts";
import type { RuntimeSettings } from "../../settings/runtime.ts";
import { isGroup, type Group } from "../../settings/types.ts";

const reauth = { password: z.string().min(1).max(1024), code: z.string().min(1).max(64).optional() };
const saveSchema = z.object({
  settings: z.record(z.string().max(40), z.unknown()).refine((o) => Object.keys(o).length <= 20, "Too many fields."),
  ...reauth,
});
const clearSchema = z.object(reauth);

function groupOf(raw: string): Group {
  if (!isGroup(raw)) throw new AppError("Unknown settings group.", 404, "NOT_FOUND");
  return raw;
}

/**
 * Server settings (mounted AFTER the auth middleware). Owner-only, enforced in the database and again in the service;
 * saving and removing ask for the password again; secrets are never sent back; nothing here is ever cached.
 */
export function platformRouter(deps: AppDeps & { settings: RuntimeSettings }): Router {
  const r = Router();
  const notify = createNotifier(deps.pool, deps.email, deps.appBaseUrl);
  const limits = { ...DEFAULT_AUTH_LIMITS, ...deps.authLimits };
  const guarded = () => rateLimit({ windowMs: limits.windowMs, max: limits.signIn });
  const d = (): platform.PlatformDeps => ({ pool: deps.pool, store: deps.secretStore, runtime: deps.settings, env: deps.envSettings ?? {} });

  // Anyone signed in may ask whether THEY are the owner (the web app uses it to decide whether to show the menu item).
  r.get("/platform/owner", h(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ owner: await platform.isOwner(deps.pool, req.userId!) });
  }));

  r.get("/platform/settings", h(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await platform.getSettings(d(), req.userId!));
  }));

  r.put("/platform/settings/:group", guarded(), h(async (req, res) => {
    const group = groupOf(String(req.params.group));
    const b = parse(saveSchema, req.body);
    res.set("Cache-Control", "no-store");
    res.json(await platform.saveGroup(d(), req.userId!, group, b.settings, { password: b.password, code: b.code }, notify));
  }));

  r.post("/platform/settings/:group/clear", guarded(), h(async (req, res) => {
    const group = groupOf(String(req.params.group));
    const b = parse(clearSchema, req.body);
    res.set("Cache-Control", "no-store");
    res.json(await platform.clearGroup(d(), req.userId!, group, { password: b.password, code: b.code }, notify));
  }));

  r.post("/platform/settings/email/test", guarded(), h(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await platform.sendTestEmail(d(), req.userId!));
  }));

  r.post("/platform/settings/scanner/test", guarded(), h(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await platform.checkScanner(d(), req.userId!));
  }));

  return r;
}
