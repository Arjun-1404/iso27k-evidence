import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { SmtpEmailSender, assertSafeMessage, type SmtpSettings } from "../src/email/smtp.ts";
import { ConsoleEmailSender } from "../src/email/console.ts";
import { EmailDeliveryError } from "../src/email/types.ts";

/**
 * These tests talk to a REAL SMTP server (the `smtp-server` package, running on a random local port) over a
 * real socket, so the protocol itself — EHLO, STARTTLS, AUTH, RCPT TO, DATA — is exercised, not a mock.
 * What they can't cover is any particular provider's quirks (Microsoft 365, SES, ...).
 */

interface Captured { from: string; to: string[]; raw: string; secure: boolean }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });

interface ServerConfig extends Partial<SMTPServerOptions> {
  users?: Record<string, string>;
  /** Recipients the server will refuse with a 550. */
  refuse?: string[];
}

async function startServer(cfg: ServerConfig = {}) {
  const captured: Captured[] = [];
  const authAttempts: string[] = [];
  const { users, refuse, ...opts } = cfg;
  // The smtp-server package warns loudly about its built-in test certificate; that's expected in tests.
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  const server = new SMTPServer({
    authOptional: !users,
    allowInsecureAuth: false,
    onAuth(auth, _session, cb) {
      authAttempts.push(String(auth.username));
      if (users && users[String(auth.username)] === auth.password) return cb(null, { user: String(auth.username) });
      cb(new Error("Invalid username or password"));
    },
    onRcptTo(address, _session, cb) {
      if (refuse?.includes(address.address)) return cb(Object.assign(new Error(`<${address.address}> Recipient address rejected: user unknown`), { responseCode: 550 })); // real servers echo the address back
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("end", () => {
        captured.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString("utf8"),
          secure: session.secure,
        });
        cb();
      });
    },
    ...opts,
  });
  // The server reports connection-level failures (a client that quits mid-handshake, a plain-text client
  // talking to a TLS port) as 'error' events. Several tests cause exactly that on purpose.
  server.on("error", () => undefined);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
  const port = (server.server.address() as net.AddressInfo).port;
  return { port, captured, authAttempts };
}

function sender(port: number, over: Partial<SmtpSettings> = {}, trustAnyCert = true) {
  const s = new SmtpEmailSender(
    { host: "127.0.0.1", port, security: "none", from: "Evidence Portal <noreply@portal.example>", timeoutMs: 3000, ...over },
    trustAnyCert ? { rejectUnauthorized: false } : undefined, // the test server's built-in certificate is self-signed
  );
  cleanups.push(() => s.close());
  return s;
}

/** Quoted-printable decode, since the mailer wraps long lines (like invite links) that way. */
const body = (raw: string) => raw.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
const header = (raw: string, name: string) => raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));

const MSG = { to: ["alice@client.example"], subject: "You've been invited", text: "Set your password: https://portal.example/accept-invite?token=abc123DEF456ghi789JKL012mno345PQR678stu901" };

describe("SmtpEmailSender: delivery", () => {
  it("delivers a plain-text message with the right sender, recipients, subject and body", async () => {
    const srv = await startServer();
    await sender(srv.port).send({ ...MSG, to: ["alice@client.example", "bob@client.example"] });

    expect(srv.captured).toHaveLength(1);
    const m = srv.captured[0];
    expect(m.from).toBe("noreply@portal.example");
    expect(m.to).toEqual(["alice@client.example", "bob@client.example"]);
    expect(header(m.raw, "Subject")).toBe("Subject: You've been invited");
    expect(header(m.raw, "From")).toContain("noreply@portal.example");
    expect(header(m.raw, "Content-Type")).toMatch(/text\/plain/);
    expect(body(m.raw)).toContain("https://portal.example/accept-invite?token=abc123DEF456ghi789JKL012mno345PQR678stu901");
  });

  it("sends no HTML part at all — plain text only", async () => {
    const srv = await startServer();
    await sender(srv.port).send(MSG);
    expect(srv.captured[0].raw).not.toMatch(/text\/html/i);
  });

  it("STARTTLS: upgrades the connection to TLS before sending anything", async () => {
    const srv = await startServer();
    await sender(srv.port, { security: "starttls" }).send(MSG);
    expect(srv.captured[0].secure).toBe(true);
  });

  it("implicit TLS: works against a server that speaks TLS from the first byte", async () => {
    const srv = await startServer({ secure: true });
    await sender(srv.port, { security: "tls" }).send(MSG);
    expect(srv.captured[0].secure).toBe(true);
  });

  it("with 'none' the message really does travel unencrypted (the local-mail-catcher mode)", async () => {
    const srv = await startServer();
    await sender(srv.port, { security: "none" }).send(MSG);
    expect(srv.captured[0].secure).toBe(false);
  });
});

describe("SmtpEmailSender: never falls back to plain text when TLS was demanded", () => {
  it("STARTTLS required but not offered by the server: nothing is sent, and it says why", async () => {
    const srv = await startServer({ disabledCommands: ["STARTTLS"] });
    const err = await sender(srv.port, { security: "starttls" }).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(srv.captured).toHaveLength(0);
  });

  it("does not hand over the password on an unencrypted connection", async () => {
    const srv = await startServer({ users: { mailer: "s3cret" }, disabledCommands: ["STARTTLS"], allowInsecureAuth: true });
    await sender(srv.port, { security: "starttls", user: "mailer", password: "s3cret" }).send(MSG).catch(() => undefined);
    expect(srv.authAttempts).toHaveLength(0); // the credentials never left the client
    expect(srv.captured).toHaveLength(0);
  });

  it("a TLS server and a plain-text client are not silently reconciled", async () => {
    const srv = await startServer({ secure: true });
    const err = await sender(srv.port, { security: "none" }).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(srv.captured).toHaveLength(0);
  });
});

describe("SmtpEmailSender: authentication", () => {
  it("logs in with the right credentials and delivers", async () => {
    const srv = await startServer({ users: { mailer: "s3cret-pass" } });
    await sender(srv.port, { security: "starttls", user: "mailer", password: "s3cret-pass" }).send(MSG);
    expect(srv.captured).toHaveLength(1);
    expect(srv.authAttempts).toEqual(["mailer"]);
  });

  it("a wrong password is reported as an auth problem, delivers nothing, and the error never contains the password", async () => {
    const srv = await startServer({ users: { mailer: "right-password" } });
    const err = await sender(srv.port, { security: "starttls", user: "mailer", password: "wrong-password-123" }).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.kind).toBe("auth");
    expect(srv.captured).toHaveLength(0);
    expect(String(err.message)).not.toContain("wrong-password-123");
    expect(String(err.message)).not.toContain("right-password");
  });

  it("refuses a half-configured login (a user with no password, or the reverse)", () => {
    expect(() => new SmtpEmailSender({ host: "h", port: 25, security: "none", from: "a@b.test", user: "u" })).toThrow(/together/);
    expect(() => new SmtpEmailSender({ host: "h", port: 25, security: "none", from: "a@b.test", password: "p" })).toThrow(/together/);
  });
});

describe("SmtpEmailSender: refuses messages that could inject headers or recipients", () => {
  const attempts: Array<[string, Partial<typeof MSG> & { to?: string[] }]> = [
    ["a line break in the subject (Bcc injection)", { subject: "Hi\r\nBcc: attacker@evil.example" }],
    ["a bare newline in the subject", { subject: "Hi\nBcc: attacker@evil.example" }],
    ["an SMTP command smuggled into a recipient", { to: ["alice@client.example\r\nRCPT TO:<attacker@evil.example>"] }],
    ["a display-name style recipient", { to: ['"Alice" <alice@client.example>'] }],
    ["two addresses in one recipient string", { to: ["alice@client.example,attacker@evil.example"] }],
    ["a recipient with a comment", { to: ["alice@client.example (attacker@evil.example)"] }],
    ["a recipient with a NUL byte", { to: ["alice\0@client.example"] }],
    ["no recipients", { to: [] }],
    ["an empty subject", { subject: "   " }],
    ["an empty body", { text: "" }],
  ];
  for (const [name, patch] of attempts) {
    it(`refuses ${name}, and nothing reaches the mail server`, async () => {
      const srv = await startServer();
      const err = await sender(srv.port).send({ ...MSG, ...patch }).catch((e) => e);
      expect(err).toBeInstanceOf(EmailDeliveryError);
      expect(err.kind).toBe("invalid_message");
      expect(srv.captured).toHaveLength(0);
    });
  }

  it("refuses an absurd number of recipients and an absurdly long subject", () => {
    expect(() => assertSafeMessage({ ...MSG, to: Array.from({ length: 51 }, (_, i) => `u${i}@client.example`) })).toThrow(/recipients/);
    expect(() => assertSafeMessage({ ...MSG, subject: "x".repeat(201) })).toThrow(/too long/);
  });

  it("accepts ordinary addresses, including plus-tags and subdomains", () => {
    expect(() => assertSafeMessage({ ...MSG, to: ["first.last+audit@mail.client.example", "o'brien@client.example"] })).not.toThrow();
  });

  it("refuses a From address containing a line break at construction time", () => {
    expect(() => new SmtpEmailSender({ host: "h", port: 25, security: "none", from: "a@b.test\r\nBcc: x@y.test" })).toThrow(/line break/);
  });
});

describe("SmtpEmailSender: when the mail server misbehaves", () => {
  it("an unreachable server is reported as unreachable, quickly", async () => {
    const dead = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => dead.once("listening", r));
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise((r) => dead.close(r)); // now nothing is listening on that port

    const t0 = Date.now();
    const err = await sender(port).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.kind).toBe("unreachable");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a server that accepts the connection and then says nothing times out instead of hanging forever", async () => {
    const sockets: net.Socket[] = [];
    const mute = net.createServer((s) => { sockets.push(s); }).listen(0, "127.0.0.1");
    await new Promise((r) => mute.once("listening", r));
    cleanups.push(() => { sockets.forEach((s) => s.destroy()); mute.close(); });

    const t0 = Date.now();
    const err = await sender((mute.address() as net.AddressInfo).port, { timeoutMs: 300 }).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.kind).toBe("unreachable");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a server that refuses every recipient is reported as a rejection", async () => {
    const srv = await startServer({ refuse: ["alice@client.example"] });
    const err = await sender(srv.port).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err.kind).toBe("rejected");
    expect(srv.captured).toHaveLength(0);
  });

  it("if only SOME recipients are refused the message still goes to the rest, and the refusal is logged by count only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const srv = await startServer({ refuse: ["bob@client.example"] });
    await sender(srv.port).send({ ...MSG, to: ["alice@client.example", "bob@client.example"] });
    expect(srv.captured[0].to).toEqual(["alice@client.example"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 of 2 recipients"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("bob@");
  });

  it("failure messages never contain the recipient, the subject or the body (the body holds a sign-in link)", async () => {
    const deadSrv = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => deadSrv.once("listening", r));
    const port = (deadSrv.address() as net.AddressInfo).port;
    await new Promise((r) => deadSrv.close(r));

    const failures: EmailDeliveryError[] = [];
    failures.push(await sender(port).send(MSG).catch((e) => e));                               // unreachable
    failures.push(await sender(port).send({ ...MSG, subject: "a\r\nb" }).catch((e) => e));     // invalid
    const refusing = await startServer({ refuse: ["alice@client.example"] });
    failures.push(await sender(refusing.port).send(MSG).catch((e) => e));                      // rejected
    for (const f of failures) {
      expect(f).toBeInstanceOf(EmailDeliveryError);
      for (const secret of ["alice@client.example", "token=abc123", "You've been invited", "client.example"]) {
        expect(f.message).not.toContain(secret);
      }
    }
  });
});

describe("SmtpEmailSender.verify", () => {
  it("passes against a healthy server without sending anything", async () => {
    const srv = await startServer();
    await sender(srv.port).verify();
    expect(srv.captured).toHaveLength(0);
  });

  it("reports bad credentials as 'auth' and a dead server as 'unreachable'", async () => {
    const srv = await startServer({ users: { mailer: "pw" } });
    const bad = await sender(srv.port, { security: "starttls", user: "mailer", password: "nope" }).verify().catch((e) => e);
    expect(bad).toBeInstanceOf(EmailDeliveryError);
    expect(bad.kind).toBe("auth");

    const dead = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => dead.once("listening", r));
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const gone = await sender(port).verify().catch((e) => e);
    expect(gone.kind).toBe("unreachable");
  });
});

describe("ConsoleEmailSender (the no-SMTP development fallback)", () => {
  it("prints the message instead of sending it, so a developer can pick up an invite link", async () => {
    const lines: string[] = [];
    await new ConsoleEmailSender((l) => lines.push(l)).send(MSG);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("alice@client.example");
    expect(lines[0]).toContain("token=abc123");
    expect(lines[0]).toContain("not-sent");
  });
});
