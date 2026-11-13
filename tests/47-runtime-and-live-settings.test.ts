import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import net from "node:net";
import type { Pool } from "pg";
import { SMTPServer } from "smtp-server";
import { adminPool, appPool } from "./helpers.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { createRuntimeSettings, openSecrets, SecretsUnreadable, envGroups, type RuntimeSettings } from "../src/settings/runtime.ts";
import { LiveEmailSender, LiveScanner, LiveGoogleOAuth } from "../src/settings/live.ts";
import type { EffectiveSettings } from "../src/settings/types.ts";
import { EmailDeliveryError } from "../src/email/types.ts";
import { EICAR_TEST_STRING, ScannerUnavailableError } from "../src/scan/types.ts";
import { FakeClamd } from "../src/scan/fakeClamd.ts";
import { FakeGoogleOAuthApi } from "../src/storage/fakeGoogleOAuthApi.ts";
import { AppError } from "../src/errors.ts";

/**
 * How the running server picks up settings: where they come from, how long they are remembered, what happens when the
 * database blinks, and that the mail sender, scanner and Google client really switch over when the owner saves
 * something — with no restart, and without ever mistaking "couldn't load" for "not set up".
 */

const STORE = new AesSecretStore("55".repeat(32));
const MAIL = { host: "mail.example.test", port: 587, security: "starttls", user: "mailer", from: "noreply@firm.example" };
const SCAN = { host: "clamav", port: 3310, timeoutSeconds: 60, maxFileMb: 25 };
const GOOGLE = { clientId: "123-abc.apps.googleusercontent.com", redirectUri: "https://portal.example.com/oauth/google/callback" };

const putRow = (key: string, config: object, secrets?: object, store: AesSecretStore = STORE) =>
  adminPool.query(
    `INSERT INTO platform_settings (key, config, secret_enc, secrets_set) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (key) DO UPDATE SET config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, secrets_set = EXCLUDED.secrets_set`,
    [key, JSON.stringify(config), secrets ? store.encrypt(JSON.stringify(secrets)) : null, secrets ? Object.keys(secrets) : []]);
const putMail = (over: object = {}, password = "mail-pw") => putRow("email", { ...MAIL, ...over }, { password });
const putScanner = (over: object = {}) => putRow("scanner", { ...SCAN, ...over });
const putGoogle = (over: object = {}, secret = "GOCSPX-test-secret") => putRow("google", { ...GOOGLE, ...over }, { clientSecret: secret });

beforeEach(async () => { await adminPool.query("DELETE FROM platform_settings"); });
afterAll(async () => { await adminPool.query("DELETE FROM platform_settings"); await adminPool.end(); await appPool.end(); });

/** A pool that counts how often the database is asked, and can be made to fail. */
function flaky(pool: Pool) {
  const state = { connects: 0, down: false };
  const wrapped = { connect: async () => { state.connects++; if (state.down) throw new Error("connection refused"); return pool.connect(); } } as unknown as Pool;
  return { pool: wrapped, state };
}

function clock() {
  const c = { t: 1_000_000, now: () => c.t, advance: (ms: number) => { c.t += ms; } };
  return c;
}

// ====================================================================================================================
describe("opening saved secrets", () => {
  it("returns an empty set when nothing was encrypted", () => { expect(openSecrets(undefined, null)).toEqual({}); expect(openSecrets(STORE, null)).toEqual({}); });
  it("opens what the key encrypted", () => { expect(openSecrets(STORE, STORE.encrypt(JSON.stringify({ password: "x" })))).toEqual({ password: "x" }); });
  it("is 'unreadable' without a key, with a different key, or when damaged or not the expected shape", () => {
    const enc = STORE.encrypt(JSON.stringify({ password: "x" }));
    expect(() => openSecrets(undefined, enc)).toThrow(SecretsUnreadable);
    expect(() => openSecrets(new AesSecretStore("77".repeat(32)), enc)).toThrow(SecretsUnreadable);
    expect(() => openSecrets(STORE, enc.slice(0, -4) + "AAAA")).toThrow(SecretsUnreadable);
    for (const odd of ["not json", "[1]", "null", "7", JSON.stringify({ a: 1 }), JSON.stringify({ a: { b: "c" } })]) {
      expect(() => openSecrets(STORE, STORE.encrypt(odd)), odd).toThrow(SecretsUnreadable);
    }
  });
  it("never puts the secret in the error", () => {
    try { openSecrets(new AesSecretStore("77".repeat(32)), STORE.encrypt(JSON.stringify({ password: "hunter2-secret" }))); } catch (e) { expect(String(e)).not.toContain("hunter2"); }
  });
});

// ====================================================================================================================
describe("where the settings in force come from", () => {
  it("are all 'none' when nothing is set up anywhere", async () => {
    const rt = createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {} });
    const s = await rt.current();
    for (const g of ["email", "scanner", "google"] as const) expect(s[g]).toEqual({ source: "none" });
  });

  it("come from what the owner saved, with the secrets opened", async () => {
    await putMail(); await putScanner({ host: "scan.test", maxFileMb: 10 }); await putGoogle();
    const s = await createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {} }).current();
    expect(s.email).toEqual({ source: "panel", settings: { host: "mail.example.test", port: 587, security: "starttls", user: "mailer", password: "mail-pw", from: "noreply@firm.example" } });
    expect(s.scanner).toEqual({ source: "panel", settings: { host: "scan.test", port: 3310, timeoutMs: 60_000, maxBytes: 10 * 1024 * 1024 } });
    expect(s.google).toEqual({ source: "panel", settings: { clientId: GOOGLE.clientId, clientSecret: "GOCSPX-test-secret", redirectUri: GOOGLE.redirectUri } });
  });

  it("let the server's environment win over what was saved, group by group", async () => {
    await putMail(); await putScanner();
    const envMail = { host: "env-mail.test", port: 25, security: "none" as const, from: "a@b.test" };
    const s = await createRuntimeSettings({ pool: appPool, secretStore: STORE, env: { email: envMail } }).current();
    expect(s.email).toEqual({ source: "environment", settings: envMail });
    expect(s.scanner.source).toBe("panel");
    expect(s.google.source).toBe("none");
  });

  it("don't touch the database at all when the environment provides everything", async () => {
    const f = flaky(appPool);
    f.state.down = true;
    const env = {
      email: { host: "m.test", port: 25, security: "none" as const, from: "a@b.test" },
      scanner: { host: "c.test", port: 3310 },
      google: { clientId: "i", clientSecret: "s", redirectUri: "https://x.test/oauth/google/callback" },
    };
    const s = await createRuntimeSettings({ pool: f.pool, env }).current();
    expect(s.email.source).toBe("environment");
    expect(f.state.connects).toBe(0);
  });

  it("ignore a saved group for which the environment now provides values, even a broken one", async () => {
    await putRow("email", { host: "bad host" });
    const envMail = { host: "env-mail.test", port: 25, security: "none" as const, from: "a@b.test" };
    const warn = vi.fn();
    const s = await createRuntimeSettings({ pool: appPool, secretStore: STORE, env: { email: envMail }, warn }).current();
    expect(s.email.source).toBe("environment");
    expect(warn).not.toHaveBeenCalled();
  });

  it("lists which groups the environment provides", () => {
    expect(envGroups({})).toEqual([]);
    expect(envGroups({ google: { clientId: "i", clientSecret: "s", redirectUri: "r" }, email: { host: "h", port: 1, security: "none", from: "f@x" } })).toEqual(["email", "google"]);
  });
});

// ====================================================================================================================
describe("saved settings that can't be used", () => {
  it("count as 'not set up', with a reason, when the key has changed — never half-used", async () => {
    await putRow("email", MAIL, { password: "old" }, new AesSecretStore("99".repeat(32)));
    const warn = vi.fn();
    const s = await createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {}, warn }).current();
    expect(s.email.source).toBe("none");
    expect(s.email.settings).toBeUndefined();
    expect(s.email.problem).toMatch(/encryption key is missing or has changed/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[settings\] the saved email settings can't be used/);
    expect(warn.mock.calls[0][0]).not.toContain("old");
  });

  it("count as 'not set up' when the server has no key at all", async () => {
    await putMail();
    const s = await createRuntimeSettings({ pool: appPool, env: {}, warn: () => undefined }).current();
    expect(s.email).toMatchObject({ source: "none", problem: expect.stringMatching(/encryption key/) });
  });

  it("count as 'not set up' when the values no longer validate (a hand-edited row)", async () => {
    await putScanner({ host: "http://scanner/", port: 99999 });
    const s = await createRuntimeSettings({ pool: appPool, env: {}, warn: () => undefined }).current();
    expect(s.scanner).toMatchObject({ source: "none", problem: expect.stringMatching(/no longer valid/) });
  });

  it("don't hold back the groups that are fine", async () => {
    await putRow("email", MAIL, { password: "x" }, new AesSecretStore("99".repeat(32)));
    await putScanner();
    const s = await createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {}, warn: () => undefined }).current();
    expect(s.email.source).toBe("none");
    expect(s.scanner.source).toBe("panel");
  });

  it("are mentioned in the log once, not on every reload", async () => {
    await putScanner({ host: "bad host" });
    const c = clock(); const warn = vi.fn();
    const rt = createRuntimeSettings({ pool: appPool, env: {}, warn, now: c.now, ttlMs: 1000 });
    for (let i = 0; i < 4; i++) { await rt.current(); c.advance(2000); }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ====================================================================================================================
describe("how long settings are remembered", () => {
  it("are read once and reused until the time is up, then read again", async () => {
    const f = flaky(appPool); const c = clock();
    const rt = createRuntimeSettings({ pool: f.pool, secretStore: STORE, env: {}, now: c.now, ttlMs: 5000 });
    expect((await rt.current()).scanner.source).toBe("none");
    await putScanner();
    c.advance(4999);
    expect((await rt.current()).scanner.source).toBe("none"); // still the remembered answer
    expect(f.state.connects).toBe(1);
    c.advance(1);
    expect((await rt.current()).scanner.source).toBe("panel");
    expect(f.state.connects).toBe(2);
  });

  it("are read again straight away after invalidate()", async () => {
    const rt = createRuntimeSettings({ pool: appPool, secretStore: STORE, env: {}, ttlMs: 60_000 });
    expect((await rt.current()).scanner.source).toBe("none");
    await putScanner();
    expect((await rt.current()).scanner.source).toBe("none");
    rt.invalidate();
    expect((await rt.current()).scanner.source).toBe("panel");
  });

  it("are read once for many requests that arrive together", async () => {
    const f = flaky(appPool);
    const rt = createRuntimeSettings({ pool: f.pool, secretStore: STORE, env: {} });
    await Promise.all(Array.from({ length: 25 }, () => rt.current()));
    expect(f.state.connects).toBe(1);
  });

  it("are not remembered if the owner saved while they were being read (that answer might be the old one)", async () => {
    // The first read gets the database's answer at once (the state from BEFORE the save) but is then held up on its
    // way back, so the save and the invalidate() happen while it is "in flight".
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void; const readOld = new Promise<void>((r) => { reached = r; });
    let first = true;
    const pool = {
      connect: async () => {
        const client = await appPool.connect();
        if (!first) return client;
        first = false;
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop !== "query") return Reflect.get(target, prop, receiver);
            return async (...args: unknown[]) => {
              const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
              if (String(args[0]).includes("platform_settings_load")) { reached(); await gate; }
              return result;
            };
          },
        });
      },
    } as unknown as Pool;
    const rt = createRuntimeSettings({ pool, secretStore: STORE, env: {}, ttlMs: 60_000 });
    const slow = rt.current();           // reads the old state (nothing saved yet), then waits
    await readOld;
    await putScanner();                   // owner saves…
    rt.invalidate();                      // …and the service says so
    release();
    expect((await slow).scanner.source).toBe("none"); // the slow read really did see the old state
    expect((await rt.current()).scanner.source).toBe("panel"); // but it was not remembered
  });
});

// ====================================================================================================================
describe("when the database can't be reached", () => {
  it("the last settings that loaded keep being used, with one warning a minute", async () => {
    await putMail();
    const f = flaky(appPool); const c = clock(); const warn = vi.fn();
    const rt = createRuntimeSettings({ pool: f.pool, secretStore: STORE, env: {}, now: c.now, ttlMs: 5000, warn });
    expect((await rt.current()).email.source).toBe("panel");
    f.state.down = true;
    for (let i = 0; i < 5; i++) { c.advance(6000); expect((await rt.current()).email.source).toBe("panel"); }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/last known values are still in use/);
    c.advance(61_000);
    await rt.current();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("retries soon (about a second later), not on every request and not only after the full time", async () => {
    await putMail();
    const f = flaky(appPool); const c = clock();
    const rt = createRuntimeSettings({ pool: f.pool, secretStore: STORE, env: {}, now: c.now, ttlMs: 5000, warn: () => undefined });
    await rt.current();
    f.state.down = true; c.advance(5000);
    await rt.current();                       // fails, falls back
    const afterFailure = f.state.connects;
    await rt.current(); await rt.current();   // immediately again: no new attempt
    expect(f.state.connects).toBe(afterFailure);
    c.advance(1000);
    await rt.current();                       // a second later: tries again
    expect(f.state.connects).toBe(afterFailure + 1);
    f.state.down = false; c.advance(1000);
    await putScanner(); await rt.current();
    expect((await rt.current()).scanner.source).toBe("panel"); // recovered
  });

  it("with nothing ever loaded, the call fails (it never pretends nothing is set up)", async () => {
    const f = flaky(appPool); f.state.down = true;
    const rt = createRuntimeSettings({ pool: f.pool, secretStore: STORE, env: {} });
    await expect(rt.current()).rejects.toThrow(/connection refused/);
    f.state.down = false;
    expect((await rt.current()).email.source).toBe("none"); // and recovers by itself
  });
});

// ====================================================================================================================
/** A stand-in for the runtime settings that the test changes by hand, to watch the live wrappers react. */
function stub(initial: Partial<EffectiveSettings> = {}) {
  const state = {
    value: { email: { source: "none" }, scanner: { source: "none" }, google: { source: "none" }, ...initial } as EffectiveSettings,
    fail: false, calls: 0,
  };
  const runtime: RuntimeSettings = {
    async current() { state.calls++; if (state.fail) throw new Error("settings database down"); return state.value; },
    invalidate() { /* not needed here */ },
  };
  return { state, runtime };
}
const logger = () => { const lines: string[] = []; return { lines, out: { log: (l: string) => lines.push(`log ${l}`), warn: (l: string) => lines.push(`warn ${l}`) } }; };
const MSG = { to: ["someone@firm.example"], subject: "Hello", text: "Body" };

describe("the live mail sender", () => {
  let smtpA: SMTPServer; let smtpB: SMTPServer; let portA: number; let portB: number;
  const gotA: string[][] = []; const gotB: string[][] = [];
  const mk = (sink: string[][]) => new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"],
    onData(stream, session, cb) { stream.resume(); stream.on("end", () => { sink.push(session.envelope.rcptTo.map((r) => r.address)); cb(); }); },
  });
  beforeAll(async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    smtpA = mk(gotA); smtpB = mk(gotB);
    for (const s of [smtpA, smtpB]) s.on("error", () => undefined);
    await Promise.all([smtpA, smtpB].map((s) => new Promise<void>((res) => s.listen(0, "127.0.0.1", res))));
    portA = (smtpA.server.address() as net.AddressInfo).port; portB = (smtpB.server.address() as net.AddressInfo).port;
  });
  afterAll(async () => { await Promise.all([smtpA, smtpB].map((s) => new Promise<void>((res) => s.close(() => res())))); });
  beforeEach(() => { gotA.length = 0; gotB.length = 0; });
  const settingsFor = (port: number) => ({ source: "panel" as const, settings: { host: "127.0.0.1", port, security: "none" as const, from: "noreply@portal.local" } });

  it("prints to the log (clearly marked as not sent) while no mail server is set up", async () => {
    const { runtime } = stub(); const { lines, out } = logger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await new LiveEmailSender(runtime, out).send(MSG);
    expect(lines.some((l) => l.startsWith("warn [startup]") && /NOT sent/.test(l))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[email:not-sent]"));
    log.mockRestore();
  });

  it("sends through the mail server in force, and moves to a new one the moment the settings change — no restart", async () => {
    const { state, runtime } = stub({ email: settingsFor(portA) });
    const sender = new LiveEmailSender(runtime, logger().out);
    await sender.send(MSG);
    expect([gotA.length, gotB.length]).toEqual([1, 0]);
    state.value = { ...state.value, email: settingsFor(portB) };
    await sender.send(MSG);
    expect([gotA.length, gotB.length]).toEqual([1, 1]);
    await sender.send(MSG);
    expect([gotA.length, gotB.length]).toEqual([1, 2]);
  });

  it("goes back to the log when the owner removes the mail settings", async () => {
    const { state, runtime } = stub({ email: settingsFor(portA) });
    const sender = new LiveEmailSender(runtime, logger().out);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await sender.send(MSG);
    state.value = { ...state.value, email: { source: "none" } };
    await sender.send(MSG);
    expect(gotA.length).toBe(1);
    vi.mocked(console.log).mockRestore();
  });

  it("builds a connection once per distinct setting, and says [settings] — not [startup] — about changes made later", async () => {
    const { state, runtime } = stub({ email: settingsFor(portA) });
    const { lines, out } = logger();
    const sender = new LiveEmailSender(runtime, out);
    await sender.send(MSG); await sender.send(MSG); await sender.send(MSG);
    await vi.waitFor(() => expect(lines.filter((l) => /mail server .* is reachable/.test(l))).toHaveLength(1));
    expect(lines.filter((l) => /mail server .* is reachable/.test(l))[0]).toMatch(/^log \[startup\]/);
    state.value = { ...state.value, email: settingsFor(portB) };
    await sender.send(MSG);
    await vi.waitFor(() => expect(lines.filter((l) => /mail server .* is reachable/.test(l))).toHaveLength(2));
    expect(lines.filter((l) => /mail server .* is reachable/.test(l))[1]).toMatch(/^log \[settings\]/);
  });

  it("reports mail as undelivered — not as 'no mail server' — when the settings can't be loaded", async () => {
    const { state, runtime } = stub();
    state.fail = true;
    const sender = new LiveEmailSender(runtime, logger().out);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(sender.send(MSG)).rejects.toMatchObject({ name: "EmailDeliveryError", kind: "other" });
    await expect(sender.send(MSG)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(log).not.toHaveBeenCalled(); // a sign-in link was NOT quietly printed to the log
    log.mockRestore();
    state.fail = false; state.value = { ...state.value, email: settingsFor(portA) };
    await sender.send(MSG); // and it recovers on its own
    expect(gotA.length).toBe(1);
  });

  it("prepare() never throws, and says in the log when the settings couldn't be read at startup", async () => {
    const { state, runtime } = stub(); state.fail = true;
    const { lines, out } = logger();
    await expect(new LiveEmailSender(runtime, out).prepare()).resolves.toBeUndefined();
    expect(lines.join("\n")).toMatch(/warn \[startup\] The server settings could not be read from the database, so mail is not ready yet/);
  });

  it("prepare() makes the startup check happen right away", async () => {
    const { runtime } = stub({ email: settingsFor(portA) }); const { lines, out } = logger();
    await new LiveEmailSender(runtime, out).prepare();
    await vi.waitFor(() => expect(lines.some((l) => /mail server .* is reachable/.test(l))).toBe(true));
  });
});

// ====================================================================================================================
describe("the live malware scanner", () => {
  let clamdA: FakeClamd; let clamdB: FakeClamd;
  beforeAll(async () => { clamdA = await FakeClamd.start(); clamdB = await FakeClamd.start(); });
  afterAll(async () => { await clamdA.close(); await clamdB.close(); });
  const settingsFor = (port: number) => ({ source: "panel" as const, settings: { host: "127.0.0.1", port } });
  const bytes = (s: string) => Buffer.from(s);

  it("records files as 'skipped' (never 'clean') while no scanner is set up", async () => {
    const { runtime } = stub();
    expect(await new LiveScanner(runtime, logger().out).scan("a.txt", bytes("hello"))).toBe("skipped");
  });

  it("scans with the scanner in force, and switches the moment the settings change", async () => {
    const { state, runtime } = stub({ scanner: settingsFor(clamdA.port) });
    const scanner = new LiveScanner(runtime, logger().out);
    const a0 = clamdA.scans.length; const b0 = clamdB.scans.length;
    expect(await scanner.scan("a.txt", bytes("hello"))).toBe("clean");
    expect(await scanner.scan("virus.com", bytes(EICAR_TEST_STRING))).toBe("infected");
    expect([clamdA.scans.length - a0, clamdB.scans.length - b0]).toEqual([2, 0]);
    state.value = { ...state.value, scanner: settingsFor(clamdB.port) };
    expect(await scanner.scan("a.txt", bytes("hello"))).toBe("clean");
    expect([clamdA.scans.length - a0, clamdB.scans.length - b0]).toEqual([2, 1]);
  });

  it("goes back to 'skipped' when the owner removes the scanner (and that is visible, not silent)", async () => {
    const { state, runtime } = stub({ scanner: settingsFor(clamdA.port) });
    const { lines, out } = logger();
    const scanner = new LiveScanner(runtime, out);
    expect(await scanner.scan("a.txt", bytes("x"))).toBe("clean");
    state.value = { ...state.value, scanner: { source: "none" } };
    expect(await scanner.scan("a.txt", bytes("x"))).toBe("skipped");
    expect(lines.some((l) => l.startsWith("warn [settings]") && /NOT scanned/.test(l))).toBe(true);
  });

  it("says the scanner is unavailable — never 'skipped' or 'clean' — when the settings can't be loaded", async () => {
    const { state, runtime } = stub();
    state.fail = true;
    const scanner = new LiveScanner(runtime, logger().out);
    await expect(scanner.scan("a.txt", bytes("x"))).rejects.toBeInstanceOf(ScannerUnavailableError);
    state.fail = false; state.value = { ...state.value, scanner: settingsFor(clamdA.port) };
    expect(await scanner.scan("a.txt", bytes("x"))).toBe("clean");
  });

  it("prepare() never throws", async () => {
    const { state, runtime } = stub(); state.fail = true;
    const { lines, out } = logger();
    await expect(new LiveScanner(runtime, out).prepare()).resolves.toBeUndefined();
    expect(lines.join("\n")).toMatch(/malware scanner is not ready yet/);
  });

  it("prepare() logs whether the scanner is reachable", async () => {
    const { runtime } = stub({ scanner: settingsFor(clamdA.port) }); const { lines, out } = logger();
    await new LiveScanner(runtime, out).prepare();
    await vi.waitFor(() => expect(lines.some((l) => /ClamAV at 127\.0\.0\.1:\d+ is reachable/.test(l))).toBe(true));
  });
});

// ====================================================================================================================
describe("the live Google sign-in client", () => {
  const settings = (over: object = {}) => ({ source: "panel" as const, settings: { clientId: "client-one", clientSecret: "secret-one", redirectUri: "https://portal.example/oauth/google/callback", ...over } });
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AppError; } throw new Error("expected a failure"); };

  it("says Google isn't set up — pointing at Server settings — when it isn't", async () => {
    const { runtime } = stub();
    const e = await code(new LiveGoogleOAuth(runtime).buildAuthUrl("s"));
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ status: 503, code: "OAUTH_NOT_CONFIGURED" });
    expect(e.message).toMatch(/Server settings/);
    expect(await code(new LiveGoogleOAuth(runtime).exchangeCode("c"))).toMatchObject({ code: "OAUTH_NOT_CONFIGURED" });
    expect(await code(new LiveGoogleOAuth(runtime).refreshAccessToken("r"))).toMatchObject({ code: "OAUTH_NOT_CONFIGURED" });
  });

  it("says 'try again' — not 'not set up' — when the settings can't be loaded", async () => {
    const { state, runtime } = stub();
    state.fail = true;
    const e = await code(new LiveGoogleOAuth(runtime).buildAuthUrl("s"));
    expect(e).toMatchObject({ status: 503, code: "OAUTH_UNAVAILABLE" });
    expect(e.message).not.toMatch(/Server settings/);
  });

  it("builds the sign-in address from the client in force and follows changes", async () => {
    const { state, runtime } = stub({ google: settings() });
    const g = new LiveGoogleOAuth(runtime);
    expect(new URL(await g.buildAuthUrl("st")).searchParams.get("client_id")).toBe("client-one");
    state.value = { ...state.value, google: settings({ clientId: "client-two" }) };
    const u = new URL(await g.buildAuthUrl("st"));
    expect(u.searchParams.get("client_id")).toBe("client-two");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.toString()).not.toContain("secret-one");
  });

  it("uses the client secret in force for the code exchange and token refresh, and follows changes", async () => {
    const api = new FakeGoogleOAuthApi();
    const { state, runtime } = stub({ google: settings() });
    const g = new LiveGoogleOAuth(runtime, api.fetcher);
    api.seedCode("c1");
    await g.exchangeCode("c1");
    expect(new URLSearchParams(api.calls[0].body).get("client_secret")).toBe("secret-one");
    state.value = { ...state.value, google: settings({ clientSecret: "secret-two" }) };
    api.seedCode("c2");
    await g.exchangeCode("c2");
    expect(new URLSearchParams(api.calls[1].body).get("client_secret")).toBe("secret-two");
  });
});
