import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { ClamAvScanner } from "../src/scan/clamav.ts";
import { FakeClamd, EICAR } from "../src/scan/fakeClamd.ts";
import type { Scanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { AppError } from "../src/errors.ts";
import * as evidence from "../src/services/evidence.ts";
import { createApp } from "../src/http/app.ts";

/**
 * The whole upload-confirmation path with the REAL ClamAV scanner (talking to FakeClamd over a real socket),
 * real Postgres and the real service code: what gets recorded as evidence, what gets refused, and — the
 * point of this file — what happens when the scanner is down.
 */

let clamd: FakeClamd;
beforeAll(async () => { clamd = await FakeClamd.start(); });
afterAll(async () => { await clamd.close(); await adminPool.end(); await appPool.end(); });
afterEach(() => { vi.restoreAllMocks(); clamd.fault = "none"; });

const clam = (over: Record<string, number> = {}) => new ClamAvScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 400, ...over });

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const e = await p.then(() => { throw new Error("expected the call to fail"); }, (x) => x);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  expect((e as AppError).status).toBe(status);
}

describe("confirming an upload with the real ClamAV scanner", () => {
  let w: World; let storage: InMemoryStorageProvider; let c: string;
  const recorded = async (name: string) =>
    (await adminPool.query("SELECT scan_status FROM evidence_files WHERE audit_control_id = $1 AND file_name = $2", [c, name])).rows;
  const upload = async (name: string, content: Buffer) => {
    const s = await evidence.requestUploadSession(appPool, w.contrib, storage, c, { fileName: name, mimeType: "application/pdf", sizeBytes: content.length || 1 });
    storage.uploadedBytes.set(s.providerFileId, content); // what the browser "uploaded" straight into storage
    return s.providerFileId;
  };

  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    storage = new InMemoryStorageProvider();
    c = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c);
  });

  it("a clean file is recorded with scan_status 'clean'", async () => {
    const id = await upload("policy.pdf", Buffer.from("an ordinary policy document"));
    const r = await evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id);
    expect(r.scan_status).toBe("clean");
    expect(await recorded("policy.pdf")).toEqual([{ scan_status: "clean" }]);
  });

  it("the file's CONTENT decides, not its name: EICAR under an innocent name is refused and never recorded", async () => {
    const id = await upload("quarterly-summary.pdf", Buffer.from(EICAR));
    await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id), "INFECTED_FILE", 422);
    expect(await recorded("quarterly-summary.pdf")).toHaveLength(0);
  });

  it("a file too big to scan is recorded as 'unscannable', so a reviewer sees it was not checked", async () => {
    const id = await upload("huge-export.pdf", Buffer.alloc(5000, 1));
    const r = await evidence.confirmUpload(appPool, w.contrib, storage, clam({ maxBytes: 1000 }), c, id);
    expect(r.scan_status).toBe("unscannable");
    expect(await recorded("huge-export.pdf")).toEqual([{ scan_status: "unscannable" }]);
  });

  describe("when the scanner is down", () => {
    it("the upload is NOT recorded — and the user gets a clear, retryable 503", async () => {
      const id = await upload("during-outage.pdf", Buffer.from("perfectly fine content"));
      clamd.fault = "mute";
      await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id), "SCANNER_UNAVAILABLE", 503);
      expect(await recorded("during-outage.pdf")).toHaveLength(0);
    });

    it("once the scanner is back, confirming the SAME upload works, and it is recorded exactly once", async () => {
      const id = await upload("retry-me.pdf", Buffer.from("content"));
      clamd.fault = "mute";
      await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id), "SCANNER_UNAVAILABLE", 503);
      clamd.fault = "none";
      const r = await evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id);
      expect(r.scan_status).toBe("clean");
      expect(await recorded("retry-me.pdf")).toEqual([{ scan_status: "clean" }]);
    });

    it("a dead clamd (connection refused) and a scanner that returns nonsense are both treated as 'unavailable'", async () => {
      const id = await upload("dead.pdf", Buffer.from("content"));
      const dead = new ClamAvScanner({ host: "127.0.0.1", port: 1, timeoutMs: 400 });
      await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, dead, c, id), "SCANNER_UNAVAILABLE", 503);
      clamd.fault = "garbage";
      await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id), "SCANNER_UNAVAILABLE", 503);
      expect(await recorded("dead.pdf")).toHaveLength(0);
    });

    it("a scanner that blows up with an unexpected error fails closed too — and nothing sensitive is logged", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const exploding: Scanner = { async scan(name) { throw new Error(`kaboom while scanning ${name}`); } };
      const id = await upload("PAYROLL-2026.pdf", Buffer.from("content"));
      await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, exploding, c, id), "SCANNER_UNAVAILABLE", 503);
      expect(await recorded("PAYROLL-2026.pdf")).toHaveLength(0);
      expect(JSON.stringify(err.mock.calls)).not.toContain("PAYROLL");
    });

    it("the log says the scanner failed, without the file's name", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      clamd.fault = "garbage";
      const id = await upload("BOARD-MINUTES.pdf", Buffer.from("content"));
      await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, clam(), c, id), "SCANNER_UNAVAILABLE", 503);
      const logged = JSON.stringify(err.mock.calls);
      expect(logged).toContain("[scan]");
      expect(logged).not.toContain("BOARD-MINUTES");
    });
  });
});

describe("over HTTP", () => {
  it("confirm returns 503 SCANNER_UNAVAILABLE while the scanner is down, then 201 once it's back", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    const storage = new InMemoryStorageProvider();
    const auth = new FakeTokenVerifier();
    const app = createApp({ pool: appPool, storage, scanner: clam(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
    const c = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c);
    const bearer = `Bearer ${auth.issue(w.contrib)}`;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const session = await request(app).post(`/controls/${c}/upload-session`).set("Authorization", bearer).send({ fileName: "mfa.pdf", mimeType: "application/pdf", sizeBytes: 20 });
    expect(session.status).toBe(200);

    clamd.fault = "mute";
    const down = await request(app).post(`/controls/${c}/uploads/confirm`).set("Authorization", bearer).send({ providerFileId: session.body.providerFileId });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("SCANNER_UNAVAILABLE");
    expect(down.body.error.message).toMatch(/try again/i);

    clamd.fault = "none";
    const up = await request(app).post(`/controls/${c}/uploads/confirm`).set("Authorization", bearer).send({ providerFileId: session.body.providerFileId });
    expect(up.status).toBe(201);
    expect(up.body.scan_status ?? up.body.scanStatus).toBe("clean");
  });
});
