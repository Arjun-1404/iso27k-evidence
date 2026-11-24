import type { Request, Response, NextFunction } from "express";

/**
 * Response headers for the API. It only ever answers with JSON (or a file being downloaded), never a page, so the
 * strictest possible policy is right: nothing it sends may be run, framed or cached.
 *
 *  - X-Content-Type-Options: nosniff — a browser must treat a response as the type the server said it is.
 *  - Content-Security-Policy: default-src 'none'; frame-ancestors 'none' — if a response were ever opened as a
 *    page, nothing in it could load or run anything, and no other site can put it in a frame.
 *  - X-Frame-Options: DENY — the same, for browsers that predate frame-ancestors.
 *  - Referrer-Policy: no-referrer — links followed from a response don't reveal where they came from.
 *  - Cache-Control: no-store — answers hold evidence details and session tokens; browsers and shared caches keep
 *    none of it. (A route that sets its own Cache-Control later simply replaces this.)
 *  - Strict-Transport-Security — only on a request that arrived over HTTPS (behind a proxy: when TRUST_PROXY is set
 *    correctly), so a plain-http test setup is never locked out of itself.
 *  - Cross-Origin-Resource-Policy: same-site — other sites cannot embed a response as a resource.
 */
export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  };
}
