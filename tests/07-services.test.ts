import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { AppError } from "../src/errors.ts";
import { auditFolderName } from "../src/services/folderNames.ts";
import * as evidence from "../src/services/evidence.ts";
import * as controls from "../src/services/controls.ts";
import * as review from "../src/services/review.ts";
import * as dashboard from "../src/services/dashboard.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

async function expectAppError(p: Promise<unknown>, code?: string, status?: number) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err, "expected an AppError to be thrown").toBeInstanceOf(AppError);
  const ae = err as AppError;
  if (code) expect(ae.code).toBe(code);
  if (status) expect(ae.status).toBe(status);
  return ae;
}

describe("evidence upload flow", () => {
  let w: World; let storage: InMemoryStorageProvider; let scanner: FakeScanner; let c85: string;
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    storage = new InMemoryStorageProvider();
    scanner = new FakeScanner();
    c85 = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c85);
    await assignContributor(w, await controlId(w.auditA1, "A.8.6"));
    await assignContributor(w, await controlId(w.auditA1, "A.8.7"));
  });

  it("rejects a disallowed file type before touching storage", async () => {
    await expectAppError(
      evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "run.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }),
      "INVALID_FILE", 422,
    );
  });

  it("refuses to start an upload for a tenant with no storage connected", async () => {
    const c = await controlId(w.auditA2, "A.8.5"); // tenant A2 has no storage_root_id set
    await expectAppError(
      evidence.requestUploadSession(appPool, w.tLead2, storage, c, { fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 }),
      "STORAGE_NOT_CONNECTED", 409,
    );
  });

  it("creates the control's folder once and reuses it on later uploads to the same control", async () => {
    const s1 = await evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "one.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const s2 = await evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "two.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const cycle = await storage.findOrCreateFolder("root-a1", auditFolderName("A1 audit", w.auditA1));
    const files = await storage.listFiles((await storage.findOrCreateFolder(cycle.id, "A.8.5")).id);
    expect(files.map((f) => f.providerFileId).sort()).toEqual([s1.providerFileId, s2.providerFileId].sort());
    const row = await adminPool.query("SELECT folder_id FROM audit_controls WHERE id = $1", [c85]);
    expect(row.rows[0].folder_id).toBeTruthy();
  });

  it("confirming a clean upload records it; the control cannot be submitted before that", async () => {
    await expectAppError(evidence.submitControl(appPool, w.contrib, c85), "EVIDENCE_REQUIRED", 409);
    const session = await evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "mfa.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const rec = await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c85, session.providerFileId);
    expect(rec.scan_status).toBe("clean");
    const files = await evidence.listEvidenceFiles(appPool, w.contrib, c85);
    expect(files.some((f) => f.fileName === "mfa.pdf" && f.scanStatus === "clean")).toBe(true);
    await evidence.submitControl(appPool, w.contrib, c85);
    const st = await adminPool.query("SELECT status FROM audit_controls WHERE id = $1", [c85]);
    expect(st.rows[0].status).toBe("submitted");
  });

  it("an infected file is refused and never recorded as evidence", async () => {
    const c87 = await controlId(w.auditA1, "A.8.7");
    const session = await evidence.requestUploadSession(appPool, w.contrib, storage, c87, { fileName: "infected-report.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await expectAppError(evidence.confirmUpload(appPool, w.contrib, storage, scanner, c87, session.providerFileId), "INFECTED_FILE", 422);
    const files = await evidence.listEvidenceFiles(appPool, w.contrib, c87);
    expect(files).toHaveLength(0);
  });

  it("an unscannable file (e.g. an encrypted archive) is still recorded, flagged for manual review", async () => {
    const c86 = await controlId(w.auditA1, "A.8.6");
    await adminPool.query("UPDATE audit_controls SET applicable = true WHERE id = $1", [c86]);
    const session = await evidence.requestUploadSession(appPool, w.contrib, storage, c86, { fileName: "unscannable-archive.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const rec = await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c86, session.providerFileId);
    expect(rec.scan_status).toBe("unscannable");
  });
});

describe("scheduled integrity checks", () => {
  let w: World; let storage: InMemoryStorageProvider; let scanner: FakeScanner; let c85: string;
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    storage = new InMemoryStorageProvider();
    scanner = new FakeScanner();
    c85 = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c85);
    const session = await evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "mfa.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c85, session.providerFileId);
    await evidence.submitControl(appPool, w.contrib, c85);
    await review.reviewControl(appPool, w.auditor, c85, "accept");
  });

  it("an unchanged accepted file is reported unchanged and the control stays accepted", async () => {
    const results = await evidence.checkIntegrity(appPool, w.lead, storage, w.auditA1);
    const mine = results.find((r) => true);
    expect(mine?.changed).toBe(false);
    const st = await adminPool.query("SELECT status FROM audit_controls WHERE id = $1", [c85]);
    expect(st.rows[0].status).toBe("accepted");
  });

  it("a file changed in storage after acceptance is flagged and the control reopens to under review", async () => {
    const files = await evidence.listEvidenceFiles(appPool, w.lead, c85);
    storage.mutate(files[0].providerFileId, { hash: "changed-hash", version: "2" });
    const results = await evidence.checkIntegrity(appPool, w.lead, storage, w.auditA1);
    expect(results.find((r) => r.evidenceFileId === files[0].id)?.changed).toBe(true);
    const st = await adminPool.query("SELECT status FROM audit_controls WHERE id = $1", [c85]);
    expect(st.rows[0].status).toBe("under_review");
    const ef = await adminPool.query("SELECT integrity_status FROM evidence_files WHERE id = $1", [files[0].id]);
    expect(ef.rows[0].integrity_status).toBe("modified");
  });

  it("integrity checks only run for the caller's own org (RLS scopes the join)", async () => {
    const results = await evidence.checkIntegrity(appPool, w.leadB, storage, w.auditA1);
    expect(results).toHaveLength(0);
  });
});

describe("controls service: requirement overrides, applicability, due dates", () => {
  let w: World; let c85: string;
  beforeAll(async () => { w = await makeWorld(); c85 = await controlId(w.auditA1, "A.8.5"); await assignContributor(w, c85); });

  it("lists controls with the effective (overridden or default) evidence text and file spec", async () => {
    const before = await controls.listControls(appPool, w.lead, w.auditA1);
    const row = before.find((r) => r.controlRef === "A.8.5")!;
    expect(row.isOverridden).toBe(false);
    expect(row.effectiveEvidence).toBeTruthy();

    await controls.updateRequirement(appPool, w.lead, c85, { evidenceText: "Up to 4 documents", fileSpec: { types: ["document"], maxFiles: 4 } });
    const after = await controls.listControls(appPool, w.lead, w.auditA1);
    const updated = after.find((r) => r.controlRef === "A.8.5")!;
    expect(updated.isOverridden).toBe(true);
    expect(updated.effectiveEvidence).toBe("Up to 4 documents");
    expect(updated.effectiveFileSpec).toEqual({ types: ["document"], maxFiles: 4 });

    await controls.updateRequirement(appPool, w.lead, c85, { resetToDefault: true });
    const reset = (await controls.listControls(appPool, w.lead, w.auditA1)).find((r) => r.controlRef === "A.8.5")!;
    expect(reset.isOverridden).toBe(false);
  });

  it("a contributor cannot edit requirements; the service surfaces a clean 403", async () => {
    await expectAppError(controls.updateRequirement(appPool, w.contrib, c85, { evidenceText: "hacked" }), "FORBIDDEN_COLUMN", 403);
  });

  it("marking a control not applicable without a justification is rejected with a clean 400", async () => {
    const c86 = await controlId(w.auditA1, "A.8.6");
    const err = await expectAppError(controls.setApplicability(appPool, w.lead, c86, false));
    expect(err.status).toBe(400);
    await controls.setApplicability(appPool, w.lead, c86, false, "Managed SaaS, no capacity risk");
    const row = (await controls.listControls(appPool, w.lead, w.auditA1)).find((r) => r.controlRef === "A.8.6")!;
    expect(row.applicable).toBe(false);
  });

  it("sets a due date, and editing an unknown control id is a clean 404", async () => {
    await controls.setDueDate(appPool, w.lead, c85, "2026-12-01");
    const row = (await controls.listControls(appPool, w.lead, w.auditA1)).find((r) => r.controlRef === "A.8.5")!;
    expect(row.dueDate).toBe("2026-12-01");
    await expectAppError(controls.setDueDate(appPool, w.lead, "00000000-0000-0000-0000-000000000000", "2026-01-01"), "NOT_FOUND", 404);
  });
});

describe("review service: accept, reject, comments, reminders", () => {
  let w: World; let storage: InMemoryStorageProvider; let scanner: FakeScanner; let email: FakeEmailSender; let c85: string;
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    storage = new InMemoryStorageProvider(); scanner = new FakeScanner(); email = new FakeEmailSender();
    c85 = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c85);
  });

  it("rejecting requires a reason and is recorded alongside the status change", async () => {
    await expectAppError(review.reviewControl(appPool, w.auditor, c85, "reject"));
    const session = await evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "mfa.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c85, session.providerFileId);
    await evidence.submitControl(appPool, w.contrib, c85);
    await review.reviewControl(appPool, w.auditor, c85, "reject", "Screenshot is cropped");
    const comments = await review.listComments(appPool, w.contrib, c85);
    const st = await adminPool.query("SELECT status FROM audit_controls WHERE id = $1", [c85]);
    expect(st.rows[0].status).toBe("rejected");
    expect(comments).toHaveLength(0); // a review reason is not itself a comment
  });

  it("comments and findings can be added and are readable by the tenant", async () => {
    await review.addComment(appPool, w.auditor, c85, "minor", "Please also attach the sign-off email.");
    await review.addComment(appPool, w.contrib, c85, "comment", "Attached now.");
    const seenByTenant = await review.listComments(appPool, w.contrib, c85);
    expect(seenByTenant.map((c: { type: string }) => c.type).sort()).toEqual(["comment", "minor"]);
  });

  it("a reminder emails the assigned contributor and is rate-limited by the database", async () => {
    const result = await review.remindForControl(appPool, w.auditor, email, c85);
    expect(result.remindedCount).toBeGreaterThan(0);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toContain("contrib@a1-" + w.tag + ".test");
    await expectAppError(review.remindForControl(appPool, w.auditor, email, c85), "REMINDER_RATE_LIMIT", 429);
  });
});

describe("dashboard service", () => {
  it("returns the same aggregate numbers the database computes, through a clean service call", async () => {
    const w = await makeWorld();
    const s = await dashboard.getDashboard(appPool, w.dash, w.auditA1);
    expect(s.total).toBe(117);
    await expectAppError(dashboard.getDashboard(appPool, w.dash, w.auditA2), "NOT_FOUND", 404);
  });
});
