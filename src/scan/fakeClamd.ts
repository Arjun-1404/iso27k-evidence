import net from "node:net";

/** The standard antivirus test string; real ClamAV flags it too, under the name "Eicar-Signature". */
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export type FakeClamdFault =
  | "none"
  | "mute"            // accepts the connection, then never answers
  | "dropMidStream"   // hangs up after the first chunk
  | "garbage"         // answers with something that isn't clamd's language
  | "scanError";      // answers "... ERROR", as clamd does for internal problems

export interface FakeScan { payload: Buffer; chunkSizes: number[] }

/**
 * A stand-in for the ClamAV daemon that speaks clamd's real TCP protocol (zINSTREAM / zPING, 4-byte
 * big-endian chunk lengths, a zero-length terminator, NUL-terminated replies) and is strict about it: a
 * malformed stream gets an ERROR, as it would from clamd. It "detects" only the EICAR test string.
 * Used by the tests, and handy for running the portal locally without installing ClamAV.
 */
export class FakeClamd {
  fault: FakeClamdFault = "none";
  connections = 0;
  readonly scans: FakeScan[] = [];
  /** Every raw byte received on every connection, command and framing included. */
  readonly rawReceived: Buffer[] = [];
  private readonly sockets = new Set<net.Socket>();
  private constructor(private readonly server: net.Server, readonly port: number, private readonly streamMaxBytes: number) {}

  static async start(opts: { streamMaxBytes?: number } = {}): Promise<FakeClamd> {
    let self!: FakeClamd;
    const server = net.createServer((sock) => self.handle(sock));
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    self = new FakeClamd(server, (server.address() as net.AddressInfo).port, opts.streamMaxBytes ?? 25 * 1024 * 1024);
    return self;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => this.server.close(() => res()));
  }

  private handle(sock: net.Socket) {
    this.connections++;
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let raw = Buffer.alloc(0);
    let command: string | null = null;
    const chunks: Buffer[] = [];
    const sizes: number[] = [];
    let total = 0;
    let done = false;

    const reply = (text: string) => { if (!done) { done = true; sock.end(Buffer.from(text + "\0", "latin1")); } };

    sock.on("data", (d: Buffer) => {
      if (done) return;
      raw = Buffer.concat([raw, d]);
      this.rawReceived.push(d);
      buf = Buffer.concat([buf, d]);
      if (this.fault === "mute") return;

      if (command === null) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        command = buf.subarray(0, nul).toString("latin1");
        buf = buf.subarray(nul + 1);
        if (command === "zPING") return reply("PONG");
        if (command !== "zINSTREAM") return reply("UNKNOWN COMMAND");
      }

      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) { // end of stream
          const payload = Buffer.concat(chunks);
          this.scans.push({ payload, chunkSizes: sizes });
          if (this.fault === "garbage") return reply("banana");
          if (this.fault === "scanError") return reply("lstat() failed: No such file or directory. ERROR");
          return reply(payload.includes(Buffer.from(EICAR)) ? "stream: Eicar-Signature FOUND" : "stream: OK");
        }
        if (buf.length < 4 + len) return;
        total += len;
        if (total > this.streamMaxBytes) return reply("INSTREAM size limit exceeded. ERROR");
        chunks.push(Buffer.from(buf.subarray(4, 4 + len)));
        sizes.push(len);
        buf = buf.subarray(4 + len);
        if (this.fault === "dropMidStream") { done = true; sock.destroy(); return; }
      }
    });
  }
}
