// @vitest-environment node
// The evidence life cycle as the screens drive it, through the app's real ApiClient: ask, upload, submit, review, close.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadFile } from "../api/client";
import { auditOf, control, makeKit, pdfFile, PEOPLE, refusal, type Kit } from "./testkit";

let kit: Kit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.stop());

/** A control of the open Brightwave audit that nothing has happened to yet. */
async function untouched(kit: Kit, asEmail: string) {
  const api = await kit.as(asEmail);
  const audit = await auditOf(api, "Brightwave", "open");
  const c = (await api.listControls(audit.id)).find((x) => x.applicable && x.status === "not_started" && x.fileCount === 0);
  if (!c) throw new Error("the sample audit has no untouched control");
  return { api, audit, c };
}

describe("the evidence life cycle", () => {
  it("a contributor uploads, submits, and an auditor accepts it; every step is in the audit log", async () => {
    // A contributor only sees the controls handed to them, so the lead (Priya) hands one over first.
    const { api: priya, c } = await untouched(kit, PEOPLE.priya);
    const tom = await kit.as(PEOPLE.tom);
    expect((await tom.listControls((await auditOf(tom, "Brightwave", "open")).id)).some((x) => x.id === c.id)).toBe(false);
    expect(await refusal(tom.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }))).toMatchObject({ status: 404 });
    const tomId = (await priya.listTenantUsers((await priya.listTenants())[0]!.id)).find((u) => u.email === PEOPLE.tom)!.id;
    await priya.assignControl(c.id, tomId);

    const uploaded = await uploadFile(tom, c.id, pdfFile("policy.pdf", 4096));
    expect(uploaded).toMatchObject({ fileName: "policy.pdf", scanStatus: "skipped" });
    const files = await tom.listFiles(c.id);
    expect(files.map((f) => f.fileName)).toEqual(["policy.pdf"]);

    expect(await tom.submitControl(c.id)).toEqual({ id: c.id, status: "submitted" });

    const declan = await kit.as(PEOPLE.declan);
    expect(await declan.review(c.id, "accept")).toEqual({ id: c.id, status: "accepted" });

    const actions = (await declan.listAuditLog()).filter((e) => e.entityId === c.id || e.entityId === uploaded.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["evidence.uploaded", "control.submitted", "control.accept"]));
  });

  it("what was uploaded can be downloaded again, byte for byte, and the download is logged", async () => {
    const { api: priya, c } = await untouched(kit, PEOPLE.priya);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
    const file = new File([bytes], "notes.txt", { type: "text/plain" });
    const up = await uploadFile(priya, c.id, file);
    const blob = await priya.downloadEvidence(up.id);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

    const declan = await kit.as(PEOPLE.declan);
    const log = await declan.listAuditLog();
    expect(log.find((e) => e.action === "evidence.downloaded" && e.entityId === up.id)).toBeTruthy();
  });

  it("sample evidence (never uploaded in this tab) downloads as a real, valid PDF placeholder", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const withFiles = (await declan.listControls(audit.id)).find((x) => x.fileCount > 0)!;
    const [f] = await declan.listFiles(withFiles.id);
    const blob = await declan.downloadEvidence(f!.id);
    const text = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("cannot submit a control with no evidence", async () => {
    const { api: priya, c } = await untouched(kit, PEOPLE.priya);
    expect(await refusal(priya.submitControl(c.id))).toMatchObject({ status: 409, code: "EVIDENCE_REQUIRED" });
  });

  it("a rejected control can be fixed and submitted again; a reason is needed to reject", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const rejected = (await declan.listControls(audit.id)).find((x) => x.status === "rejected")!;
    const priya = await kit.as(PEOPLE.priya);
    expect(await priya.submitControl(rejected.id)).toMatchObject({ status: "submitted" });
    expect(await refusal(declan.review(rejected.id, "reject"))).toMatchObject({ status: 400, code: "reject_needs_reason" });
    expect(await declan.review(rejected.id, "reject", "Still the old version.")).toMatchObject({ status: "rejected" });
  });

  it("a status that cannot move is refused (accepting something nobody submitted)", async () => {
    const { c } = await untouched(kit, PEOPLE.declan);
    const declan = await kit.as(PEOPLE.declan);
    expect(await refusal(declan.review(c.id, "accept"))).toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
    // and no decision was left behind by the refused attempt
    expect((await declan.listAuditLog()).some((e) => e.entityId === c.id && e.action === "control.accept")).toBe(false);
  });

  it("refuses files the upload rules do not allow", async () => {
    const { api, c } = await untouched(kit, PEOPLE.priya);
    const bad = new File(["MZ"], "tool.exe", { type: "application/x-msdownload" });
    expect(await refusal(uploadFile(api, c.id, bad))).toMatchObject({ status: 422, code: "INVALID_FILE" });
    const tooBig = await refusal(api.requestUploadSession(c.id, { fileName: "big.pdf", mimeType: "application/pdf", sizeBytes: 26 * 1024 * 1024 }));
    expect(tooBig).toMatchObject({ status: 422, code: "INVALID_FILE" });
    const noExt = await refusal(api.requestUploadSession(c.id, { fileName: "report", mimeType: "application/pdf", sizeBytes: 100 }));
    expect(noExt.status).toBe(422);
  });

  it("a file that is not the size announced is not accepted", async () => {
    const { api, c } = await untouched(kit, PEOPLE.priya);
    const session = await api.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 100 });
    const res = await fetch(`https://api.demo.invalid${session.uploadUrl}`, { method: "PUT", body: new Blob([new Uint8Array(99)]) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("UPLOAD_SIZE_MISMATCH");
  });

  it("an upload cannot be confirmed before the file arrived, or on another control", async () => {
    const { api, audit, c } = await untouched(kit, PEOPLE.priya);
    const session = await api.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 100 });
    expect(await refusal(api.confirmUpload(c.id, session.providerFileId))).toMatchObject({ status: 409, code: "UPLOAD_INCOMPLETE" });
    const other = (await api.listControls(audit.id)).find((x) => x.id !== c.id && x.applicable)!;
    const wrong = await refusal(api.confirmUpload(other.id, session.providerFileId));
    expect(["UPLOAD_NOT_STARTED", "FILE_NOT_IN_FOLDER"]).toContain(wrong.code);
  });

  it("an upload link stops working when it expires", async () => {
    const { api, c } = await untouched(kit, PEOPLE.priya);
    const session = await api.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 3 });
    kit.clock.now += 16 * 60 * 1000; // the link lives fifteen minutes
    const res = await fetch(`https://api.demo.invalid${session.uploadUrl}`, { method: "PUT", body: new Blob([new Uint8Array(3)]) });
    expect(res.status).toBe(403);
  });

  it("a control marked not applicable takes no evidence and needs a reason; clauses can never be marked so", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const annex = (await declan.listControls(audit.id)).find((x) => x.kind === "annex" && x.applicable && x.status === "not_started" && x.fileCount === 0)!;
    expect(await refusal(declan.setApplicability(annex.id, false))).toMatchObject({ status: 400, code: "na_needs_justification" });
    await declan.setApplicability(annex.id, false, "No physical premises: fully remote company.");
    const after = await control(declan, audit.id, annex.controlRef);
    expect(after).toMatchObject({ applicable: false, naJustification: "No physical premises: fully remote company." });
    const priya = await kit.as(PEOPLE.priya);
    expect(await refusal(priya.requestUploadSession(annex.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }))).toMatchObject({ code: "NOT_APPLICABLE" });

    const clause = (await declan.listControls(audit.id)).find((x) => x.kind === "clause")!;
    expect(await refusal(declan.setApplicability(clause.id, false, "not for us"))).toMatchObject({ status: 400, code: "clauses_always_applicable" });
  });

  it("only staff who set the requirements can change what is asked for; auditors cannot", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const c = (await declan.listControls(audit.id))[30]!;
    await declan.updateRequirement(c.id, { evidenceText: "Last two access reviews." });
    expect((await control(declan, audit.id, c.controlRef))).toMatchObject({ effectiveEvidence: "Last two access reviews.", isOverridden: true });
    await declan.updateRequirement(c.id, { resetToDefault: true });
    expect((await control(declan, audit.id, c.controlRef)).isOverridden).toBe(false);

    const maeve = await kit.as(PEOPLE.maeve);
    expect(await refusal(maeve.updateRequirement(c.id, { evidenceText: "x" }))).toMatchObject({ status: 403, code: "FORBIDDEN_COLUMN" });
    expect(await refusal(maeve.setDueDate(c.id, "2026-12-01"))).toMatchObject({ status: 403 });
    const priya = await kit.as(PEOPLE.priya);
    expect(await refusal(priya.setDueDate(c.id, "2026-12-01"))).toMatchObject({ status: 403 });
  });

  it("a reminder reaches the people it is for, and only one a day", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const c = (await declan.listControls(audit.id)).find((x) => x.applicable && (x.status === "awaiting_evidence" || x.status === "not_started") && x.fileCount === 0)!;
    const sent = await declan.remind(c.id);
    expect(sent.remindedCount).toBeGreaterThan(0);
    expect(await refusal(declan.remind(c.id))).toMatchObject({ status: 429, code: "REMINDER_RATE_LIMIT" });
    kit.clock.now += 25 * 60 * 60 * 1000;
    expect((await declan.remind(c.id)).remindedCount).toBeGreaterThan(0);
    // evidence already in: nothing outstanding to remind about
    const accepted = (await declan.listControls(audit.id)).find((x) => x.status === "accepted")!;
    expect(await refusal(declan.remind(accepted.id))).toMatchObject({ status: 409, code: "REMINDER_NOT_ALLOWED" });
  });

  it("comments: staff can raise findings, the client side can only comment", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const c = (await declan.listControls(audit.id)).find((x) => x.status === "submitted")!;
    await declan.addComment(c.id, "minor", "Date missing on page 2.");
    const priya = await kit.as(PEOPLE.priya);
    await priya.addComment(c.id, "comment", "Fixed, re-uploading today.");
    expect(await refusal(priya.addComment(c.id, "major", "Sneaky"))).toMatchObject({ status: 403 });
    const thread = await priya.listComments(c.id);
    expect(thread.map((t) => t.type)).toEqual(expect.arrayContaining(["minor", "comment"]));
  });
});

describe("closing and reopening an audit cycle", () => {
  it("closing makes the cycle read-only for everyone; reopening (with a reason) makes it editable again", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const closed = await declan.closeAudit(audit.id);
    expect(closed).toMatchObject({ status: "closed" });
    expect(closed.closedAt).toBeTruthy();

    const submitted = (await declan.listControls(audit.id)).find((x) => x.status === "submitted")!;
    expect(await refusal(declan.review(submitted.id, "accept"))).toMatchObject({ status: 409, code: "AUDIT_CLOSED" });
    expect(await refusal(declan.addComment(submitted.id, "comment", "late"))).toMatchObject({ code: "AUDIT_CLOSED" });
    expect(await refusal(declan.setDueDate(submitted.id, "2026-12-31"))).toMatchObject({ code: "AUDIT_CLOSED" });
    const priya = await kit.as(PEOPLE.priya);
    expect(await refusal(priya.requestUploadSession(submitted.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }))).toMatchObject({ code: "AUDIT_CLOSED" });
    expect(await refusal(declan.closeAudit(audit.id))).toMatchObject({ status: 409, code: "AUDIT_ALREADY_CLOSED" });

    expect(await refusal(declan.reopenAudit(audit.id, ""))).toMatchObject({ status: 400 });
    expect(await declan.reopenAudit(audit.id, "Client sent a missing report")).toMatchObject({ status: "in_progress", closedAt: null });
    expect(await declan.review(submitted.id, "accept")).toMatchObject({ status: "accepted" });
    const log = await declan.listAuditLog();
    expect(log.find((e) => e.action === "audit.reopened")?.change).toMatchObject({ reason: "Client sent a missing report" });
  });

  it("the client side does not see who closed a cycle; staff do", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const priya = await kit.as(PEOPLE.priya);
    const forStaff = await auditOf(declan, "Brightwave", "closed");
    const forClient = await auditOf(priya, "Brightwave", "closed");
    expect(forStaff.closedBy).toBeTruthy();
    expect(forClient.closedBy).toBeNull();
  });

  it("auditors and the client side cannot close or reopen", async () => {
    const maeve = await kit.as(PEOPLE.maeve);
    const audit = await auditOf(maeve, "Brightwave", "open");
    expect(await refusal(maeve.closeAudit(audit.id))).toMatchObject({ status: 403, code: "FORBIDDEN_ROLE" });
    const priya = await kit.as(PEOPLE.priya);
    expect(await refusal(priya.closeAudit(audit.id))).toMatchObject({ status: 403 });
    const closed = await auditOf(maeve, "Brightwave", "closed");
    expect(await refusal(maeve.reopenAudit(closed.id, "please"))).toMatchObject({ status: 403 });
  });

  it("the 2025 sample cycle is closed with every applicable control accepted", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "closed");
    const d = await declan.getDashboard(audit.id);
    expect(d.completionPct).toBe(100);
    expect(d.accepted).toBe(d.applicable);
  });
});
