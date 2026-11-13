import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimit, warnIfProxyUnconfigured } from "../src/http/middleware/rateLimit.ts";

/** A tiny app with one limited endpoint, and a clock the test controls. */
function limitedApp(opts: { max: number; windowMs?: number; maxClients?: number; trustProxy?: number }) {
  let t = 1_000_000;
  const app = express();
  app.set("trust proxy", opts.trustProxy ?? 0);
  app.get("/x", rateLimit({ windowMs: opts.windowMs ?? 60_000, max: opts.max, maxClients: opts.maxClients, now: () => t }), (_req, res) => { res.json({ ok: true }); });
  return { app, advance: (ms: number) => { t += ms; } };
}
const hit = (app: express.Express, ip?: string) => {
  const r = request(app).get("/x");
  return ip ? r.set("X-Forwarded-For", ip) : r;
};

describe("rateLimit", () => {
  it("lets through exactly `max` requests per window, then answers 429 with the standard error body", async () => {
    const { app } = limitedApp({ max: 3 });
    for (let i = 0; i < 3; i++) expect((await hit(app)).status).toBe(200);
    const res = await hit(app);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error.message).toMatch(/too many requests/i);
  });

  it("tells the client how long to wait (Retry-After, in whole seconds, at least 1)", async () => {
    const { app, advance } = limitedApp({ max: 1, windowMs: 60_000 });
    await hit(app);
    advance(20_500);
    const res = await hit(app);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("40"); // 39.5s left, rounded up
    advance(39_400); // 100 ms before the window ends
    expect((await hit(app)).headers["retry-after"]).toBe("1");
  });

  it("starts a fresh window once the old one has passed", async () => {
    const { app, advance } = limitedApp({ max: 2, windowMs: 60_000 });
    await hit(app); await hit(app);
    expect((await hit(app)).status).toBe(429);
    advance(59_999);
    expect((await hit(app)).status).toBe(429);
    advance(1);
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(429);
  });

  it("counts each address separately when it is told to trust one proxy", async () => {
    const { app } = limitedApp({ max: 1, trustProxy: 1 });
    expect((await hit(app, "203.0.113.1")).status).toBe(200);
    expect((await hit(app, "203.0.113.1")).status).toBe(429);
    expect((await hit(app, "203.0.113.2")).status).toBe(200); // someone else is unaffected
  });

  it("does NOT believe X-Forwarded-For when no proxy is trusted: varying it buys no extra requests", async () => {
    const { app } = limitedApp({ max: 2, trustProxy: 0 });
    expect((await hit(app, "203.0.113.1")).status).toBe(200);
    expect((await hit(app, "203.0.113.2")).status).toBe(200);
    expect((await hit(app, "203.0.113.3")).status).toBe(429);
  });

  it("with one trusted proxy, uses the address that proxy saw — not one the visitor invented in front of it", async () => {
    const { app } = limitedApp({ max: 1, trustProxy: 1 });
    // A visitor sends their own "X-Forwarded-For: 1.1.1.1"; the proxy appends the real address after it.
    expect((await hit(app, "1.1.1.1, 198.51.100.7")).status).toBe(200);
    expect((await hit(app, "2.2.2.2, 198.51.100.7")).status).toBe(429); // same real visitor, different forgery
  });

  it("never remembers more than maxClients addresses: expired entries are dropped first, then the oldest", async () => {
    const { app, advance } = limitedApp({ max: 1, windowMs: 60_000, maxClients: 3, trustProxy: 1 });
    await hit(app, "10.0.0.1"); advance(1_000);
    await hit(app, "10.0.0.2"); advance(1_000);
    await hit(app, "10.0.0.3"); // table full, all three still counting
    expect((await hit(app, "10.0.0.2")).status).toBe(429);
    expect((await hit(app, "10.0.0.3")).status).toBe(429);

    // a fourth address arrives: the OLDEST (10.0.0.1) is forgotten to make room...
    expect((await hit(app, "10.0.0.4")).status).toBe(200);
    expect((await hit(app, "10.0.0.2")).status).toBe(429); // ...the others are still limited
    expect((await hit(app, "10.0.0.3")).status).toBe(429);
    expect((await hit(app, "10.0.0.1")).status).toBe(200); // forgotten, so counted afresh (the cost of a bounded table)
  });

  it("prefers dropping entries whose window has already ended over live ones", async () => {
    const { app, advance } = limitedApp({ max: 1, windowMs: 60_000, maxClients: 2, trustProxy: 1 });
    await hit(app, "10.0.0.1"); // window ends at +60s
    advance(50_000);
    await hit(app, "10.0.0.2"); // window ends at +110s
    advance(15_000); // 10.0.0.1 has expired, 10.0.0.2 has not
    expect((await hit(app, "10.0.0.3")).status).toBe(200);
    expect((await hit(app, "10.0.0.2")).status).toBe(429); // the live entry was kept
  });
});

describe("warnIfProxyUnconfigured", () => {
  function appWith(trustProxy: number) {
    const warn = vi.fn();
    const app = express();
    app.set("trust proxy", trustProxy);
    app.use(warnIfProxyUnconfigured({ warn }));
    app.get("/x", (_req, res) => { res.json({ ok: true }); });
    return { app, warn };
  }

  it("says so, once, when a proxy header arrives but no proxy is trusted — and still serves the request", async () => {
    const { app, warn } = appWith(0);
    const res = await request(app).get("/x").set("X-Forwarded-For", "203.0.113.9");
    expect(res.status).toBe(200);
    await request(app).get("/x").set("X-Forwarded-For", "203.0.113.10");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/TRUST_PROXY/);
    expect(warn.mock.calls[0][0]).not.toContain("203.0.113"); // no visitor addresses in the log
  });

  it("stays quiet when no proxy header is present, or when a proxy is configured", async () => {
    const a = appWith(0); await request(a.app).get("/x");
    expect(a.warn).not.toHaveBeenCalled();
    const b = appWith(1); await request(b.app).get("/x").set("X-Forwarded-For", "203.0.113.9");
    expect(b.warn).not.toHaveBeenCalled();
  });
});
