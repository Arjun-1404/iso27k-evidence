import type { Request, Response, NextFunction } from "express";

/**
 * Minimal, explicit CORS for a browser frontend served from a different origin than this API (the
 * default in docker-compose: frontend on :8080, API on :3000).
 *
 * Deliberately NOT "allow everything": a request from an origin that isn't on the list gets no CORS
 * headers at all, so the browser refuses to hand the response to the page. Sign-in uses a bearer token
 * in the Authorization header rather than cookies, so credentials mode is never enabled — a page on
 * another site can't ride on a visitor's existing session, because there is no ambient session.
 *
 * Requests with no Origin header (curl, server-to-server, same-origin navigations) pass straight
 * through untouched; CORS only governs what a browser lets a *page* read.
 */
const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Authorization,Content-Type";
const PREFLIGHT_MAX_AGE_SECONDS = "600";

/** Turns a user-supplied origin ("https://portal.example/", " https://x.example ") into the exact form
 *  browsers send in the Origin header, or null if it isn't a plain http(s) origin. */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin; // scheme + host + non-default port; drops any path or trailing slash
  } catch {
    return null;
  }
}

export function corsMiddleware(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin).filter((o): o is string => o !== null));

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    // Responses can differ by Origin, so shared caches must key on it — set on every response, even
    // when this origin isn't allowed, or a cache could replay an allowed origin's headers to another.
    res.vary("Origin");

    if (!origin) return next();

    const isPreflight = req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string";
    const permitted = allowed.has(origin);

    if (!permitted) {
      // No CORS headers: the browser will block the page from reading the answer. A preflight gets an
      // explicit 403 rather than falling through to the router (where it would look like a 404/401).
      if (isPreflight) {
        res.status(403).json({ error: { code: "CORS_ORIGIN_NOT_ALLOWED", message: "This origin is not allowed to call the API." } });
        return;
      }
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    if (isPreflight) {
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
      res.status(204).end();
      return;
    }
    next();
  };
}
