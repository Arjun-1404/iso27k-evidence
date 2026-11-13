import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutBucketVersioningCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { S3Provider, createS3Client, mapS3Error, normalisePrefix, testS3Connection, type S3Config } from "../src/storage/s3.ts";
import { AddressNotAllowedError, checkEndpoint, classifyAddress, guardedLookup } from "../src/storage/addressGuard.ts";
import { StorageError, type UploadTarget } from "../src/storage/types.ts";

/**
 * These tests talk to a REAL S3 server — "moto", a widely used stand-in for Amazon S3 that speaks the actual S3 protocol —
 * through the real AWS client library. They need `moto_server` installed (pip install "moto[server]"); on a computer
 * without it the S3 tests are skipped and say so, and everything else still runs.
 */
const MOTO = spawnSync("moto_server", ["--help"], { stdio: "ignore" }).status === 0;
const describeS3 = MOTO ? describe : describe.skip;

const PORT = 5198;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
const rejects = (p: Promise<unknown>) => p.then(() => null, (e) => e as StorageError);

function waitForPort(port: number, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => { s.destroy(); if (Date.now() - t0 > ms) reject(new Error("moto did not start")); else setTimeout(attempt, 150); });
    };
    attempt();
  });
}

const baseConfig = (bucket: string, prefix = ""): S3Config => ({ endpoint: ENDPOINT, region: "us-east-1", bucket, accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true, prefix });
const allowAll = { allowPrivate: true };

let n = 0;
async function newBucket(opts: { versioned?: boolean } = {}): Promise<{ bucket: string; raw: S3Client }> {
  const bucket = `evidence-test-${Date.now()}-${n++}`;
  const raw = createS3Client(baseConfig(bucket), allowAll);
  await raw.send(new CreateBucketCommand({ Bucket: bucket }));
  if (opts.versioned) await raw.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
  return { bucket, raw };
}
const urls: UploadTarget[] = [];
const provider = (bucket: string, prefix = "", now?: () => number) =>
  new S3Provider({ client: createS3Client(baseConfig(bucket, prefix), allowAll), bucket, prefix, now, makeUploadUrl: (t) => { urls.push(t); return `/uploads/${encodeURIComponent(t.providerFileId)}`; } });
async function store(p: S3Provider, folder: string, name: string, content: string, mime = "application/pdf") {
  const s = await p.createUploadSession(folder, name, mime, Buffer.byteLength(content));
  await p.receiveUpload(urls[urls.length - 1], body(content));
  return s.providerFileId;
}
const keysIn = async (raw: S3Client, bucket: string) => ((await raw.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? []).map((c) => c.Key!).sort();

beforeAll(async () => {
  if (!MOTO) return;
  server = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(PORT)], { stdio: "ignore" });
  await waitForPort(PORT);
}, 40_000);
afterAll(() => { server?.kill("SIGKILL"); });

describeS3("S3-compatible storage, against a real S3 server", () => {
  it("builds the folder tree from names, lets files in, and reads them back with a SHA-256", async () => {
    const { bucket, raw } = await newBucket(); const p = provider(bucket);
    const root = await p.createRootFolder("Evidence Portal – Acme");
    const audit = await p.findOrCreateFolder(root.id, "Audit [1a2b3c4d]");
    const control = await p.findOrCreateFolder(audit.id, "A.8.5");
    expect(control.id).toBe("Evidence Portal – Acme/Audit [1a2b3c4d]/A.8.5");
    expect((await p.findOrCreateFolder(audit.id, "A.8.5")).id).toBe(control.id);

    const s = await p.createUploadSession(control.id, "mfa-settings.pdf", "application/pdf", 11);
    expect(s).toMatchObject({ method: "PUT", providerFileId: `${control.id}/mfa-settings.pdf` });
    expect(await keysIn(raw, bucket)).toEqual([]);                                   // nothing stored until the bytes arrive
    await p.receiveUpload(urls[urls.length - 1], body("the content"));
    expect(await keysIn(raw, bucket)).toEqual([`${control.id}/mfa-settings.pdf`]);

    const m = await p.getFileMetadata(s.providerFileId);
    expect(m).toMatchObject({ name: "mfa-settings.pdf", sizeBytes: 11, mimeType: "application/pdf", hashAlgo: "sha256", hash: sha("the content"), folderId: control.id });
    expect(m.version).toMatch(/^[0-9a-f]{32}$/);                                      // the object's ETag
    const d = await p.downloadFile(s.providerFileId);
    expect(Buffer.from(d.bytes).toString()).toBe("the content");
    const o = await p.openFile(s.providerFileId);
    expect(o).toMatchObject({ sizeBytes: 11, fileName: "mfa-settings.pdf", mimeType: "application/pdf" });
    const chunks: Buffer[] = []; for await (const c of o.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("the content");
  });

  it("two clients with the same name get different roots; the same file name twice gives two objects", async () => {
    const { bucket } = await newBucket(); const p = provider(bucket);
    const a = await p.createRootFolder("Acme"); const b0 = await p.createRootFolder("Acme");
    expect(b0.id).toBe("Acme");                                                      // nothing stored under "Acme" yet, so the name is still free
    const f = await p.findOrCreateFolder(a.id, "A.8.5");
    const id1 = await store(p, f.id, "r.pdf", "one");
    const s2 = await p.createUploadSession(f.id, "r.pdf", "application/pdf", 3); const t2 = urls[urls.length - 1];
    const s3 = await p.createUploadSession(f.id, "r.pdf", "application/pdf", 3);
    expect([id1, s2.providerFileId, s3.providerFileId]).toEqual(["Acme/A.8.5/r.pdf", "Acme/A.8.5/r (2).pdf", "Acme/A.8.5/r (3).pdf"]);
    await p.receiveUpload(t2, body("two"));
    expect(Buffer.from((await p.downloadFile(id1)).bytes).toString()).toBe("one");
    expect((await p.createRootFolder("Acme")).id).toBe("Acme (2)");                    // now it is taken
  });

  it("delivering the same announcement twice does not overwrite the first, and a stored object is never replaced through a link", async () => {
    const { bucket, raw } = await newBucket(); const p = provider(bucket);
    const f = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, f.id, "r.pdf", "one");
    const target = urls[urls.length - 1];
    const err = await rejects(p.receiveUpload(target, body("two")));
    expect(err).toMatchObject({ code: "ALREADY_EXISTS" });
    const got = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: id }));
    expect(Buffer.from(await got.Body!.transformToByteArray()).toString()).toBe("one");
    // Even a hand-made link for a name that was never announced can't replace an object that is already there.
    const forged: UploadTarget = { providerFileId: id, folderId: f.id, fileName: "r.pdf", mimeType: "application/pdf", sizeBytes: 3 };
    expect(await rejects(p.receiveUpload(forged, body("xxx")))).toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("asks the service to write only if nothing is there; a service that doesn't understand that is still protected by the check before it", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const mk = (onPut: (n: number) => void) => {
      let puts = 0;
      const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "HeadObjectCommand") throw Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        if (cmd.constructor.name === "PutObjectCommand") onPut(++puts);
        return {};
      } } as unknown as S3Client;
      return new S3Provider({ client, bucket: "b", prefix: "", makeUploadUrl: () => "/uploads/x" });
    };
    const target: UploadTarget = { providerFileId: "Acme/A.8.5/r.pdf", folderId: "Acme/A.8.5", fileName: "r.pdf", mimeType: "application/pdf", sizeBytes: 3 };

    // 1. A modern service: one write, with the condition.
    await mk(() => undefined).receiveUpload(target, body("abc"));
    const put1 = calls.filter((c) => c.name === "PutObjectCommand");
    expect(put1).toHaveLength(1);
    expect(put1[0].input.IfNoneMatch).toBe("*");

    // 2. The service says "someone got there first": refused as already existing.
    calls.length = 0;
    const lost = mk(() => { throw Object.assign(new Error("Precondition Failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }); });
    expect(await rejects(lost.receiveUpload(target, body("abc")))).toMatchObject({ code: "ALREADY_EXISTS" });

    // 3. A service that doesn't implement the condition (501): the write is repeated without it.
    calls.length = 0;
    const old = mk((n) => { if (n === 1) throw Object.assign(new Error("Not Implemented"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } }); });
    await old.receiveUpload(target, body("abc"));
    const puts = calls.filter((c) => c.name === "PutObjectCommand");
    expect(puts).toHaveLength(2);
    expect(puts[0].input.IfNoneMatch).toBe("*");
    expect(puts[1].input.IfNoneMatch).toBeUndefined();

    // 4. Any other failure is reported as itself, not retried.
    calls.length = 0;
    const down = mk(() => { throw Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }); });
    expect(await rejects(down.receiveUpload(target, body("abc")))).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(calls.filter((c) => c.name === "PutObjectCommand")).toHaveLength(1);

    // 5. A service that does NOT understand the condition, holding an object already: the check before the write is all
    //    that stands between the link and a replaced evidence file, so nothing may be written at all.
    calls.length = 0;
    const noConditionClient = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "HeadObjectCommand") return { ContentLength: 3 };   // it is already there
      if (cmd.constructor.name === "PutObjectCommand" && cmd.input.IfNoneMatch) throw Object.assign(new Error("Not Implemented"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
      return {};
    } } as unknown as S3Client;
    const existing = new S3Provider({ client: noConditionClient, bucket: "b", prefix: "", makeUploadUrl: () => "/uploads/x" });
    expect(await rejects(existing.receiveUpload(target, body("new")))).toMatchObject({ code: "ALREADY_EXISTS" });
    expect(calls.filter((c) => c.name === "PutObjectCommand")).toHaveLength(0);
  });

  it("names promised in one request are still taken in the next, when the providers share their reservations", async () => {
    const { bucket } = await newBucket();
    const shared = new Map<string, number>();
    const mkp = () => new S3Provider({ client: createS3Client(baseConfig(bucket), allowAll), bucket, prefix: "", reservations: shared, makeUploadUrl: () => "/uploads/x" });
    const p1 = mkp(); const p2 = mkp();
    const f = await p1.findOrCreateFolder((await p1.createRootFolder("Acme")).id, "A.8.5");
    const a = await p1.createUploadSession(f.id, "r.pdf", "application/pdf", 3);
    const b = await p2.createUploadSession(f.id, "r.pdf", "application/pdf", 3);
    expect([a.providerFileId, b.providerFileId]).toEqual(["Acme/A.8.5/r.pdf", "Acme/A.8.5/r (2).pdf"]);
  });

  it("a file shorter or longer than announced is refused and nothing is stored", async () => {
    const { bucket, raw } = await newBucket(); const p = provider(bucket);
    const f = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    for (const [content, why] of [["12", "shorter"], ["12345678", "longer"]] as const) {
      await p.createUploadSession(f.id, `${why}.pdf`, "application/pdf", 5);
      expect(await rejects(p.receiveUpload(urls[urls.length - 1], body(content))), why).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(await keysIn(raw, bucket)).toEqual([]);
  });

  it("everything lives under the chosen prefix, and two prefixes in one bucket can't see each other", async () => {
    const { bucket, raw } = await newBucket();
    const a = provider(bucket, "org-a/"); const b = provider(bucket, "org-b/");
    const fa = await a.findOrCreateFolder((await a.createRootFolder("Acme")).id, "A.8.5");
    const ida = await store(a, fa.id, "x.pdf", "A's file");
    expect(await keysIn(raw, bucket)).toEqual(["org-a/Acme/A.8.5/x.pdf"]);
    expect(await rejects(b.getFileMetadata(ida))).toMatchObject({ code: "NOT_FOUND" });
    expect((await b.createRootFolder("Acme")).id).toBe("Acme");
    expect((await a.listFiles(fa.id)).map((f) => f.name)).toEqual(["x.pdf"]);
    expect(await b.listFiles(fa.id)).toEqual([]);
  });

  it("the integrity check sees a replaced file, however it was replaced, and not an untouched one", async () => {
    const { bucket, raw } = await newBucket(); const p = provider(bucket);
    const f = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, f.id, "policy.pdf", "original");
    const before = await p.getFileMetadata(id);
    const again = await p.getFileMetadata(id);
    expect([again.hash, again.version]).toEqual([before.hash, before.version]);

    // Someone overwrites it with the S3 console / another tool: no portal fingerprint on the new object.
    await raw.send(new PutObjectCommand({ Bucket: bucket, Key: id, Body: "tampered" }));
    const tampered = await p.getFileMetadata(id);
    expect(tampered.hash).not.toBe(before.hash);
    expect(tampered.version).not.toBe(before.version);

    // ...or with different content under the SAME fingerprint (copying metadata along): the ETag still changes.
    await raw.send(new PutObjectCommand({ Bucket: bucket, Key: id, Body: "sneaky", Metadata: { sha256: sha("original") } }));
    const sneaky = await p.getFileMetadata(id);
    expect(sneaky.hash).toBe(before.hash);
    expect(sneaky.version).not.toBe(before.version);
  });

  it("with versioning on, the version id is the revision marker", async () => {
    const { bucket } = await newBucket({ versioned: true }); const p = provider(bucket);
    const f = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, f.id, "v.pdf", "v1");
    const v1 = await p.getFileMetadata(id);
    expect(v1.version).not.toMatch(/^[0-9a-f]{32}$/);                                // a version id, not an ETag
    expect(v1.version.length).toBeGreaterThan(8);
  });

  it("a missing object is 'not found'", async () => {
    const { bucket } = await newBucket(); const p = provider(bucket);
    for (const call of [() => p.getFileMetadata("Acme/x.pdf"), () => p.downloadFile("Acme/x.pdf"), () => p.openFile("Acme/x.pdf")]) {
      expect(await rejects(call())).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("lists the files directly in a folder, not those in folders below it", async () => {
    const { bucket } = await newBucket(); const p = provider(bucket);
    const root = await p.createRootFolder("Acme"); const f = await p.findOrCreateFolder(root.id, "A.8.5");
    await store(p, f.id, "b.pdf", "b"); await store(p, f.id, "a.pdf", "aa");
    await store(p, (await p.findOrCreateFolder(f.id, "deeper")).id, "c.pdf", "c");
    expect((await p.listFiles(f.id)).map((x) => [x.name, x.sizeBytes])).toEqual([["a.pdf", 2], ["b.pdf", 1]]);
  });

  it("quarantine moves the object to a quarantine folder in the bucket", async () => {
    const { bucket, raw } = await newBucket(); const p = provider(bucket, "ev/", () => Date.UTC(2026, 10, 8, 12, 0, 0));
    const f = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, f.id, "bad file (1).pdf", "malware-ish");
    await p.quarantineFile(id);
    expect(await keysIn(raw, bucket)).toEqual(["ev/_quarantine/2026-11-08T12-00-00-000Z-bad file (1).pdf"]);
    expect(await rejects(p.getFileMetadata(id))).toMatchObject({ code: "NOT_FOUND" });
    const q = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: "ev/_quarantine/2026-11-08T12-00-00-000Z-bad file (1).pdf" }));
    expect(await q.Body!.transformToString()).toBe("malware-ish");
  });

  it("hostile ids are refused before S3 is asked anything", async () => {
    const { bucket, raw } = await newBucket(); const p = provider(bucket, "ev/");
    await raw.send(new PutObjectCommand({ Bucket: bucket, Key: "secret.txt", Body: "outside the prefix" }));
    for (const id of ["../secret.txt", "Acme/../../secret.txt", "/secret.txt", "..\\x", "Acme//x", "", "Acme/./x", "a:b"]) {
      for (const call of [() => p.getFileMetadata(id), () => p.downloadFile(id), () => p.openFile(id), () => p.quarantineFile(id), () => p.listFiles(id), () => p.findOrCreateFolder(id, "x"), () => p.createUploadSession(id, "x.pdf", "application/pdf", 1)]) {
        expect(await rejects(call()), id).toMatchObject({ code: "INVALID_REQUEST" });
      }
    }
    const bad: UploadTarget = { providerFileId: "Acme/../x.pdf", folderId: "Acme/..", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    expect(await rejects(p.receiveUpload(bad, body("x")))).toMatchObject({ code: "INVALID_REQUEST" });
    const mismatch: UploadTarget = { providerFileId: "Acme/other/x.pdf", folderId: "Acme", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    expect(await rejects(p.receiveUpload(mismatch, body("x")))).toMatchObject({ code: "INVALID_REQUEST" });
    expect(await keysIn(raw, bucket)).toEqual(["secret.txt"]);
  });
});

describeS3("testing a connection before it is saved", () => {
  it("passes for a bucket the key can use, and leaves nothing behind", async () => {
    const { bucket, raw } = await newBucket();
    await testS3Connection(createS3Client(baseConfig(bucket), allowAll), bucket, "");
    expect(await keysIn(raw, bucket)).toEqual([]);
  });

  it("says plainly when the bucket doesn't exist", async () => {
    const err = await rejects(testS3Connection(createS3Client(baseConfig("no-such-bucket-here"), allowAll), "no-such-bucket-here", ""));
    expect(err).toBeInstanceOf(StorageError);
    expect(err!.message).toMatch(/bucket doesn't exist/);
  });

  it("says plainly when the service can't be reached", async () => {
    const cfg = { ...baseConfig("x"), endpoint: "http://127.0.0.1:1" };
    const err = await rejects(testS3Connection(createS3Client(cfg, allowAll), "x", ""));
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(err!.message).toMatch(/Can't reach the storage service/);
  });
});

describeS3("the address guard applies to real connections", () => {
  const making = (cfg: S3Config, policy: { allowPrivate: boolean }) => rejects(Promise.resolve().then(() => createS3Client(cfg, policy)));

  it("a private address given as numbers is refused when the owner hasn't allowed private addresses — before anything is sent", async () => {
    const err = await making(baseConfig("x"), { allowPrivate: false });
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ code: "INVALID_REQUEST" });
    expect(err!.message).toMatch(/private network/);
    expect(err!.message).toContain("STORAGE_ALLOW_PRIVATE_ADDRESSES");
    expect(await making(baseConfig("x"), allowAll)).toBeNull();
  });

  it("the cloud metadata address is refused even when private addresses are allowed", async () => {
    for (const endpoint of ["http://169.254.169.254", "http://[fd00:ec2::254]", "http://0.0.0.0:9000"]) {
      const err = await making({ ...baseConfig("x"), endpoint }, allowAll);
      expect(err, endpoint).toBeInstanceOf(StorageError);
      expect(err!.message).toMatch(/not allowed/);
    }
  });

  it("a NAME that points at a private address is refused at the moment of connecting, not just when it was typed in", async () => {
    // "localhost" is a name, so it goes through the guarded lookup on every connection.
    const cfg = { ...baseConfig("x"), endpoint: `http://localhost:${PORT}` };
    const err = await rejects(testS3Connection(createS3Client(cfg, { allowPrivate: false }), "x", ""));
    expect(err).toBeInstanceOf(StorageError);
    expect(err!.message).toMatch(/private network|not allowed/);
    const { bucket } = await newBucket();
    await testS3Connection(createS3Client({ ...baseConfig(bucket), endpoint: `http://localhost:${PORT}` }, allowAll), bucket, "");   // and works when allowed
  });
});

describe("S3 prefix handling", () => {
  it("accepts plain folder paths and tidies them; refuses anything odd", () => {
    expect(normalisePrefix("")).toBe(""); expect(normalisePrefix("  /  ")).toBe("");
    expect(normalisePrefix("evidence")).toBe("evidence/"); expect(normalisePrefix("/evidence/2026/")).toBe("evidence/2026/");
    for (const bad of ["../x", "a/../b", "a//b", ".hidden", "a:b", "a\\b", "CON"]) expect(normalisePrefix(bad), bad).toBeNull();
  });
});

describe("what S3 errors turn into", () => {
  const e = (name: string, status: number, extra: object = {}) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status }, ...extra });
  it("each failure becomes advice an administrator can act on", () => {
    expect(mapS3Error(e("NoSuchKey", 404))).toMatchObject({ code: "NOT_FOUND" });
    expect(mapS3Error(e("NotFound", 404))).toMatchObject({ code: "NOT_FOUND" });
    expect(mapS3Error(e("NoSuchBucket", 404))).toMatchObject({ code: "INVALID_REQUEST" });
    expect(mapS3Error(e("InvalidAccessKeyId", 403)).message).toMatch(/access key ID/);
    expect(mapS3Error(e("SignatureDoesNotMatch", 403)).message).toMatch(/secret access key/);
    expect(mapS3Error(e("AccessDenied", 403))).toMatchObject({ code: "PERMISSION_DENIED", retryable: false });
    expect(mapS3Error(e("PermanentRedirect", 301, { $response: { headers: { "x-amz-bucket-region": "eu-west-1" } } })).message).toContain("eu-west-1");
    expect(mapS3Error(e("SlowDown", 503))).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(mapS3Error(e("InternalError", 500))).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(mapS3Error(Object.assign(new Error("x"), { name: "TimeoutError" }))).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(mapS3Error(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(mapS3Error(new Error("weird"))).toBeInstanceOf(StorageError);
  });
  it("never puts secrets or raw SDK text in the message", () => {
    const m = mapS3Error(e("AccessDenied", 403, { message: "secret=ABCDEF token=xyz" })).message;
    expect(m).not.toContain("ABCDEF"); expect(m).not.toContain("xyz");
  });
  it("a StorageError passes through untouched", () => {
    const s = new StorageError("already clear", "NOT_FOUND", false);
    expect(mapS3Error(s)).toBe(s);
  });
});

describe("the address guard", () => {
  it("classifies addresses", () => {
    const never = ["0.0.0.0", "0.1.2.3", "169.254.169.254", "169.254.0.1", "224.0.0.1", "255.255.255.255", "::", "fe80::1", "fd00:ec2::254", "ff02::1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "not an address", "::2"];
    const priv = ["127.0.0.1", "127.255.255.255", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "::1", "fc00::1", "fdab::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3"];
    const ok = ["8.8.8.8", "52.95.0.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "192.167.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
    for (const a of never) expect(classifyAddress(a), a).toBe("never");
    for (const a of priv) expect(classifyAddress(a), a).toBe("private");
    for (const a of ok) expect(classifyAddress(a), a).toBe("ok");
  });

  const fakeDns = (map: Record<string, string[]>) => ((host: string, _o: unknown, cb: (...a: unknown[]) => void) => {
    const list = map[host]; if (!list) return cb(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    cb(null, list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  }) as never;

  it("checkEndpoint accepts a clean public address and returns it tidied", async () => {
    const dns = fakeDns({ "s3.example.com": ["52.95.0.1"], "minio.corp": ["10.1.2.3"] });
    expect(await checkEndpoint("https://s3.example.com/", { allowPrivate: false }, dns)).toBe("https://s3.example.com");
    expect(await checkEndpoint(" http://minio.corp:9000 ", { allowPrivate: true }, dns)).toBe("http://minio.corp:9000");
  });

  it("checkEndpoint refuses what it should, with a message that says what to do", async () => {
    const dns = fakeDns({ "minio.corp": ["10.1.2.3"], "evil.example": ["52.95.0.1", "169.254.169.254"], "ok.example": ["52.95.0.1"] });
    const fails = async (u: string, allowPrivate: boolean) => (await checkEndpoint(u, { allowPrivate }, dns).then(() => null, (e) => e as Error));
    expect(await fails("not a url", true)).toBeInstanceOf(AddressNotAllowedError);
    expect((await fails("ftp://ok.example", true))!.message).toMatch(/https:\/\//);
    expect((await fails("https://user:pw@ok.example", true))!.message).toMatch(/access key fields/);
    expect((await fails("https://ok.example/bucket", true))!.message).toMatch(/without a path/);
    expect((await fails("https://ok.example/?x=1", true))!.message).toMatch(/nothing after/);
    expect((await fails("http://minio.corp:9000", false))!.message).toContain("STORAGE_ALLOW_PRIVATE_ADDRESSES");
    expect((await fails("http://127.0.0.1:9000", false))!.message).toContain("STORAGE_ALLOW_PRIVATE_ADDRESSES");
    expect((await fails("http://localhost:9000", false))!.message).toContain("STORAGE_ALLOW_PRIVATE_ADDRESSES");
    expect((await fails("http://[::1]:9000", false))!.message).toContain("STORAGE_ALLOW_PRIVATE_ADDRESSES");
    expect((await fails("http://169.254.169.254", true))!.message).toMatch(/not allowed/);
    expect((await fails("https://evil.example", true))!.message).toMatch(/not allowed/);      // one bad address among good ones is enough
    expect((await fails("https://missing.example", true))!.message).toMatch(/could not be found/);
  });

  it("guardedLookup hands out good addresses and refuses bad ones, in both the single and the 'all' shapes", async () => {
    const resolveTo = (addrs: string[]) => ((h: string, o: unknown, cb: (...a: unknown[]) => void) => cb(null, addrs.map((address) => ({ address, family: 4 })))) as never;
    const call = (policy: { allowPrivate: boolean }, addrs: string[], all: boolean) => new Promise<{ err: Error | null; result: unknown }>((ok) => {
      (guardedLookup(policy, resolveTo(addrs)) as unknown as (h: string, o: object, cb: (e: Error | null, ...r: unknown[]) => void) => void)("h", { all }, (err, ...rest) => ok({ err, result: rest.length === 1 ? rest[0] : rest }));
    });
    expect((await call({ allowPrivate: false }, ["52.95.0.1"], true)).result).toEqual([{ address: "52.95.0.1", family: 4 }]);
    expect((await call({ allowPrivate: false }, ["52.95.0.1"], false)).result).toEqual(["52.95.0.1", 4]);
    expect((await call({ allowPrivate: false }, ["10.0.0.5"], true)).err).toBeInstanceOf(AddressNotAllowedError);
    expect((await call({ allowPrivate: true }, ["10.0.0.5"], true)).err).toBeNull();
    expect((await call({ allowPrivate: true }, ["169.254.169.254"], true)).err).toBeInstanceOf(AddressNotAllowedError);
    expect((await call({ allowPrivate: true }, ["52.95.0.1", "169.254.169.254"], false)).err).toBeInstanceOf(AddressNotAllowedError);
  });
});
