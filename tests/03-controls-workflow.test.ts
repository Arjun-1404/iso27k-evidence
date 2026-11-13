import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { adminPool, appPool, as, makeWorld, controlId, addEvidence, denied, type World } from "./helpers";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const status = async (id: string) => (await adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [id])).rows[0].status as string;
const setStatus = (id: string, s: string) => (c: PoolClient) => c.query("UPDATE audit_controls SET status=$1 WHERE id=$2", [s, id]);
const assign = (w: World, control: string, user: string) =>
  as(w.tLead, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, control, user]));

describe("audit creation from a template", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("copies all 117 controls (24 clauses + 93 Annex A), all applicable and not started", async () => {
    const r = await adminPool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE kind='clause')::int AS clauses, count(*) FILTER (WHERE kind='annex')::int AS annex,
              count(*) FILTER (WHERE applicable)::int AS applicable, count(*) FILTER (WHERE status='not_started')::int AS fresh
       FROM audit_controls WHERE audit_id=$1`, [w.auditA1]);
    expect(r.rows[0]).toEqual({ n: 117, clauses: 24, annex: 93, applicable: 117, fresh: 117 });
  });

  it("is a snapshot: later edits to the template do not change an audit that already exists", async () => {
    const before = (await adminPool.query("SELECT base_evidence FROM audit_controls WHERE audit_id=$1 AND control_ref='A.8.5'", [w.auditA1])).rows[0].base_evidence;
    await adminPool.query("UPDATE template_controls SET default_evidence='CHANGED LATER' WHERE template_id=$1 AND control_ref='A.8.5'", [w.templateId]);
    const after = (await adminPool.query("SELECT base_evidence FROM audit_controls WHERE audit_id=$1 AND control_ref='A.8.5'", [w.auditA1])).rows[0].base_evidence;
    expect(after).toBe(before);
    expect(after).not.toBe("CHANGED LATER");
    await adminPool.query("UPDATE template_controls SET default_evidence=$1 WHERE template_id=$2 AND control_ref='A.8.5'", [before, w.templateId]);
  });

  it("only lead auditors and org admins can create audits, and only for tenants they can see", async () => {
    await denied(as(w.auditor, (c) => c.query("SELECT create_audit($1,$2,'x')", [w.tA1, w.templateId])), /row-level security/);
    await denied(as(w.tLead, (c) => c.query("SELECT create_audit($1,$2,'x')", [w.tA1, w.templateId])));
    await denied(as(w.lead, (c) => c.query("SELECT create_audit($1,'00000000-0000-0000-0000-000000000000','x')", [w.tA1])), /TEMPLATE_NOT_FOUND/);
  });
});

describe("applicability and editable evidence requirements", () => {
  let w: World; let c86: string; let c85: string; let cClause: string;
  beforeAll(async () => {
    w = await makeWorld();
    c86 = await controlId(w.auditA1, "A.8.6"); c85 = await controlId(w.auditA1, "A.8.5"); cClause = await controlId(w.auditA1, "4.1");
    await assign(w, c85, w.contrib);
  });

  it("a lead auditor can mark a control not applicable, but only with a justification", async () => {
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET applicable=false WHERE id=$1", [c86])), /na_needs_justification/);
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='Managed SaaS, no capacity risk' WHERE id=$1", [c86]));
    const r = await adminPool.query("SELECT applicable, na_justification FROM audit_controls WHERE id=$1", [c86]);
    expect(r.rows[0]).toEqual({ applicable: false, na_justification: "Managed SaaS, no capacity risk" });
  });

  it("mandatory clauses 4 to 10 can never be marked not applicable", async () => {
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='not needed at all' WHERE id=$1", [cClause])), /clauses_always_applicable/);
  });

  it("auditors, read-only staff, tenant users and viewers cannot change applicability", async () => {
    await denied(as(w.auditor, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='trying it' WHERE id=$1", [c85])), /FORBIDDEN_COLUMN/);
    await denied(as(w.contrib, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='trying it' WHERE id=$1", [c85])), /FORBIDDEN_COLUMN/);
    await denied(as(w.tLead, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='trying it' WHERE id=$1", [c85])), /FORBIDDEN_COLUMN/);
    for (const u of [w.readOnly, w.viewer]) {
      const r = await as(u, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='trying it' WHERE id=$1", [c85]));
      expect(r.rowCount).toBe(0);
    }
  });

  it("the auditor can override the evidence requirement per tenant; the default stays and reset restores it", async () => {
    const base = (await adminPool.query("SELECT base_evidence FROM audit_controls WHERE id=$1", [c85])).rows[0].base_evidence as string;
    await as(w.lead, (c) => c.query(
      "UPDATE audit_controls SET evidence_override='Up to 4 documents: MFA policy, conditional access export', file_spec_override='{\"types\":[\"document\"],\"max_files\":4}' WHERE id=$1", [c85]));
    const eff = (id: string, uid: string) => as(uid, (c) => c.query("SELECT COALESCE(evidence_override, base_evidence) AS effective, base_evidence, file_spec_override FROM audit_controls WHERE id=$1", [id]));
    const r = (await eff(c85, w.contrib)).rows[0];
    expect(r.effective).toBe("Up to 4 documents: MFA policy, conditional access export");
    expect(r.base_evidence).toBe(base);
    expect(r.file_spec_override).toEqual({ types: ["document"], max_files: 4 });
    // another tenant's audit is unaffected
    const other = await adminPool.query("SELECT evidence_override FROM audit_controls WHERE audit_id=$1 AND control_ref='A.8.5'", [w.auditA2]);
    expect(other.rows[0].evidence_override).toBeNull();
    // reset to default
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET evidence_override=NULL, file_spec_override=NULL WHERE id=$1", [c85]));
    expect((await eff(c85, w.contrib)).rows[0].effective).toBe(base);
  });

  it("only lead auditors and admins may edit requirements or due dates; the template snapshot itself is immutable", async () => {
    await denied(as(w.auditor, (c) => c.query("UPDATE audit_controls SET evidence_override='x' WHERE id=$1", [c85])), /FORBIDDEN_COLUMN/);
    await denied(as(w.contrib, (c) => c.query("UPDATE audit_controls SET evidence_override='x' WHERE id=$1", [c85])), /FORBIDDEN_COLUMN/);
    await denied(as(w.auditor, (c) => c.query("UPDATE audit_controls SET due_date=current_date+5 WHERE id=$1", [c85])), /FORBIDDEN_COLUMN/);
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET due_date=current_date+5 WHERE id=$1", [c85]));
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET title='Renamed' WHERE id=$1", [c85])), /IMMUTABLE_COLUMN/);
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET base_evidence='rewritten' WHERE id=$1", [c85])), /IMMUTABLE_COLUMN/);
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET tenant_id=$1 WHERE id=$2", [w.tA2, c85])));
  });

  it("changing a requirement after evidence was submitted flags the control as 'requirement changed'", async () => {
    const c = await controlId(w.auditA1, "A.8.3");
    await adminPool.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [c]);
    await as(w.lead, (cl) => cl.query("UPDATE audit_controls SET evidence_override='Three screenshots' WHERE id=$1", [c]));
    const r = await adminPool.query("SELECT requirement_changed_at, status FROM audit_controls WHERE id=$1", [c]);
    expect(r.rows[0].requirement_changed_at).not.toBeNull();
    expect(r.rows[0].status).toBe("submitted");   // existing evidence is kept, status is not reset
  });
});

describe("evidence, submission and review workflow", () => {
  let w: World; let c85: string;
  beforeAll(async () => { w = await makeWorld(); c85 = await controlId(w.auditA1, "A.8.5"); await assign(w, c85, w.contrib); });

  it("a contributor cannot submit without evidence, then can once a file is recorded", async () => {
    await denied(as(w.contrib, setStatus(c85, "submitted")), /EVIDENCE_REQUIRED/);
    await as(w.contrib, (c) => c.query(
      "INSERT INTO evidence_files (org_id, tenant_id, audit_control_id, provider_file_id, file_name, uploaded_by) VALUES ($1,$2,$3,'drive-1','mfa.pdf',$4)", [w.orgA, w.tA1, c85, w.contrib]));
    await as(w.contrib, setStatus(c85, "submitted"));
    expect(await status(c85)).toBe("submitted");
  });

  it("a contributor cannot accept, reject or review their own submission", async () => {
    await denied(as(w.contrib, setStatus(c85, "accepted")), /INVALID_TRANSITION/);
    await denied(as(w.tLead, setStatus(c85, "under_review")), /INVALID_TRANSITION/);
    await denied(as(w.contrib, (c) => c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision) VALUES ($1,$2,$3,$4,'accept')", [w.orgA, w.tA1, c85, w.contrib])), /row-level security/);
  });

  it("read-only auditors and viewers cannot change status at all", async () => {
    for (const u of [w.readOnly, w.viewer]) {
      const r = await as(u, setStatus(c85, "accepted"));
      expect(r.rowCount).toBe(0);
    }
    expect(await status(c85)).toBe("submitted");
  });

  it("rejecting needs a reason; the auditor rejects, the contributor resubmits, the auditor accepts", async () => {
    await denied(as(w.auditor, (c) => c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision) VALUES ($1,$2,$3,$4,'reject')", [w.orgA, w.tA1, c85, w.auditor])), /reject_needs_reason/);
    await as(w.auditor, async (c) => {
      await c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4,'reject','Screenshot is cropped')", [w.orgA, w.tA1, c85, w.auditor]);
      await c.query("UPDATE audit_controls SET status='rejected' WHERE id=$1", [c85]);
    });
    // the tenant can read the reason
    const reason = await as(w.contrib, (c) => c.query("SELECT reason FROM reviews WHERE audit_control_id=$1", [c85]));
    expect(reason.rows[0].reason).toBe("Screenshot is cropped");
    await as(w.contrib, setStatus(c85, "submitted"));
    await as(w.auditor, async (c) => {
      await c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision) VALUES ($1,$2,$3,$4,'accept')", [w.orgA, w.tA1, c85, w.auditor]);
      await c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [c85]);
    });
    expect(await status(c85)).toBe("accepted");
  });

  it("accepted evidence is locked for the tenant; the auditor can only reopen it to 'under review'", async () => {
    await denied(as(w.contrib, setStatus(c85, "submitted")), /INVALID_TRANSITION/);
    await denied(as(w.auditor, setStatus(c85, "submitted")), /INVALID_TRANSITION/);
    await denied(as(w.auditor, setStatus(c85, "not_started")), /INVALID_TRANSITION/);
    await as(w.auditor, setStatus(c85, "under_review"));
    expect(await status(c85)).toBe("under_review");
  });

  it("reviews cannot be forged as somebody else, and cannot be edited or deleted afterwards", async () => {
    await denied(as(w.auditor, (c) => c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision) VALUES ($1,$2,$3,$4,'accept')", [w.orgA, w.tA1, c85, w.lead])), /row-level security/);
    await denied(as(w.auditor, (c) => c.query("UPDATE reviews SET decision='accept'")), /permission denied/);
    await denied(as(w.auditor, (c) => c.query("DELETE FROM reviews")), /permission denied/);
  });

  it("a control that is not applicable cannot change status", async () => {
    const c86 = await controlId(w.auditA1, "A.8.6");
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='Not relevant here' WHERE id=$1", [c86]));
    await denied(as(w.lead, setStatus(c86, "awaiting_evidence")), /NOT_APPLICABLE/);
  });

  it("evidence rules: unassigned contributors, viewers, spoofed uploaders and other tenants are all refused", async () => {
    const c87 = await controlId(w.auditA1, "A.8.7");
    const ins = (uid: string, by: string, tenant = w.tA1) => (c: PoolClient) => c.query(
      "INSERT INTO evidence_files (org_id, tenant_id, audit_control_id, provider_file_id, file_name, uploaded_by) VALUES ($1,$2,$3,'x1','x.pdf',$4)", [w.orgA, tenant, c87, by]);
    await denied(as(w.contrib, ins(w.contrib, w.contrib)), /row-level security/);          // not assigned to A.8.7
    await denied(as(w.viewer, ins(w.viewer, w.viewer)), /row-level security/);              // viewers cannot upload
    await denied(as(w.tLead, ins(w.tLead, w.contrib)), /row-level security/);               // uploaded_by must be yourself
    await denied(as(w.tLead2, ins(w.tLead2, w.tLead2)), /row-level security/);              // other tenant
    await denied(as(w.contrib, (c) => c.query("UPDATE evidence_files SET file_name='renamed.pdf'")), /permission denied/);
    await denied(as(w.tLead, (c) => c.query("DELETE FROM evidence_files")), /permission denied/);
    await as(w.tLead, ins(w.tLead, w.tLead));                                                // the tenant lead may
  });
});

describe("reminders", () => {
  let w: World; let c85: string;
  beforeAll(async () => { w = await makeWorld(); c85 = await controlId(w.auditA1, "A.8.5"); });
  const remind = (id: string) => (c: PoolClient) => c.query("UPDATE audit_controls SET last_reminded_at = now() WHERE id=$1", [id]);

  it("an auditor can remind once; a second reminder within 24 hours is refused; after 24 hours it works again", async () => {
    await as(w.auditor, remind(c85));
    await denied(as(w.auditor, remind(c85)), /REMINDER_RATE_LIMIT/);
    await denied(as(w.lead, remind(c85)), /REMINDER_RATE_LIMIT/);
    await adminPool.query("UPDATE audit_controls SET last_reminded_at = now() - interval '25 hours' WHERE id=$1", [c85]);
    await as(w.auditor, remind(c85));
  });

  it("the reminder timestamp cannot be back-dated or spoofed; the database sets it", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    await as(w.lead, (cl) => cl.query("UPDATE audit_controls SET last_reminded_at = '2001-01-01' WHERE id=$1", [c]));
    const r = await adminPool.query("SELECT extract(epoch from now() - last_reminded_at) AS age FROM audit_controls WHERE id=$1", [c]);
    expect(Number(r.rows[0].age)).toBeLessThan(60);
  });

  it("reminders are refused for evidence that is not outstanding, and for tenant users and read-only staff", async () => {
    const c = await controlId(w.auditA1, "A.8.4");
    await adminPool.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [c]);
    await denied(as(w.auditor, remind(c)), /REMINDER_NOT_ALLOWED/);
    const c2 = await controlId(w.auditA1, "A.8.2");
    await denied(as(w.tLead, remind(c2)), /FORBIDDEN_COLUMN/);
    const r = await as(w.readOnly, remind(c2));
    expect(r.rowCount).toBe(0);
  });
});

describe("comments and findings", () => {
  let w: World; let c85: string;
  beforeAll(async () => { w = await makeWorld(); c85 = await controlId(w.auditA1, "A.8.5"); await assign(w, c85, w.contrib); });
  const post = (uid: string, type: string, body = "hello", tenant = w.tA1) => (c: PoolClient) => c.query(
    "INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, type, body) VALUES ($1,$2,$3,$4,$5,$6)", [w.orgA, tenant, c85, uid, type, body]);

  it("tenant users can only post plain comments; auditors can also record findings (major, minor, OFI)", async () => {
    await as(w.contrib, post(w.contrib, "comment"));
    await denied(as(w.contrib, post(w.contrib, "major")), /row-level security/);
    await denied(as(w.tLead, post(w.tLead, "ofi")), /row-level security/);
    for (const t of ["comment", "major", "minor", "ofi", "observation"]) await as(w.auditor, post(w.auditor, t, `finding ${t}`));
  });

  it("read-only staff, viewers and dashboard roles cannot comment; authors cannot be forged", async () => {
    await denied(as(w.readOnly, post(w.readOnly, "comment")), /row-level security/);
    await denied(as(w.viewer, post(w.viewer, "comment")), /row-level security/);
    await denied(as(w.auditor, post(w.lead, "comment")), /row-level security/);
    await denied(as(w.tLead2, post(w.tLead2, "comment")), /row-level security/);
  });

  it("empty and oversized comments are refused; comments are immutable once posted", async () => {
    await denied(as(w.auditor, post(w.auditor, "comment", "   ")), /comments_body_check/);
    await denied(as(w.auditor, post(w.auditor, "comment", "x".repeat(4001))), /comments_body_check/);
    await denied(as(w.auditor, (c) => c.query("UPDATE comments SET body='edited'")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("DELETE FROM comments")), /permission denied/);
  });

  it("the tenant sees auditor comments on its own controls; nobody else does", async () => {
    const own = await as(w.contrib, (c) => c.query("SELECT count(*)::int AS n FROM comments"));
    expect(own.rows[0].n).toBeGreaterThanOrEqual(6);
    for (const u of [w.tLead2, w.adminB, w.leadB]) {
      const r = await as(u, (c) => c.query("SELECT count(*)::int AS n FROM comments"));
      expect(r.rows[0].n).toBe(0);
    }
    const ro = await as(w.readOnly, (c) => c.query("SELECT count(*)::int AS n FROM comments"));
    expect(ro.rows[0].n).toBeGreaterThanOrEqual(6);
    const dash = await as(w.dash, (c) => c.query("SELECT count(*)::int AS n FROM comments"));
    expect(dash.rows[0].n).toBe(0);
  });
});

describe("archived tenants are read-only", () => {
  it("after archiving, reads still work but nothing can be written", async () => {
    const w = await makeWorld();
    const c85 = await controlId(w.auditA1, "A.8.5");
    await as(w.admin, (c) => c.query("UPDATE tenants SET status='archived' WHERE id=$1", [w.tA1]));
    const read = await as(w.lead, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls WHERE audit_id=$1", [w.auditA1]));
    expect(read.rows[0].n).toBe(117);
    const upd = await as(w.lead, (c) => c.query("UPDATE audit_controls SET due_date=current_date+1 WHERE id=$1", [c85]));
    expect(upd.rowCount).toBe(0);
    await denied(as(w.lead, (c) => c.query("INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, body) VALUES ($1,$2,$3,$4,'late')", [w.orgA, w.tA1, c85, w.lead])), /row-level security/);
    await denied(as(w.lead, (c) => c.query("SELECT create_audit($1,$2,'new')", [w.tA1, w.templateId])), /row-level security/);
  });
});

describe("dashboard numbers", () => {
  it("counts, overdue and completion percentage are correct and exclude not-applicable controls", async () => {
    const w = await makeWorld();
    const ref = async (r: string) => controlId(w.auditA1, r);
    for (const r of ["A.7.1", "A.7.2", "A.7.3", "A.7.4"]) {
      await adminPool.query("UPDATE audit_controls SET applicable=false, na_justification='Fully remote company' WHERE id=$1", [await ref(r)]);
    }
    for (const r of ["4.1", "4.2", "4.3", "4.4", "5.1"]) {
      const id = await ref(r); await addEvidence(w.orgA, w.tA1, id, null);
      await adminPool.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [id]);
    }
    await adminPool.query("UPDATE audit_controls SET status='awaiting_evidence', due_date=current_date-3 WHERE id=$1", [await ref("A.8.5")]);
    await adminPool.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [await ref("A.8.7")]);
    const s = (await as(w.dash, (c) => c.query("SELECT dashboard_summary($1) AS s", [w.auditA1]))).rows[0].s;
    expect(s.total).toBe(117);
    expect(s.not_applicable).toBe(4);
    expect(s.applicable).toBe(113);
    expect(s.accepted).toBe(5);
    expect(s.overdue).toBe(1);
    expect(s.completion_pct).toBe(4.4);          // 5 of 113
    expect(s.by_status.awaiting_evidence).toBe(1);
    expect(s.by_status.submitted).toBe(1);
    const phys = s.by_section.find((x: { section: string }) => x.section === "A.7 Physical controls");
    expect(phys).toEqual({ section: "A.7 Physical controls", applicable: 10, accepted: 0 });
  });
});
