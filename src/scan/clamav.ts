import net from "node:net";
import { ScannerUnavailableError, type ScanResult, type Scanner } from "./types.ts";

export interface ClamAvSettings {
  host: string;
  port: number;
  /** Give up on clamd after this many milliseconds, overall. Default 60 seconds. */
  timeoutMs?: number;
  /**
   * Files bigger than this are reported "unscannable" without being sent. Keep it at or below clamd's own
   * StreamMaxLength (25 MB by default); anything larger would be refused by clamd anyway, after wasting
   * the transfer. Default 25 MB.
   */
  maxBytes?: number;
  /** Size of each INSTREAM chunk. Default 64 KiB. */
  chunkBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CHUNK = 64 * 1024;

/**
 * Scans files with ClamAV by streaming them to a clamd daemon over TCP, using clamd's documented INSTREAM
 * command: `zINSTREAM\0`, then each chunk as a 4-byte big-endian length followed by its bytes, then a
 * zero-length chunk to finish. The reply is one NUL-terminated line:
 *     stream: OK                      -> clean
 *     stream: <signature> FOUND       -> infected
 *     INSTREAM size limit exceeded. ERROR -> unscannable
 * Anything else — no connection, no answer in time, a connection dropped half-way, an unrecognised reply —
 * throws ScannerUnavailableError. It never returns "clean" for a file it did not actually get a verdict on.
 *
 * Only the bytes are sent. The file's name never leaves this process.
 */
export class ClamAvScanner implements Scanner {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly chunkBytes: number;

  constructor(private readonly settings: ClamAvSettings) {
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = settings.maxBytes ?? DEFAULT_MAX_BYTES;
    this.chunkBytes = settings.chunkBytes ?? DEFAULT_CHUNK;
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > 0x7fffffff) throw new Error("ClamAV chunk size must be a positive integer.");
  }

  async scan(_fileName: string, bytes: ArrayLike<number>): Promise<ScanResult> {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (data.length > this.maxBytes) return "unscannable";
    const reply = await this.talk(
      (sock) => this.streamFile(sock, data),
      Buffer.from("zINSTREAM\0", "latin1"),
    );
    return interpret(reply);
  }

  /** Asks clamd if it's alive (`zPING` -> `PONG`). Used at startup to warn about a missing scanner early. */
  async ping(): Promise<void> {
    const reply = await this.talk(async () => undefined, Buffer.from("zPING\0", "latin1"));
    if (reply !== "PONG") throw new ScannerUnavailableError("clamd answered a ping with something other than PONG.");
  }

  private async streamFile(sock: net.Socket, data: Uint8Array): Promise<void> {
    for (let off = 0; off < data.length; off += this.chunkBytes) {
      const chunk = data.subarray(off, Math.min(off + this.chunkBytes, data.length));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(chunk.length, 0);
      await write(sock, header);
      await write(sock, chunk);
    }
    await write(sock, Buffer.alloc(4)); // zero-length chunk = end of stream
  }

  /** One connection, one command, one reply. */
  private talk(sendBody: (sock: net.Socket) => Promise<void>, command: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: this.settings.host, port: this.settings.port });
      const received: Buffer[] = [];
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const fail = (why: string) => finish(() => reject(new ScannerUnavailableError(`Malware scanner unavailable: ${why}.`)));
      const text = () => Buffer.concat(received).toString("latin1");
      const ok = () => finish(() => resolve(text().replace(/\0+$/, "").trim()));

      const timer = setTimeout(() => fail("timed out waiting for clamd"), this.timeoutMs);

      sock.on("data", (d: Buffer) => {
        received.push(d);
        if (d.includes(0)) ok(); // replies to z-commands are NUL-terminated
      });
      sock.on("end", () => { if (received.length > 0) ok(); else fail("clamd closed the connection without answering"); });
      // Safety net only: a lost connection normally raises 'end' or 'error' first, so this rarely fires.
      sock.on("close", () => { if (received.length > 0) ok(); else fail("connection to clamd was lost"); });
      sock.on("error", (e: NodeJS.ErrnoException) => {
        // clamd may answer ("size limit exceeded") and hang up while we're still sending; that answer counts.
        if (received.length > 0) ok(); else fail(`could not talk to clamd${e.code ? ` (${e.code})` : ""}`);
      });
      sock.on("connect", () => {
        write(sock, command).then(() => sendBody(sock)).catch(() => { /* surfaced by the socket's own events */ });
      });
    });
  }
}

function write(sock: net.Socket, buf: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (sock.destroyed) return reject(new Error("socket closed"));
    sock.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

function interpret(reply: string): ScanResult {
  if (reply === "stream: OK") return "clean";
  if (/^stream: .+ FOUND$/.test(reply)) return "infected";
  if (/size limit exceeded/i.test(reply)) return "unscannable";
  throw new ScannerUnavailableError("Malware scanner unavailable: clamd sent a reply this portal does not understand.");
}
