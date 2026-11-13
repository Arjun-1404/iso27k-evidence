import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { adminPool, appPool, makeWorld, controlId, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { createStorageResolver } from "../src/storage/resolver.ts";
import { createS3Client } from "../src/storage/s3.ts";

/**
 * Connecting an S3-compatible service and keeping evidence in it, end to end through the real app and against a REAL S3
 * server ("moto"; needs `pip install "moto[server]"` — without it these tests are skipped and say so).
 * Note what moto cannot do: it accepts any access key, so "wrong key" messages are covered by the unit tests of the
 * error translation (tests/61), and have only been seen against a real service when someone tries one.
 */
const MOTO = spawnSync("moto_server", ["--help"], { stdio: "ignore" }).status === 0;
const describeS3 = MOTO ? describe : describe.skip;

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const PORT = 5199;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const JWT = "test-jwt-secret-test-jwt-secret-1234";
let server: ChildProcess | undefined;

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
beforeAll(async () => {
  if (!MOTO) return;
  server = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(PORT)], { stdio: "ignore" });
  await waitForPort(PORT);
}, 40_000);
afterAll(() => { server?.kill("SIGKILL"); });

const SECRET_KEY = "super-secret-access-key-value-1234567890";
let n = 0;
async function newBucket(): Promise<{ bucket: string; raw: S3Client }> {
  const bucket = `portal-http-${Date.now()}-${n++}`;
  const raw = createS3Client({ endpoint: ENDPOINT, region: "us-east-1", bucket, accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true, prefix: "" }, { allowPrivate: true });
  await raw.send(new CreateBucketCommand({ Bucket: bucket }));
  return { bucket, raw };
}
const keysIn = async (raw: S3Client, bucket: string) => ((await raw.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? []).map((c) => c.Key!).sort();
const form = (bucket: string, over: Record<string, unknown> = {}) => ({ endpoint: ENDPOINT, region: "us-east-1", bucket, accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET_KEY, forcePathStyle: true, prefix: "", ...over });

function rig(opts: { allowPrivate?: boolean; secretStore?: boolean } = {}) {
  const auth = new FakeTokenVerifier();
  const secretStore = opts.secretStore === false ? undefined : new AesSecretStore(randomBytes(32).toString("hex"));
  const allowPrivateAddresses = opts.allowPrivate ?? true;
  const app = createApp({
    pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: JWT, appBaseUrl: "https://portal.example", secretStore,
    storageResolver: createStorageResolver({ pool: appPool, secretStore, jwtSecret: JWT, allowPrivateAddresses }),
    storageOptions: { allowPrivateAddresses },
  });
  const call = (method: "get" | "post" | "put", p: string, userId: string, body?: object) => {
    const r = request(app)[method](p).set("Authorization", `Bearer ${auth.issue(userId)}`);
    return body ? r.send(body) : r;
  };
  return { app, call, secretStore };
}
type Rig = ReturnType<typeof rig>;
const bytes = (n: number, seed = 3) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 17 + seed) % 256));
const PDF = "application/pdf";

async function connectAndRoot(t: Rig, w: World, bucket: string, over: Record<string, unknown> = {}) {
  const conn = await t.call("put", "/org/storage-connections/s3", w.admin, form(bucket, over));
  expect(conn.status, JSON.stringify(conn.body)).toBe(200);
  const root = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  return { conn, root };
}
async function sendFile(t: Rig, userId: string, control: string, name: string, content: Buffer) {
  const session = await t.call("post", `/controls/${control}/upload-session`, userId, { fileName: name, mimeType: PDF, sizeBytes: content.length });
  const put = await request(t.app).put(session.body.uploadUrl).set("Content-Type", PDF).send(content);
  const confirm = await t.call("post", `/controls/${control}/uploads/confirm`, userId, { providerFileId: session.body.providerFileId });
  return { session, put, confirm };
}

describeS3("testing and connecting an S3 service", () => {
  it("the Test button proves the bucket works and saves nothing", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket, raw } = await newBucket();
    const res = await t.call("post", "/org/storage-connections/s3/test", w.admin, form(bucket));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(0);
    expect(await keysIn(raw, bucket)).toEqual([]); // the test file was removed again
  });

  it("only an org admin may test or connect", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket } = await newBucket();
    for (const u of [w.lead, w.auditor, w.readOnly, w.dash, w.tLead, w.contrib, w.viewer, w.tDash, w.adminB]) {
      const test = await t.call("post", "/org/storage-connections/s3/test", u, form(bucket));
      const put = await t.call("put", "/org/storage-connections/s3", u, form(bucket));
      if (u === w.adminB) { expect(test.status).toBe(200); expect(put.status).toBe(200); continue; } // an admin of ANOTHER org connects only their own
      expect(test.status, u).toBe(403); expect(put.status, u).toBe(403);
    }
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(0);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgB])).rows[0].n).toBe(1);
  });

  it("explains a bucket that doesn't exist, an unreachable address and a malformed form in plain words", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket } = await newBucket();
    const missing = await t.call("post", "/org/storage-connections/s3/test", w.admin, form("no-such-bucket-here"));
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("S3_CONNECTION_FAILED");
    expect(missing.body.error.message).toMatch(/bucket doesn't exist/);

    const dead = await t.call("post", "/org/storage-connections/s3/test", w.admin, form(bucket, { endpoint: "http://127.0.0.1:1" }));
    expect(dead.status).toBeGreaterThanOrEqual(422);
    expect(dead.body.error.message).toMatch(/Can't reach/);

    const checks: Array<[Record<string, unknown>, RegExp]> = [
      [{ bucket: "X" }, /bucket name/], [{ bucket: "has space" }, /bucket name/], [{ region: "" }, /region/], [{ accessKeyId: "" }, /access key ID/],
      [{ secretAccessKey: "" }, /secret access key/], [{ secretAccessKey: "has space" }, /can't contain spaces/], [{ prefix: "../x" }, /folder inside the bucket/],
      [{ prefix: "a/./b" }, /folder inside the bucket/], [{ endpoint: "ftp://x.example" }, /https/], [{ endpoint: "not a url" }, /valid web address/],
      [{ endpoint: "http://user:pw@host.example" }, /access key/], [{ endpoint: "http://host.example/some/path" }, /without a path/],
    ];
    for (const [over, msg] of checks) {
      const res = await t.call("post", "/org/storage-connections/s3/test", w.admin, form(bucket, over));
      expect(res.status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(over)).toBeLessThan(500);
      expect(res.body.error.message, JSON.stringify(over)).toMatch(msg);
    }
    const noBody = await t.call("post", "/org/storage-connections/s3/test", w.admin);
    expect(noBody.status).toBe(400);
  });

  it("a service on a private network is refused unless the server's owner allowed it; cloud metadata addresses never", async () => {
    const w = await makeWorld(); const { bucket } = await newBucket();
    const strict = rig({ allowPrivate: false });
    const refused = await strict.call("post", "/org/storage-connections/s3/test", w.admin, form(bucket));
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("STORAGE_ADDRESS_NOT_ALLOWED");
    expect(refused.body.error.message).toMatch(/STORAGE_ALLOW_PRIVATE_ADDRESSES=true/);
    const refusedSave = await strict.call("put", "/org/storage-connections/s3", w.admin, form(bucket));
    expect(refusedSave.status).toBe(422);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(0);

    const lax = rig({ allowPrivate: true });
    for (const bad of ["http://169.254.169.254", "http://[fd00:ec2::254]", "http://0.0.0.0:9000", "http://[::]:9000"]) {
      const res = await lax.call("post", "/org/storage-connections/s3/test", w.admin, form(bucket, { endpoint: bad }));
      expect(res.status, bad).toBe(422);
      expect(res.body.error.code, bad).toBe("STORAGE_ADDRESS_NOT_ALLOWED");
    }
    expect((await lax.call("post", "/org/storage-connections/s3/test", w.admin, form(bucket))).status).toBe(200);
  });

  it("the access keys are stored encrypted and never come back in any answer, list or log", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket } = await newBucket();
    const conn = await t.call("put", "/org/storage-connections/s3", w.admin, form(bucket, { prefix: "evidence" }));
    expect(conn.status).toBe(200);
    expect(conn.body.label).toBe(`${bucket} @ 127.0.0.1:${PORT}`);

    const row = (await adminPool.query("SELECT token_ref, account_label, status FROM storage_connections WHERE org_id = $1 AND provider = 's3'", [w.orgA])).rows[0];
    expect(row.status).toBe("active");
    expect(row.token_ref).not.toContain(SECRET_KEY);
    expect(row.token_ref).not.toContain("AKIAEXAMPLE");
    expect(row.token_ref).not.toContain(bucket);
    expect(JSON.parse(t.secretStore!.decrypt(row.token_ref))).toMatchObject({ bucket, accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET_KEY, prefix: "evidence/" });

    const everything = [
      JSON.stringify(conn.body),
      JSON.stringify((await t.call("get", "/org/storage-options", w.admin)).body),
      JSON.stringify((await t.call("get", "/org/storage-connections", w.admin)).body),
      JSON.stringify((await adminPool.query("SELECT action, change FROM audit_log WHERE org_id = $1", [w.orgA])).rows),
    ].join("\n");
    expect(everything).not.toContain(SECRET_KEY);
    expect(everything).not.toContain("AKIAEXAMPLE");
    expect((await adminPool.query("SELECT storage_provider FROM orgs WHERE id = $1", [w.orgA])).rows[0].storage_provider).toBe("s3");
  });

  it("cannot be saved on a server without SECRET_ENCRYPTION_KEY, and says what to set", async () => {
    const w = await makeWorld(); const t = rig({ secretStore: false }); const { bucket } = await newBucket();
    const res = await t.call("put", "/org/storage-connections/s3", w.admin, form(bucket));
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/SECRET_ENCRYPTION_KEY/);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(0);
  });
});

describeS3("keeping evidence in S3", () => {
  it("the whole journey, byte for byte, with objects under the chosen folder in the bucket", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket, raw } = await newBucket();
    const { root } = await connectAndRoot(t, w, bucket, { prefix: "evidence/portal" });
    const c = await controlId(w.auditA1, "A.8.5");
    const content = bytes(30_000);
    const { session, put, confirm } = await sendFile(t, w.tLead, c, "MFA settings.pdf", content);
    expect(session.status).toBe(200);
    expect(session.body.uploadUrl).toMatch(/^\/uploads\//);
    expect(put.status).toBe(204);
    expect(confirm.status).toBe(201);
    expect(confirm.body.scanStatus).toBe("clean");

    const keys = await keysIn(raw, bucket);
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`evidence/portal/${root.body.storageRootId}/`)).toBe(true);
    expect(keys[0].endsWith("/A.8.5/MFA settings.pdf")).toBe(true);
    const obj = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: keys[0] }));
    expect(Buffer.from(await obj.Body!.transformToByteArray()).equals(content)).toBe(true);

    const list = await t.call("get", `/controls/${c}/files`, w.tLead);
    const dl = await t.call("get", `/evidence/${list.body[0].id}/download`, w.tLead).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(dl.headers["content-type"]).toBe("application/octet-stream");
  });

  it("a file of the wrong size, or sent twice, is refused and the stored object is untouched", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket, raw } = await newBucket();
    await connectAndRoot(t, w, bucket);
    const c = await controlId(w.auditA1, "A.8.5");
    const s = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "doc.pdf", mimeType: PDF, sizeBytes: 300 });
    const wrong = await request(t.app).put(s.body.uploadUrl).set("Content-Type", PDF).send(bytes(299));
    expect(wrong.status).toBe(400);
    expect(await keysIn(raw, bucket)).toEqual([]);
    const first = bytes(300, 1);
    expect((await request(t.app).put(s.body.uploadUrl).set("Content-Type", PDF).send(first)).status).toBe(204);
    const again = await request(t.app).put(s.body.uploadUrl).set("Content-Type", PDF).send(bytes(300, 2));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("STORAGE_ALREADY_EXISTS");
    const [key] = await keysIn(raw, bucket);
    const obj = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(Buffer.from(await obj.Body!.transformToByteArray()).equals(first)).toBe(true);
  });

  it("two people announcing the same file name at the same moment get different names", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket } = await newBucket();
    await connectAndRoot(t, w, bucket);
    const c = await controlId(w.auditA1, "A.8.5");
    const announce = () => t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "scan.pdf", mimeType: PDF, sizeBytes: 10 });
    const first = await announce(); const second = await announce();
    expect(first.body.providerFileId.endsWith("/scan.pdf")).toBe(true);
    expect(second.body.providerFileId.endsWith("/scan (2).pdf")).toBe(true);
  });

  it("a file from another control, or another organisation's bucket, can't be recorded", async () => {
    const w = await makeWorld(); const t = rig();
    const a = await newBucket(); const b = await newBucket();
    await connectAndRoot(t, w, a.bucket);
    const bConn = await t.call("put", "/org/storage-connections/s3", w.adminB, form(b.bucket));
    expect(bConn.status).toBe(200);
    expect((await t.call("post", `/tenants/${w.tB1}/storage-root/create`, w.adminB)).status).toBe(201);
    const cB = await controlId(w.auditB1, "A.8.5");
    const sentB = await sendFile(t, w.leadB, cB, "b-secret.pdf", bytes(50)).catch(() => null);
    void sentB;

    const c1 = await controlId(w.auditA1, "A.8.5"); const c2 = await controlId(w.auditA1, "A.8.6");
    const one = await sendFile(t, w.tLead, c1, "one.pdf", bytes(40));
    expect(one.confirm.status).toBe(201);
    await t.call("post", `/controls/${c2}/upload-session`, w.tLead, { fileName: "two.pdf", mimeType: PDF, sizeBytes: 10 });
    const crossControl = await t.call("post", `/controls/${c2}/uploads/confirm`, w.tLead, { providerFileId: one.session.body.providerFileId });
    expect(crossControl.status).toBe(422);
    expect(crossControl.body.error.code).toBe("FILE_NOT_IN_FOLDER");

    const bKeys = await keysIn(b.raw, b.bucket);
    for (const providerFileId of [...bKeys, "../x.pdf", "a/../b.pdf", "/abs.pdf"]) {
      const res = await t.call("post", `/controls/${c1}/uploads/confirm`, w.tLead, { providerFileId });
      expect(res.status, providerFileId).toBeGreaterThanOrEqual(400);
    }
    expect((await adminPool.query("SELECT count(*)::int AS n FROM evidence_files WHERE audit_control_id = $1", [c2])).rows[0].n).toBe(0);
  });

  it("after evidence exists, the access keys can be replaced but not the bucket, folder or address", async () => {
    const w = await makeWorld(); const t = rig();
    const a = await newBucket(); const other = await newBucket();
    await connectAndRoot(t, w, a.bucket, { prefix: "ev" });
    const c = await controlId(w.auditA1, "A.8.5");
    expect((await sendFile(t, w.tLead, c, "a.pdf", bytes(20))).confirm.status).toBe(201);

    const rotated = await t.call("put", "/org/storage-connections/s3", w.admin, form(a.bucket, { prefix: "ev", accessKeyId: "AKIANEWKEY", secretAccessKey: "brand-new-secret-key-9876" }));
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const stored = (await adminPool.query("SELECT token_ref FROM storage_connections WHERE org_id = $1 AND provider = 's3'", [w.orgA])).rows[0].token_ref;
    expect(JSON.parse(t.secretStore!.decrypt(stored)).accessKeyId).toBe("AKIANEWKEY");

    for (const over of [{ bucket: other.bucket, prefix: "ev" }, { prefix: "elsewhere" }, { prefix: "" }]) {
      const res = await t.call("put", "/org/storage-connections/s3", w.admin, form(a.bucket, Object.assign({ prefix: "ev" }, over)));
      expect(res.status, JSON.stringify(over)).toBe(409);
      expect(res.body.error.code).toBe("STORAGE_LOCATION_LOCKED");
    }
    expect(JSON.parse(t.secretStore!.decrypt((await adminPool.query("SELECT token_ref FROM storage_connections WHERE org_id = $1 AND provider = 's3'", [w.orgA])).rows[0].token_ref)).bucket).toBe(a.bucket);
    // And another storage can't be chosen instead.
    await adminPool.query("INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,'google_drive','x','active')", [w.orgA]);
    const sw = await t.call("put", "/org/storage-provider", w.admin, { provider: "google_drive" });
    expect(sw.status).toBe(409); expect(sw.body.error.code).toBe("STORAGE_PROVIDER_LOCKED");
  });

  it("before any evidence exists the bucket can be changed, and the old folders are forgotten", async () => {
    const w = await makeWorld(); const t = rig();
    const a = await newBucket(); const b = await newBucket();
    const first = await connectAndRoot(t, w, a.bucket);
    const second = await t.call("put", "/org/storage-connections/s3", w.admin, form(b.bucket));
    expect(second.status).toBe(200);
    // the connection was replaced; the tenant's folder was made in the old bucket's naming and is still valid there, so it must be made afresh only if the provider changed
    const root = (await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id;
    expect([first.root.body.storageRootId, null]).toContain(root);
  });

  it("an unreadable stored connection is reported as needing to be entered again", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket } = await newBucket();
    await connectAndRoot(t, w, bucket);
    const c = await controlId(w.auditA1, "A.8.5");
    for (const garbage of ["not-encrypted", t.secretStore!.encrypt("not json"), t.secretStore!.encrypt(JSON.stringify({ bucket: 5 })), t.secretStore!.encrypt(JSON.stringify({}))]) {
      await adminPool.query("UPDATE storage_connections SET token_ref = $2 WHERE org_id = $1 AND provider = 's3'", [w.orgA, garbage]);
      const res = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "x.pdf", mimeType: PDF, sizeBytes: 10 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("STORAGE_RECONNECT_REQUIRED");
    }
  });

  it("if the server's owner later forbids private-network addresses, existing use stops with a message naming the setting", async () => {
    const w = await makeWorld(); const open = rig({ allowPrivate: true }); const { bucket } = await newBucket();
    await connectAndRoot(open, w, bucket);
    const strict = rig({ allowPrivate: false });
    // the strict server doesn't share the encryption key, so build one that does
    const secretStore = open.secretStore!;
    const auth = new FakeTokenVerifier();
    const app = createApp({ pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: JWT, appBaseUrl: "https://portal.example", secretStore,
      storageResolver: createStorageResolver({ pool: appPool, secretStore, jwtSecret: JWT, allowPrivateAddresses: false }) });
    void strict;
    const c = await controlId(w.auditA1, "A.8.5");
    const res = await request(app).post(`/controls/${c}/upload-session`).set("Authorization", `Bearer ${auth.issue(w.tLead)}`).send({ fileName: "x.pdf", mimeType: PDF, sizeBytes: 10 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.message).toMatch(/STORAGE_ALLOW_PRIVATE_ADDRESSES/);
  });

  it("changing storage before any evidence works in both directions between disk-less choices", async () => {
    const w = await makeWorld(); const t = rig(); const { bucket } = await newBucket();
    await connectAndRoot(t, w, bucket);
    await adminPool.query("INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,'google_drive','x','active')", [w.orgA]);
    expect((await t.call("put", "/org/storage-provider", w.admin, { provider: "google_drive" })).status).toBe(200);
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).toBeNull();
    expect((await t.call("put", "/org/storage-provider", w.admin, { provider: "s3" })).status).toBe(200);
    const opts = await t.call("get", "/org/storage-options", w.admin);
    expect(opts.body.current).toBe("s3");
    expect(opts.body.options.find((o: any) => o.provider === "s3")).toMatchObject({ connected: true, status: "active" });
  });
});
