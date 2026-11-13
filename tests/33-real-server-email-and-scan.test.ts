import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import type { Server } from "node:http";
import { SMTPServer } from "smtp-server";
import { adminPool, appPool, makeWorld, PORT, type World } from "./helpers.ts";
import { startServer } from "../src/server.ts";
import jwt from "jsonwebtoken";
import { signSessionToken } from "../src/auth/jwt.ts";
import { FakeClamd } from "../src/scan/fakeClamd.ts";

/**
 * The real entry point (src/server.ts), started the way a deployment starts it — from environment
 * variables alone — with a real SMTP server and a (protocol-accurate) clamd on the other end. This is the
 * test that the pieces are actually *connected*: that config.ts reads the settings, wiring.ts builds the
 * right implementations, and an invite sent over HTTP arrives as a real email whose link really signs the
 * recipient up.
 */

const SECRET = "real-server-test-secret-value-long-enough";
const sent: Array<{ to: string[]; raw: string }> = [];

let smtp: SMTPServer; let clamd: FakeClamd; let server: Server; let base: string; let w: World;
const logs: string[] = [];

beforeAll(async () => {
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("end", () => { sent.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString("utf8") }); cb(); });
    },
  });
  smtp.on("error", () => undefined);
  await new Promise<void>((res) => smtp.listen(0, "127.0.0.1", res));
  clamd = await FakeClamd.start();
  w = await makeWorld();

  Object.assign(process.env, {
    DATABASE_URL: `postgres://portal_app@127.0.0.1:${PORT}/portal_test`,
    JWT_SECRET: SECRET,
    APP_BASE_URL: "https://portal.test",
    PORT: "0",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.server.address() as net.AddressInfo).port), SMTP_SECURITY: "none",
    EMAIL_FROM: "Evidence Portal <noreply@portal.test>",
    CLAMD_HOST: "127.0.0.1", CLAMD_PORT: String(clamd.port),
    TRUST_PROXY: "1",
  });
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });

  server = startServer();
  await new Promise<void>((res) => server.once("listening", res));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  await new Promise((r) => setTimeout(r, 300)); // let the background startup checks report
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => smtp.close(() => res()));
  await clamd.close();
  for (const k of ["DATABASE_URL", "JWT_SECRET", "APP_BASE_URL", "PORT", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "EMAIL_FROM", "CLAMD_HOST", "CLAMD_PORT", "TRUST_PROXY"]) delete process.env[k];
  await adminPool.end(); await appPool.end();
});

const decodeQp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

describe("the real server, configured only through environment variables", () => {
  it("reports at startup that both the mail server and ClamAV were reached", () => {
    const text = logs.join("\n");
    expect(text).toMatch(/mail server 127\.0\.0\.1:\d+ is reachable/);
    expect(text).toMatch(/ClamAV at 127\.0\.0\.1:\d+ is reachable/);
    expect(text).not.toMatch(/NOT sent|NOT scanned/); // neither fallback was chosen
  });

  it("an invite sent over HTTP arrives as a real email, and its link signs the person up and in", async () => {
    const to = `real-e2e@audit-a-${w.tag}.test`;
    const adminToken = signSessionToken(w.admin, SECRET);

    const invite = await fetch(`${base}/users`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: to, role: "auditor" }),
    });
    expect(invite.status).toBe(201);
    expect((await invite.json()).emailSent).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([to]);
    const body = decodeQp(sent[0].raw);
    expect(body).toContain("https://portal.test/accept-invite?token=");
    expect(sent[0].raw).toMatch(/From: .*noreply@portal\.test/i);
    const token = body.match(/token=([0-9a-f]+)/)![1];

    const accepted = await fetch(`${base}/auth/accept-invite`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "a-genuinely-long-password-999" }),
    });
    expect(accepted.status).toBe(200);

    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: to, password: "a-genuinely-long-password-999" }),
    });
    expect(login.status).toBe(200);
    expect((await login.json()).role).toBe("auditor");
  });

  it("a forgotten password: the reset email arrives over SMTP, its link sets a new password, and sessions from before are refused", async () => {
    const address = `real-e2e@audit-a-${w.tag}.test`; // signed up in the test above
    const userId = (await adminPool.query("SELECT id FROM users WHERE email = $1", [address])).rows[0].id as string;
    const oldSession = jwt.sign({ sub: userId, iat: Math.floor(Date.now() / 1000) - 60 }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });
    const get = (token: string) => fetch(`${base}/audits/${w.auditA1}/controls`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get(oldSession)).status).not.toBe(401); // the real server accepts it (whatever the route says about the id)

    const before = sent.length;
    const asked = await fetch(`${base}/auth/forgot-password`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: address }),
    });
    expect(asked.status).toBe(202);
    await vi.waitFor(() => expect(sent.length).toBe(before + 1)); // sent in the background, so wait for it to arrive
    expect(sent.at(-1)!.to).toEqual([address]);
    const body = decodeQp(sent.at(-1)!.raw);
    expect(body).toContain("https://portal.test/reset-password?token=");
    const token = body.match(/reset-password\?token=([0-9a-f]+)/)![1];

    const done = await fetch(`${base}/auth/reset-password`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: "a-second-genuinely-long-password-1" }),
    });
    expect(done.status).toBe(200);

    expect((await get(oldSession)).status).toBe(401); // the real server (not just a test double) now refuses the old session
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: address, password: "a-second-genuinely-long-password-1" }),
    });
    expect(login.status).toBe(200);
    expect((await get((await login.json()).token)).status).not.toBe(401);
  });

  it("TRUST_PROXY reaches the app: with one trusted proxy, visitors are told apart by X-Forwarded-For", async () => {
    // The default allowance is 10 reset requests per address; 12 from different forwarded addresses must all pass.
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/auth/reset-password`, {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i + 1}` },
        body: JSON.stringify({ token: "f".repeat(64), password: "a-genuinely-long-password-999" }),
      });
      expect(res.status).toBe(400); // an invalid link — but never 429
    }
  });

  it("the mail server going away turns the next invite into 'saved, but not emailed' — not an error", async () => {
    await new Promise<void>((res) => smtp.close(() => res()));
    const to = `real-e2e-2@audit-a-${w.tag}.test`;
    const res = await fetch(`${base}/users`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signSessionToken(w.admin, SECRET)}` },
      body: JSON.stringify({ email: to, role: "auditor" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).emailSent).toBe(false);
    const row = await adminPool.query("SELECT status FROM users WHERE email = $1", [to]);
    expect(row.rows[0].status).toBe("invited");
    // restart so afterAll's close() has something to close
    smtp = new SMTPServer({ authOptional: true });
    smtp.on("error", () => undefined);
    await new Promise<void>((res) => smtp.listen(0, "127.0.0.1", res));
  });
});
