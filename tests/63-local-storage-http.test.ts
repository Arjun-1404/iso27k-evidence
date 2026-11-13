import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { adminPool, appPool, makeWorld, controlId, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { createStorageResolver } from "../src/storage/resolver.ts";
import { signUploadToken } from "../src/storage/uploadTokens.ts";
import { isSafeSegment } from "../src/storage/safeNames.ts";

/**
 * "Keep the evidence on this server's own disk", end to end through the real app: choosing it, creating the folders,
 * sending a file, recording it, downloading it, and everything that must NOT work (links that were altered, files that
 * belong somewhere else, people who may not see a file, switching storage after evidence exists).
 */
afterAll(async () => { await adminPool.end(); await appPool.end(); });

const JWT = "test-jwt-secret-test-jwt-secret-1234";
const tmpDirs: string[] = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

function rig(opts: { localDir?: string | null; secretStore?: boolean } = {}) {
  const auth = new FakeTokenVerifier();
  const localDir = opts.localDir === null ? undefined : (opts.localDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "portal-local-")));
  if (localDir && !opts.localDir) tmpDirs.push(localDir);
  const secretStore = opts.secretStore === false ? undefined : new AesSecretStore(randomBytes(32).toString("hex"));
  const app = createApp({
    pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth,
    jwtSecret: JWT, appBaseUrl: "https://portal.example", secretStore,
    storageResolver: createStorageResolver({ pool: appPool, secretStore, jwtSecret: JWT, localStorageDir: localDir }),
    storageOptions: { localStorageDir: localDir },
  });
  const bearer = (u: string) => `Bearer ${auth.issue(u)}`;
  const call = (method: "get" | "post" | "put" | "patch", p: string, userId: string, body?: object) => {
    const r = request(app)[method](p).set("Authorization", bearer(userId));
    return body ? r.send(body) : r;
  };
  return { app, auth, localDir, call, bearer };
}
type Rig = ReturnType<typeof rig>;

const PDF = "application/pdf";
const bytes = (n: number, seed = 7) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));

/** Admin chooses the disk and creates tenant A1's evidence folder. */
async function chooseDiskAndRoot(t: Rig, w: World) {
  const chosen = await t.call("post", "/org/storage-connections/local", w.admin);
  expect(chosen.status).toBe(200);
  const root = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
  expect(root.status).toBe(201);
  return { orgFolder: chosen.body.folder as string, storageRootId: root.body.storageRootId as string };
}

/** Announces, sends and records one file. Returns each step's response so tests can look at any of them. */
async function sendFile(t: Rig, userId: string, control: string, name: string, content: Buffer, mime = PDF) {
  const session = await t.call("post", `/controls/${control}/upload-session`, userId, { fileName: name, mimeType: mime, sizeBytes: content.length });
  if (session.status !== 200 && session.status !== 201) return { session };
  const put = await request(t.app).put(session.body.uploadUrl).set("Content-Type", mime).send(content);
  const confirm = await t.call("post", `/controls/${control}/uploads/confirm`, userId, { providerFileId: session.body.providerFileId });
  return { session, put, confirm };
}

/** A real PUT with no Content-Length (chunked), which supertest can't make. */
function chunkedPut(app: Rig["app"], urlPath: string, chunks: Buffer[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const req = http.request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: urlPath, method: "PUT", headers: { "Transfer-Encoding": "chunked", "Content-Type": PDF } }, (res) => {
        res.resume(); res.on("end", () => { server.close(); resolve(res.statusCode ?? 0); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      for (const c of chunks) req.write(c);
      req.end();
    });
  });
}

const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));

describe("what an org admin can choose", () => {
  it("sees the choices, and only an org admin may see or change them", async () => {
    const w = await makeWorld(); const t = rig();
    const res = await t.call("get", "/org/storage-options", w.admin);
    expect(res.status).toBe(200);
    expect(res.body.current).toBe("google_drive");
    expect(res.body.locked).toBe(false);
    const by = Object.fromEntries(res.body.options.map((o: any) => [o.provider, o]));
    expect(by.local.available).toBe(true);
    expect(by.s3.available).toBe(true);
    expect(by.sharepoint.available).toBe(false);
    expect(by.sharepoint.unavailableReason).toMatch(/later release/);
    expect(by.google_drive.available).toBe(false); // this rig has no Google app configured
    for (const u of [w.lead, w.auditor, w.readOnly, w.dash, w.tLead, w.contrib, w.viewer, w.tDash]) {
      expect((await t.call("get", "/org/storage-options", u)).status, u).toBe(403);
      expect((await t.call("post", "/org/storage-connections/local", u)).status, u).toBe(403);
      expect((await t.call("put", "/org/storage-provider", u, { provider: "local" })).status, u).toBe(403);
    }
    expect((await adminPool.query("SELECT storage_provider FROM orgs WHERE id = $1", [w.orgA])).rows[0].storage_provider).toBe("google_drive");
  });

  it("says plainly when the server's owner has not switched the disk option on, and refuses it", async () => {
    const w = await makeWorld(); const t = rig({ localDir: null });
    const opts = await t.call("get", "/org/storage-options", w.admin);
    const local = opts.body.options.find((o: any) => o.provider === "local");
    expect(local.available).toBe(false);
    expect(local.unavailableReason).toMatch(/LOCAL_STORAGE_DIR/);
    const res = await t.call("post", "/org/storage-connections/local", w.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LOCAL_STORAGE_NOT_CONFIGURED");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(0);
  });

  it("choosing the disk makes the organisation's own folder, switches the org to it and writes the audit trail", async () => {
    const w = await makeWorld(); const t = rig();
    const res = await t.call("post", "/org/storage-connections/local", w.admin);
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("local");
    expect(path.dirname(res.body.folder)).toBe(t.localDir);
    expect(path.basename(res.body.folder)).toBe(`Org A ${w.tag} [${w.orgA.slice(0, 8)}]`);
    expect(fs.statSync(res.body.folder).isDirectory()).toBe(true);
    expect(fs.readdirSync(res.body.folder)).toEqual([]); // the write test left nothing behind
    expect((await adminPool.query("SELECT storage_provider FROM orgs WHERE id = $1", [w.orgA])).rows[0].storage_provider).toBe("local");
    const log = await adminPool.query("SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'org.storage%' ORDER BY created_at", [w.orgA]);
    expect(log.rows.map((r) => r.action).sort()).toEqual(["org.storage_connected", "org.storage_provider_changed"]);
    const opts = await t.call("get", "/org/storage-options", w.admin);
    expect(opts.body.current).toBe("local");
    expect(opts.body.options.find((o: any) => o.provider === "local")).toMatchObject({ connected: true, status: "active", label: "This server's disk" });
  });

  it("keeps the same folder when it is chosen again, even after the organisation is renamed", async () => {
    const w = await makeWorld(); const t = rig();
    const first = await t.call("post", "/org/storage-connections/local", w.admin);
    await adminPool.query("UPDATE orgs SET name = 'Completely New Name' WHERE id = $1", [w.orgA]);
    const second = await t.call("post", "/org/storage-connections/local", w.admin);
    expect(second.body.folder).toBe(first.body.folder);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(1);
  });

  it("an organisation name that is unsafe as a folder name still gets a safe folder inside the evidence folder", async () => {
    const w = await makeWorld(); const t = rig();
    await adminPool.query("UPDATE orgs SET name = $2 WHERE id = $1", [w.orgA, "../../etc/CON: <Evil>?*"]);
    const res = await t.call("post", "/org/storage-connections/local", w.admin);
    expect(res.status).toBe(200);
    expect(path.dirname(res.body.folder)).toBe(t.localDir);     // one folder directly inside the evidence folder, nothing climbs out
    expect(isSafeSegment(path.basename(res.body.folder))).toBe(true);
    expect(path.basename(res.body.folder)).not.toMatch(/[<>:?*\\/]/);
  });

  it("two organisations on one server get separate folders", async () => {
    const w = await makeWorld(); const t = rig();
    const a = await t.call("post", "/org/storage-connections/local", w.admin);
    const b = await t.call("post", "/org/storage-connections/local", w.adminB);
    expect(a.body.folder).not.toBe(b.body.folder);
    expect(path.dirname(a.body.folder)).toBe(path.dirname(b.body.folder));
  });

  it("works on a server with no SECRET_ENCRYPTION_KEY (the disk needs no stored secret)", async () => {
    const w = await makeWorld(); const t = rig({ secretStore: false });
    const opts = await t.call("get", "/org/storage-options", w.admin);
    expect(opts.body.options.find((o: any) => o.provider === "s3").available).toBe(false);
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const sent = await sendFile(t, w.tLead, c, "policy.pdf", bytes(500));
    expect(sent.confirm!.status).toBe(201);
  });

  it("refuses a folder the portal can't write to, and changes nothing", async () => {
    const w = await makeWorld();
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), "portal-blocker-")); tmpDirs.push(blocker);
    const asFile = path.join(blocker, "a-file"); fs.writeFileSync(asFile, "x");
    const t = rig({ localDir: asFile }); // a FILE where the evidence folder should be
    const res = await t.call("post", "/org/storage-connections/local", w.admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("LOCAL_STORAGE_UNUSABLE");
    expect((await adminPool.query("SELECT storage_provider FROM orgs WHERE id = $1", [w.orgA])).rows[0].storage_provider).toBe("google_drive");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w.orgA])).rows[0].n).toBe(0);
  });
});

describe("sending, recording and downloading a file", () => {
  it("the whole journey: folder → announce → send → record → list → download, byte for byte", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder, storageRootId } = await chooseDiskAndRoot(t, w);
    expect(fs.existsSync(path.join(orgFolder, storageRootId))).toBe(true);

    const c = await controlId(w.auditA1, "A.8.5");
    const content = bytes(20_000);
    const { session, put, confirm } = await sendFile(t, w.tLead, c, "MFA settings.pdf", content);
    expect(session.status).toBe(200);
    expect(session.body.uploadUrl).toMatch(/^\/uploads\/[\w-]+\.[\w-]+$/);
    expect(session.body.method).toBe("PUT");
    expect(put!.status).toBe(204);
    expect(confirm!.status).toBe(201);
    expect(confirm!.body.scanStatus).toBe("clean");

    // The file sits where an administrator would look for it, under the audit cycle and control, with its real name.
    const onDisk = filesUnder(orgFolder);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toContain(`${path.sep}A.8.5${path.sep}MFA settings.pdf`);
    expect(fs.readFileSync(onDisk[0]).equals(content)).toBe(true);

    const list = await t.call("get", `/controls/${c}/files`, w.tLead);
    expect(list.body).toHaveLength(1);
    const fileId = list.body[0].id as string;

    const dl = await t.call("get", `/evidence/${fileId}/download`, w.tLead).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (d: Buffer) => chunks.push(d)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
    expect(dl.headers["content-type"]).toBe("application/octet-stream");
    expect(dl.headers["content-disposition"]).toBe(`attachment; filename="MFA settings.pdf"; filename*=UTF-8''MFA%20settings.pdf`);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(dl.headers["cache-control"]).toBe("no-store");
    expect(dl.headers["content-length"]).toBe(String(content.length));

    const log = await adminPool.query("SELECT actor_id, entity_id, change FROM audit_log WHERE org_id = $1 AND action = 'evidence.downloaded'", [w.orgA]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].actor_id).toBe(w.tLead);
    expect(log.rows[0].entity_id).toBe(fileId);
  });

  it("two files with the same name in one control are both kept", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const one = await sendFile(t, w.tLead, c, "scan.pdf", bytes(100, 1));
    const two = await sendFile(t, w.tLead, c, "scan.pdf", bytes(100, 2));
    expect(one.confirm!.status).toBe(201); expect(two.confirm!.status).toBe(201);
    expect(filesUnder(orgFolder).map((f) => path.basename(f)).sort()).toEqual(["scan (2).pdf", "scan.pdf"]);
  });

  it("two people announcing the same file name at the same moment get different names, even though each request is handled on its own", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const announce = () => t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "scan.pdf", mimeType: PDF, sizeBytes: 10 });
    const first = await announce(); const second = await announce();
    expect(first.body.providerFileId.endsWith("/scan.pdf")).toBe(true);
    expect(second.body.providerFileId.endsWith("/scan (2).pdf")).toBe(true);
  });

  it("a download name with quotes, line breaks and non-ASCII letters cannot break out of the header", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    // A name with a line break never gets as far as being stored...
    const crlf = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "a.pdf\r\nSet-Cookie: x=1.pdf", mimeType: PDF, sizeBytes: 50 });
    expect(crlf.status).toBe(422);
    // ...and quotes, semicolons and non-ASCII letters are carried safely.
    const sent = await sendFile(t, w.tLead, c, 'Zoë "final"; draft.pdf', bytes(50));
    expect(sent.confirm!.status).toBe(201);
    const list = await t.call("get", `/controls/${c}/files`, w.tLead);
    const dl = await t.call("get", `/evidence/${list.body[0].id}/download`, w.tLead);
    expect(dl.status).toBe(200);
    expect(dl.headers["set-cookie"]).toBeUndefined();
    expect(dl.headers["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="[A-Za-z0-9._ -]+"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
  });

  it("the announcement is checked against the control's requirement before anything is created", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const tooBig = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "big.pdf", mimeType: PDF, sizeBytes: 26 * 1024 * 1024 });
    expect(tooBig.status).toBe(422);
    const exe = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "run.exe", mimeType: "application/x-msdownload", sizeBytes: 100 });
    expect(exe.status).toBe(422);
    expect(filesUnder(orgFolder)).toEqual([]);
  });
});

describe("upload links that must not work", () => {
  async function announced(t: Rig, w: World, size = 300) {
    const c = await controlId(w.auditA1, "A.8.5");
    const s = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "doc.pdf", mimeType: PDF, sizeBytes: size });
    return { c, url: s.body.uploadUrl as string, providerFileId: s.body.providerFileId as string };
  }

  it("a link whose signature was altered is refused, and nothing is written", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const { url } = await announced(t, w);
    for (const bad of [url.slice(0, -2) + (url.endsWith("AA") ? "BB" : "AA"), url.replace("/uploads/", "/uploads/x"), "/uploads/not-a-token", "/uploads/a.b"]) {
      const res = await request(t.app).put(bad).set("Content-Type", PDF).send(bytes(300));
      expect(res.status, bad).toBe(403);
      expect(res.body.error.code).toBe("UPLOAD_LINK_INVALID");
    }
    expect(filesUnder(orgFolder)).toEqual([]);
  });

  it("a link that has expired is refused", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const { providerFileId } = await announced(t, w);
    const target = { providerFileId, folderId: path.posix.dirname(providerFileId), fileName: "doc.pdf", mimeType: PDF, sizeBytes: 300 };
    const stale = signUploadToken(JWT, { userId: w.tLead, target, expiresAt: Date.now() - 1000 });
    const res = await request(t.app).put(`/uploads/${stale}`).set("Content-Type", PDF).send(bytes(300));
    expect(res.status).toBe(403);
    expect(filesUnder(orgFolder)).toEqual([]);
  });

  it("a link signed with another server's secret is refused", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const { providerFileId } = await announced(t, w);
    const forged = signUploadToken("some-other-servers-secret-some-other-secret", { userId: w.tLead, target: { providerFileId, folderId: path.posix.dirname(providerFileId), fileName: "doc.pdf", mimeType: PDF, sizeBytes: 300 }, expiresAt: Date.now() + 60_000 });
    expect((await request(t.app).put(`/uploads/${forged}`).set("Content-Type", PDF).send(bytes(300))).status).toBe(403);
  });

  it("a file of a different size than announced is refused, and no partial file is left", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const { url } = await announced(t, w, 300);
    for (const n of [299, 301, 5_000]) {
      const res = await request(t.app).put(url).set("Content-Type", PDF).send(bytes(n));
      expect(res.status, String(n)).toBe(400);
      expect(res.body.error.code).toBe("UPLOAD_SIZE_MISMATCH");
    }
    expect(filesUnder(orgFolder)).toEqual([]);
  });

  it("an upload that doesn't say how large it is (chunked) is refused", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const { url } = await announced(t, w, 300);
    expect(await chunkedPut(t.app, url, [bytes(150), bytes(150)])).toBe(411);
    expect(filesUnder(orgFolder)).toEqual([]);
  });

  it("a link can be used once: sending again can't overwrite the file that arrived", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const { url } = await announced(t, w, 300);
    const first = bytes(300, 1);
    expect((await request(t.app).put(url).set("Content-Type", PDF).send(first)).status).toBe(204);
    const second = await request(t.app).put(url).set("Content-Type", PDF).send(bytes(300, 2));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("STORAGE_ALREADY_EXISTS");
    const [file] = filesUnder(orgFolder);
    expect(fs.readFileSync(file).equals(first)).toBe(true);
  });

  it("a person who has been disabled since the link was made can no longer use it", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const { url } = await announced(t, w);
    await adminPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [w.tLead]);
    const res = await request(t.app).put(url).set("Content-Type", PDF).send(bytes(300));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(filesUnder(orgFolder)).toEqual([]);
  });

  it("the link needs no sign-in header, and a browser from the allowed origin may use it (preflight answered)", async () => {
    const w = await makeWorld();
    const auth = new FakeTokenVerifier();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-local-")); tmpDirs.push(dir);
    const secretStore = new AesSecretStore(randomBytes(32).toString("hex"));
    const app = createApp({ pool: appPool, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: JWT, appBaseUrl: "https://portal.example", secretStore,
      corsAllowedOrigins: ["https://portal.example"], storageResolver: createStorageResolver({ pool: appPool, secretStore, jwtSecret: JWT, localStorageDir: dir }), storageOptions: { localStorageDir: dir } });
    const pre = await request(app).options("/uploads/anything").set("Origin", "https://portal.example").set("Access-Control-Request-Method", "PUT").set("Access-Control-Request-Headers", "content-type");
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://portal.example");
    expect(pre.headers["access-control-allow-methods"]).toMatch(/PUT/);
    const evil = await request(app).options("/uploads/anything").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "PUT");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    void w;
  });
});

describe("a file can only be recorded where it was sent", () => {
  it("naming a file that belongs to another control is refused (and the file is not recorded)", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const c1 = await controlId(w.auditA1, "A.8.5"); const c2 = await controlId(w.auditA1, "A.8.6");
    const sent = await sendFile(t, w.tLead, c1, "one.pdf", bytes(100));
    expect(sent.confirm!.status).toBe(201);
    // Make c2's folder exist, then try to record c1's file against c2.
    await t.call("post", `/controls/${c2}/upload-session`, w.tLead, { fileName: "two.pdf", mimeType: PDF, sizeBytes: 100 });
    const res = await t.call("post", `/controls/${c2}/uploads/confirm`, w.tLead, { providerFileId: sent.session.body.providerFileId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("FILE_NOT_IN_FOLDER");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM evidence_files WHERE audit_control_id = $1", [c2])).rows[0].n).toBe(0);
  });

  it("naming a control's file before anything was announced for it is refused", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const res = await t.call("post", `/controls/${c}/uploads/confirm`, w.tLead, { providerFileId: "anything/at/all.pdf" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("UPLOAD_NOT_STARTED");
  });

  it("another organisation's file can't be recorded, however its location is spelled", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    // Org B also keeps its evidence on this disk.
    const bChosen = await t.call("post", "/org/storage-connections/local", w.adminB);
    const bRoot = await t.call("post", `/tenants/${w.tB1}/storage-root/create`, w.adminB);
    expect(bRoot.status).toBe(201);
    const cB = await controlId(w.auditB1, "A.8.5");
    const bSent = await sendFile(t, w.leadB, cB, "secret-b.pdf", bytes(100, 9)).catch(() => null);
    void bChosen; void bSent;
    const bFiles = filesUnder(bChosen.body.folder);

    const cA = await controlId(w.auditA1, "A.8.5");
    const announced = await t.call("post", `/controls/${cA}/upload-session`, w.tLead, { fileName: "mine.pdf", mimeType: PDF, sizeBytes: 100 });
    expect(announced.status).toBe(200);
    const orgBName = path.basename(bChosen.body.folder);
    const attempts = [
      `../${orgBName}/${bRoot.body.storageRootId}/x.pdf`,
      `${orgBName}/${bRoot.body.storageRootId}/x.pdf`,
      "../../../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "a/./b.pdf",
      "a//b.pdf",
      "a\\..\\b.pdf",
    ];
    for (const providerFileId of attempts) {
      const res = await t.call("post", `/controls/${cA}/uploads/confirm`, w.tLead, { providerFileId });
      expect(res.status, providerFileId).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toMatch(/root:|\[fonts\]/);
    }
    expect((await adminPool.query("SELECT count(*)::int AS n FROM evidence_files WHERE audit_control_id = $1", [cA])).rows[0].n).toBe(0);
    void bFiles;
  });

  it("a file sitting in the control's folder that arrived some other way is not trusted unless it was announced and sent", async () => {
    const w = await makeWorld(); const t = rig();
    const { orgFolder } = await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const s = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "doc.pdf", mimeType: PDF, sizeBytes: 100 });
    // Announced but never sent: there is nothing to record.
    const res = await t.call("post", `/controls/${c}/uploads/confirm`, w.tLead, { providerFileId: s.body.providerFileId });
    expect(res.status).toBe(404);
    expect(filesUnder(orgFolder)).toEqual([]);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM evidence_files WHERE audit_control_id = $1", [c])).rows[0].n).toBe(0);
  });
});

describe("who may download", () => {
  async function oneFile(t: Rig, w: World) {
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    const sent = await sendFile(t, w.tLead, c, "evidence.pdf", bytes(64));
    expect(sent.confirm!.status).toBe(201);
    return (await t.call("get", `/controls/${c}/files`, w.tLead)).body[0].id as string;
  }

  it("people with access to the control can; people from another tenant, another organisation, or with a dashboard-only role can't", async () => {
    const w = await makeWorld(); const t = rig();
    const id = await oneFile(t, w);
    for (const u of [w.tLead, w.admin, w.lead, w.auditor]) expect((await t.call("get", `/evidence/${id}/download`, u)).status, u).toBe(200);
    for (const u of [w.tLead2, w.adminB, w.leadB, w.tLeadB]) expect((await t.call("get", `/evidence/${id}/download`, u)).status, u).toBe(404);
    for (const u of [w.dash, w.tDash]) expect((await t.call("get", `/evidence/${id}/download`, u)).status, u).toBeGreaterThanOrEqual(400);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'evidence.downloaded' AND org_id = $1", [w.orgA])).rows[0].n).toBe(4);
  });

  it("an unknown or malformed file id is a plain refusal", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    expect((await t.call("get", "/evidence/00000000-0000-0000-0000-000000000000/download", w.tLead)).status).toBe(404);
    const bad = await t.call("get", "/evidence/not-a-uuid/download", w.tLead);
    expect(bad.status).toBeGreaterThanOrEqual(400); expect(bad.status).toBeLessThan(500);
  });

  it("a file that has disappeared from the disk is reported, not served empty; and the download is not logged", async () => {
    const w = await makeWorld(); const t = rig();
    const id = await oneFile(t, w);
    const { orgFolder } = { orgFolder: filesUnder(t.localDir!)[0] };
    fs.rmSync(orgFolder);
    const res = await t.call("get", `/evidence/${id}/download`, w.tLead);
    expect(res.status).toBe(404);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'evidence.downloaded' AND org_id = $1", [w.orgA])).rows[0].n).toBe(0);
  });

  it("the integrity check notices a file that was changed, replaced or removed on the disk (and not one that was merely touched)", async () => {
    const w = await makeWorld(); const t = rig();
    await oneFile(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    expect((await t.call("post", `/controls/${c}/submit`, w.tLead)).status).toBe(200);
    expect((await t.call("post", `/controls/${c}/reviews`, w.lead, { decision: "accept" })).status).toBe(201);
    const status = async () => (await adminPool.query("SELECT ac.status, ef.integrity_status FROM audit_controls ac JOIN evidence_files ef ON ef.audit_control_id = ac.id WHERE ac.id = $1", [c])).rows[0];
    const check = async () => (await t.call("post", `/audits/${w.auditA1}/integrity-check`, w.admin)).body as { evidenceFileId: string; changed: boolean }[];
    const [file] = filesUnder(t.localDir!);

    expect((await check()).map((r) => r.changed)).toEqual([false]);
    const now = new Date(); fs.utimesSync(file, now, now);                        // touched, same content
    expect((await check()).map((r) => r.changed)).toEqual([false]);
    expect(await status()).toMatchObject({ status: "accepted", integrity_status: "unchecked" });

    fs.appendFileSync(file, "tampered");                                          // changed
    expect((await check()).map((r) => r.changed)).toEqual([true]);
    expect(await status()).toMatchObject({ status: "under_review", integrity_status: "modified" });
  });

  it("a removed file is reported as missing", async () => {
    const w = await makeWorld(); const t = rig();
    await oneFile(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    await t.call("post", `/controls/${c}/submit`, w.tLead);
    await t.call("post", `/controls/${c}/reviews`, w.lead, { decision: "accept" });
    fs.rmSync(filesUnder(t.localDir!)[0]);
    const res = await t.call("post", `/audits/${w.auditA1}/integrity-check`, w.admin);
    expect(res.body.map((r: { changed: boolean }) => r.changed)).toEqual([true]);
    expect((await adminPool.query("SELECT integrity_status FROM evidence_files WHERE audit_control_id = $1", [c])).rows[0].integrity_status).toBe("missing");
  });
});

describe("choosing storage, and when it can no longer be changed", () => {
  const seedDrive = (orgId: string) => adminPool.query("INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,'google_drive','x','active') ON CONFLICT DO NOTHING", [orgId]);

  it("a storage that isn't connected can't be chosen", async () => {
    const w = await makeWorld(); const t = rig();
    const res = await t.call("put", "/org/storage-provider", w.admin, { provider: "s3" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STORAGE_NOT_CONNECTED");
    expect((await t.call("put", "/org/storage-provider", w.admin, { provider: "sharepoint" })).status).toBe(400);
    expect((await t.call("put", "/org/storage-provider", w.admin, {})).status).toBe(400);
  });

  it("before any evidence exists the choice can change freely; the folders of the old choice are forgotten", async () => {
    const w = await makeWorld(); const t = rig();
    const { storageRootId } = await chooseDiskAndRoot(t, w);
    await seedDrive(w.orgA);
    const to = await t.call("put", "/org/storage-provider", w.admin, { provider: "google_drive" });
    expect(to.status).toBe(200);
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).toBeNull();
    const back = await t.call("put", "/org/storage-provider", w.admin, { provider: "local" });
    expect(back.status).toBe(200);
    const again = await t.call("post", `/tenants/${w.tA1}/storage-root/create`, w.admin);
    expect(again.status).toBe(201);
    expect(again.body.storageRootId).not.toBe(storageRootId); // the earlier folder stays on disk; a new one is made rather than reusing its name
  });

  it("once a file is recorded the choice is locked: refused with a clear message, and nothing moves", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    expect((await sendFile(t, w.tLead, c, "a.pdf", bytes(10))).confirm!.status).toBe(201);
    await seedDrive(w.orgA);
    const res = await t.call("put", "/org/storage-provider", w.admin, { provider: "google_drive" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STORAGE_PROVIDER_LOCKED");
    expect(res.body.error.message).toMatch(/already has evidence/);
    expect((await adminPool.query("SELECT storage_provider FROM orgs WHERE id = $1", [w.orgA])).rows[0].storage_provider).toBe("local");
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).not.toBeNull();
    const opts = await t.call("get", "/org/storage-options", w.admin);
    expect(opts.body.locked).toBe(true);
    expect(opts.body.current).toBe("local");
    // Choosing the SAME storage again is harmless.
    expect((await t.call("put", "/org/storage-provider", w.admin, { provider: "local" })).status).toBe(200);
    expect((await t.call("post", "/org/storage-connections/local", w.admin)).status).toBe(200);
  });

  it("one organisation's evidence doesn't lock another organisation's choice", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const c = await controlId(w.auditA1, "A.8.5");
    expect((await sendFile(t, w.tLead, c, "a.pdf", bytes(10))).confirm!.status).toBe(201);
    const b = await t.call("post", "/org/storage-connections/local", w.adminB);
    expect(b.status).toBe(200);
    expect((await t.call("get", "/org/storage-options", w.adminB)).body.locked).toBe(false);
  });
});

describe("a damaged or unusable setup is reported, not guessed around", () => {
  it("a stored folder reference that isn't a plain folder name is refused (so nothing outside the evidence folder is ever used)", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    for (const bad of ["local:v1:../../etc", "local:v1:", "local:v1:a/b", "local:v1:/abs", "local:v2:x", "plain"]) {
      await adminPool.query("UPDATE storage_connections SET token_ref = $2 WHERE org_id = $1 AND provider = 'local'", [w.orgA, bad]);
      const c = await controlId(w.auditA1, "A.8.5");
      const res = await t.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "x.pdf", mimeType: PDF, sizeBytes: 10 });
      expect(res.status, bad).toBe(409);
      expect(res.body.error.code).toBe("STORAGE_RECONNECT_REQUIRED");
    }
  });

  it("if the server's owner later removes LOCAL_STORAGE_DIR, uploads say exactly what to fix", async () => {
    const w = await makeWorld(); const t = rig();
    await chooseDiskAndRoot(t, w);
    const without = rig({ localDir: null });
    const c = await controlId(w.auditA1, "A.8.5");
    const res = await without.call("post", `/controls/${c}/upload-session`, w.tLead, { fileName: "x.pdf", mimeType: PDF, sizeBytes: 10 });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/LOCAL_STORAGE_DIR/);
  });
});
