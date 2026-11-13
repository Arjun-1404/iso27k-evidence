import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import type { AppDeps } from "../app.ts";
import type { StorageProvider } from "../../storage/types.ts";

/** Wraps an async route handler so a rejected promise reaches the error middleware instead of hanging the request. */
export const h = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400, "VALIDATION");
  return r.data;
}

/** Express 5 types a route param as `string | string[]` (it allows repeated-segment routes elsewhere
 *  in an app). None of our routes use that pattern, so a param is always a single string at runtime —
 *  this just asserts that, with a clean 400 instead of a crash if it's ever somehow not. */
export function pid(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string") throw new AppError(`Invalid path parameter: ${name}`, 400, "VALIDATION");
  return v;
}

/** The storage provider to use for this user's request: the org-specific one when a resolver is
 *  configured (production), otherwise the single fixed provider (tests, single-tenant setups). Lazy, so
 *  no credentials are fetched unless a service actually reaches for storage. */
export function storageFor(deps: AppDeps, userId: string): StorageProvider {
  if (deps.storageResolver) return deps.storageResolver(userId);
  if (deps.storage) return deps.storage;
  throw new AppError("No storage backend is configured on this server.", 503, "STORAGE_NOT_CONFIGURED");
}
