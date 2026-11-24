import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, denied, makeWorld, controlId, addEvidence, type World } from "./helpers.ts";
import { BASE_ROLE_PERMISSIONS, PERMISSIONS, BASE_ROLES } from "../src/services/roles.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const RLS = /row-level security/;
let seq = 0;
const status = async (ctl: string) => (await adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [ctl])).rows[0].status as string;
const setStatus = (ctl: string, s: string) => adminPool.query("UPDATE audit_controls SET status=$2 WHERE id=$1", [ctl, s]);
/** A fresh control (a different one on every call for the same audit, so tests never share state). */
const REFS = [...Array.from({ length: 37 }, (_, i) => `A.5.${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `A.6.${i + 1}`), ...Array.from({ length: 14 }, (_, i) => `A.7.${i + 1}`)];
const used = new Map<string, number>();
const nextControl = (audit: string) => {
  const n = used.get(audit) ?? 0;
  if (n >= REFS.length) throw new Error("test used up the controls of one audit");
  used.set(audit, n + 1);
  return controlId(audit, REFS[n]);
};

/** What the firm's "close" does, the way the service does it: the review and the status change in one transaction. */
const closeAs = (actor: string, ctl: string, reason: string | null = "Seen on site during the visit") =>
  as(actor, async (c) => {
    await c.query(
      "INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) SELECT org_id, tenant_id, id, $2, 'close', $3 FROM audit_controls WHERE id=$1",
      [ctl, actor, reason]);
    await c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl]);
  });

async function mkRole(w: World, base: string, denied: string[], name = `role-${base}-${++seq}-${Math.random().toString(36).slice(2, 6)}`) {
  return (await adminPool.query("INSERT INTO custom_roles (org_id, name, base_role, denied) VALUES ($1,$2,$3,$4) RETURNING id", [w.orgA, name, base, denied])).rows[0].id as string;
}
/** A new, active person, optionally with a custom role. Firm staff are assigned to client A1 so they can see it. */
async function mkUser(w: World, role: string, customRole: string | null = null) {
  const tenant = ["tenant_lead", "contributor", "viewer", "tenant_dashboard"].includes(role) ? w.tA1 : null;
  const email = `${role}-${++seq}@${tenant ? `a1-${w.tag}.test` : `audit-a-${w.tag}.test`}`;
  const id = (await adminPool.query(
    "INSERT INTO users (org_id, tenant_id, email, full_name, role, status, custom_role_id) VALUES ($1,$2,$3,'X','" + role + "','active',$4) RETURNING id",
    [w.orgA, tenant, email, customRole])).rows[0].id as string;
  if (!tenant) await adminPool.query("INSERT INTO auditor_assignments (org_id, user_id, tenant_id) VALUES ($1,$2,$3)", [w.orgA, id, w.tA1]);
  return id;
}
const assign = (w: World, ctl: string, user: string) =>
  adminPool.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [w.orgA, w.tA1, ctl, user]);

describe("the firm closing a control without client evidence", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an organisation admin, a lead auditor and an auditor can close controls that were never submitted", async () => {
    for (const [actor, from] of [[w.admin, "not_started"], [w.lead, "awaiting_evidence"], [w.auditor, "rejected"]] as const) {
      const ctl = await nextControl(w.auditA1);
      await setStatus(ctl, from);
      await closeAs(actor, ctl);
      expect(await status(ctl)).toBe("accepted");
      const rv = (await adminPool.query("SELECT decision, reason, reviewer_id FROM reviews WHERE audit_control_id=$1", [ctl])).rows;
      expect(rv).toEqual([{ decision: "close", reason: "Seen on site during the visit", reviewer_id: actor }]);
      expect((await adminPool.query("SELECT count(*)::int n FROM evidence_files WHERE audit_control_id=$1", [ctl])).rows[0].n).toBe(0);
    }
  });

  it("a reason is required (the review is refused without one, and so nothing changes)", async () => {
    const ctl = await nextControl(w.auditA1);
    for (const reason of [null, "", "  ", "ab"]) await denied(closeAs(w.lead, ctl, reason), /reject_needs_reason/);
    expect(await status(ctl)).toBe("not_started");
  });

  it("without a 'close' review in the same transaction, a control still cannot be accepted without evidence", async () => {
    for (const from of ["not_started", "awaiting_evidence", "rejected"]) {
      const ctl = await nextControl(w.auditA1);
      await setStatus(ctl, from);
      await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl])), /INVALID_TRANSITION/);
      expect(await status(ctl)).toBe(from);
    }
    const sub = await nextControl(w.auditA1);
    await setStatus(sub, "submitted"); // submitted, but no file is recorded: still refused, as before
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [sub])), /EVIDENCE_REQUIRED/);
  });

  it("an 'accept' or 'reject' review is not a 'close': it does not open the way", async () => {
    const ctl = await nextControl(w.auditA1);
    await denied(as(w.lead, async (c) => {
      await c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) SELECT org_id, tenant_id, id, $2, 'accept', NULL FROM audit_controls WHERE id=$1", [ctl, w.lead]);
      await c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl]);
    }), /INVALID_TRANSITION/);
  });

  it("an older 'close' review cannot be reused later: it has to be written in the same transaction", async () => {
    const ctl = await nextControl(w.auditA1);
    await adminPool.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason, created_at) VALUES ($1,$2,$3,$4,'close','Earlier close', now() - interval '1 minute')", [w.orgA, w.tA1, ctl, w.lead]);
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl])), /INVALID_TRANSITION/);
    // Another person's review of the same control, written just now, does not count for this person either.
    await adminPool.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4,'close','Written by the lead')", [w.orgA, w.tA1, ctl, w.lead]);
    await denied(as(w.auditor, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl])), /INVALID_TRANSITION/);
    expect(await status(ctl)).toBe("not_started");
  });

  it("client-side roles, read-only reviewers and dashboard users cannot close a control", async () => {
    for (const actor of [w.tLead, w.contrib, w.viewer, w.readOnly]) {
      const ctl = await nextControl(w.auditA1);
      await assign(w, ctl, w.contrib);
      await denied(closeAs(actor, ctl), RLS);
      expect(await status(ctl)).toBe("not_started");
    }
    // Even if the review row existed, the client roles' own transition rule has no way to 'accepted'.
    const ctl = await nextControl(w.auditA1);
    await adminPool.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4,'close','x y z')", [w.orgA, w.tA1, ctl, w.lead]);
    await denied(as(w.tLead, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl])), /INVALID_TRANSITION|FORBIDDEN/);
  });

  it("an auditor who is not assigned to the client, and another organisation's staff, cannot close its controls", async () => {
    const ctl = await nextControl(w.auditA1);
    const unassigned = (await adminPool.query("INSERT INTO users (org_id, email, role, status) VALUES ($1,$2,'auditor','active') RETURNING id", [w.orgA, `unassigned-${w.tag}-${++seq}@audit-a-${w.tag}.test`])).rows[0].id as string;
    // The control is invisible to them, so nothing is found to review or change (the service answers "not found").
    for (const who of [unassigned, w.adminB, w.leadB]) await closeAs(who, ctl);
    expect(await status(ctl)).toBe("not_started");
    expect((await adminPool.query("SELECT 1 FROM reviews WHERE audit_control_id=$1", [ctl])).rowCount).toBe(0);
  });

  it("a control that is not applicable cannot be closed (nothing is asked of the client, and there is nothing to sign off)", async () => {
    const ctl = await nextControl(w.auditA1);
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='Not used here' WHERE id=$1", [ctl]));
    await denied(closeAs(w.lead, ctl), /NOT_APPLICABLE/);
  });

  it("works again after the control is put back under review, but accept still needs a file", async () => {
    const ctl = await nextControl(w.auditA1);
    await closeAs(w.lead, ctl);
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET status='under_review' WHERE id=$1", [ctl])); // reopened for review
    expect(await status(ctl)).toBe("under_review");
    await denied(as(w.lead, (c) => c.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [ctl])), /EVIDENCE_REQUIRED/);
    await closeAs(w.lead, ctl, "Confirmed again at the follow-up visit");
    expect(await status(ctl)).toBe("accepted");
  });

  it("is not possible in a closed audit cycle", async () => {
    const a = (await as(w.admin, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [w.tA1, w.templateId, "to be closed"]))).rows[0].id as string;
    const ctl = await controlId(a, "A.5.1");
    await as(w.admin, (c) => c.query("SELECT audit_close($1)", [a]));
    await denied(closeAs(w.lead, ctl), /AUDIT_CLOSED/);
  });
});

describe("custom roles: what they can be", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("the list of abilities in the program is the one the database allows, for every built-in role it can be based on", async () => {
    for (const base of BASE_ROLES) {
      for (const p of PERMISSIONS) {
        const ok = BASE_ROLE_PERMISSIONS[base].includes(p);
        const attempt = adminPool.query("INSERT INTO custom_roles (org_id, name, base_role, denied) VALUES ($1,$2,$3,$4) RETURNING id", [w.orgA, `fit-${base}-${p}-${++seq}`, base, [p]]);
        if (ok) await attempt; else await denied(attempt, /custom_roles_denied_fit_base/);
      }
    }
  });

  it("can only be based on a lead auditor, auditor, client lead or contributor (never the organisation admin)", async () => {
    for (const base of ["org_admin", "read_only", "dashboard_only", "viewer", "tenant_dashboard", "nonsense"]) {
      await denied(adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,$2,$3)", [w.orgA, `bad-${base}`, base]), /custom_roles_base_check/);
    }
  });

  it("needs a name of 1 to 60 characters, unique within the organisation whatever the case", async () => {
    await denied(adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,'   ','auditor')", [w.orgA]), /custom_roles_name_check/);
    await denied(adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,$2,'auditor')", [w.orgA, "x".repeat(61)]), /custom_roles_name_check/);
    await adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,'Junior Auditor','auditor')", [w.orgA]);
    await denied(adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,' junior auditor ','lead_auditor')", [w.orgA]), /custom_roles_name_uq/);
    await adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,'Junior Auditor','auditor')", [w.orgB]); // another organisation may use the name
  });

  it("only the organisation admin can create, change or delete one; the firm's staff can read them; the client's people and other organisations cannot", async () => {
    const id = await mkRole(w, "auditor", ["remind"]);
    const mk = (u: string) => as(u, (c) => c.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,$2,'auditor')", [w.orgA, `mine-${++seq}`]));
    await mk(w.admin);
    for (const u of [w.lead, w.auditor, w.readOnly, w.tLead, w.contrib]) await denied(mk(u), RLS);

    for (const u of [w.admin, w.lead, w.auditor, w.readOnly]) {
      expect((await as(u, (c) => c.query("SELECT id FROM custom_roles WHERE id=$1", [id]))).rowCount).toBe(1);
    }
    for (const u of [w.tLead, w.contrib, w.viewer, w.tDash, w.adminB, w.leadB]) {
      expect((await as(u, (c) => c.query("SELECT id FROM custom_roles WHERE id=$1", [id]))).rowCount).toBe(0);
    }
    // A change or delete by anybody but the admin matches no row.
    for (const u of [w.lead, w.auditor, w.adminB]) {
      expect((await as(u, (c) => c.query("UPDATE custom_roles SET denied='{}' WHERE id=$1", [id]))).rowCount).toBe(0);
      expect((await as(u, (c) => c.query("DELETE FROM custom_roles WHERE id=$1", [id]))).rowCount).toBe(0);
    }
    expect((await adminPool.query("SELECT denied FROM custom_roles WHERE id=$1", [id])).rows[0].denied).toEqual(["remind"]);
    expect((await as(w.admin, (c) => c.query("UPDATE custom_roles SET denied='{review}' WHERE id=$1", [id]))).rowCount).toBe(1);
    expect((await as(w.admin, (c) => c.query("DELETE FROM custom_roles WHERE id=$1", [id]))).rowCount).toBe(1);
  });

  it("the organisation admin of one firm cannot make a role in another's name", async () => {
    await denied(as(w.admin, (c) => c.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,'sneaky','auditor')", [w.orgB])), RLS);
  });

  it("its base role and organisation can never change", async () => {
    const id = await mkRole(w, "auditor", []);
    await denied(adminPool.query("UPDATE custom_roles SET base_role='lead_auditor' WHERE id=$1", [id]), /IMMUTABLE_COLUMN/);
    await denied(adminPool.query("UPDATE custom_roles SET org_id=$2 WHERE id=$1", [id, w.orgB]), /IMMUTABLE_COLUMN/);
    await adminPool.query("UPDATE custom_roles SET name='renamed', denied='{comment}' WHERE id=$1", [id]);
  });
});

describe("custom roles: who has one", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("a person's custom role must be based on their built-in role, and belong to their organisation", async () => {
    const aud = await mkRole(w, "auditor", ["remind"]);
    const lead = await mkUser(w, "lead_auditor");
    await denied(adminPool.query("UPDATE users SET custom_role_id=$2 WHERE id=$1", [lead, aud]), /INVALID_CUSTOM_ROLE/);
    const auditor = await mkUser(w, "auditor", aud);
    await denied(adminPool.query("UPDATE users SET role='lead_auditor' WHERE id=$1", [auditor]), /INVALID_CUSTOM_ROLE/); // the role can't move out from under it
    await adminPool.query("UPDATE users SET role='lead_auditor', custom_role_id=NULL WHERE id=$1", [auditor]);
    const otherOrg = (await adminPool.query("INSERT INTO custom_roles (org_id, name, base_role) VALUES ($1,'theirs','auditor') RETURNING id", [w.orgB])).rows[0].id as string;
    await denied(mkUser(w, "auditor", otherOrg), /INVALID_CUSTOM_ROLE/);
  });

  it("a role in use cannot be deleted", async () => {
    const r = await mkRole(w, "contributor", ["comment"]);
    await mkUser(w, "contributor", r);
    await denied(adminPool.query("DELETE FROM custom_roles WHERE id=$1", [r]), /users_custom_role_fk/);
  });

  it("only the firm hands out custom roles: a client lead cannot give one, or lift one the firm gave", async () => {
    const r = await mkRole(w, "contributor", ["upload"]);
    const restricted = await mkUser(w, "contributor", r);
    // The client lead can edit their own contributors in general...
    expect((await as(w.tLead, (c) => c.query("UPDATE users SET full_name='Renamed' WHERE id=$1", [restricted]))).rowCount).toBe(1);
    // ...but not the custom role.
    await denied(as(w.tLead, (c) => c.query("UPDATE users SET custom_role_id=NULL WHERE id=$1", [restricted])), /FORBIDDEN_ROLE: only the audit firm/);
    await denied(as(w.tLead, (c) => c.query("UPDATE users SET custom_role_id=$2 WHERE id=$1", [w.contrib, r])), /FORBIDDEN_ROLE: only the audit firm/);
    await denied(as(w.tLead, (c) => c.query(
      "INSERT INTO users (org_id, tenant_id, email, role, custom_role_id) VALUES ($1,$2,$3,'contributor',$4)", [w.orgA, w.tA1, `new-${++seq}@a1-${w.tag}.test`, r])), /FORBIDDEN_ROLE: only the audit firm/);
    expect((await adminPool.query("SELECT custom_role_id FROM users WHERE id=$1", [restricted])).rows[0].custom_role_id).toBe(r);

    // The firm can: a lead auditor assigned to the client, and the organisation admin.
    expect((await as(w.lead, (c) => c.query("UPDATE users SET custom_role_id=NULL WHERE id=$1", [restricted]))).rowCount).toBe(1);
    expect((await as(w.admin, (c) => c.query("UPDATE users SET custom_role_id=$2 WHERE id=$1", [restricted, r]))).rowCount).toBe(1);
  });

  it("a lead auditor cannot give a custom role to staff, and an auditor cannot give one to anybody", async () => {
    const r = await mkRole(w, "auditor", ["remind"]);
    const a = await mkUser(w, "auditor");
    expect((await as(w.lead, (c) => c.query("UPDATE users SET custom_role_id=$2 WHERE id=$1", [a, r]))).rowCount).toBe(0);
    expect((await as(w.auditor, (c) => c.query("UPDATE users SET custom_role_id=$2 WHERE id=$1", [w.contrib, null]))).rowCount).toBe(0);
    expect((await as(w.admin, (c) => c.query("UPDATE users SET custom_role_id=$2 WHERE id=$1", [a, r]))).rowCount).toBe(1);
  });

  it("a person cannot change their own custom role or role", async () => {
    const r = await mkRole(w, "auditor", ["remind"]);
    const a = await mkUser(w, "auditor", r);
    expect((await as(a, (c) => c.query("UPDATE users SET custom_role_id=NULL WHERE id=$1", [a]))).rowCount).toBe(0);
    expect((await as(a, (c) => c.query("UPDATE users SET role='lead_auditor', custom_role_id=NULL WHERE id=$1", [a]))).rowCount).toBe(0);
    expect((await adminPool.query("SELECT role, custom_role_id FROM users WHERE id=$1", [a])).rows[0]).toEqual({ role: "auditor", custom_role_id: r });
  });

  it("app_allows() is true unless the person's own custom role took the ability away; app_access() says what", async () => {
    const r = await mkRole(w, "auditor", ["remind", "comment"]);
    const a = await mkUser(w, "auditor", r);
    const ask = (u: string, p: string) => as(u, async (c) => (await c.query("SELECT app_allows($1) AS ok", [p])).rows[0].ok as boolean);
    expect(await ask(a, "remind")).toBe(false);
    expect(await ask(a, "comment")).toBe(false);
    expect(await ask(a, "review")).toBe(true);
    expect(await ask(w.auditor, "remind")).toBe(true); // no custom role
    expect(await ask(w.admin, "review")).toBe(true);
    const acc = (await as(a, (c) => c.query("SELECT * FROM app_access()"))).rows[0];
    expect(acc.out_role).toBe("auditor");
    expect(acc.out_custom_role_id).toBe(r);
    expect([...acc.out_denied].sort()).toEqual(["comment", "remind"]);
    expect((await as(w.lead, (c) => c.query("SELECT * FROM app_access()"))).rows[0]).toMatchObject({ out_role: "lead_auditor", out_custom_role_id: null, out_denied: [] });
    // A switched-off person has no access at all.
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [a]);
    expect((await as(a, (c) => c.query("SELECT * FROM app_access()"))).rowCount).toBe(0);
  });
});

describe("custom roles: each ability that can be taken away really is, by the database", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  const restricted = async (base: string, perms: string[]) => mkUser(w, base, await mkRole(w, base, perms));

  it("review: cannot record a decision, nor move a control to under review, accepted or rejected", async () => {
    const u = await restricted("auditor", ["review"]);
    const ctl = await nextControl(w.auditA1);
    await addEvidence(w.orgA, w.tA1, ctl, w.contrib);
    await setStatus(ctl, "submitted");
    await denied(as(u, (c) => c.query("INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision) SELECT org_id, tenant_id, id, $2, 'accept' FROM audit_controls WHERE id=$1", [ctl, u])), RLS);
    for (const s of ["under_review", "accepted", "rejected"]) {
      await denied(as(u, (c) => c.query("UPDATE audit_controls SET status=$2 WHERE id=$1", [ctl, s])), /FORBIDDEN_PERMISSION: your role does not allow reviewing/);
    }
    expect(await status(ctl)).toBe("submitted");
    await denied(closeAs(u, await nextControl(w.auditA1)), RLS); // and so cannot close either
    // The same lead role without the restriction still can.
    await as(w.auditor, (c) => c.query("UPDATE audit_controls SET status='under_review' WHERE id=$1", [ctl]));
  });

  it("remind: cannot send a reminder", async () => {
    const u = await restricted("lead_auditor", ["remind"]);
    const ctl = await nextControl(w.auditA1);
    await denied(as(u, (c) => c.query("UPDATE audit_controls SET last_reminded_at=now() WHERE id=$1", [ctl])), /FORBIDDEN_PERMISSION: your role does not allow sending reminders/);
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET last_reminded_at=now() WHERE id=$1", [ctl]));
  });

  it("applicability: cannot mark a control applicable or not applicable", async () => {
    const u = await restricted("lead_auditor", ["applicability"]);
    const ctl = await nextControl(w.auditA1);
    await denied(as(u, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='Not used here' WHERE id=$1", [ctl])), /FORBIDDEN_PERMISSION: your role does not allow changing whether a control applies/);
    // ...but can still do the other things a lead auditor does.
    await as(u, (c) => c.query("UPDATE audit_controls SET due_date='2030-01-01' WHERE id=$1", [ctl]));
  });

  it("due_dates: cannot set or clear a due date", async () => {
    const u = await restricted("lead_auditor", ["due_dates"]);
    const ctl = await nextControl(w.auditA1);
    await denied(as(u, (c) => c.query("UPDATE audit_controls SET due_date='2030-01-01' WHERE id=$1", [ctl])), /FORBIDDEN_PERMISSION: your role does not allow changing due dates/);
    await as(u, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='Not used here' WHERE id=$1", [ctl]));
  });

  it("requirements: cannot change what evidence a control asks for", async () => {
    const u = await restricted("lead_auditor", ["requirements"]);
    const ctl = await nextControl(w.auditA1);
    await denied(as(u, (c) => c.query("UPDATE audit_controls SET evidence_override='Something else' WHERE id=$1", [ctl])), /FORBIDDEN_PERMISSION: your role does not allow changing what evidence/);
    await as(w.lead, (c) => c.query("UPDATE audit_controls SET evidence_override='Something else' WHERE id=$1", [ctl]));
  });

  it("assign_controls: cannot hand a control to a person, or take it away (client lead and lead auditor alike)", async () => {
    for (const base of ["tenant_lead", "lead_auditor"]) {
      const u = await restricted(base, ["assign_controls"]);
      const ctl = await nextControl(w.auditA1);
      await denied(as(u, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, ctl, w.contrib])), RLS);
      await assign(w, ctl, w.contrib);
      expect((await as(u, (c) => c.query("DELETE FROM control_assignments WHERE audit_control_id=$1 AND user_id=$2", [ctl, w.contrib]))).rowCount).toBe(0);
      expect((await adminPool.query("SELECT 1 FROM control_assignments WHERE audit_control_id=$1", [ctl])).rowCount).toBe(1);
    }
  });

  it("manage_people: cannot invite, switch off or change anyone (client lead and lead auditor alike)", async () => {
    for (const base of ["tenant_lead", "lead_auditor"]) {
      const u = await restricted(base, ["manage_people"]);
      await denied(as(u, (c) => c.query("INSERT INTO users (org_id, tenant_id, email, role) VALUES ($1,$2,$3,'viewer')", [w.orgA, w.tA1, `nope-${++seq}@a1-${w.tag}.test`])), RLS);
      const victim = await mkUser(w, "viewer");
      expect((await as(u, (c) => c.query("UPDATE users SET status='disabled' WHERE id=$1", [victim]))).rowCount).toBe(0);
      expect((await adminPool.query("SELECT status FROM users WHERE id=$1", [victim])).rows[0].status).toBe("active");
    }
    // Without the restriction the same lead auditor can invite.
    await as(w.lead, (c) => c.query("INSERT INTO users (org_id, tenant_id, email, role) VALUES ($1,$2,$3,'viewer')", [w.orgA, w.tA1, `yes-${++seq}@a1-${w.tag}.test`]));
  });

  it("comment: cannot add a comment (anyone who can comment at all)", async () => {
    for (const base of ["lead_auditor", "auditor", "tenant_lead", "contributor"]) {
      const u = await restricted(base, ["comment"]);
      const ctl = await nextControl(w.auditA1);
      if (base === "contributor") await assign(w, ctl, u);
      await denied(as(u, (c) => c.query("INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, type, body) SELECT org_id, tenant_id, id, $2, 'comment', 'hello' FROM audit_controls WHERE id=$1", [ctl, u])), RLS);
    }
  });

  it("close_cycle: cannot close or reopen an audit cycle", async () => {
    const u = await restricted("lead_auditor", ["close_cycle"]);
    const a = (await as(w.admin, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [w.tA1, w.templateId, `cycle ${++seq}`]))).rows[0].id as string;
    await denied(as(u, (c) => c.query("SELECT audit_close($1)", [a])), /FORBIDDEN_PERMISSION: Your role does not allow closing or reopening/);
    await as(w.lead, (c) => c.query("SELECT audit_close($1)", [a]));
    await denied(as(u, (c) => c.query("SELECT audit_reopen($1,'Late evidence arrived')", [a])), /FORBIDDEN_PERMISSION: Your role does not allow closing or reopening/);
    await as(w.lead, (c) => c.query("SELECT audit_reopen($1,'Late evidence arrived')", [a]));
  });

  it("upload: cannot add evidence, or submit a control", async () => {
    for (const base of ["contributor", "tenant_lead"]) {
      const u = await restricted(base, ["upload"]);
      const ctl = await nextControl(w.auditA1);
      await assign(w, ctl, u);
      await denied(as(u, (c) => c.query(
        "INSERT INTO evidence_files (org_id, tenant_id, audit_control_id, provider_file_id, file_name, uploaded_by) SELECT org_id, tenant_id, id, 'f1', 'a.pdf', $2 FROM audit_controls WHERE id=$1", [ctl, u])), RLS);
      await addEvidence(w.orgA, w.tA1, ctl, w.contrib); // a file got there another way; submitting it is still not theirs to do
      await setStatus(ctl, "awaiting_evidence");
      await denied(as(u, (c) => c.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [ctl])), /FORBIDDEN_PERMISSION: your role does not allow submitting evidence/);
    }
  });

  it("a restriction does not widen anything: a restricted auditor still can't do what a plain auditor can't", async () => {
    const u = await restricted("auditor", ["remind"]);
    const ctl = await nextControl(w.auditA1);
    await denied(as(u, (c) => c.query("UPDATE audit_controls SET applicable=false, na_justification='no reason' WHERE id=$1", [ctl])), /FORBIDDEN_COLUMN/);
    await denied(as(u, (c) => c.query("UPDATE audit_controls SET due_date='2030-01-01' WHERE id=$1", [ctl])), /FORBIDDEN_COLUMN/);
    await denied(as(u, (c) => c.query("SELECT audit_close($1)", [w.auditA1])), /FORBIDDEN_ROLE/);
  });
});

describe("the migration file", () => {
  it("explains itself and lists every ability that can be taken away", () => {
    const sql = fs.readFileSync(path.resolve("db/migrations/016_firm_close_and_custom_roles.sql"), "utf8");
    for (const p of PERMISSIONS) expect(sql).toMatch(new RegExp(`^--\\s+${p}\\s`, "m"));
    expect(sql).toMatch(/can only ever do LESS/);
  });
});
