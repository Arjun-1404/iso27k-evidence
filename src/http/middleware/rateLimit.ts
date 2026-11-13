import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface RateLimitOptions {
  /** Length of each counting window, in milliseconds. */
  windowMs: number;
  /** Requests allowed per client per window; the next one gets a 429. */
  max: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Most addresses remembered at once (default 10,000), so a flood from very many addresses can't grow
   *  memory without bound. When full, the address whose window began longest ago is forgotten first. */
  maxClients?: number;
}

const DEFAULT_MAX_TRACKED_CLIENTS = 10_000;

/**
 * A small fixed-window limiter keyed by client IP, kept in this process's memory. It is coarse flood
 * protection for the endpoints a signed-out visitor can reach — the real per-account protections (login
 * lockout, the reset-link limit) live in the database and don't depend on it.
 *
 * Two honest limits: with several API replicas each counts separately, and behind a reverse proxy the
 * "client IP" is the proxy's unless the app is told how many proxies to trust (TRUST_PROXY).
 */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const now = opts.now ?? Date.now;
  const maxClients = opts.maxClients ?? DEFAULT_MAX_TRACKED_CLIENTS;
  const clients = new Map<string, { count: number; resetAt: number }>();

  /** Forget the address whose window began longest ago. Windows are all the same length, so that is also
   *  the one that ends first: an address whose window has already ended always goes before one still counting. */
  function makeRoom() {
    while (clients.size >= maxClients) {
      const oldest = clients.keys().next();
      if (oldest.done) break;
      clients.delete(oldest.value);
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();
    const key = req.ip ?? "unknown";
    let entry = clients.get(key);
    if (!entry || entry.resetAt <= t) {
      clients.delete(key); // a returning address goes to the END of the Map, so its order stays "oldest window first"
      makeRoom();
      entry = { count: 0, resetAt: t + opts.windowMs };
      clients.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please wait a few minutes and try again." } });
      return;
    }
    next();
  };
}

/**
 * Behind a reverse proxy every request seems to come from the proxy, so the per-address limits would treat
 * all visitors as one. A proxy announces itself with an X-Forwarded-For header; seeing one while TRUST_PROXY
 * is 0 means the setting is almost certainly missing. Says so once in the log, and does nothing else — it
 * never trusts the header itself.
 */
export function warnIfProxyUnconfigured(out: { warn(line: string): void } = console): RequestHandler {
  let warned = false;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!warned && req.headers["x-forwarded-for"] && !req.app.get("trust proxy")) {
      warned = true;
      out.warn("[security] A request carried an X-Forwarded-For header but TRUST_PROXY is 0, so the per-address request limits see your reverse proxy's address for every visitor. " +
        "Set TRUST_PROXY to the number of proxies in front of the API (usually 1). See .env.example.");
    }
    next();
  };
}
