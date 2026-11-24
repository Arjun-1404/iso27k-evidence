import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, as, makeWorld, controlId, addEvidence, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

function setup() {
  const auth = new FakeTokenVerifier();
  const email = new FakeEmailSender();
  const app = createApp({ pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email, tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
  const hdr = (u: string) => ({ Authorization: `Bearer ${auth.issue(u)}` });
  return { app, email, hdr };
}

let n = 0;
const REFS = [...Array.from({ length: 37 }, (_, i) => `A.5.${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `A.6.${i + 1}`)];
const used = new Map<string, number>();
const nextControl = (audit: string) => { const i = used.get(audit) ?? 0; used.set(audit, i + 1); return controlId(audit, REFS[i]); };
const statusOf = async (ctl: string) => (await adminPool.query("SELECT status FROM audit_controls WHERE id=$1", [ctl])).rows[0].status as string;
const logFor = async (w: World, action: string, entity?: string) =>
  (await adminPool.query("SELECT actor_id, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id=$3) ORDER BY seq", [w.orgA, action, entity ?? null])).rows;
async function mkRole(w: World, base: string, denied: string[], name = `r-${base}-${++n}-${Math.random().toString(36).slice(2, 6)}`) {
  return (await adminPool.query("INSERT INTO custom_roles (org_id, name, base_role, denied) VALUES ($1,$2,$3,$4) RETURNING id", [w.orgA, name, base, denied])).rows[0].id as string;
}
async function mkUser(w: World, role: string, customRole: string | null = null) {
  const tenant = ["tenant_lead", "contributor", "viewer", "tenant_dashboard"].includes(role) ? w.tA1 : null;
  const id = (await adminPool.query(
    `INSERT INTO users (org_id, tenant_id, email, full_name, role, status, custom_role_id) VALUES ($1,$2,$3,$4,'${role}','active',$5) RETURNING id`,
    [w.orgA, tenant, `${role}-${++n}@${tenant ? `a1-${w.tag}.test` : `audit-a-${w.tag}.test`}`, `${role} ${n}`, customRole])).rows[0].id as string;
  if (!tenant) await adminPool.query("INSERT INTO auditor_assignments (org_id, user_id, tenant_id) VALUES ($1,$2,$3)", [w.orgA, id, w.tA1]);
  return id;
}

describe("the firm closing a control over HTTP", () => {
  let w: World; const { app, hdr } = setup();
  beforeAll(async () => { w = await makeWorld(); });
  const close = (who: string, ctl: string, body: object = { decision: "close", reason: "Seen on site during the visit on 12 March" }) =>
    request(app).post(`/controls/${ctl}/reviews`).set(hdr(who)).send(body);

  it("closes a control the client never submitted: accepted, no file needed, and the reason is on record", async () => {
    const ctl = await nextControl(w.auditA1);
    const res = await close(w.lead, ctl);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: ctl, status: "accepted" });
    expect(await statusOf(ctl)).toBe("accepted");

    // The client's people can see why, in the control's comment thread.
    const thread = (await request(app).get(`/controls/${ctl}/comments`).set(hdr(w.tLead))).body as { body: string }[];
    expect(thread.map((x) => x.body)).toEqual(["Closed by the audit firm without client evidence. Reason: Seen on site during the visit on 12 March"]);
    // And in the audit log, with who did it.
    const log = await logFor(w, "control.close", ctl);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: w.lead, change: { status: "accepted", reason: "Seen on site during the visit on 12 March" } });

    // It counts towards completion, and shows as accepted with no files in the list.
    const list = (await request(app).get(`/audits/${w.auditA1}/controls`).set(hdr(w.admin))).body as { id: string; status: string; fileCount: number }[];
    expect(list.find((x) => x.id === ctl)).toMatchObject({ status: "accepted", fileCount: 0 });
    const dash = (await request(app).get(`/audits/${w.auditA1}/dashboard`).set(hdr(w.admin))).body;
    expect(dash.accepted).toBeGreaterThanOrEqual(1);
  });

  it("an organisation admin and an auditor can do it too", async () => {
    for (const who of [w.admin, w.auditor]) {
      const ctl = await nextControl(w.auditA1);
      expect((await close(who, ctl)).status).toBe(201);
      expect(await statusOf(ctl)).toBe("accepted");
    }
  });

  it("works for a control that was awaiting evidence or was rejected", async () => {
    for (const from of ["awaiting_evidence", "rejected"]) {
      const ctl = await nextControl(w.auditA1);
      await adminPool.query("UPDATE audit_controls SET status=$2 WHERE id=$1", [ctl, from]);
      expect((await close(w.lead, ctl)).status).toBe(201);
    }
  });

  it("needs a written reason of at least 3 characters", async () => {
    const ctl = await nextControl(w.auditA1);
    for (const body of [{ decision: "close" }, { decision: "close", reason: "" }, { decision: "close", reason: "  " }, { decision: "close", reason: "ab" }, { decision: "reject" }]) {
      const res = await close(w.lead, ctl, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
    }
    expect(await statusOf(ctl)).toBe("not_started");
    expect((await close(w.lead, ctl, { decision: "accept" })).status).toBe(409); // accept (not close) still needs the file
  });

  it("says why when it can't be done: not applicable, already accepted, evidence waiting for review", async () => {
    const na = await nextControl(w.auditA1);
    await request(app).patch(`/controls/${na}/applicability`).set(hdr(w.lead)).send({ applicable: false, naJustification: "We do not develop software" });
    let res = await close(w.lead, na);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "NOT_APPLICABLE", message: "This control is marked not applicable, so there is nothing to close." });

    const done = await nextControl(w.auditA1);
    await close(w.lead, done);
    res = await close(w.lead, done);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_ACCEPTED");

    const sub = await nextControl(w.auditA1);
    await addEvidence(w.orgA, w.tA1, sub, w.contrib);
    await adminPool.query("UPDATE audit_controls SET status='submitted' WHERE id=$1", [sub]);
    res = await close(w.lead, sub);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NEEDS_REVIEW");
    expect(await statusOf(sub)).toBe("submitted");
  });

  it("is refused for the client's people and for read-only staff, and a control that can't be seen is 'not found'", async () => {
    const ctl = await nextControl(w.auditA1);
    for (const who of [w.tLead, w.contrib, w.viewer, w.readOnly]) {
      const res = await close(who, ctl);
      expect([403, 404]).toContain(res.status);
    }
    for (const who of [w.adminB, w.leadB]) expect((await close(who, ctl)).status).toBe(404);
    expect(await statusOf(ctl)).toBe("not_started");
    expect((await adminPool.query("SELECT 1 FROM reviews WHERE audit_control_id=$1", [ctl])).rowCount).toBe(0);
  });

  it("is refused in a closed audit cycle", async () => {
    const a = (await as(w.admin, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [w.tA1, w.templateId, "closed one"]))).rows[0].id as string;
    const ctl = await controlId(a, "A.5.1");
    await request(app).post(`/audits/${a}/close`).set(hdr(w.lead));
    const res = await close(w.lead, ctl);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUDIT_CLOSED");
  });

  it("a custom role that took away 'review' cannot close; one that took away only 'comment' can, without the comment", async () => {
    const noReview = await mkUser(w, "auditor", await mkRole(w, "auditor", ["review"]));
    const ctl = await nextControl(w.auditA1);
    expect((await close(noReview, ctl)).status).toBe(403);
    expect(await statusOf(ctl)).toBe("not_started");

    const noComment = await mkUser(w, "auditor", await mkRole(w, "auditor", ["comment"]));
    const ctl2 = await nextControl(w.auditA1);
    expect((await close(noComment, ctl2)).status).toBe(201);
    expect(await statusOf(ctl2)).toBe("accepted");
    expect((await adminPool.query("SELECT 1 FROM comments WHERE audit_control_id=$1", [ctl2])).rowCount).toBe(0);
    expect(await logFor(w, "control.close", ctl2)).toHaveLength(1); // the reason is on record in the log either way
  });
});

describe("marking controls applicable or not, and due dates, from the firm's side", () => {
  let w: World; const { app, hdr } = setup();
  beforeAll(async () => { w = await makeWorld(); });

  it("a lead auditor and an organisation admin can mark a control not applicable (with a reason) and back", async () => {
    for (const who of [w.lead, w.admin]) {
      const ctl = await nextControl(w.auditA1);
      let res = await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(who)).send({ applicable: false, naJustification: "No physical premises" });
      expect(res.status).toBe(200);
      const row = (await adminPool.query("SELECT applicable, na_justification FROM audit_controls WHERE id=$1", [ctl])).rows[0];
      expect(row).toEqual({ applicable: false, na_justification: "No physical premises" });
      res = await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(who)).send({ applicable: true });
      expect(res.status).toBe(200);
      expect((await adminPool.query("SELECT applicable, na_justification FROM audit_controls WHERE id=$1", [ctl])).rows[0]).toEqual({ applicable: true, na_justification: null });
    }
  });

  it("needs a reason, and never applies to the mandatory clauses 4 to 10", async () => {
    const ctl = await nextControl(w.auditA1);
    expect((await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(w.lead)).send({ applicable: false })).status).toBeGreaterThanOrEqual(400);
    const clause = (await adminPool.query("SELECT id FROM audit_controls WHERE audit_id=$1 AND kind='clause' LIMIT 1", [w.auditA1])).rows[0].id as string;
    const res = await request(app).patch(`/controls/${clause}/applicability`).set(hdr(w.lead)).send({ applicable: false, naJustification: "Not wanted" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Clauses 4 to 10 are mandatory and cannot be marked not applicable.");
  });

  it("a plain auditor and the client's people can't; a custom lead role without the ability can't either", async () => {
    const ctl = await nextControl(w.auditA1);
    for (const who of [w.auditor, w.tLead]) {
      expect((await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(who)).send({ applicable: false, naJustification: "Not ours" })).status).toBe(403);
    }
    // A contributor who isn't assigned the control can't even see it.
    expect([403, 404]).toContain((await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(w.contrib)).send({ applicable: false, naJustification: "Not ours" })).status);
    const restricted = await mkUser(w, "lead_auditor", await mkRole(w, "lead_auditor", ["applicability", "due_dates"]));
    let res = await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(restricted)).send({ applicable: false, naJustification: "Not ours" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN_PERMISSION");
    res = await request(app).patch(`/controls/${ctl}/due-date`).set(hdr(restricted)).send({ dueDate: "2031-05-01" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN_PERMISSION");
    expect((await request(app).patch(`/controls/${ctl}/due-date`).set(hdr(w.lead)).send({ dueDate: "2031-05-01" })).status).toBe(200);
  });

  it("a not-applicable control is counted as such on the dashboard, and is no longer overdue or outstanding", async () => {
    const ctl = await nextControl(w.auditA1);
    const before = (await request(app).get(`/audits/${w.auditA1}/dashboard`).set(hdr(w.lead))).body;
    await request(app).patch(`/controls/${ctl}/due-date`).set(hdr(w.lead)).send({ dueDate: "2020-01-01" });
    const overdue = (await request(app).get(`/audits/${w.auditA1}/dashboard`).set(hdr(w.lead))).body;
    expect(overdue.overdue).toBe(before.overdue + 1);
    await request(app).patch(`/controls/${ctl}/applicability`).set(hdr(w.lead)).send({ applicable: false, naJustification: "Not in scope" });
    const after = (await request(app).get(`/audits/${w.auditA1}/dashboard`).set(hdr(w.lead))).body;
    expect(after.notApplicable).toBe(before.notApplicable + 1);
    expect(after.applicable).toBe(before.applicable - 1);
    expect(after.overdue).toBe(before.overdue);
  });
});

describe("custom roles over HTTP", () => {
  let w: World; const { app, hdr } = setup();
  beforeAll(async () => { w = await makeWorld(); });
  const create = (who: string, body: object) => request(app).post("/roles").set(hdr(who)).send(body);

  it("the organisation admin creates one; it lists with what is taken away and how many people have it", async () => {
    const res = await create(w.admin, { name: "Junior auditor", description: "Reviews, but doesn't chase clients", baseRole: "auditor", denied: ["remind", "comment"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Junior auditor", description: "Reviews, but doesn't chase clients", baseRole: "auditor", denied: ["remind", "comment"], memberCount: 0 });
    const list = (await request(app).get("/roles").set(hdr(w.admin))).body;
    expect(list.custom.map((r: { name: string }) => r.name)).toContain("Junior auditor");
    // The page also gets the list of abilities in plain words, and what each built-in role starts with.
    expect(list.catalog.permissions.map((p: { key: string }) => p.key)).toContain("close_cycle");
    expect(list.catalog.baseRoles.find((b: { role: string }) => b.role === "auditor")).toMatchObject({ side: "firm", allowed: ["review", "remind", "comment"] });
    expect(list.catalog.baseRoles.find((b: { role: string }) => b.role === "contributor")).toMatchObject({ side: "client" });
    expect(await logFor(w, "role.created")).toHaveLength(1);
  });

  it("nobody else can create, change or delete one: a lead auditor can read them, a client's people see none", async () => {
    const made = await create(w.admin, { name: "Careful lead", baseRole: "lead_auditor", denied: ["close_cycle"] });
    for (const who of [w.lead, w.auditor, w.tLead, w.contrib]) {
      expect((await create(who, { name: "Mine", baseRole: "auditor", denied: [] })).status).toBe(403);
      expect((await request(app).patch(`/roles/${made.body.id}`).set(hdr(who)).send({ name: "Taken" })).status).toBe(403);
      expect((await request(app).delete(`/roles/${made.body.id}`).set(hdr(who))).status).toBe(403);
    }
    expect((await request(app).get("/roles").set(hdr(w.lead))).body.custom.map((r: { id: string }) => r.id)).toContain(made.body.id);
    expect((await request(app).get("/roles").set(hdr(w.tLead))).body.custom).toEqual([]);
    expect((await request(app).get("/roles").set(hdr(w.adminB))).body.custom).toEqual([]);
  });

  it("cannot be based on the admin role or any read-only role, and cannot take away what the base role never had", async () => {
    expect((await create(w.admin, { name: "Super", baseRole: "org_admin", denied: [] })).status).toBe(400);
    expect((await create(w.admin, { name: "Weird", baseRole: "read_only", denied: [] })).status).toBe(400);
    expect((await create(w.admin, { name: "Nonsense", baseRole: "auditor", denied: ["fly"] })).status).toBe(400);
    const res = await create(w.admin, { name: "Pointless", baseRole: "auditor", denied: ["close_cycle"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("doesn't have") });
    expect((await create(w.admin, { name: "", baseRole: "auditor", denied: [] })).status).toBe(400);
    expect((await create(w.admin, { name: "x".repeat(61), baseRole: "auditor", denied: [] })).status).toBe(400);
  });

  it("a name can't be used twice (whatever the case)", async () => {
    expect((await create(w.admin, { name: "Duplicate me", baseRole: "auditor", denied: [] })).status).toBe(201);
    const res = await create(w.admin, { name: "  duplicate ME ", baseRole: "contributor", denied: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_ROLE_NAME");
  });

  it("can be renamed and changed, and the change reaches the people who have it straight away; its base never changes", async () => {
    const made = (await create(w.admin, { name: "Live change", baseRole: "contributor", denied: [] })).body;
    const person = await mkUser(w, "contributor", made.id);
    const ctl = await nextControl(w.auditA1);
    await adminPool.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, ctl, person]);
    const comment = () => request(app).post(`/controls/${ctl}/comments`).set(hdr(person)).send({ body: "Working on it" });
    expect((await comment()).status).toBe(201);

    const res = await request(app).patch(`/roles/${made.id}`).set(hdr(w.admin)).send({ name: "Live change 2", denied: ["comment"], baseRole: "lead_auditor" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Live change 2", denied: ["comment"], baseRole: "contributor", memberCount: 1 });
    expect((await comment()).status).toBe(403);

    await request(app).patch(`/roles/${made.id}`).set(hdr(w.admin)).send({ denied: [] });
    expect((await comment()).status).toBe(201);
    expect((await request(app).patch(`/roles/${made.id}`).set(hdr(w.admin)).send({ denied: ["close_cycle"] })).status).toBe(400);
    expect((await request(app).patch(`/roles/00000000-0000-0000-0000-000000000000`).set(hdr(w.admin)).send({ name: "x" })).status).toBe(404);
    expect((await logFor(w, "role.updated")).length).toBeGreaterThanOrEqual(2);
  });

  it("can't be deleted while anyone has it", async () => {
    const made = (await create(w.admin, { name: "Delete me", baseRole: "auditor", denied: [] })).body;
    const person = await mkUser(w, "auditor", made.id);
    let res = await request(app).delete(`/roles/${made.id}`).set(hdr(w.admin));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "ROLE_IN_USE", message: "1 person has this role. Give them a different role first." });
    await adminPool.query("UPDATE users SET custom_role_id=NULL WHERE id=$1", [person]);
    res = await request(app).delete(`/roles/${made.id}`).set(hdr(w.admin));
    expect(res.status).toBe(200);
    expect((await request(app).get("/roles").set(hdr(w.admin))).body.custom.map((r: { id: string }) => r.id)).not.toContain(made.id);
    expect(await logFor(w, "role.deleted", made.id)).toHaveLength(1);
  });

  it("GET /me/access says what the signed-in person's role takes away", async () => {
    const r = await mkRole(w, "lead_auditor", ["close_cycle", "manage_people"], "Lead without people or cycles");
    const restricted = await mkUser(w, "lead_auditor", r);
    expect((await request(app).get("/me/access").set(hdr(restricted))).body).toEqual({ role: "lead_auditor", customRole: { id: r, name: "Lead without people or cycles" }, denied: ["close_cycle", "manage_people"] });
    expect((await request(app).get("/me/access").set(hdr(w.lead))).body).toEqual({ role: "lead_auditor", customRole: null, denied: [] });
    expect((await request(app).get("/me/access").set(hdr(w.contrib))).body).toEqual({ role: "contributor", customRole: null, denied: [] });
    expect((await request(app).get("/me/access")).status).toBe(401);
  });
});

describe("the firm inviting and restricting a client's people", () => {
  let w: World; const { app, email, hdr } = setup();
  beforeAll(async () => { w = await makeWorld(); });
  const invite = (who: string, tenant: string, body: object) => request(app).post(`/tenants/${tenant}/users`).set(hdr(who)).send(body);
  const people = async (who: string, tenant: string) => (await request(app).get(`/tenants/${tenant}/users`).set(hdr(who))).body as { id: string; email: string; role: string; customRoleId: string | null; customRoleName: string | null }[];

  it("a lead auditor assigned to the client invites its people, who are emailed the link", async () => {
    const res = await invite(w.lead, w.tA1, { email: `new1@a1-${w.tag}.test`, fullName: "New One", role: "contributor" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: "contributor", status: "invited", emailSent: true });
    expect(email.sent.some((m) => m.to.includes(`new1@a1-${w.tag}.test`))).toBe(true);
    expect((await people(w.lead, w.tA1)).find((p) => p.email === `new1@a1-${w.tag}.test`)).toMatchObject({ role: "contributor", customRoleId: null, customRoleName: null });
    expect(await logFor(w, "user.invited")).not.toHaveLength(0);
  });

  it("an organisation admin too; but an auditor, a client's contributor or an unassigned lead auditor cannot", async () => {
    expect((await invite(w.admin, w.tA1, { email: `new2@a1-${w.tag}.test`, role: "viewer" })).status).toBe(201);
    expect((await invite(w.auditor, w.tA1, { email: `new3@a1-${w.tag}.test`, role: "viewer" })).status).toBe(403);
    expect((await invite(w.contrib, w.tA1, { email: `new4@a1-${w.tag}.test`, role: "viewer" })).status).toBe(403);
    expect((await invite(w.lead, w.tB1, { email: `new5@b1-${w.tag}.test`, role: "viewer" })).status).toBe(404);
    const t3 = (await adminPool.query("INSERT INTO tenants (org_id, name, allowed_domains) VALUES ($1,'A3',$2) RETURNING id", [w.orgA, [`a3-${w.tag}.test`]])).rows[0].id as string;
    expect((await invite(w.lead, t3, { email: `new6@a3-${w.tag}.test`, role: "viewer" })).status).toBe(404); // not assigned to this client
  });

  it("invites with a custom role: the custom role's base role becomes the person's role, and the firm sees the name", async () => {
    const r = await mkRole(w, "contributor", ["comment"], "Upload only");
    const res = await invite(w.lead, w.tA1, { email: `restricted@a1-${w.tag}.test`, customRoleId: r });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("contributor");
    const row = (await people(w.lead, w.tA1)).find((p) => p.email === `restricted@a1-${w.tag}.test`);
    expect(row).toMatchObject({ role: "contributor", customRoleId: r, customRoleName: "Upload only" });
    // The client's own lead sees that the person is restricted, but not the firm's name for it.
    expect((await people(w.tLead, w.tA1)).find((p) => p.email === `restricted@a1-${w.tag}.test`)).toMatchObject({ customRoleId: r, customRoleName: null });
    expect(await logFor(w, "user.invited").then((l) => l.some((x) => x.change.customRoleId === r))).toBe(true);
  });

  it("explains what's wrong with a role: neither chosen, a firm role for a client's person, a different base, an unknown one", async () => {
    const firmRole = await mkRole(w, "auditor", []);
    const clientRole = await mkRole(w, "tenant_lead", []);
    let res = await invite(w.lead, w.tA1, { email: `bad1@a1-${w.tag}.test` });
    expect(res.status).toBe(400);
    res = await invite(w.lead, w.tA1, { email: `bad2@a1-${w.tag}.test`, customRoleId: firmRole });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_CUSTOM_ROLE", message: "That custom role is for your own staff, not for a client's people." });
    res = await invite(w.lead, w.tA1, { email: `bad3@a1-${w.tag}.test`, role: "viewer", customRoleId: clientRole });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CUSTOM_ROLE");
    res = await invite(w.lead, w.tA1, { email: `bad4@a1-${w.tag}.test`, customRoleId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
    res = await request(app).post("/users").set(hdr(w.admin)).send({ email: `staff1@audit-a-${w.tag}.test`, customRoleId: clientRole });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("That custom role is for a client's people, not for your own staff.");
    res = await request(app).post("/users").set(hdr(w.admin)).send({ email: `staff2@audit-a-${w.tag}.test`, customRoleId: firmRole });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("auditor");
  });

  it("the client's own lead can still invite plain contributors (no custom role), but can't hand out a restriction", async () => {
    expect((await invite(w.tLead, w.tA1, { email: `byclient@a1-${w.tag}.test`, role: "contributor" })).status).toBe(201);
    const r = await mkRole(w, "contributor", ["upload"]);
    const res = await invite(w.tLead, w.tA1, { email: `byclient2@a1-${w.tag}.test`, customRoleId: r });
    expect(res.status).toBe(404);
  });

  it("a client lead whose role took away 'manage people' cannot invite anybody", async () => {
    const lead = await mkUser(w, "tenant_lead", await mkRole(w, "tenant_lead", ["manage_people"]));
    const res = await invite(lead, w.tA1, { email: `blocked@a1-${w.tag}.test`, role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("changes a person's access: restrict, change role, lift the restriction; the change is logged", async () => {
    const target = await mkUser(w, "contributor");
    const r = await mkRole(w, "contributor", ["upload"], "No uploads");
    const patch = (who: string, id: string, body: object) => request(app).patch(`/users/${id}/access`).set(hdr(who)).send(body);

    let res = await patch(w.lead, target, { customRoleId: r });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: target, role: "contributor", customRoleId: r });
    expect((await request(app).get("/me/access").set(hdr(target))).body.denied).toEqual(["upload"]);

    // Changing the role while a custom role is attached needs the custom role dealt with in the same request.
    res = await patch(w.lead, target, { role: "viewer" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CUSTOM_ROLE");
    res = await patch(w.lead, target, { role: "viewer", customRoleId: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: target, role: "viewer", customRoleId: null });
    expect((await request(app).get("/me/access").set(hdr(target))).body.denied).toEqual([]);

    const log = await logFor(w, "user.access_changed", target);
    expect(log.map((l) => l.change)).toEqual([
      { from: { role: "contributor", customRoleId: null }, to: { role: "contributor", customRoleId: r } },
      { from: { role: "contributor", customRoleId: r }, to: { role: "viewer", customRoleId: null } },
    ]);
  });

  it("refuses the changes nobody should make: your own, the admin's, a role of the other kind, and lifting a restriction as the client", async () => {
    const patch = (who: string, id: string, body: object) => request(app).patch(`/users/${id}/access`).set(hdr(who)).send(body);
    let res = await patch(w.lead, w.lead, { role: "auditor" });
    expect(res).toMatchObject({ status: 403 });
    expect(res.body.error.code).toBe("SELF_CHANGE");
    res = await patch(w.admin, w.admin, { role: "auditor" });
    expect(res.body.error.code).toBe("SELF_CHANGE");
    res = await patch(w.admin, w.lead, { role: "org_admin" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ORG_ADMIN_LOCKED");
    const otherAdmin = await adminPool.query("INSERT INTO users (org_id, email, role, status) VALUES ($1,$2,'org_admin','active') RETURNING id", [w.orgA, `admin2-${w.tag}@audit-a-${w.tag}.test`]);
    res = await patch(w.admin, otherAdmin.rows[0].id, { role: "auditor" });
    expect(res.body.error.code).toBe("ORG_ADMIN_LOCKED");
    res = await patch(w.lead, w.viewer, { role: "auditor" });
    expect(res.status).toBe(400);
    res = await patch(w.admin, w.auditor, { role: "contributor" });
    expect(res.status).toBe(400);
    expect((await patch(w.lead, w.viewer, {})).status).toBe(400);

    const r = await mkRole(w, "contributor", ["upload"]);
    const restricted = await mkUser(w, "contributor", r);
    res = await patch(w.tLead, restricted, { customRoleId: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN_ROLE");
    expect((await adminPool.query("SELECT custom_role_id FROM users WHERE id=$1", [restricted])).rows[0].custom_role_id).toBe(r);
    // A person who can't see them at all (another organisation, an unassigned lead) gets 'not found'.
    expect((await patch(w.adminB, restricted, { role: "viewer", customRoleId: null })).status).toBe(404);
    expect((await patch(w.auditor, restricted, { role: "viewer", customRoleId: null })).status).toBe(403);
  });

  it("the organisation admin can give a member of staff a custom role", async () => {
    const r = await mkRole(w, "lead_auditor", ["close_cycle"], "Lead, no cycle closing");
    const lead = await mkUser(w, "lead_auditor");
    const res = await request(app).patch(`/users/${lead}/access`).set(hdr(w.admin)).send({ customRoleId: r });
    expect(res.status).toBe(200);
    expect((await request(app).get("/users").set(hdr(w.admin))).body.find((u: { id: string }) => u.id === lead)).toMatchObject({ customRoleId: r, customRoleName: "Lead, no cycle closing" });
    // A lead auditor can't do that to staff.
    expect((await request(app).patch(`/users/${w.auditor}/access`).set(hdr(w.lead)).send({ customRoleId: r })).status).toBe(403);
  });
});

describe("assigning staff to a client, and seeing who is", () => {
  let w: World; const { app, hdr } = setup();
  beforeAll(async () => { w = await makeWorld(); });

  it("the organisation admin sees who is assigned to a client; everyone else sees at most themselves", async () => {
    const res = await request(app).get(`/tenants/${w.tA1}/auditors`).set(hdr(w.admin));
    expect(res.status).toBe(200);
    expect(res.body.map((u: { email: string }) => u.email).sort()).toEqual([`auditor@audit-a-${w.tag}.test`, `dash@audit-a-${w.tag}.test`, `lead@audit-a-${w.tag}.test`, `ro@audit-a-${w.tag}.test`]);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: expect.any(String), role: expect.any(String), status: "active", customRoleId: null, customRoleName: null }));
    expect((await request(app).get(`/tenants/${w.tA1}/auditors`).set(hdr(w.lead))).body.map((u: { id: string }) => u.id)).toEqual([w.lead]);
    expect((await request(app).get(`/tenants/${w.tA1}/auditors`).set(hdr(w.tLead))).body).toEqual([]);
    expect((await request(app).get(`/tenants/${w.tB1}/auditors`).set(hdr(w.admin))).status).toBe(404);
  });

  it("assigns and unassigns, and the list follows", async () => {
    const aud = await adminPool.query("INSERT INTO users (org_id, email, role, status) VALUES ($1,$2,'auditor','active') RETURNING id", [w.orgA, `extra-${w.tag}@audit-a-${w.tag}.test`]);
    const id = aud.rows[0].id as string;
    expect((await request(app).put(`/tenants/${w.tA2}/auditors/${id}`).set(hdr(w.admin))).status).toBe(200);
    expect((await request(app).get(`/tenants/${w.tA2}/auditors`).set(hdr(w.admin))).body.map((u: { id: string }) => u.id)).toContain(id);
    expect((await request(app).delete(`/tenants/${w.tA2}/auditors/${id}`).set(hdr(w.admin))).body).toEqual({ removed: true });
    expect((await request(app).get(`/tenants/${w.tA2}/auditors`).set(hdr(w.admin))).body.map((u: { id: string }) => u.id)).not.toContain(id);
    // Only the organisation admin may assign.
    expect((await request(app).put(`/tenants/${w.tA2}/auditors/${id}`).set(hdr(w.lead))).status).toBe(403);
  });

  it("only staff who need assigning can be: not a client's person, not the organisation admin", async () => {
    let res = await request(app).put(`/tenants/${w.tA1}/auditors/${w.contrib}`).set(hdr(w.admin));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "ASSIGNEE_ROLE", message: "That person works for a client, not for your firm." });
    res = await request(app).put(`/tenants/${w.tA1}/auditors/${w.admin}`).set(hdr(w.admin));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Organisation admins already see every client.");
    res = await request(app).put(`/tenants/${w.tA1}/auditors/00000000-0000-0000-0000-000000000000`).set(hdr(w.admin));
    expect(res.status).toBe(404);
  });
});
