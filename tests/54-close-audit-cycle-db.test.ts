import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, denied, makeWorld, controlId, addEvidence, type World } from "./helpers.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const CLOSED = /AUDIT_CLOSED: This audit cycle is closed/;
const state = async (audit: string) =>
  (await adminPool.query("SELECT status, closed_at, closed_by FROM audits WHERE id=$1", [audit])).rows[0] as { status: string; closed_at: Date | null; closed_by: string | null };
const logs = async (w: World, action: string, audit?: string) =>
  (await adminPool.query(
    "SELECT actor_id, tenant_id, entity, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id=$3) ORDER BY seq",
    [w.orgA, action, audit ?? null])).rows;
const chainBreak = async (w: World) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA])).rows[0].bad as string | null;
const close = (actor: string, audit: string) => as(actor, (c) => c.query("SELECT audit_close($1)", [audit]));
const reopen = (actor: string, audit: string, reason: string | null = "Late evidence for A.8.5 arrived") => as(actor, (c) => c.query("SELECT audit_reopen($1,$2)", [audit, reason]));
const newAudit = async (w: World, tenant: string, name: string) =>
  (await as(w.admin, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [tenant, w.templateId, name]))).rows[0].id as string;

describe("who may close and reopen an audit cycle", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("a lead auditor assigned to the client and an organisation admin can close it, and it is recorded", async () => {
    const a = await newAudit(w, w.tA1, "to close by lead");
    await adminPool.query("UPDATE audits SET created_at = now() - interval '3 days' WHERE id=$1", [a]); // so 'now' can't be mistaken for the creation time
    await close(w.lead, a);
    const s = await state(a);
    expect(s.status).toBe("closed");
    expect(s.closed_by).toBe(w.lead);
    expect(s.closed_at).toBeInstanceOf(Date);
    expect(Math.abs(s.closed_at!.getTime() - Date.now())).toBeLessThan(60_000); // the moment it was closed, not some other time

    const b = await newAudit(w, w.tA1, "to close by admin");
    await close(w.admin, b);
    expect((await state(b)).closed_by).toBe(w.admin);
  });

  it("an auditor, a read-only reviewer, a dashboard user and every client-side role are refused", async () => {
    const a = await newAudit(w, w.tA1, "refused closers");
    for (const actor of [w.auditor, w.readOnly, w.tLead, w.contrib, w.viewer]) {
      await denied(close(actor, a), /FORBIDDEN_ROLE: Only a lead auditor or an organisation admin/);
    }
    // These roles cannot even see the audit.
    for (const actor of [w.dash, w.tDash]) await denied(close(actor, a), /NOT_FOUND/);
    expect((await state(a)).status).toBe("in_progress");
    expect(await logs(w, "audit.closed", a)).toEqual([]);
  });

  it("an audit that cannot be seen is 'not found', not 'forbidden': another organisation, an unassigned lead auditor, another client", async () => {
    const a = await newAudit(w, w.tA2, "client A2");
    // lead is assigned to A1 and A2, so build one for a client the lead is not assigned to.
    const t3 = (await adminPool.query("INSERT INTO tenants (org_id, name, allowed_domains) VALUES ($1,'A3',$2) RETURNING id", [w.orgA, [`a3-${w.tag}.test`]])).rows[0].id as string;
    const a3 = await newAudit(w, t3, "client A3");
    await denied(close(w.lead, a3), /NOT_FOUND/);
    await denied(close(w.adminB, a), /NOT_FOUND/);
    await denied(close(w.leadB, a), /NOT_FOUND/);
    await denied(close(w.tLead2, w.auditA1), /NOT_FOUND/);
    await denied(close(w.admin, "00000000-0000-0000-0000-000000000000"), /NOT_FOUND/);
    expect((await state(a3)).status).toBe("in_progress");
    await close(w.admin, a3); // an organisation admin sees every client of the organisation
    expect((await state(a3)).status).toBe("closed");
    // the same goes for reopening: someone who cannot see the audit is told it isn't there, and it stays closed
    await denied(reopen(w.lead, a3), /NOT_FOUND/);
    await denied(reopen(w.tLead2, a3), /NOT_FOUND/);
    await denied(reopen(w.adminB, a3), /NOT_FOUND/);
    expect((await state(a3)).status).toBe("closed");
  });

  it("closing twice is refused, not silently repeated", async () => {
    const a = await newAudit(w, w.tA1, "twice");
    await close(w.lead, a);
    await denied(close(w.lead, a), /AUDIT_ALREADY_CLOSED/);
    expect(await logs(w, "audit.closed", a)).toHaveLength(1);
  });

  it("nothing can be closed or reopened for a client that has been archived", async () => {
    const w2 = await makeWorld();
    const a = await newAudit(w2, w2.tA1, "archived client");
    await close(w2.lead, a);
    await adminPool.query("UPDATE tenants SET status='archived' WHERE id=$1", [w2.tA1]);
    await denied(reopen(w2.lead, a), /TENANT_INACTIVE: This client is archived/);
    await denied(close(w2.admin, w2.auditA1), /TENANT_INACTIVE/);
    expect((await state(a)).status).toBe("closed");
    expect((await state(w2.auditA1)).status).toBe("in_progress");
    await adminPool.query("UPDATE tenants SET status='active' WHERE id=$1", [w2.tA1]);
    await reopen(w2.lead, a);
    expect((await state(a)).status).toBe("in_progress");
  });

  it("only a lead auditor or an admin can reopen; everyone else is refused", async () => {
    const a = await newAudit(w, w.tA1, "reopen roles");
    await close(w.lead, a);
    for (const actor of [w.auditor, w.readOnly, w.tLead, w.contrib, w.viewer]) await denied(reopen(actor, a), /FORBIDDEN_ROLE/);
    for (const actor of [w.dash, w.tDash, w.adminB, w.leadB]) await denied(reopen(actor, a), /NOT_FOUND/);
    expect((await state(a)).status).toBe("closed");
    await reopen(w.admin, a);
    expect((await state(a)).status).toBe("in_progress");
  });
});

describe("the audit log entries for closing and reopening (written by the database itself)", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("closing records who, which cycle, and how many controls were accepted at that moment", async () => {
    const a = await newAudit(w, w.tA1, "log close");
    const c1 = await controlId(a, "A.8.5"), c2 = await controlId(a, "A.8.7");
    await adminPool.query("UPDATE audit_controls SET status='awaiting_evidence' WHERE id=ANY($1)", [[c1, c2]]);
    await addEvidence(w.orgA, w.tA1, c1, w.contrib); await addEvidence(w.orgA, w.tA1, c2, w.contrib);
    await adminPool.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [c1]);
    await adminPool.query("UPDATE audit_controls SET applicable=false, na_justification='not used here' WHERE id=$1", [await controlId(a, "A.8.9")]);
    // A control that was accepted and later marked not applicable is not counted as an accepted control of the audit.
    const c3 = await controlId(a, "A.8.10");
    await adminPool.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [c3]);
    await adminPool.query("UPDATE audit_controls SET applicable=false, na_justification='dropped from scope' WHERE id=$1", [c3]);
    const applicable = (await adminPool.query("SELECT count(*)::int n FROM audit_controls WHERE audit_id=$1 AND applicable", [a])).rows[0].n;

    await close(w.lead, a);
    const rows = await logs(w, "audit.closed", a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: w.lead, tenant_id: w.tA1, entity: "audit", entity_id: a });
    expect(rows[0].change).toEqual({ name: "log close", applicableControls: applicable, acceptedControls: 1 });
    expect(await chainBreak(w)).toBeNull();
  });

  it("reopening needs a reason of 3 to 1000 characters (after trimming), and the reason is recorded with when it had been closed", async () => {
    const a = await newAudit(w, w.tA1, "log reopen");
    await close(w.admin, a);
    const closedAt = (await state(a)).closed_at!;
    for (const bad of [null, "", "   ", "ab", " a ", "x".repeat(1001)]) await denied(reopen(w.admin, a, bad), /VALIDATION: Say why you are reopening/);
    expect((await state(a)).status).toBe("closed");
    expect(await logs(w, "audit.reopened", a)).toEqual([]);

    await reopen(w.lead, a, "  Client sent the missing policy  ");
    const rows = await logs(w, "audit.reopened", a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: w.lead, tenant_id: w.tA1, entity: "audit", entity_id: a });
    const { closedAt: loggedAt, ...rest } = rows[0].change as { closedAt: string };
    expect(rest).toEqual({ name: "log reopen", reason: "Client sent the missing policy", closedBy: w.admin });
    expect(new Date(loggedAt).getTime()).toBe(closedAt.getTime()); // the moment it had been closed
    const s = await state(a);
    expect(s).toMatchObject({ status: "in_progress", closed_at: null, closed_by: null });
    expect(await chainBreak(w)).toBeNull();
  });

  it("a reason of exactly 3 and exactly 1000 characters is accepted", async () => {
    const a = await newAudit(w, w.tA1, "reason limits");
    await close(w.admin, a); await reopen(w.admin, a, "abc");
    await close(w.admin, a); await reopen(w.admin, a, "y".repeat(1000));
    expect(await logs(w, "audit.reopened", a)).toHaveLength(2);
  });

  it("reopening an audit that isn't closed is refused", async () => {
    const a = await newAudit(w, w.tA1, "not closed");
    await denied(reopen(w.admin, a), /AUDIT_NOT_CLOSED/);
  });

  it("a refused close or reopen leaves no trace in the audit log", async () => {
    const a = await newAudit(w, w.tA1, "no trace");
    const before = (await adminPool.query("SELECT count(*)::int n FROM audit_log WHERE org_id=$1", [w.orgA])).rows[0].n;
    await denied(close(w.auditor, a)); await denied(reopen(w.admin, a)); await denied(close(w.dash, a));
    expect((await adminPool.query("SELECT count(*)::int n FROM audit_log WHERE org_id=$1", [w.orgA])).rows[0].n).toBe(before);
  });
});

describe("the status can only be changed by closing and reopening", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("the application role cannot write the status, closing time or closing person directly, not even an admin", async () => {
    for (const actor of [w.admin, w.lead]) {
      await denied(as(actor, (c) => c.query("UPDATE audits SET status='closed' WHERE id=$1", [w.auditA1])), /permission denied/);
      await denied(as(actor, (c) => c.query("UPDATE audits SET closed_at=now() WHERE id=$1", [w.auditA1])), /permission denied/);
      await denied(as(actor, (c) => c.query("UPDATE audits SET closed_by=$2 WHERE id=$1", [w.auditA1, actor])), /permission denied/);
    }
    await close(w.admin, w.auditA2);
    await denied(as(w.admin, (c) => c.query("UPDATE audits SET status='in_progress' WHERE id=$1", [w.auditA2])), /permission denied/);
    expect((await state(w.auditA2)).status).toBe("closed");
  });

  it("an audit cannot be inserted already closed", async () => {
    await denied(as(w.admin, (c) => c.query(
      "INSERT INTO audits (org_id, tenant_id, template_version, name, status, closed_at) VALUES ($1,$2,'x','sneaky','closed',now())", [w.orgA, w.tA1])), /permission denied/);
  });

  it("creating an audit and renaming an open one still work", async () => {
    const a = await newAudit(w, w.tA1, "before");
    await as(w.lead, (c) => c.query("UPDATE audits SET name='after' WHERE id=$1", [a]));
    expect((await adminPool.query("SELECT name FROM audits WHERE id=$1", [a])).rows[0].name).toBe("after");
  });

  it("the database itself refuses 'closed' without a closing time, and a closing time without 'closed'", async () => {
    await denied(adminPool.query("UPDATE audits SET status='closed' WHERE id=$1", [w.auditB1]), /audits_closed_consistent/);
    await denied(adminPool.query("UPDATE audits SET closed_at=now() WHERE id=$1", [w.auditB1]), /audits_closed_consistent/);
  });

  it("a closed audit cannot be renamed, by anyone, until it is reopened", async () => {
    const a = await newAudit(w, w.tA1, "frozen name");
    await close(w.lead, a);
    await denied(as(w.lead, (c) => c.query("UPDATE audits SET name='new name' WHERE id=$1", [a])), CLOSED);
    await denied(adminPool.query("UPDATE audits SET name='new name' WHERE id=$1", [a]), CLOSED);
    await reopen(w.lead, a);
    await as(w.lead, (c) => c.query("UPDATE audits SET name='new name' WHERE id=$1", [a]));
  });
});

describe("a closed audit cycle cannot be changed", () => {
  let w: World; let a: string; let other: string; let c85: string, c87: string, c88: string, c89: string;
  let fileId: string;
  beforeAll(async () => {
    w = await makeWorld();
    a = await newAudit(w, w.tA1, "locked");
    other = await newAudit(w, w.tA1, "still open");
    [c85, c87, c88, c89] = await Promise.all(["A.8.5", "A.8.7", "A.8.8", "A.8.9"].map((r) => controlId(a, r)));
    // Fixtures set up BEFORE closing: an assigned contributor, evidence on A.8.5, a comment, an accepted control.
    for (const c of [c85, c87]) {
      await adminPool.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, c, w.contrib]);
    }
    await adminPool.query("UPDATE audit_controls SET status='awaiting_evidence' WHERE id=ANY($1)", [[c85, c87, c88]]);
    await addEvidence(w.orgA, w.tA1, c85, w.contrib, "policy.pdf");
    fileId = (await adminPool.query("SELECT id FROM evidence_files WHERE audit_control_id=$1", [c85])).rows[0].id as string;
    await adminPool.query("INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'hello')", [w.orgA, w.tA1, c85, w.lead]);
    await adminPool.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [c85]);
    await adminPool.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4,'reject','needs more')", [w.orgA, w.tA1, c87, w.auditor]);
    await close(w.lead, a);
  });

  it("no control of it can change: status, applicability, requirement, due date, reminder, storage folder", async () => {
    const edits: [string, unknown[]][] = [
      ["UPDATE audit_controls SET status='under_review' WHERE id=$1", []],
      ["UPDATE audit_controls SET applicable=false, na_justification='no longer used' WHERE id=$1", []],
      ["UPDATE audit_controls SET evidence_override='Something else' WHERE id=$1", []],
      ["UPDATE audit_controls SET due_date='2030-01-01' WHERE id=$1", []],
      ["UPDATE audit_controls SET last_reminded_at=now() WHERE id=$1", []],
      ["UPDATE audit_controls SET folder_id='some-folder' WHERE id=$1", []],
    ];
    for (const [sql, extra] of edits) {
      for (const actor of [w.admin, w.lead]) await denied(as(actor, (c) => c.query(sql, [c85, ...extra])), CLOSED);
      await denied(adminPool.query(sql, [c85, ...extra]), CLOSED); // even a script with full rights
    }
    // The role-specific moves that normally succeed are refused for the same reason.
    await denied(as(w.auditor, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [c85])), CLOSED);
    await denied(as(w.contrib, (c) => c.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [c87])), CLOSED);
    const row = (await adminPool.query("SELECT status, applicable, evidence_override, due_date, last_reminded_at, folder_id FROM audit_controls WHERE id=$1", [c85])).rows[0];
    expect(row).toEqual({ status: "submitted", applicable: true, evidence_override: null, due_date: null, last_reminded_at: null, folder_id: null });
  });

  it("no control can be added to it or removed from it", async () => {
    await denied(as(w.lead, (c) => c.query(
      "INSERT INTO audit_controls (org_id, tenant_id, audit_id, kind, section, control_ref, title) VALUES ($1,$2,$3,'annex','X','X.1','Extra')", [w.orgA, w.tA1, a])), CLOSED);
    await denied(adminPool.query("DELETE FROM audit_controls WHERE id=$1", [c88]), CLOSED);
    expect((await adminPool.query("SELECT count(*)::int n FROM audit_controls WHERE audit_id=$1", [a])).rows[0].n).toBeGreaterThan(90);
  });

  it("no evidence can be recorded, and none removed", async () => {
    const insert = (actor: string) => as(actor, (c) => c.query(
      "INSERT INTO evidence_files (org_id, tenant_id, audit_control_id, provider_file_id, file_name, uploaded_by) VALUES ($1,$2,$3,'new-file','new.pdf',$4)", [w.orgA, w.tA1, c87, actor]));
    await denied(insert(w.contrib), CLOSED);
    await denied(insert(w.tLead), CLOSED);
    await denied(insert(w.lead), CLOSED);
    await denied(adminPool.query("DELETE FROM evidence_files WHERE id=$1", [fileId]), CLOSED);
    expect((await adminPool.query("SELECT count(*)::int n FROM evidence_files WHERE audit_control_id IN (SELECT id FROM audit_controls WHERE audit_id=$1)", [a])).rows[0].n).toBe(1);
  });

  it("an evidence file can't be moved into or out of the closed cycle either", async () => {
    const openControl = await controlId(other, "A.8.5");
    await denied(adminPool.query("UPDATE evidence_files SET audit_control_id=$1 WHERE id=$2", [openControl, fileId]), /IMMUTABLE_COLUMN/);
    await addEvidence(w.orgA, w.tA1, openControl, w.contrib, "open.pdf");
    const openFile = (await adminPool.query("SELECT id FROM evidence_files WHERE audit_control_id=$1", [openControl])).rows[0].id as string;
    await denied(adminPool.query("UPDATE evidence_files SET audit_control_id=$1 WHERE id=$2", [c87, openFile]), /IMMUTABLE_COLUMN/);
  });

  it("a control can't be moved between a closed and an open cycle", async () => {
    await denied(adminPool.query("UPDATE audit_controls SET audit_id=$2 WHERE id=$1", [c88, other]), CLOSED);
    const openControl = await controlId(other, "A.8.8");
    await denied(adminPool.query("UPDATE audit_controls SET audit_id=$2 WHERE id=$1", [openControl, a]), CLOSED);
  });

  it("scan results and integrity flags can still be recorded on an evidence file that already exists", async () => {
    await as(w.lead, (c) => c.query("UPDATE evidence_files SET integrity_status='modified', scan_status='clean' WHERE id=$1", [fileId]));
    const row = (await adminPool.query("SELECT integrity_status, scan_status FROM evidence_files WHERE id=$1", [fileId])).rows[0];
    expect(row).toEqual({ integrity_status: "modified", scan_status: "clean" });
    // …but nothing else about the file can change (as before).
    await denied(adminPool.query("UPDATE evidence_files SET file_name='renamed.pdf' WHERE id=$1", [fileId]), /IMMUTABLE_COLUMN/);
  });

  it("no comment (including a finding) and no review can be added", async () => {
    for (const [actor, type] of [[w.lead, "comment"], [w.auditor, "major"], [w.contrib, "comment"], [w.tLead, "comment"]] as const) {
      await denied(as(actor, (c) => c.query(
        "INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, type, body) VALUES ($1,$2,$3,$4,$5,'late remark')", [w.orgA, w.tA1, c85, actor, type])), CLOSED);
    }
    await denied(as(w.auditor, (c) => c.query(
      "INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision) VALUES ($1,$2,$3,$4,'accept')", [w.orgA, w.tA1, c85, w.auditor])), CLOSED);
    await denied(adminPool.query("DELETE FROM comments WHERE audit_control_id=$1", [c85]), CLOSED);
    expect((await adminPool.query("SELECT count(*)::int n FROM comments WHERE audit_control_id=$1", [c85])).rows[0].n).toBe(1);
    expect((await adminPool.query("SELECT count(*)::int n FROM reviews WHERE audit_control_id=$1", [c85])).rows[0].n).toBe(0);
  });

  it("an existing comment, review or assignment can't be edited or removed either", async () => {
    await denied(adminPool.query("UPDATE comments SET body='edited afterwards' WHERE audit_control_id=$1", [c85]), CLOSED);
    await denied(adminPool.query("UPDATE reviews SET reason='edited afterwards' WHERE audit_control_id=$1", [c87]), CLOSED);
    await denied(adminPool.query("DELETE FROM reviews WHERE audit_control_id=$1", [c87]), CLOSED);
    await denied(adminPool.query("UPDATE control_assignments SET user_id=$2 WHERE audit_control_id=$1", [c85, w.tLead]), CLOSED);
    expect((await adminPool.query("SELECT body FROM comments WHERE audit_control_id=$1", [c85])).rows).toEqual([{ body: "hello" }]);
    expect((await adminPool.query("SELECT reason FROM reviews WHERE audit_control_id=$1", [c87])).rows).toEqual([{ reason: "needs more" }]);
    expect((await adminPool.query("SELECT user_id FROM control_assignments WHERE audit_control_id=$1", [c85])).rows).toEqual([{ user_id: w.contrib }]);
  });

  it("no control can be assigned or unassigned", async () => {
    await denied(as(w.tLead, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, c88, w.contrib])), CLOSED);
    await denied(as(w.lead, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, c88, w.tLead])), CLOSED);
    await denied(as(w.tLead, (c) => c.query("DELETE FROM control_assignments WHERE audit_control_id=$1", [c85])), CLOSED);
    await denied(adminPool.query("DELETE FROM control_assignments WHERE audit_control_id=$1", [c87]), CLOSED);
    expect((await adminPool.query("SELECT user_id FROM control_assignments WHERE audit_control_id=$1", [c85])).rows).toEqual([{ user_id: w.contrib }]);
    expect((await adminPool.query("SELECT count(*)::int n FROM control_assignments WHERE audit_control_id=$1", [c88])).rows[0].n).toBe(0);
  });

  it("everything can still be read, and the dashboard still works", async () => {
    for (const actor of [w.lead, w.auditor, w.readOnly]) {
      const rows = (await as(actor, (c) => c.query("SELECT id FROM audit_controls WHERE audit_id=$1", [a]))).rows;
      expect(rows.length).toBeGreaterThan(90);
    }
    const files = (await as(w.contrib, (c) => c.query("SELECT file_name FROM evidence_files WHERE audit_control_id=$1", [c85]))).rows;
    expect(files).toEqual([{ file_name: "policy.pdf" }]);
    const d = (await as(w.dash, (c) => c.query("SELECT dashboard_summary($1) AS d", [a]))).rows[0].d;
    expect(d.total).toBeGreaterThan(90);
  });

  it("other cycles are not affected: a second cycle for the same client, another client, another organisation", async () => {
    const o = await controlId(other, "A.8.5");
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET due_date='2031-02-02' WHERE id=$1", [o]));
    await as(w.tLead, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, o, w.contrib]));
    await as(w.lead, (c) => c.query("INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'fine')", [w.orgA, w.tA1, o, w.lead]));
    const a2 = await controlId(w.auditA2, "A.8.5");
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET due_date='2031-02-02' WHERE id=$1", [a2]));
    const b1 = await controlId(w.auditB1, "A.8.5");
    await as(w.leadB, (c) => c.query("UPDATE audit_controls SET due_date='2031-02-02' WHERE id=$1", [b1]));
  });

  it("the lock does not depend on what row-level security lets the person see: a contributor writing to a control that isn't theirs still gets the plain 'closed' answer", async () => {
    // c88 is not assigned to this contributor, so they cannot even read it; the lock must still recognise the closed cycle.
    await denied(as(w.contrib, (c) => c.query(
      "INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'x')", [w.orgA, w.tA1, c88, w.contrib])), CLOSED);
    await denied(as(w.contrib, (c) => c.query(
      "INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'x')", [w.orgA, w.tA1, c87, w.contrib])), CLOSED);
  });

  it("reopening makes every one of those changes possible again", async () => {
    const w2 = await makeWorld();
    const a2 = await newAudit(w2, w2.tA1, "round trip");
    const c = await controlId(a2, "A.8.5");
    await close(w2.admin, a2);
    await denied(as(w2.lead, (cl) => cl.query("UPDATE audit_controls SET due_date='2030-05-05' WHERE id=$1", [c])), CLOSED);
    await reopen(w2.admin, a2);
    await as(w2.lead, (cl) => cl.query("UPDATE audit_controls SET due_date='2030-05-05' WHERE id=$1", [c]));
    await as(w2.tLead, (cl) => cl.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w2.orgA, w2.tA1, c, w2.contrib]));
    await as(w2.lead, (cl) => cl.query("INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'back')", [w2.orgA, w2.tA1, c, w2.lead]));
    await addEvidence(w2.orgA, w2.tA1, c, w2.contrib);
    // and it can be closed again, with a second pair of log entries
    await close(w2.admin, a2);
    expect((await state(a2)).status).toBe("closed");
    expect(await logs(w2, "audit.closed", a2)).toHaveLength(2);
    expect(await logs(w2, "audit.reopened", a2)).toHaveLength(1);
  });
});

describe("removing whole records is not blocked by the lock", () => {
  it("a database administrator can still delete a closed audit as a whole (its controls and evidence records go with it)", async () => {
    const w = await makeWorld();
    const a = await newAudit(w, w.tA1, "to be erased");
    const c = await controlId(a, "A.8.5");
    await addEvidence(w.orgA, w.tA1, c, w.contrib);
    await adminPool.query("INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'x')", [w.orgA, w.tA1, c, w.lead]);
    await adminPool.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, c, w.contrib]);
    await close(w.admin, a);
    await adminPool.query("DELETE FROM audits WHERE id=$1", [a]);
    const count = async (sql: string, params: unknown[]) => (await adminPool.query(sql, params)).rows[0].n as number;
    expect(await count("SELECT count(*)::int n FROM audit_controls WHERE audit_id=$1", [a])).toBe(0);
    expect(await count("SELECT count(*)::int n FROM evidence_files WHERE audit_control_id=$1", [c])).toBe(0);
    expect(await count("SELECT count(*)::int n FROM comments WHERE audit_control_id=$1", [c])).toBe(0);
    expect(await count("SELECT count(*)::int n FROM control_assignments WHERE audit_control_id=$1", [c])).toBe(0);
  });
});

// ====================================================================================================================
describe("an installation that already has a cycle marked closed", () => {
  // Statements are taken from the migration actually in use (a breakage run points MIGRATIONS_DIR at a changed copy).
  const migration = () => {
    const dir = process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : path.resolve("db/migrations");
    return fs.readFileSync(path.join(dir, "014_close_audit_cycle.sql"), "utf8");
  };

  it("the upgrade gives it a closing time (so the new rule can be applied), and leaves an existing closing time and open cycles alone", async () => {
    const sql = migration();
    const backfill = sql.match(/UPDATE audits SET closed_at = created_at[\s\S]*?;\n/)![0];
    const constraint = sql.match(/ALTER TABLE audits ADD CONSTRAINT audits_closed_consistent[\s\S]*?;\n/)![0];
    const w = await makeWorld();
    const legacy = await newAudit(w, w.tA1, "legacy closed");
    const timed = await newAudit(w, w.tA1, "legacy closed with a time");
    const open = await newAudit(w, w.tA1, "legacy open");
    const c = await adminPool.connect();
    try {
      await c.query("BEGIN");
      // Put the database back as it was before this migration, then run the migration's own statements.
      await c.query("ALTER TABLE audits DROP CONSTRAINT audits_closed_consistent");
      await c.query("ALTER TABLE audits DISABLE TRIGGER audits_closed_guard");
      await c.query("UPDATE audits SET status='closed' WHERE id=$1", [legacy]);
      await c.query("UPDATE audits SET status='closed', closed_at='2020-01-01T10:00:00Z' WHERE id=$1", [timed]);
      await c.query(backfill);
      const rows = (await c.query("SELECT id, status, closed_at, created_at FROM audits WHERE id = ANY($1)", [[legacy, timed, open]])).rows;
      const by = (id: string) => rows.find((r) => r.id === id)!;
      expect(by(legacy).closed_at.getTime()).toBe(by(legacy).created_at.getTime());
      expect(by(timed).closed_at.toISOString()).toBe("2020-01-01T10:00:00.000Z");
      expect(by(open).closed_at).toBeNull();
      await c.query(constraint); // would fail if any closed cycle were left without a time
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
