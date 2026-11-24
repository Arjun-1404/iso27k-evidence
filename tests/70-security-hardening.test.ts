import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { JwtTokenVerifier, signSessionToken } from "../src/auth/jwt.ts";
import { checkPasswordStrength, hashPassword, MAX_PASSWORD_BYTES } from "../src/auth/password.ts";
import { PhantomLockout, LOCK_AFTER_FAILURES, LOCK_FOR_MS } from "../src/auth/phantomLockout.ts";
import { loadConfig } from "../src/config.ts";
import { assertUsableJwtSecret, isPlaceholder } from "../src/secretsCheck.ts";

/**
 * What a security review found, pinned so it stays fixed: headers on every answer, 4xx (not 500) for a bad request,
 * only HS256 sessions, a password policy that refuses the obvious, sign-in that doesn't reveal which addresses have
 * accounts, and a portal that won't start on the example secrets from .env.example.
 */

afterAll(async () => { await adminPool.end(); await appPool.end(); });
const root = (p: string) => resolve(__dirname, "..", p);
const SECRET = "hardening-test-secret-value-long-enough-0123";

function makeApp(extra: Record<string, unknown> = {}) {
  const verifier = new FakeTokenVerifier();
  const email = new FakeEmailSender();
  const app = createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email,
    tokenVerifier: verifier, jwtSecret: SECRET, appBaseUrl: "https://portal.example",
    authLimits: { windowMs: 60_000, signIn: 10_000, passwordReset: 10_000 },
    ...extra,
  });
  return { app, verifier, email };
}

describe("API response headers", () => {
  const { app } = makeApp();
  const must = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  };

  it("every answer carries them — a normal one, a refusal and a not-found alike — and never announces the framework", async () => {
    for (const res of [
      await request(app).post("/auth/login").send({ email: "nobody@nowhere.test", password: "whatever-it-is-here" }),
      await request(app).get("/audits"),
      await request(app).get("/no/such/route"),
      await request(app).options("/audits").set("Origin", "https://evil.example"),
    ]) {
      for (const [k, v] of Object.entries(must)) expect(res.headers[k], `${res.status} ${k}`).toBe(v);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["permissions-policy"]).toContain("camera=()");
    }
  });

  it("asks browsers to insist on HTTPS only when the request came in over it", async () => {
    const plain = await request(app).get("/audits");
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
    const behindProxy = makeApp({ trustProxy: 1 }).app;
    const secure = await request(behindProxy).get("/audits").set("X-Forwarded-Proto", "https");
    expect(secure.headers["strict-transport-security"]).toMatch(/max-age=\d+; includeSubDomains/);
  });
});

describe("a bad request is the caller's mistake, never a 500", () => {
  let w: World; let ctx: ReturnType<typeof makeApp>;
  beforeAll(async () => { w = await makeWorld(); ctx = makeApp(); });

  it("malformed JSON → 400, without echoing what was sent", async () => {
    const res = await request(ctx.app).post("/auth/login").set("Content-Type", "application/json").send("{ \"email\": \"SECRET-MARKER-123\", oops");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "BAD_REQUEST", message: "The request body is not valid JSON." });
    expect(JSON.stringify(res.body)).not.toContain("SECRET-MARKER-123");
  });

  it("a body over the size limit → 413", async () => {
    const res = await request(ctx.app).post("/auth/login").set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "a@b.co", password: "x".repeat(300_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("something that isn't an id where an id belongs → 400 INVALID_ID, on a read path as well", async () => {
    const auth = { Authorization: `Bearer ${ctx.verifier.issue(w.admin)}` };
    for (const path of ["/audits/abc/controls", "/audits/1'%20OR%20'1'='1/controls"]) {
      const res = await request(ctx.app).get(path).set(auth);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code, path).toBe("INVALID_ID");
    }
  });
});

describe("session tokens", () => {
  const verifier = new JwtTokenVerifier(SECRET);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

  it("accepts its own HS256 token", async () => {
    expect(await verifier.verify(signSessionToken("11111111-1111-1111-1111-111111111111", SECRET))).toEqual({ userId: "11111111-1111-1111-1111-111111111111" });
  });

  it("refuses alg=none, a different algorithm signed with the same secret, a wrong issuer and a tampered payload", async () => {
    const claims = { sub: "11111111-1111-1111-1111-111111111111", iss: "evidence-portal", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
    expect(await verifier.verify(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`)).toBeNull();
    expect(await verifier.verify(jwt.sign(claims, SECRET, { algorithm: "HS512" }))).toBeNull();
    expect(await verifier.verify(jwt.sign({ ...claims, iss: "someone-else" }, SECRET, { algorithm: "HS256" }))).toBeNull();
    const good = signSessionToken("11111111-1111-1111-1111-111111111111", SECRET);
    const [h, , s] = good.split(".");
    expect(await verifier.verify(`${h}.${b64({ ...claims, sub: "22222222-2222-2222-2222-222222222222" })}.${s}`)).toBeNull();
  });
});

describe("password policy", () => {
  it("refuses what an attacker tries first, however it is dressed up", () => {
    for (const bad of ["password1234", "Password1234!", "P@ssw0rd2024", "letmein12345", "qwertyuiop12", "welcome12345", "Admin1234567",
      "123456789012", "abcdefghijklmn", "qwertyuiopasdf", "aaaaaaaaaaaa", "abababababab", "123123123123", "iloveyou!!!!!!"]) {
      expect(checkPasswordStrength(bad).ok, bad).toBe(false);
    }
  });

  it("still accepts long, ordinary passphrases and random strings", () => {
    for (const good of ["a-genuinely-long-password-999", "Correct-Horse-Battery-77", "xK9$mQ2#vL7!pR4", "my dog eats purple socks on tuesdays", "welcomehome-to-the-jungle"]) {
      expect(checkPasswordStrength(good), good).toEqual({ ok: true });
    }
  });

  it("says plainly when a password is longer than can be used (bcrypt reads only 72 bytes)", () => {
    expect(checkPasswordStrength("a1b2c3d4e5f6".repeat(6)).ok).toBe(true);                         // 72 characters
    const tooLong = checkPasswordStrength("a1b2c3d4e5f6".repeat(6) + "x");                           // 73
    expect(tooLong.ok).toBe(false); expect(tooLong.reason).toContain(String(MAX_PASSWORD_BYTES));
    expect(checkPasswordStrength("é".repeat(40) + "xyz123").ok).toBe(false);                         // 2 bytes each: counted in bytes
  });
});

describe("sign-in doesn't reveal which addresses have accounts", () => {
  let w: World; let app: ReturnType<typeof makeApp>["app"]; let email: FakeEmailSender;
  beforeAll(async () => { w = await makeWorld(); ({ app, email } = makeApp()); });
  const login = (e: string, p: string) => request(app).post("/auth/login").send({ email: e, password: p });

  it("an address with no account is locked after the same number of wrong passwords, with the same message, as a real one", async () => {
    const real = (await adminPool.query("SELECT email FROM users WHERE id = $1", [w.admin])).rows[0].email as string;
    await adminPool.query("UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1", [w.admin, await hashPassword("a-genuinely-long-password-999")]);
    const ghost = `ghost-${w.tag}@nowhere.test`;
    const seenReal: Array<[number, string]> = []; const seenGhost: Array<[number, string]> = [];
    for (let i = 0; i < LOCK_AFTER_FAILURES + 2; i++) {
      const a = await login(real, "not-the-password-here"); seenReal.push([a.status, a.body.error.code]);
      const b = await login(ghost, "not-the-password-here"); seenGhost.push([b.status, b.body.error.code]);
    }
    expect(seenGhost).toEqual(seenReal);
    expect(seenReal.slice(0, LOCK_AFTER_FAILURES).every(([s]) => s === 401)).toBe(true);
    expect(seenReal.slice(LOCK_AFTER_FAILURES).every(([s, c]) => s === 423 && c === "ACCOUNT_LOCKED")).toBe(true);
    void email;
  });

  it("an address with no account takes about as long as a real password check (bcrypt cost 12), not a couple of milliseconds", async () => {
    const t0 = performance.now();
    const res = await login(`timing-${w.tag}@nowhere.test`, "not-the-password-here");
    const ms = performance.now() - t0;
    expect(res.status).toBe(401);
    expect(ms).toBeGreaterThan(80);
  });
});

describe("the lock for addresses that have no account", () => {
  it("locks after the limit, for as long as a real lock, then starts over — and forgets the oldest address when full", () => {
    let now = 1_000_000;
    const p = new PhantomLockout(() => now);
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) p.recordFailure("Someone@Example.test");
    expect(p.isLocked("someone@example.test")).toBe(false);                 // capitals don't matter
    p.recordFailure("someone@example.test");
    expect(p.isLocked("SOMEONE@example.test")).toBe(true);
    expect(p.isLocked("other@example.test")).toBe(false);
    now += LOCK_FOR_MS - 1; expect(p.isLocked("someone@example.test")).toBe(true);
    now += 2; expect(p.isLocked("someone@example.test")).toBe(false);
    p.recordFailure("someone@example.test"); expect(p.isLocked("someone@example.test")).toBe(false);   // a finished lock starts counting from zero
  });

  it("remembers a bounded number of addresses, so a flood of made-up ones can't use up memory", () => {
    const p = new PhantomLockout();
    for (let i = 0; i < 10_050; i++) p.recordFailure(`flood-${i}@example.test`);
    expect((p as unknown as { seen: Map<string, unknown> }).seen.size).toBeLessThanOrEqual(10_000);
  });
});

describe("the portal won't start on example or weak secrets", () => {
  const SAVED = { ...process.env };
  const MANAGED = ["DATABASE_URL", "JWT_SECRET"];
  afterEach(() => { for (const k of MANAGED) delete process.env[k]; Object.assign(process.env, SAVED); });
  const env = (v: Record<string, string>) => { for (const k of MANAGED) delete process.env[k]; Object.assign(process.env, v); };

  it("refuses the JWT_SECRET from .env.example, a short one and a repetitive one — and accepts a generated one", () => {
    const example = readFileSync(root(".env.example"), "utf8").match(/^JWT_SECRET=(.*)$/m)![1];
    expect(isPlaceholder(example)).toBe(true);
    for (const bad of [example, "change-me", "short", "a".repeat(40), "x".repeat(64), "your-secret-here-your-secret-here-1"]) {
      expect(() => assertUsableJwtSecret(bad), bad).toThrow(/JWT_SECRET/);
    }
    expect(() => assertUsableJwtSecret("abcdefghij1234567890")).toThrow(/too short/);       // varied, but only 20 characters
    expect(() => assertUsableJwtSecret("0f3c9a7e51d84b26a9e07c15bd3f48a2e6d91b70c4a58f3e5b7c")).not.toThrow();
  });

  it("loadConfig stops, naming the setting and the fix, when .env.example was copied and not edited", () => {
    const text = readFileSync(root(".env.example"), "utf8");
    const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, "m"))![1];
    env({ DATABASE_URL: `postgres://portal_app:${get("APP_DB_PASSWORD")}@db:5432/evidenceportal`, JWT_SECRET: "0f3c9a7e51d84b26a9e07c15bd3f48a2e6d91b70c4a58f3e5b7c" });
    expect(() => loadConfig()).toThrow(/password in DATABASE_URL is still the example text.*npm run setup/s);
    env({ DATABASE_URL: "postgres://portal_app:Zk3h9fQ2xLm7@db:5432/evidenceportal", JWT_SECRET: get("JWT_SECRET") });
    expect(() => loadConfig()).toThrow(/JWT_SECRET is still the example text/);
    env({ DATABASE_URL: "postgres://portal_app:Zk3h9fQ2xLm7@db:5432/evidenceportal", JWT_SECRET: "0f3c9a7e51d84b26a9e07c15bd3f48a2e6d91b70c4a58f3e5b7c" });
    expect(loadConfig().jwtSecret).toHaveLength(52);
  });

  it("the migration command refuses the example database passwords before it connects to anything", () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [root("node_modules/tsx/dist/cli.mjs"), root("src/db/migrate-cli.ts")], {
      cwd: root("."), env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 60_000,
    });
    const a = run({ DATABASE_URL: "postgres://postgres:change-me@127.0.0.1:1/x" });
    expect(a.status).toBe(1); expect(a.stderr).toMatch(/POSTGRES_PASSWORD.*still the example text/s);
    const b = run({ DATABASE_URL: "postgres://postgres:Zk3h9fQ2xLm7@127.0.0.1:1/x", APP_DB_PASSWORD: "change-me-too" });
    expect(b.status).toBe(1); expect(b.stderr).toMatch(/APP_DB_PASSWORD is still the example text/);
  });
});

describe("the web app's own server", () => {
  const nginx = readFileSync(root("frontend/nginx/security-headers.conf"), "utf8");
  const header = (name: string) => nginx.match(new RegExp(`add_header ${name} "(.*)" always;`))?.[1];

  it("the no-Docker server and the nginx image send the identical headers", async () => {
    const { SECURITY_HEADERS } = (await import(pathToFileURL(root("scripts/serve-web.mjs")).href)) as { SECURITY_HEADERS: Record<string, string> };
    expect(Object.keys(SECURITY_HEADERS).length).toBeGreaterThanOrEqual(6);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(header(name), name).toBe(value);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toMatch(/script-src 'self'(;|$)/);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  });

  it("nginx includes them in every location (it forgets inherited headers once a location sets its own), hides its version, and both images ship the files", () => {
    const conf = readFileSync(root("frontend/nginx/default.conf"), "utf8");
    expect(conf).toMatch(/server_tokens off;/);
    const locations = conf.split(/\n\s*location /).slice(1);
    expect(locations).toHaveLength(2);
    for (const l of locations) expect(l).toContain("include /etc/nginx/snippets/security-headers.conf;");
    for (const f of ["frontend/Dockerfile", "frontend/Dockerfile.prebuilt"]) {
      const d = readFileSync(root(f), "utf8");
      expect(d, f).toContain("COPY nginx/default.conf /etc/nginx/conf.d/default.conf");
      expect(d, f).toContain("COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf");
    }
  });

  it("the build context never carries a .env file or a key into an image", () => {
    for (const f of [".dockerignore", "frontend/.dockerignore"]) {
      const t = readFileSync(root(f), "utf8").split("\n").map((l) => l.trim());
      expect(t, f).toContain(".env"); expect(t, f).toContain(".env.*");
    }
  });
});

describe("how to report a vulnerability", () => {
  it("SECURITY.md points to private reporting on GitHub and carries no personal email address", () => {
    expect(existsSync(root("SECURITY.md"))).toBe(true);
    const t = readFileSync(root("SECURITY.md"), "utf8");
    expect(t).toMatch(/private/i);
    expect(t).toContain("github.com/Arjun-1404/iso27k-evidence/security/advisories/new");
    expect(t).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  });
});
