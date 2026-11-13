import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { corsMiddleware, normalizeOrigin } from "../src/http/middleware/cors.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { appPool, adminPool } from "./helpers.ts";
import { afterAll } from "vitest";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const ALLOWED = "https://portal.example";

/** A tiny app so middleware behaviour is tested in isolation from auth, routing and the database. */
function tinyApp(origins: string[]) {
  const app = express();
  app.use(corsMiddleware(origins));
  app.get("/ping", (_req, res) => { res.json({ ok: true }); });
  app.options("/ping", (_req, res) => { res.status(200).json({ reached: "router" }); });
  return app;
}

describe("normalizeOrigin", () => {
  it("reduces a URL to the exact form browsers send", () => {
    expect(normalizeOrigin("https://portal.example/")).toBe("https://portal.example");
    expect(normalizeOrigin("  https://portal.example/some/path?x=1  ")).toBe("https://portal.example");
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeOrigin("https://portal.example:443")).toBe("https://portal.example"); // default port dropped
  });
  it("rejects anything that isn't a plain http(s) origin", () => {
    for (const bad of ["", "   ", "portal.example", "javascript:alert(1)", "ftp://portal.example", "null", "*"]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });
});

describe("corsMiddleware — actual requests", () => {
  it("echoes an allowed origin and marks the response as varying by Origin", async () => {
    const res = await request(tinyApp([ALLOWED])).get("/ping").set("Origin", ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers.vary).toMatch(/Origin/i);
  });

  it("gives an origin that isn't on the list no CORS headers (the browser then blocks the page)", async () => {
    const res = await request(tinyApp([ALLOWED])).get("/ping").set("Origin", "https://evil.example");
    expect(res.status).toBe(200); // the request itself isn't rejected — CORS only governs what the page may read
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers.vary).toMatch(/Origin/i); // still varies, so a cache can't replay another origin's headers
  });

  it("matches origins exactly — lookalikes, other schemes and other ports don't pass", async () => {
    const app = tinyApp([ALLOWED]);
    for (const o of ["https://portal.example.evil.com", "http://portal.example", "https://portal.example:8443", "https://sub.portal.example", "null"]) {
      const res = await request(app).get("/ping").set("Origin", o);
      expect(res.headers["access-control-allow-origin"], o).toBeUndefined();
    }
  });

  it("leaves requests with no Origin header (curl, server-to-server) completely untouched", async () => {
    const res = await request(tinyApp([ALLOWED])).get("/ping");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never enables credentialed (cookie) mode and never answers with a wildcard", async () => {
    const res = await request(tinyApp([ALLOWED])).get("/ping").set("Origin", ALLOWED);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("an empty allow-list means nobody gets cross-origin access", async () => {
    const res = await request(tinyApp([])).get("/ping").set("Origin", ALLOWED);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("ignores malformed entries in the list rather than treating them as wildcards", async () => {
    const app = tinyApp(["*", "", "not a url", ALLOWED + "/"]);
    const star = await request(app).get("/ping").set("Origin", "https://anything.example");
    expect(star.headers["access-control-allow-origin"]).toBeUndefined();
    const ok = await request(app).get("/ping").set("Origin", ALLOWED);
    expect(ok.headers["access-control-allow-origin"]).toBe(ALLOWED); // trailing slash tolerated
  });
});

describe("corsMiddleware — preflight", () => {
  const preflight = (app: express.Express, origin: string) =>
    request(app).options("/ping").set("Origin", origin)
      .set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "authorization,content-type");

  it("answers an allowed origin's preflight with 204 and the permitted methods, headers and max-age", async () => {
    const res = await preflight(tinyApp([ALLOWED]), ALLOWED);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(res.headers["access-control-allow-headers"]).toMatch(/Authorization/i);
    expect(res.headers["access-control-allow-headers"]).toMatch(/Content-Type/i);
    expect(Number(res.headers["access-control-max-age"])).toBeGreaterThan(0);
  });

  it("refuses a disallowed origin's preflight outright, with no CORS headers", async () => {
    const res = await preflight(tinyApp([ALLOWED]), "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CORS_ORIGIN_NOT_ALLOWED");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("does not hijack an ordinary OPTIONS request that isn't a CORS preflight", async () => {
    const res = await request(tinyApp([ALLOWED])).options("/ping").set("Origin", ALLOWED); // no Access-Control-Request-Method
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe("router");
  });
});

describe("through the real app", () => {
  const auth = new FakeTokenVerifier();
  const make = (corsAllowedOrigins?: string[]) => createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(),
    tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: ALLOWED, corsAllowedOrigins,
  });

  it("answers a browser preflight to a protected route WITHOUT a bearer token (preflights never carry one)", async () => {
    const res = await request(make([ALLOWED])).options("/controls/00000000-0000-0000-0000-000000000000/upload-session")
      .set("Origin", ALLOWED).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("attaches the allow-origin header to error responses too, so the page can read a 401", async () => {
    const res = await request(make([ALLOWED])).get("/audit-log").set("Origin", ALLOWED);
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("attaches it to the public login route as well", async () => {
    const res = await request(make([ALLOWED])).post("/auth/login").set("Origin", ALLOWED).send({ email: "nobody@example.com", password: "x".repeat(12) });
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("is off by default — an app built without corsAllowedOrigins allows no cross-origin callers", async () => {
    const res = await request(make()).get("/audit-log").set("Origin", ALLOWED);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("loadConfig — CORS_ALLOWED_ORIGINS", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  const base = () => { process.env.DATABASE_URL = "postgres://x"; process.env.JWT_SECRET = "s".repeat(32); delete process.env.CORS_ALLOWED_ORIGINS; };

  it("defaults to the frontend's own origin (from APP_BASE_URL)", () => {
    base(); process.env.APP_BASE_URL = "https://portal.example/";
    expect(loadConfig().corsAllowedOrigins).toEqual(["https://portal.example"]);
  });

  it("defaults to the local dev frontend when nothing is configured", () => {
    base(); delete process.env.APP_BASE_URL;
    expect(loadConfig().corsAllowedOrigins).toEqual(["http://localhost:5173"]);
  });

  it("accepts an explicit comma-separated list and normalises each entry", () => {
    base(); process.env.CORS_ALLOWED_ORIGINS = " https://a.example/ , http://localhost:3001 ";
    expect(loadConfig().corsAllowedOrigins).toEqual(["https://a.example", "http://localhost:3001"]);
  });

  it("an explicitly EMPTY value disables cross-origin access (distinct from 'not set')", () => {
    base(); process.env.CORS_ALLOWED_ORIGINS = "";
    expect(loadConfig().corsAllowedOrigins).toEqual([]);
  });

  it("refuses to start on a bad entry instead of silently leaving the frontend blocked", () => {
    base(); process.env.CORS_ALLOWED_ORIGINS = "https://ok.example,portal.example";
    expect(() => loadConfig()).toThrow(/invalid origin: "portal.example"/);
    process.env.CORS_ALLOWED_ORIGINS = "*";
    expect(() => loadConfig()).toThrow(/invalid origin/);
  });
});
