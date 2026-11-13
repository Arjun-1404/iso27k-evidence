import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { ClamAvScanner } from "../src/scan/clamav.ts";
import { FakeClamd, EICAR } from "../src/scan/fakeClamd.ts";
import { ScannerUnavailableError } from "../src/scan/types.ts";

/**
 * The scanner is tested against FakeClamd, which speaks clamd's real TCP protocol over a real socket and is
 * strict about it (a malformed stream gets an ERROR back). What this can't prove is that a real ClamAV
 * daemon agrees with our reading of the protocol — see the README for the one-command way to check that.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function clamd(opts?: { streamMaxBytes?: number }) {
  const c = await FakeClamd.start(opts);
  cleanups.push(() => c.close());
  return c;
}
const scanner = (port: number, over: Record<string, number> = {}) => new ClamAvScanner({ host: "127.0.0.1", port, timeoutMs: 2000, ...over });
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

/** A port with nothing listening on it. */
async function deadPort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe("ClamAvScanner: verdicts", () => {
  it("a harmless file is clean", async () => {
    const c = await clamd();
    expect(await scanner(c.port).scan("policy.pdf", bytes("just an ordinary document"))).toBe("clean");
  });

  it("the standard EICAR test file is infected", async () => {
    const c = await clamd();
    expect(await scanner(c.port).scan("innocent-name.txt", bytes(EICAR))).toBe("infected");
  });

  it("EICAR buried in the middle of a larger file is still found", async () => {
    const c = await clamd();
    const data = Buffer.concat([randomBytes(200_000), Buffer.from(EICAR), randomBytes(200_000)]);
    expect(await scanner(c.port, { chunkBytes: 4096 }).scan("big.bin", new Uint8Array(data))).toBe("infected");
  });

  it("an empty file is clean (just the terminator is sent)", async () => {
    const c = await clamd();
    expect(await scanner(c.port).scan("empty.txt", new Uint8Array(0))).toBe("clean");
    expect(c.scans[0].payload.length).toBe(0);
  });

  it("accepts a plain number array as well as a Uint8Array", async () => {
    const c = await clamd();
    expect(await scanner(c.port).scan("a.txt", Array.from(Buffer.from("hello")))).toBe("clean");
    expect(c.scans[0].payload.toString()).toBe("hello");
  });
});

describe("ClamAvScanner: what goes over the wire", () => {
  it("the file arrives byte-for-byte intact, split into chunks no larger than configured", async () => {
    const c = await clamd();
    const data = randomBytes(2_500_000);
    expect(await scanner(c.port, { chunkBytes: 100_000 }).scan("x.bin", new Uint8Array(data))).toBe("clean");
    expect(c.scans).toHaveLength(1);
    expect(c.scans[0].payload.equals(data)).toBe(true);
    expect(Math.max(...c.scans[0].chunkSizes)).toBeLessThanOrEqual(100_000);
    expect(c.scans[0].chunkSizes.length).toBe(25);
  });

  it("starts with the zINSTREAM command and ends with a zero-length chunk", async () => {
    const c = await clamd();
    await scanner(c.port).scan("a.txt", bytes("abc"));
    const raw = Buffer.concat(c.rawReceived);
    expect(raw.subarray(0, 10).toString("latin1")).toBe("zINSTREAM\0");
    expect(raw.subarray(raw.length - 4).equals(Buffer.alloc(4))).toBe(true);
    expect(raw.length).toBe(10 + 4 + 3 + 4); // command + (length + data) + terminator
  });

  it("never sends the file's name — only its bytes", async () => {
    const c = await clamd();
    await scanner(c.port).scan("CONFIDENTIAL-board-minutes.pdf", bytes("body text"));
    expect(Buffer.concat(c.rawReceived).toString("latin1")).not.toContain("CONFIDENTIAL");
  });

  it("uses one short-lived connection per scan, and handles scans running at the same time without mixing results up", async () => {
    const c = await clamd();
    const s = scanner(c.port);
    const jobs = Array.from({ length: 8 }, (_, i) => ({ i, evil: i % 3 === 0 }));
    const results = await Promise.all(jobs.map((j) => s.scan(`f${j.i}`, bytes(j.evil ? `${EICAR} #${j.i}` : `fine #${j.i}`))));
    expect(results).toEqual(jobs.map((j) => (j.evil ? "infected" : "clean")));
    expect(c.connections).toBe(8);
  });
});

describe("ClamAvScanner: size limits", () => {
  it("a file over the configured limit is 'unscannable' and is not even sent", async () => {
    const c = await clamd();
    expect(await scanner(c.port, { maxBytes: 1000 }).scan("big.bin", new Uint8Array(1001))).toBe("unscannable");
    expect(c.connections).toBe(0);
    expect(await scanner(c.port, { maxBytes: 1000 }).scan("ok.bin", new Uint8Array(1000))).toBe("clean");
  });

  it("if clamd itself says the stream is too long, that is 'unscannable' too — not an outage", async () => {
    const c = await clamd({ streamMaxBytes: 500 });
    expect(await scanner(c.port, { chunkBytes: 100 }).scan("big.bin", new Uint8Array(2000))).toBe("unscannable");
  });
});

describe("ClamAvScanner: when clamd can't give an answer it must NEVER say 'clean'", () => {
  const unavailable = (p: Promise<unknown>) => p.then(() => { throw new Error("expected the scan to fail, but it returned a result"); }, (e) => e);

  it("nothing listening: throws ScannerUnavailableError, quickly", async () => {
    const t0 = Date.now();
    const e = await unavailable(scanner(await deadPort()).scan("a.txt", bytes("hello")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("clamd accepts the connection but never answers: times out instead of waiting forever", async () => {
    const c = await clamd();
    c.fault = "mute";
    const t0 = Date.now();
    const e = await unavailable(scanner(c.port, { timeoutMs: 300 }).scan("a.txt", bytes("hello")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
    expect(e.message).toMatch(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("clamd hangs up part-way through the file", async () => {
    const c = await clamd();
    c.fault = "dropMidStream";
    const e = await unavailable(scanner(c.port, { chunkBytes: 10 }).scan("a.txt", bytes("a file long enough to need several chunks")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
  });

  it("clamd answers in a language we don't understand", async () => {
    const c = await clamd();
    c.fault = "garbage";
    const e = await unavailable(scanner(c.port).scan("a.txt", bytes("hello")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
    expect(e.message).toMatch(/does not understand/);
  });

  it("clamd reports an internal error", async () => {
    const c = await clamd();
    c.fault = "scanError";
    const e = await unavailable(scanner(c.port).scan("a.txt", bytes("hello")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
  });

  it("a connection that is accepted and immediately closed", async () => {
    const closer = net.createServer((s) => s.destroy()).listen(0, "127.0.0.1");
    await new Promise((r) => closer.once("listening", r));
    cleanups.push(() => { closer.close(); });
    const e = await unavailable(scanner((closer.address() as net.AddressInfo).port).scan("a.txt", bytes("hello")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
  });

  it("a truncated 'OK' that never completed is not taken as a verdict", async () => {
    const half = net.createServer((s) => { s.on("data", () => undefined); s.write("stream: O"); s.end(); }).listen(0, "127.0.0.1");
    await new Promise((r) => half.once("listening", r));
    cleanups.push(() => { half.close(); });
    const e = await unavailable(scanner((half.address() as net.AddressInfo).port).scan("a.txt", bytes("hello")));
    expect(e).toBeInstanceOf(ScannerUnavailableError);
  });

  it("an error message never contains the file's name or contents", async () => {
    const c = await clamd();
    c.fault = "garbage";
    const e = await unavailable(scanner(c.port).scan("PAYROLL-2026.xlsx", bytes("salary data")));
    expect(e.message).not.toContain("PAYROLL");
    expect(e.message).not.toContain("salary");
  });
});

describe("ClamAvScanner.ping", () => {
  it("succeeds against a live clamd and fails clearly against a dead one", async () => {
    const c = await clamd();
    await expect(scanner(c.port).ping()).resolves.toBeUndefined();
    await expect(scanner(await deadPort()).ping()).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

describe("ClamAvScanner: configuration", () => {
  it("rejects a nonsensical chunk size", () => {
    expect(() => new ClamAvScanner({ host: "h", port: 3310, chunkBytes: 0 })).toThrow(/chunk size/);
    expect(() => new ClamAvScanner({ host: "h", port: 3310, chunkBytes: 1.5 })).toThrow(/chunk size/);
  });
});
