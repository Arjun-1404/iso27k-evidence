import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { adminPool, appPool, as, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import * as evidence from "../src/services/evidence.ts";
import * as review from "../src/services/review.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const logFor = async (w: World, action: string, entity?: string) =>
  (await adminPool.query(
    "SELECT actor_id, tenant_id, entity, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id=$3) ORDER BY seq",
    [w.orgA, action, entity ?? null])).rows;
const newAudit = async (w: World, tenant: string, name: string) =>
  (await as(w.admin, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [tenant, w.templateId, name]))).rows[0].id as string;

function setup() {
  const auth = new FakeTokenVerifier();
  const storage = new InMemoryStorageProvider();
  const scanner = new FakeScanner();
  const email = new FakeEmailSender();
  const app = createApp({ pool: appPool, storage, scanner, email, tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
  const hdr = (u: string) => ({ Authorization: `Bearer ${auth.issue(u)}` });
  return { app, storage, scanner, email, hdr };
}

describe("closing and reopening over HTTP", () => {
  let w: World; const { app, hdr } = setup();
  beforeAll(async () => { w = await makeWorld(); });

  it("POST /audits/:id/close closes the cycle and answers with the cycle as it now is", async () => {
    const a = await newAudit(w, w.tA1, "Surveillance 2027");
    const res = await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a, name: "Surveillance 2027", status: "closed", closedBy: "Lead A" });
    expect(Date.now() - new Date(res.body.closedAt).getTime()).toBeLessThan(60_000);
    expect(Object.keys(res.body).sort()).toEqual(["closedAt", "closedBy", "createdAt", "id", "name", "status", "templateVersion"]);
  });

  it("the cycle shows as closed when fetched, and in the client's list, with who closed it and when", async () => {
    const a = await newAudit(w, w.tA1, "Listed closed");
    await request(app).post(`/audits/${a}/close`).set(hdr(w.admin));
    const one = (await request(app).get(`/audits/${a}`).set(hdr(w.lead))).body;
    expect(one).toMatchObject({ status: "closed", closedBy: "Admin A" });
    const list = (await request(app).get(`/tenants/${w.tA1}/audits`).set(hdr(w.lead))).body as { id: string; status: string; closedAt: string | null }[];
    expect(list.find((x) => x.id === a)).toMatchObject({ status: "closed", closedBy: "Admin A" });
    expect(list.find((x) => x.id === w.auditA1)).toMatchObject({ status: "in_progress", closedAt: null, closedBy: null });
  });

  it("people on the client's side can see that it is closed and when, but not who closed it (they can't see staff)", async () => {
    const a = await newAudit(w, w.tA1, "Seen by client");
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    const one = (await request(app).get(`/audits/${a}`).set(hdr(w.tLead))).body;
    expect(one.status).toBe("closed");
    expect(typeof one.closedAt).toBe("string");
    expect(one.closedBy).toBeNull();
  });

  it("is refused with a plain explanation for people who may not close it", async () => {
    const a = await newAudit(w, w.tA1, "Refusals");
    for (const who of [w.auditor, w.readOnly, w.tLead, w.contrib]) {
      const res = await request(app).post(`/audits/${a}/close`).set(hdr(who));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN_ROLE");
      expect(res.body.error.message).toBe("Only a lead auditor or an organisation admin can close or reopen an audit cycle.");
    }
    for (const who of [w.dash, w.tDash, w.adminB, w.leadB]) {
      const res = await request(app).post(`/audits/${a}/close`).set(hdr(who));
      expect(res.status, who).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect((await request(app).post(`/audits/${a}/close`)).status).toBe(401);
    expect((await request(app).post(`/audits/not-a-uuid/close`).set(hdr(w.admin))).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).get(`/audits/${a}`).set(hdr(w.lead))).body.status).toBe("in_progress");
  });

  it("closing a closed cycle is a 409 that says so", async () => {
    const a = await newAudit(w, w.tA1, "Twice");
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    const res = await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "AUDIT_ALREADY_CLOSED", message: "This audit cycle is already closed." });
  });

  it("POST /audits/:id/reopen needs a reason, then opens the cycle and clears who closed it", async () => {
    const a = await newAudit(w, w.tA1, "Reopened");
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));

    const none = await request(app).post(`/audits/${a}/reopen`).set(hdr(w.lead));
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("VALIDATION");
    expect(none.body.error.message).toMatch(/Say why you are reopening this audit cycle/);
    const short = await request(app).post(`/audits/${a}/reopen`).set(hdr(w.lead)).send({ reason: "ok" });
    expect(short.status).toBe(400);
    expect(short.body.error.message).toMatch(/3 to 1000 characters/);
    const huge = await request(app).post(`/audits/${a}/reopen`).set(hdr(w.lead)).send({ reason: "x".repeat(5001) });
    expect(huge.status).toBe(400);
    expect((await request(app).get(`/audits/${a}`).set(hdr(w.lead))).body.status).toBe("closed");

    const ok = await request(app).post(`/audits/${a}/reopen`).set(hdr(w.admin)).send({ reason: "Client found one more policy" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: a, status: "in_progress", closedAt: null, closedBy: null });
    const rows = await logFor(w, "audit.reopened", a);
    expect(rows).toHaveLength(1);
    expect(rows[0].change).toMatchObject({ reason: "Client found one more policy", name: "Reopened" });
  });

  it("reopening: refused for the wrong people, and for a cycle that is open", async () => {
    const a = await newAudit(w, w.tA1, "Reopen refusals");
    const notClosed = await request(app).post(`/audits/${a}/reopen`).set(hdr(w.lead)).send({ reason: "no need" });
    expect(notClosed.status).toBe(409);
    expect(notClosed.body.error).toEqual({ code: "AUDIT_NOT_CLOSED", message: "This audit cycle isn't closed." });
    expect(await logFor(w, "audit.reopened", a)).toEqual([]);
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    for (const who of [w.auditor, w.tLead, w.contrib]) {
      expect((await request(app).post(`/audits/${a}/reopen`).set(hdr(who)).send({ reason: "let me in" })).status).toBe(403);
    }
    expect((await request(app).post(`/audits/${a}/reopen`).set(hdr(w.adminB)).send({ reason: "let me in" })).status).toBe(404);
    expect((await request(app).get(`/audits/${a}`).set(hdr(w.lead))).body.status).toBe("closed");
  });

  it("a client that has been archived can't have its cycles closed or reopened: a 409 that says so, until it is restored", async () => {
    const w2 = await makeWorld();
    const open = await newAudit(w2, w2.tA1, "Archived client, open");
    const shut = await newAudit(w2, w2.tA1, "Archived client, closed");
    await request(app).post(`/audits/${shut}/close`).set(hdr(w2.lead));
    await adminPool.query("UPDATE tenants SET status='archived' WHERE id=$1", [w2.tA1]);
    const closeRes = await request(app).post(`/audits/${open}/close`).set(hdr(w2.admin));
    expect(closeRes.status).toBe(409);
    expect(closeRes.body.error.code).toBe("TENANT_INACTIVE");
    expect(closeRes.body.error.message).toMatch(/This client is archived/);
    const reopenRes = await request(app).post(`/audits/${shut}/reopen`).set(hdr(w2.admin)).send({ reason: "Client came back" });
    expect(reopenRes.status).toBe(409);
    expect(reopenRes.body.error.code).toBe("TENANT_INACTIVE");
    await adminPool.query("UPDATE tenants SET status='active' WHERE id=$1", [w2.tA1]);
    expect((await request(app).post(`/audits/${shut}/reopen`).set(hdr(w2.admin)).send({ reason: "Client came back" })).status).toBe(200);
  });

  it("the person who closed it is named by their name, or by their email address if they have no name", async () => {
    const w3 = await makeWorld();
    const email = (await adminPool.query("SELECT email FROM users WHERE id=$1", [w3.lead])).rows[0].email as string;
    const named = await newAudit(w3, w3.tA1, "Closed by a named person");
    expect((await request(app).post(`/audits/${named}/close`).set(hdr(w3.lead))).body.closedBy).toBe("Lead A");
    for (const noName of [null, "", "   "]) {
      await adminPool.query("UPDATE users SET full_name=$2 WHERE id=$1", [w3.lead, noName]);
      const a = await newAudit(w3, w3.tA1, `Closed by ${JSON.stringify(noName)}`);
      expect((await request(app).post(`/audits/${a}/close`).set(hdr(w3.lead))).body.closedBy, JSON.stringify(noName)).toBe(email);
    }
  });

  it("looking up a cycle that doesn't exist, or belongs to another organisation, is a 404", async () => {
    const a = await newAudit(w, w.tA1, "Not for B");
    for (const [who, id] of [[w.lead, "00000000-0000-0000-0000-000000000000"], [w.adminB, a], [w.dash, a]] as const) {
      const res = await request(app).get(`/audits/${id}`).set(hdr(who));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("both actions appear in the audit log that lead auditors and admins read", async () => {
    const a = await newAudit(w, w.tA1, "Visible in log");
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    await request(app).post(`/audits/${a}/reopen`).set(hdr(w.lead)).send({ reason: "Checking the log" });
    const res = await request(app).get("/audit-log").set(hdr(w.lead));
    const mine = (res.body as { action: string; entityId: string }[]).filter((e) => e.entityId === a).map((e) => e.action);
    expect(mine.sort()).toEqual(["audit.closed", "audit.reopened"]);
    expect((await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA])).rows[0].bad).toBeNull();
  });
});

describe("every way of changing a closed cycle says that it is closed", () => {
  let w: World; let a: string; let other: string; const { app, storage, scanner, email, hdr } = setup();
  let c85: string, c87: string, c88: string, c89: string, o85: string;
  const closedAnswer = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("AUDIT_CLOSED");
    expect(res.body.error.message).toMatch(/audit cycle is closed/);
    return res;
  };

  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    a = await newAudit(w, w.tA1, "Frozen");
    other = await newAudit(w, w.tA1, "Open one");
    [c85, c87, c88, c89] = await Promise.all(["A.8.5", "A.8.7", "A.8.8", "A.8.9"].map((r) => controlId(a, r)));
    o85 = await controlId(other, "A.8.5");
    await assignContributor(w, c85); await assignContributor(w, c87); await assignContributor(w, o85);
    // c85: submitted with evidence. c87: awaiting evidence. c88: submitted for the reviewer test.
    const s = await evidence.requestUploadSession(appPool, w.contrib, storage, c85, { fileName: "mfa.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c85, s.providerFileId);
    await evidence.submitControl(appPool, w.contrib, c85);
    await adminPool.query("UPDATE audit_controls SET status='awaiting_evidence' WHERE id=$1", [c87]);
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead)).expect(200);
  });

  it("changing the requirement, applicability or due date of a control", async () => {
    closedAnswer(await request(app).patch(`/controls/${c87}/requirement`).set(hdr(w.lead)).send({ evidenceText: "Something new" }));
    closedAnswer(await request(app).patch(`/controls/${c87}/applicability`).set(hdr(w.lead)).send({ applicable: false, naJustification: "Not used" }));
    closedAnswer(await request(app).patch(`/controls/${c87}/due-date`).set(hdr(w.lead)).send({ dueDate: "2030-01-01" }));
    closedAnswer(await request(app).patch(`/controls/${c87}/due-date`).set(hdr(w.admin)).send({ dueDate: null }));
  });

  it("submitting, reviewing and reminding", async () => {
    closedAnswer(await request(app).post(`/controls/${c87}/submit`).set(hdr(w.contrib)));
    closedAnswer(await request(app).post(`/controls/${c85}/reviews`).set(hdr(w.auditor)).send({ decision: "accept" }));
    closedAnswer(await request(app).post(`/controls/${c85}/reviews`).set(hdr(w.lead)).send({ decision: "reject", reason: "not enough" }));
    closedAnswer(await request(app).post(`/controls/${c87}/remind`).set(hdr(w.lead)));
    expect(email.sent).toHaveLength(0); // no reminder email goes out for a closed cycle
    expect((await adminPool.query("SELECT status, last_reminded_at FROM audit_controls WHERE id=$1", [c87])).rows[0]).toEqual({ status: "awaiting_evidence", last_reminded_at: null });
    expect((await adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [c85])).rows[0].status).toBe("submitted");
    expect((await adminPool.query("SELECT count(*)::int n FROM reviews WHERE audit_control_id=$1", [c85])).rows[0].n).toBe(0);
  });

  it("comments and findings, from any role", async () => {
    closedAnswer(await request(app).post(`/controls/${c85}/comments`).set(hdr(w.auditor)).send({ type: "major", body: "Late finding" }));
    closedAnswer(await request(app).post(`/controls/${c85}/comments`).set(hdr(w.contrib)).send({ body: "One more thing" }));
    closedAnswer(await request(app).post(`/controls/${c85}/comments`).set(hdr(w.lead)).send({ body: "Note" }));
    expect((await adminPool.query("SELECT count(*)::int n FROM comments WHERE audit_control_id=$1", [c85])).rows[0].n).toBe(0);
  });

  it("assigning, assigning in bulk, and unassigning", async () => {
    closedAnswer(await request(app).post(`/controls/${c88}/assignments`).set(hdr(w.tLead)).send({ userId: w.contrib }));
    closedAnswer(await request(app).post(`/controls/${c88}/assignments`).set(hdr(w.lead)).send({ userId: w.tLead }));
    closedAnswer(await request(app).post(`/audits/${a}/assignments`).set(hdr(w.tLead)).send({ userId: w.contrib, controlIds: [c88, c89] }));
    closedAnswer(await request(app).delete(`/controls/${c85}/assignments/${w.contrib}`).set(hdr(w.tLead)));
    expect((await adminPool.query("SELECT user_id FROM control_assignments WHERE audit_control_id=$1", [c85])).rows).toEqual([{ user_id: w.contrib }]);
    expect((await adminPool.query("SELECT count(*)::int n FROM control_assignments WHERE audit_control_id=ANY($1)", [[c88, c89]])).rows[0].n).toBe(0);
  });

  it("starting an upload does nothing at all in the storage (no folder, no upload session)", async () => {
    const folders = vi.spyOn(storage, "findOrCreateFolder"); const sessions = vi.spyOn(storage, "createUploadSession");
    try {
      const res = closedAnswer(await request(app).post(`/controls/${c87}/upload-session`).set(hdr(w.contrib)).send({ fileName: "late.pdf", mimeType: "application/pdf", sizeBytes: 10 }));
      expect(res.body.error.message).toBe("This audit cycle is closed, so no more evidence can be added to it. A lead auditor or an organisation admin can reopen it.");
      closedAnswer(await request(app).post(`/controls/${c87}/upload-session`).set(hdr(w.lead)).send({ fileName: "late.pdf", mimeType: "application/pdf", sizeBytes: 10 }));
      expect(folders).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
    } finally { folders.mockRestore(); sessions.mockRestore(); }
    expect((await adminPool.query("SELECT folder_id FROM audit_controls WHERE id=$1", [c87])).rows[0].folder_id).toBeNull();
  });

  it("a file sent just before the cycle was closed is not recorded, not scanned, and left where it is", async () => {
    // A second cycle: the session is opened while it is open, the cycle is closed, then the browser confirms.
    const b = await newAudit(w, w.tA1, "Closed mid-upload");
    const c = await controlId(b, "A.8.5"); await assignContributor(w, c);
    const s = await evidence.requestUploadSession(appPool, w.contrib, storage, c, { fileName: "in-flight.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await request(app).post(`/audits/${b}/close`).set(hdr(w.lead)).expect(200);

    const scan = vi.spyOn(scanner, "scan"); const trash = vi.spyOn(storage, "quarantineFile");
    try {
      const res = closedAnswer(await request(app).post(`/controls/${c}/uploads/confirm`).set(hdr(w.contrib)).send({ providerFileId: s.providerFileId }));
      expect(res.body.error.message).toMatch(/The file you sent has not been recorded; it is still in your storage folder\. A lead auditor or an organisation admin can reopen it\./);
      expect(scan).not.toHaveBeenCalled();
      expect(trash).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); trash.mockRestore(); }
    expect((await adminPool.query("SELECT count(*)::int n FROM evidence_files WHERE audit_control_id=$1", [c])).rows[0].n).toBe(0);
    expect(storage.isQuarantined(s.providerFileId)).toBe(false);

    // After reopening, the same file can simply be confirmed.
    await request(app).post(`/audits/${b}/reopen`).set(hdr(w.lead)).send({ reason: "Upload was in flight" }).expect(200);
    const again = await request(app).post(`/controls/${c}/uploads/confirm`).set(hdr(w.contrib)).send({ providerFileId: s.providerFileId });
    expect(again.status).toBe(201);
  });

  it("everything can still be read", async () => {
    expect((await request(app).get(`/audits/${a}/controls`).set(hdr(w.lead))).status).toBe(200);
    expect((await request(app).get(`/audits/${a}/dashboard`).set(hdr(w.lead))).status).toBe(200);
    expect((await request(app).get(`/audits/${a}/dashboard`).set(hdr(w.dash))).status).toBe(200);
    const files = await request(app).get(`/controls/${c85}/files`).set(hdr(w.contrib));
    expect(files.status).toBe(200);
    expect(files.body).toHaveLength(1);
    expect((await request(app).get(`/controls/${c85}/comments`).set(hdr(w.contrib))).status).toBe(200);
    expect((await request(app).get(`/controls/${c85}/assignments`).set(hdr(w.lead))).status).toBe(200);
  });

  it("the other cycle of the same client keeps working in every one of those ways", async () => {
    const f = await request(app).patch(`/controls/${o85}/due-date`).set(hdr(w.lead)).send({ dueDate: "2030-01-01" });
    expect(f.status).toBe(200);
    expect((await request(app).post(`/controls/${o85}/comments`).set(hdr(w.auditor)).send({ body: "fine" })).status).toBe(201);
    const s = await request(app).post(`/controls/${o85}/upload-session`).set(hdr(w.contrib)).send({ fileName: "ok.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    expect(s.status).toBe(200);
    expect((await request(app).post(`/controls/${o85}/assignments`).set(hdr(w.tLead)).send({ userId: w.tLead })).status).toBe(201);
  });
});

describe("the evidence integrity check on a closed cycle", () => {
  let w: World; const { app, storage, scanner, hdr } = setup();
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
  });

  async function acceptedControl(audit: string, ref: string, file: string) {
    const c = await controlId(audit, ref); await assignContributor(w, c);
    const s = await evidence.requestUploadSession(appPool, w.contrib, storage, c, { fileName: file, mimeType: "application/pdf", sizeBytes: 10 });
    await evidence.confirmUpload(appPool, w.contrib, storage, scanner, c, s.providerFileId);
    await evidence.submitControl(appPool, w.contrib, c);
    await review.reviewControl(appPool, w.auditor, c, "accept");
    return { control: c, providerFileId: s.providerFileId };
  }

  it("still notices a file that changed or went missing, and records it, but leaves the control as it was signed off", async () => {
    const a = await newAudit(w, w.tA1, "Closed and checked");
    const changed = await acceptedControl(a, "A.8.5", "changed.pdf");
    const intact = await acceptedControl(a, "A.8.6", "intact.pdf");
    storage.mutate(changed.providerFileId, { hash: "different", version: "2" });
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead)).expect(200);

    const res = await request(app).post(`/audits/${a}/integrity-check`).set(hdr(w.lead));
    expect(res.status).toBe(200);
    expect((res.body as { changed: boolean }[]).map((r) => r.changed).sort()).toEqual([false, true]);

    const file = (c: string) => adminPool.query("SELECT integrity_status FROM evidence_files WHERE audit_control_id=$1", [c]).then((r) => r.rows[0].integrity_status);
    const status = (c: string) => adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [c]).then((r) => r.rows[0].status);
    expect(await file(changed.control)).toBe("modified");
    expect(await file(intact.control)).toBe("unchecked");
    expect(await status(changed.control)).toBe("accepted");   // frozen with the rest of the cycle
    expect(await status(intact.control)).toBe("accepted");

    const rows = await adminPool.query(
      "SELECT change FROM audit_log WHERE org_id=$1 AND action='evidence.integrity_flagged' AND tenant_id=$2", [w.orgA, w.tA1]);
    expect(rows.rows.filter((r) => r.change.auditClosed === true)).toEqual([{ change: { status: "modified", auditClosed: true } }]);
  });

  it("a file that has gone missing is flagged the same way", async () => {
    const a = await newAudit(w, w.tA1, "Closed, file deleted");
    const gone = await acceptedControl(a, "A.8.5", "gone.pdf");
    // Simulate the provider no longer knowing the file.
    const spy = vi.spyOn(storage, "getFileMetadata").mockImplementation(async (id) => {
      if (id === gone.providerFileId) { const { StorageError } = await import("../src/storage/types.ts"); throw new StorageError("gone", "NOT_FOUND", false); }
      throw new Error("unexpected");
    });
    try {
      await request(app).post(`/audits/${a}/close`).set(hdr(w.admin)).expect(200);
      const res = await request(app).post(`/audits/${a}/integrity-check`).set(hdr(w.admin));
      expect(res.status).toBe(200);
    } finally { spy.mockRestore(); }
    expect((await adminPool.query("SELECT integrity_status FROM evidence_files WHERE audit_control_id=$1", [gone.control])).rows[0].integrity_status).toBe("missing");
    expect((await adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [gone.control])).rows[0].status).toBe("accepted");
  });

  it("on an open cycle nothing changed: the control goes back to under review", async () => {
    const a = await newAudit(w, w.tA1, "Open and checked");
    const open = await acceptedControl(a, "A.8.5", "open.pdf");
    storage.mutate(open.providerFileId, { hash: "different", version: "2" });
    await request(app).post(`/audits/${a}/integrity-check`).set(hdr(w.lead)).expect(200);
    expect((await adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [open.control])).rows[0].status).toBe("under_review");
    const rows = await adminPool.query("SELECT change FROM audit_log WHERE action='evidence.integrity_flagged' AND entity_id=(SELECT id::text FROM evidence_files WHERE audit_control_id=$1)", [open.control]);
    expect(rows.rows).toEqual([{ change: { status: "modified" } }]);
  });
});
