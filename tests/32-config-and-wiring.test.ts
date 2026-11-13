import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import net from "node:net";
import { SMTPServer } from "smtp-server";
import { loadConfig } from "../src/config.ts";
import { buildEmailSender, buildScanner, type StartupLog } from "../src/wiring.ts";
import { SmtpEmailSender } from "../src/email/smtp.ts";
import { ConsoleEmailSender } from "../src/email/console.ts";
import { ClamAvScanner } from "../src/scan/clamav.ts";
import { FakeClamd } from "../src/scan/fakeClamd.ts";
import { NoScanner } from "../src/scan/types.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import * as evidence from "../src/services/evidence.ts";
import { adminPool, appPool, makeWorld, controlId, assignContributor } from "./helpers.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const SAVED = { ...process.env };
const MANAGED = ["DATABASE_URL", "JWT_SECRET", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM",
  "CLAMD_HOST", "CLAMD_PORT", "CLAMD_TIMEOUT_SECONDS", "CLAMD_MAX_FILE_MB", "TRUST_PROXY"];
function env(vars: Record<string, string> = {}) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, { DATABASE_URL: "postgres://x@localhost/x", JWT_SECRET: "j" }, vars);
}
afterEach(() => { for (const k of MANAGED) delete process.env[k]; Object.assign(process.env, SAVED); });

const GOOD_SMTP = { SMTP_HOST: "smtp.example.com", EMAIL_FROM: "Evidence Portal <noreply@firm.example>" };

describe("config: reverse proxies (TRUST_PROXY)", () => {
  it("defaults to 0 — no proxy is trusted — and treats the empty value docker compose passes the same way", () => {
    env(); expect(loadConfig().trustProxy).toBe(0);
    env({ TRUST_PROXY: "" }); expect(loadConfig().trustProxy).toBe(0);
  });

  it("reads a proxy count", () => {
    env({ TRUST_PROXY: "1" }); expect(loadConfig().trustProxy).toBe(1);
    env({ TRUST_PROXY: "2" }); expect(loadConfig().trustProxy).toBe(2);
  });

  it("refuses 'true' and anything else that is not a small count — trusting every forwarded address would let a visitor choose their own", () => {
    for (const bad of ["true", "yes", "-1", "1.5", "11", "loopback", "10.0.0.0/8"]) {
      env({ TRUST_PROXY: bad });
      expect(() => loadConfig(), bad).toThrow(/TRUST_PROXY must be a whole number between 0 and 10/);
    }
  });
});

describe("config: email (SMTP)", () => {
  it("is off unless SMTP_HOST is set", () => {
    env();
    expect(loadConfig().smtp).toBeUndefined();
  });

  it("picks STARTTLS on port 587 by default", () => {
    env(GOOD_SMTP);
    expect(loadConfig().smtp).toEqual({ host: "smtp.example.com", port: 587, security: "starttls", user: undefined, password: undefined, from: "Evidence Portal <noreply@firm.example>" });
  });

  it("chooses the usual port for each kind of connection security, unless told otherwise", () => {
    env({ ...GOOD_SMTP, SMTP_SECURITY: "tls" });
    expect(loadConfig().smtp?.port).toBe(465);
    env({ ...GOOD_SMTP, SMTP_SECURITY: "none" });
    expect(loadConfig().smtp?.port).toBe(25);
    env({ ...GOOD_SMTP, SMTP_SECURITY: "TLS", SMTP_PORT: "2465" });
    expect(loadConfig().smtp).toMatchObject({ security: "tls", port: 2465 });
  });

  it("reads a login when both halves are given", () => {
    env({ ...GOOD_SMTP, SMTP_USER: "apikey", SMTP_PASSWORD: "s3cret" });
    expect(loadConfig().smtp).toMatchObject({ user: "apikey", password: "s3cret" });
  });

  const bad: Array<[string, Record<string, string>, RegExp]> = [
    ["a login with only a user", { ...GOOD_SMTP, SMTP_USER: "u" }, /both SMTP_USER and SMTP_PASSWORD/],
    ["a login with only a password", { ...GOOD_SMTP, SMTP_PASSWORD: "p" }, /both SMTP_USER and SMTP_PASSWORD/],
    ["a password over an unencrypted connection", { ...GOOD_SMTP, SMTP_SECURITY: "none", SMTP_USER: "u", SMTP_PASSWORD: "p" }, /unencrypted/],
    ["no sender address", { SMTP_HOST: "smtp.example.com" }, /EMAIL_FROM is required/],
    ["a sender address with a line break", { SMTP_HOST: "h", EMAIL_FROM: "a@b.test\nBcc: x@y.test" }, /EMAIL_FROM must be a single/],
    ["a sender with no @", { SMTP_HOST: "h", EMAIL_FROM: "noreply" }, /EMAIL_FROM must be a single/],
    ["an unknown security mode", { ...GOOD_SMTP, SMTP_SECURITY: "ssl3" }, /starttls, tls or none/],
    ["a port that isn't a number", { ...GOOD_SMTP, SMTP_PORT: "abc" }, /SMTP_PORT must be a whole number/],
    ["port zero", { ...GOOD_SMTP, SMTP_PORT: "0" }, /SMTP_PORT/],
    ["a port above 65535", { ...GOOD_SMTP, SMTP_PORT: "70000" }, /SMTP_PORT/],
    ["a fractional port", { ...GOOD_SMTP, SMTP_PORT: "587.5" }, /SMTP_PORT/],
    ["a negative port", { ...GOOD_SMTP, SMTP_PORT: "-1" }, /SMTP_PORT/],
    ["other SMTP settings with no host (likely a typo'd name)", { SMTP_HOSTNAME: "x", SMTP_PORT: "587", EMAIL_FROM: "a@b.test" }, /SMTP_PORT, EMAIL_FROM is set but SMTP_HOST is not/],
  ];
  for (const [name, vars, msg] of bad) {
    it(`stops the server at startup on ${name}`, () => {
      env(vars);
      expect(() => loadConfig()).toThrow(msg);
    });
  }

  it("treats empty values (what docker compose passes for unset ones) as not set", () => {
    env({ SMTP_HOST: "", SMTP_PORT: "", SMTP_SECURITY: "", SMTP_USER: "", SMTP_PASSWORD: "", EMAIL_FROM: "" });
    expect(loadConfig().smtp).toBeUndefined();
  });
});

describe("config: malware scanning (ClamAV)", () => {
  it("is off unless CLAMD_HOST is set", () => {
    env();
    expect(loadConfig().clamav).toBeUndefined();
  });

  it("uses clamd's standard port and sensible limits by default", () => {
    env({ CLAMD_HOST: "clamav" });
    expect(loadConfig().clamav).toEqual({ host: "clamav", port: 3310, timeoutMs: 60_000, maxBytes: 25 * 1024 * 1024 });
  });

  it("takes custom values", () => {
    env({ CLAMD_HOST: "10.0.0.5", CLAMD_PORT: "3311", CLAMD_TIMEOUT_SECONDS: "120", CLAMD_MAX_FILE_MB: "100" });
    expect(loadConfig().clamav).toEqual({ host: "10.0.0.5", port: 3311, timeoutMs: 120_000, maxBytes: 100 * 1024 * 1024 });
  });

  const bad: Array<[string, Record<string, string>, RegExp]> = [
    ["a port with no host", { CLAMD_PORT: "3310" }, /CLAMD_PORT is set but CLAMD_HOST is not/],
    ["a limit with no host", { CLAMD_MAX_FILE_MB: "25" }, /CLAMD_MAX_FILE_MB is set but CLAMD_HOST is not/],
    ["a bad port", { CLAMD_HOST: "c", CLAMD_PORT: "http" }, /CLAMD_PORT must be a whole number/],
    ["a zero timeout", { CLAMD_HOST: "c", CLAMD_TIMEOUT_SECONDS: "0" }, /CLAMD_TIMEOUT_SECONDS/],
    ["a zero size limit", { CLAMD_HOST: "c", CLAMD_MAX_FILE_MB: "0" }, /CLAMD_MAX_FILE_MB/],
    ["an absurd size limit", { CLAMD_HOST: "c", CLAMD_MAX_FILE_MB: "99999" }, /CLAMD_MAX_FILE_MB/],
  ];
  for (const [name, vars, msg] of bad) {
    it(`stops the server at startup on ${name}`, () => {
      env(vars);
      expect(() => loadConfig()).toThrow(msg);
    });
  }

  it("treats empty values as not set", () => {
    env({ CLAMD_HOST: "", CLAMD_PORT: "" });
    expect(loadConfig().clamav).toBeUndefined();
  });
});

function recorder() {
  const lines: Array<["log" | "warn", string]> = [];
  const out: StartupLog = { log: (l) => lines.push(["log", l]), warn: (l) => lines.push(["warn", l]) };
  return { out, lines, text: () => lines.map((l) => l[1]).join("\n"), warned: () => lines.some((l) => l[0] === "warn") };
}
async function deadPort() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe("wiring: email", () => {
  it("without SMTP it falls back to the log and says loudly that nothing is being sent", () => {
    const r = recorder();
    const { sender } = buildEmailSender({ smtp: undefined }, r.out);
    expect(sender).toBeInstanceOf(ConsoleEmailSender);
    expect(r.warned()).toBe(true);
    expect(r.text()).toMatch(/SMTP_HOST is not set.*NOT sent/);
  });

  it("with SMTP it builds the real sender and reports a reachable mail server", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const server = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"] });
    server.on("error", () => undefined);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    try {
      const port = (server.server.address() as net.AddressInfo).port;
      const r = recorder();
      const { sender, startupCheck } = buildEmailSender({ smtp: { host: "127.0.0.1", port, security: "none", from: "a@b.test", timeoutMs: 2000 } }, r.out);
      expect(sender).toBeInstanceOf(SmtpEmailSender);
      await startupCheck;
      expect(r.text()).toMatch(/mail server 127\.0\.0\.1:\d+ is reachable/);
      expect(r.text()).toMatch(/unencrypted/); // 'none' is flagged
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("an unreachable mail server is a warning, not a crash — and the check never rejects", async () => {
    const r = recorder();
    const { startupCheck } = buildEmailSender({ smtp: { host: "127.0.0.1", port: await deadPort(), security: "starttls", from: "a@b.test", timeoutMs: 1000 } }, r.out);
    await expect(startupCheck).resolves.toBeUndefined();
    expect(r.text()).toMatch(/could not reach the mail server/);
    expect(r.text()).toMatch(/Emails will fail until this is fixed/);
  });
});

describe("wiring: malware scanning", () => {
  it("without ClamAV it uses a scanner that says 'skipped', never 'clean', and warns", async () => {
    const r = recorder();
    const { scanner } = buildScanner({ clamav: undefined }, r.out);
    expect(scanner).toBeInstanceOf(NoScanner);
    expect(await scanner.scan("a.pdf", new Uint8Array([1, 2, 3]))).toBe("skipped");
    expect(r.text()).toMatch(/CLAMD_HOST is not set.*NOT scanned/);
  });

  it("with ClamAV it builds the real scanner and reports a reachable daemon", async () => {
    const clamd = await FakeClamd.start();
    try {
      const r = recorder();
      const { scanner, startupCheck } = buildScanner({ clamav: { host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 } }, r.out);
      expect(scanner).toBeInstanceOf(ClamAvScanner);
      await startupCheck;
      expect(r.text()).toMatch(/ClamAV at 127\.0\.0\.1:\d+ is reachable/);
      expect(r.warned()).toBe(false);
    } finally {
      await clamd.close();
    }
  });

  it("an unreachable ClamAV is a warning that says uploads will be refused — not a crash", async () => {
    const r = recorder();
    const { startupCheck } = buildScanner({ clamav: { host: "127.0.0.1", port: await deadPort(), timeoutMs: 1000 } }, r.out);
    await expect(startupCheck).resolves.toBeUndefined();
    expect(r.text()).toMatch(/Uploads will be refused \(503\)/);
  });

  it("end to end: with no scanner configured, an upload is recorded as 'skipped' — not 'clean'", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    const c = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c);
    const storage = new InMemoryStorageProvider();
    const s = await evidence.requestUploadSession(appPool, w.contrib, storage, c, { fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const r = await evidence.confirmUpload(appPool, w.contrib, storage, new NoScanner(), c, s.providerFileId);
    expect(r.scan_status).toBe("skipped");
    const row = await adminPool.query("SELECT scan_status FROM evidence_files WHERE audit_control_id = $1", [c]);
    expect(row.rows).toEqual([{ scan_status: "skipped" }]);
  });
});
