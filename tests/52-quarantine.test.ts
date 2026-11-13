import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { AppError } from "../src/errors.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { GoogleDriveProvider } from "../src/storage/googleDrive.ts";
import { FakeDriveApi } from "../src/storage/fakeDriveApi.ts";
import { LazyStorageProvider } from "../src/storage/lazyProvider.ts";
import { StorageError } from "../src/storage/types.ts";
import { EICAR_TEST_STRING, FakeScanner, ScannerUnavailableError, type Scanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { createApp } from "../src/http/app.ts";
import { auditFolderName } from "../src/services/folderNames.ts";
import * as evidence from "../src/services/evidence.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

async function appError(p: Promise<unknown>): Promise<AppError> {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err, "expected an AppError to be thrown").toBeInstanceOf(AppError);
  return err as AppError;
}

const logFor = async (w: World, action: string, control?: string) =>
  (await adminPool.query(
    "SELECT actor_id, tenant_id, entity, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id=$3) ORDER BY seq",
    [w.orgA, action, control ?? null])).rows;
const recorded = async (control: string) =>
  (await adminPool.query("SELECT file_name, scan_status FROM evidence_files WHERE audit_control_id=$1 ORDER BY uploaded_at", [control])).rows;

describe("a file that malware scanning flags is quarantined", () => {
  let w: World; let storage: InMemoryStorageProvider; const scanner = new FakeScanner();
  const upload = async (control: string, name: string, bytes?: Buffer) => {
    const s = await evidence.requestUploadSession(appPool, w.contrib, storage, control, { fileName: name, mimeType: "application/pdf", sizeBytes: 10 });
    if (bytes) storage.setBytes(s.providerFileId, bytes);
    return s.providerFileId;
  };
  const folderOf = async (control: string) => (await adminPool.query("SELECT folder_id FROM audit_controls WHERE id=$1", [control])).rows[0].folder_id as string;

  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    storage = new InMemoryStorageProvider();
  });

  it("is refused, moved out of the evidence folder, never recorded, and says where it went", async () => {
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);
    const good = await upload(c, "good.pdf");
    await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, good);
    const bad = await upload(c, "infected-report.pdf");
    const err = await appError(evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, bad));
    expect(err.code).toBe("INFECTED_FILE");
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/moved to the trash of your storage/);
    expect(storage.isQuarantined(bad)).toBe(true);
    expect(storage.isQuarantined(good)).toBe(false);
    // the evidence folder holds only the clean file, and only that is recorded
    expect((await storage.listFiles(await folderOf(c))).map((f) => f.providerFileId)).toEqual([good]);
    expect(await recorded(c)).toEqual([{ file_name: "good.pdf", scan_status: "clean" }]);
  });

  it("is decided by the file's content, not its name", async () => {
    const c = await controlId(w.auditA1, "A.8.6"); await assignContributor(w, c);
    const id = await upload(c, "quarterly-summary.pdf", Buffer.from(EICAR_TEST_STRING));
    expect((await appError(evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, id))).code).toBe("INFECTED_FILE");
    expect(storage.isQuarantined(id)).toBe(true);
  });

  it("is written to the audit log with who, which control, which file and that it was quarantined", async () => {
    const c = await controlId(w.auditA1, "A.8.7"); await assignContributor(w, c);
    const id = await upload(c, "infected-notes.pdf");
    await appError(evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, id));
    const log = await logFor(w, "evidence.infected", c);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: w.contrib, tenant_id: w.tA1, entity: "audit_control", entity_id: c, change: { fileName: "infected-notes.pdf", quarantined: true } });
    expect(await logFor(w, "evidence.uploaded", c)).toEqual([]); // and it was never logged as evidence
  });

  it("if the storage service can't move it, the upload is still refused and the person is told to delete it themselves", async () => {
    const c = await controlId(w.auditA1, "A.8.8"); await assignContributor(w, c);
    const id = await upload(c, "infected-again.pdf");
    storage.failQuarantine = true;
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await appError(evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, id));
      expect(err.code).toBe("INFECTED_FILE");
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/could NOT be moved/);
      expect(err.message).toMatch(/delete it there/);
      expect(err.message).not.toMatch(/moved to the trash/);
      // the server log gets one generic line: no file name, no file id, nothing the storage service said
      expect(logs.mock.calls).toEqual([["[quarantine] could not move a flagged file to the trash (PROVIDER_UNAVAILABLE)"]]);
    } finally { storage.failQuarantine = false; logs.mockRestore(); }
    expect(storage.isQuarantined(id)).toBe(false);
    expect(await recorded(c)).toEqual([]);
    expect((await logFor(w, "evidence.infected", c))[0].change).toEqual({ fileName: "infected-again.pdf", quarantined: false });
  });

  it("a clean file is left where it is, recorded, and nothing is logged as infected", async () => {
    const c = await controlId(w.auditA1, "A.8.9"); await assignContributor(w, c);
    const id = await upload(c, "policy.pdf");
    const r = await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, id);
    expect(r.scan_status).toBe("clean");
    expect(storage.isQuarantined(id)).toBe(false);
    expect(await logFor(w, "evidence.infected", c)).toEqual([]);
  });

  it("a file that could not be scanned is recorded for manual review, not quarantined", async () => {
    const c = await controlId(w.auditA1, "A.8.10"); await assignContributor(w, c);
    const id = await upload(c, "unscannable-archive.pdf");
    const r = await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, id);
    expect(r.scan_status).toBe("unscannable");
    expect(storage.isQuarantined(id)).toBe(false);
    expect(await logFor(w, "evidence.infected", c)).toEqual([]);
  });

  it("when the scanner is down nothing is quarantined: 'couldn't check' is not 'infected'", async () => {
    const c = await controlId(w.auditA1, "A.8.11"); await assignContributor(w, c);
    const id = await upload(c, "report.pdf");
    const down: Scanner = { scan: async () => { throw new ScannerUnavailableError("scanner is down"); } };
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await appError(evidence.confirmUpload(appPool, w.contrib, storage, down, c, id))).code).toBe("SCANNER_UNAVAILABLE");
    } finally { logs.mockRestore(); }
    expect(storage.isQuarantined(id)).toBe(false);
    expect(await logFor(w, "evidence.infected", c)).toEqual([]);
  });

  it("a person without access to the control cannot trigger a quarantine", async () => {
    const c = await controlId(w.auditA1, "A.8.12"); // contrib is NOT assigned to this one
    const id = await upload(await controlId(w.auditA1, "A.8.5"), "infected-x.pdf");
    expect((await appError(evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, id))).code).toBe("NOT_FOUND");
    expect(storage.isQuarantined(id)).toBe(false);
  });

  it("the audit log chain stays intact", async () => {
    expect((await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA])).rows[0].bad).toBeNull();
  });
});

describe("quarantine over HTTP", () => {
  it("answers 422 with the explanation, and the file is in the trash", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    const storage = new InMemoryStorageProvider(); const auth = new FakeTokenVerifier();
    const app = createApp({ pool: appPool, storage, scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
    const c = await controlId(w.auditA1, "A.8.7"); await assignContributor(w, c);
    const headers = { Authorization: `Bearer ${auth.issue(w.contrib)}` };
    const session = await request(app).post(`/controls/${c}/upload-session`).set(headers).send({ fileName: "infected-evidence.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const confirm = await request(app).post(`/controls/${c}/uploads/confirm`).set(headers).send({ providerFileId: session.body.providerFileId });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.code).toBe("INFECTED_FILE");
    expect(confirm.body.error.message).toMatch(/moved to the trash of your storage/);
    expect(storage.isQuarantined(session.body.providerFileId)).toBe(true);
  });
});

describe("quarantine in Google Drive", () => {
  const noSleep = { retries: 3, baseDelayMs: 1, sleep: async () => undefined };
  function setup() {
    const api = new FakeDriveApi();
    api.seedFolder("root-1", "Client");
    return { api, provider: new GoogleDriveProvider(async () => "fake-token", api.fetcher, noSleep) };
  }
  const put = async (provider: GoogleDriveProvider, name: string) => {
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    const s = await provider.createUploadSession(folder.id, name, "application/pdf", 10);
    return { folder, id: s.providerFileId };
  };

  it("moves the file to the Drive trash with one authorised request, and the folder no longer lists it", async () => {
    const { api, provider } = setup();
    const keep = await put(provider, "keep.pdf"); const bad = await put(provider, "bad.pdf");
    await provider.quarantineFile(bad.id);
    expect(api.isTrashed(bad.id)).toBe(true);
    expect(api.isTrashed(keep.id)).toBe(false);
    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain(`/drive/v3/files/${bad.id}`);
    expect(patches[0].auth).toBe("Bearer fake-token");
    expect((await provider.listFiles(bad.folder.id)).map((f) => f.providerFileId)).toEqual([keep.id]);
  });

  it("sends exactly 'trashed: true' — it moves the file to the bin, it does not delete it", async () => {
    const bodies: string[] = [];
    const { api } = setup();
    const spy: typeof fetch = async (input, init) => { if (init?.method === "PATCH") bodies.push(String(init.body)); return api.fetcher(input, init); };
    const provider = new GoogleDriveProvider(async () => "fake-token", spy, noSleep);
    const bad = await put(provider, "bad.pdf");
    await provider.quarantineFile(bad.id);
    expect(bodies).toEqual([JSON.stringify({ trashed: true })]);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("keeps trying through a temporary Drive failure", async () => {
    const { api, provider } = setup();
    const bad = await put(provider, "bad.pdf");
    api.queueFailure(503, 2);
    await provider.quarantineFile(bad.id);
    expect(api.isTrashed(bad.id)).toBe(true);
  });

  it("reports a file that doesn't exist, and a Drive that refuses", async () => {
    const { api, provider } = setup();
    await expect(provider.quarantineFile("no-such-file")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const bad = await put(provider, "bad.pdf");
    api.queueFailure(403);
    const err = await provider.quarantineFile(bad.id).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(api.isTrashed(bad.id)).toBe(false);
  });

  it("is passed on by the lazy provider", async () => {
    const { api, provider } = setup();
    const bad = await put(provider, "bad.pdf");
    await new LazyStorageProvider(async () => provider).quarantineFile(bad.id);
    expect(api.isTrashed(bad.id)).toBe(true);
  });

  it("end to end with the upload flow: a flagged file lands in the trash of the firm's Drive", async () => {
    const w = await makeWorld();
    const api = new FakeDriveApi(); api.seedFolder("drive-root", "Client folder");
    const provider = new GoogleDriveProvider(async () => "fake-token", api.fetcher, noSleep);
    await adminPool.query("UPDATE tenants SET storage_root_id = 'drive-root' WHERE id = $1", [w.tA1]);
    const c = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c);
    const s = await evidence.requestUploadSession(appPool, w.contrib, provider, c, { fileName: "infected-doc.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const err = await appError(evidence.confirmUpload(appPool, w.contrib, provider, new FakeScanner(), c, s.providerFileId));
    expect(err.code).toBe("INFECTED_FILE");
    expect(api.isTrashed(s.providerFileId)).toBe(true);
    const cycle = await provider.findOrCreateFolder("drive-root", auditFolderName("A1 audit", w.auditA1));
    expect(await provider.listFiles((await provider.findOrCreateFolder(cycle.id, "A.8.5")).id)).toEqual([]);
  });
});
