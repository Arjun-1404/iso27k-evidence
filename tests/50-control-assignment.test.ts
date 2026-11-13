import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, as, denied, makeWorld, controlId, type World } from "./helpers.ts";
import { AppError } from "../src/errors.ts";
import * as users from "../src/services/users.ts";
import * as controls from "../src/services/controls.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).status).toBe(status);
  return err as AppError;
}

const NIL = "00000000-0000-0000-0000-000000000000";
const addUser = async (w: World, tenant: string, label: string, role: string, status: string) =>
  (await adminPool.query(
    "INSERT INTO users (org_id, tenant_id, email, full_name, role, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [w.orgA, tenant, `${label}-${w.tag}@a1-${w.tag}.test`, label, role, status])).rows[0].id as string;

const assigneesOf = async (control: string) =>
  (await adminPool.query("SELECT user_id FROM control_assignments WHERE audit_control_id=$1", [control])).rows.map((r) => r.user_id as string);
const logFor = async (w: World, action: string, control?: string) =>
  (await adminPool.query(
    "SELECT actor_id, tenant_id, entity, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id=$3) ORDER BY seq",
    [w.orgA, action, control ?? null])).rows;
const chainBreak = async (w: World) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA])).rows[0].bad as string | null;
const allControlIds = async (audit: string) =>
  (await adminPool.query("SELECT id FROM audit_controls WHERE audit_id=$1 ORDER BY sort_order, control_ref", [audit])).rows.map((r) => r.id as string);

describe("who may be given a control (database rule, migration 013)", () => {
  let w: World; let c85: string;
  let disabled: string, invited: string, otherLead: string;
  beforeAll(async () => {
    w = await makeWorld(); c85 = await controlId(w.auditA1, "A.8.5");
    disabled = await addUser(w, w.tA1, "gone", "contributor", "disabled");
    invited = await addUser(w, w.tA1, "invited", "contributor", "invited");
    otherLead = await addUser(w, w.tA1, "lead2", "tenant_lead", "active");
  });
  const insert = (actor: string, control: string, who: string) =>
    as(actor, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, control, who]));

  it("a contributor and a client lead can be assigned, by a client lead, a lead auditor or an org admin", async () => {
    await insert(w.tLead, c85, w.contrib);
    await insert(w.lead, c85, w.tLead);
    await insert(w.admin, c85, otherLead);
    expect((await assigneesOf(c85)).sort()).toEqual([w.contrib, w.tLead, otherLead].sort());
  });

  it("someone who has been invited but hasn't signed in yet can be lined up for a control", async () => {
    await insert(w.tLead, c85, invited);
    expect(await assigneesOf(c85)).toContain(invited);
  });

  it("a viewer, a dashboard-only user and a disabled account cannot be assigned", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    await denied(insert(w.tLead, c, w.viewer), /row-level security/);
    await denied(insert(w.tLead, c, w.tDash), /row-level security/);
    await denied(insert(w.tLead, c, disabled), /row-level security/);
    expect(await assigneesOf(c)).toEqual([]);
  });

  it("a person from another client cannot be assigned", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    await denied(insert(w.lead, c, w.tLead2), /row-level security/);
  });

  it("nothing can be assigned for a client that has been archived", async () => {
    const w2 = await makeWorld();
    const c = await controlId(w2.auditA1, "A.8.5");
    await adminPool.query("UPDATE tenants SET status='archived' WHERE id=$1", [w2.tA1]);
    await denied(as(w2.lead, (cl) => cl.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w2.orgA, w2.tA1, c, w2.contrib])), /row-level security/);
    await denied(as(w2.admin, (cl) => cl.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w2.orgA, w2.tA1, c, w2.contrib])), /row-level security/);
    expect(await assigneesOf(c)).toEqual([]);
    await adminPool.query("UPDATE tenants SET status='active' WHERE id=$1", [w2.tA1]);
    await as(w2.lead, (cl) => cl.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w2.orgA, w2.tA1, c, w2.contrib]));
    expect(await assigneesOf(c)).toEqual([w2.contrib]); // and it works again once the client is active
  });

  it("an auditor, a contributor and a viewer cannot assign anything", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    for (const actor of [w.auditor, w.contrib, w.viewer]) await denied(insert(actor, c, w.contrib));
  });

  it("assignments made before the rule existed are untouched (the rule only governs new ones)", async () => {
    // Fixture bypassing the rule through the superuser: a viewer who was assigned in the past.
    const c = await controlId(w.auditA1, "A.8.8");
    await adminPool.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, c, w.viewer]);
    expect(await assigneesOf(c)).toEqual([w.viewer]);
  });
});

describe("assigning one control (service)", () => {
  let w: World; let c85: string;
  let disabled: string;
  beforeAll(async () => { w = await makeWorld(); c85 = await controlId(w.auditA1, "A.8.5"); disabled = await addUser(w, w.tA1, "gone", "contributor", "disabled"); });

  it("assigns, and writes one audit-log entry saying who assigned whom to which control", async () => {
    await users.assignControlToUser(appPool, w.tLead, c85, w.contrib);
    expect(await assigneesOf(c85)).toEqual([w.contrib]);
    const log = await logFor(w, "control.assigned", c85);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: w.tLead, tenant_id: w.tA1, entity: "audit_control", entity_id: c85, change: { userId: w.contrib } });
  });

  it("assigning the same person again changes nothing and logs nothing more", async () => {
    const again = await users.assignControlToUser(appPool, w.tLead, c85, w.contrib);
    expect(again).toEqual({ controlId: c85, targetUserId: w.contrib });
    expect(await assigneesOf(c85)).toEqual([w.contrib]);
    expect(await logFor(w, "control.assigned", c85)).toHaveLength(1);
  });

  it("refuses someone who cannot do the work, saying why", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    const viewer = await expectAppError(users.assignControlToUser(appPool, w.tLead, c, w.viewer), "ASSIGNEE_ROLE", 400);
    expect(viewer.message).toMatch(/contributors and leads/);
    await expectAppError(users.assignControlToUser(appPool, w.tLead, c, w.tDash), "ASSIGNEE_ROLE", 400);
    const off = await expectAppError(users.assignControlToUser(appPool, w.tLead, c, disabled), "ASSIGNEE_DISABLED", 400);
    expect(off.message).toMatch(/switched off/);
    expect(await assigneesOf(c)).toEqual([]);
    expect(await logFor(w, "control.assigned", c)).toEqual([]);
  });

  it("refuses someone from another client (even another client of the same firm)", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    await expectAppError(users.assignControlToUser(appPool, w.lead, c, w.tLead2), "ASSIGNEE_WRONG_TENANT", 400);
  });

  it("a person that doesn't exist, or belongs to another firm entirely, is simply 'not found'", async () => {
    const c = await controlId(w.auditA1, "A.8.7");
    await expectAppError(users.assignControlToUser(appPool, w.tLead, c, NIL), "NOT_FOUND", 404);
    const hidden = await expectAppError(users.assignControlToUser(appPool, w.tLead, c, w.tLeadB), "NOT_FOUND", 404);
    expect(hidden.message).toBe("That person was not found.");
  });

  it("a control the caller cannot see is 'not found'", async () => {
    await expectAppError(users.assignControlToUser(appPool, w.tLead, NIL, w.contrib), "NOT_FOUND", 404);
    const other = await controlId(w.auditA2, "A.8.5");
    await expectAppError(users.assignControlToUser(appPool, w.tLead, other, w.contrib), "NOT_FOUND", 404);
  });

  it("people who can see the control but may not assign are refused, and nothing is written", async () => {
    const c = await controlId(w.auditA1, "A.8.9");
    await expectAppError(users.assignControlToUser(appPool, w.auditor, c, w.contrib), "FORBIDDEN", 403);
    await expectAppError(users.assignControlToUser(appPool, w.readOnly, c, w.contrib), "FORBIDDEN", 403);
    await expectAppError(users.assignControlToUser(appPool, w.viewer, c, w.contrib), "FORBIDDEN", 403);
    expect(await assigneesOf(c)).toEqual([]);
    expect(await logFor(w, "control.assigned", c)).toEqual([]);
  });

  it("a contributor who doesn't have the control can't even see it; one who does can't pass it on", async () => {
    const c = await controlId(w.auditA1, "A.8.10");
    const aaron = await addUser(w, w.tA1, "aaron", "contributor", "active");
    await expectAppError(users.assignControlToUser(appPool, w.contrib, c, aaron), "NOT_FOUND", 404);
    await users.assignControlToUser(appPool, w.tLead, c, w.contrib);
    await expectAppError(users.assignControlToUser(appPool, w.contrib, c, aaron), "FORBIDDEN", 403);
    expect(await assigneesOf(c)).toEqual([w.contrib]);
  });

  it("the audit-log chain stays intact", async () => { expect(await chainBreak(w)).toBeNull(); });
});

describe("assigning many controls at once (service)", () => {
  let w: World; let ids: string[];
  beforeAll(async () => { w = await makeWorld(); ids = await allControlIds(w.auditA1); });

  it("assigns every control asked for, counts them, and logs each one", async () => {
    const pick = ids.slice(0, 5);
    const r = await users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, pick);
    expect(r).toEqual({ assigned: 5 });
    for (const c of pick) {
      expect(await assigneesOf(c)).toEqual([w.contrib]);
      const log = await logFor(w, "control.assigned", c);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor_id: w.tLead, tenant_id: w.tA1, entity: "audit_control", change: { userId: w.contrib } });
    }
    expect(await assigneesOf(ids[5])).toEqual([]); // not asked for, not given
  });

  it("controls the person already has are left alone and not counted or logged again", async () => {
    const r = await users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, ids.slice(3, 8));
    expect(r).toEqual({ assigned: 3 }); // 3 and 4 were already theirs
    expect(await logFor(w, "control.assigned", ids[3])).toHaveLength(1);
    expect(await logFor(w, "control.assigned", ids[7])).toHaveLength(1);
    expect(await users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, ids.slice(0, 8))).toEqual({ assigned: 0 });
  });

  it("the same control listed twice is handled once", async () => {
    const r = await users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.tLead, [ids[20], ids[20], ids[21]]);
    expect(r).toEqual({ assigned: 2 });
    expect(await logFor(w, "control.assigned", ids[20])).toHaveLength(1);
  });

  it("is all or nothing: one control that isn't part of this audit stops the whole request", async () => {
    // (a lead auditor sees both clients, so the other audit's control is visible to them: it is refused because it
    // is not part of THIS audit, not because it is hidden)
    const foreign = (await allControlIds(w.auditA2))[0];
    const mine = ids[30];
    await expectAppError(users.assignControlsToUser(appPool, w.lead, w.auditA1, w.contrib, [mine, foreign]), "NOT_FOUND", 404);
    await expectAppError(users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, [mine, NIL]), "NOT_FOUND", 404);
    expect(await assigneesOf(mine)).toEqual([]);
    expect(await logFor(w, "control.assigned", mine)).toEqual([]);
  });

  it("is all or nothing when the person is not allowed either", async () => {
    const mine = ids[31];
    await expectAppError(users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.viewer, [mine]), "ASSIGNEE_ROLE", 400);
    await expectAppError(users.assignControlsToUser(appPool, w.lead, w.auditA1, w.tLead2, [mine]), "ASSIGNEE_WRONG_TENANT", 400);
    await expectAppError(users.assignControlsToUser(appPool, w.tLead, w.auditA1, NIL, [mine]), "NOT_FOUND", 404);
    expect(await assigneesOf(mine)).toEqual([]);
  });

  it("asks for at least one control and at most 200", async () => {
    const fake = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await expectAppError(users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, []), "VALIDATION", 400);
    await expectAppError(users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, fake(201)), "VALIDATION", 400);
    // 200 is allowed: these controls don't exist, so the answer is "not found", not "too many"
    await expectAppError(users.assignControlsToUser(appPool, w.tLead, w.auditA1, w.contrib, fake(200)), "NOT_FOUND", 404);
  });

  it("a lead auditor and an org admin can hand out work too; others cannot", async () => {
    expect((await users.assignControlsToUser(appPool, w.lead, w.auditA1, w.contrib, [ids[40]])).assigned).toBe(1);
    expect((await users.assignControlsToUser(appPool, w.admin, w.auditA1, w.contrib, [ids[41]])).assigned).toBe(1);
    const c = ids[42];
    await expectAppError(users.assignControlsToUser(appPool, w.contrib, w.auditA1, w.contrib, [c]), "NOT_FOUND", 404); // can't see it
    await expectAppError(users.assignControlsToUser(appPool, w.auditor, w.auditA1, w.contrib, [c]), "FORBIDDEN", 403);
    await expectAppError(users.assignControlsToUser(appPool, w.viewer, w.auditA1, w.contrib, [c]), "FORBIDDEN", 403);
    await expectAppError(users.assignControlsToUser(appPool, w.tLead2, w.auditA1, w.contrib, [c]), "NOT_FOUND", 404);
    expect(await assigneesOf(c)).toEqual([]);
  });

  it("a contributor sees exactly the controls they were given, and no others", async () => {
    const fresh = await makeWorld();
    const mine = await allControlIds(fresh.auditA1);
    expect(await controls.listControls(appPool, fresh.contrib, fresh.auditA1)).toEqual([]);
    await users.assignControlsToUser(appPool, fresh.tLead, fresh.auditA1, fresh.contrib, mine.slice(0, 3));
    const seen = (await controls.listControls(appPool, fresh.contrib, fresh.auditA1)).map((c) => c.id).sort();
    expect(seen).toEqual(mine.slice(0, 3).sort());
  });

  it("the audit-log chain stays intact", async () => { expect(await chainBreak(w)).toBeNull(); });
});

describe("who a control is assigned to, and taking someone off (service)", () => {
  let w: World; let c: string;
  let second: string;
  beforeAll(async () => {
    w = await makeWorld(); c = await controlId(w.auditA1, "A.8.5");
    second = await addUser(w, w.tA1, "aaron", "contributor", "active");
    await users.assignControlToUser(appPool, w.tLead, c, w.contrib);
    await users.assignControlToUser(appPool, w.tLead, c, second);
    await users.assignControlToUser(appPool, w.tLead, c, w.tLead);
  });

  it("lists the people with their address, name and role, in address order", async () => {
    const list = await users.listControlAssignees(appPool, w.tLead, c);
    expect(list.map((x) => x.email)).toEqual([...list.map((x) => x.email)].sort());
    expect(list).toHaveLength(3);
    const aaron = list.find((x) => x.userId === second)!;
    expect(aaron).toEqual({ userId: second, email: `aaron-${w.tag}@a1-${w.tag}.test`, fullName: "aaron", role: "contributor" });
    expect(list.find((x) => x.userId === w.tLead)!.role).toBe("tenant_lead");
  });

  it("an auditor and an org admin see the same list", async () => {
    expect((await users.listControlAssignees(appPool, w.auditor, c)).map((x) => x.userId).sort()).toEqual([w.contrib, second, w.tLead].sort());
    expect(await users.listControlAssignees(appPool, w.admin, c)).toHaveLength(3);
  });

  it("a contributor is only told about themselves", async () => {
    const list = await users.listControlAssignees(appPool, w.contrib, c);
    expect(list.map((x) => x.userId)).toEqual([w.contrib]);
  });

  it("a control with no one assigned gives an empty list, not an error", async () => {
    expect(await users.listControlAssignees(appPool, w.tLead, await controlId(w.auditA1, "A.8.7"))).toEqual([]);
  });

  it("a control the caller can't see is 'not found'", async () => {
    await expectAppError(users.listControlAssignees(appPool, w.tLead, NIL), "NOT_FOUND", 404);
    await expectAppError(users.listControlAssignees(appPool, w.tLead2, c), "NOT_FOUND", 404);
    await expectAppError(users.listControlAssignees(appPool, w.tLeadB, c), "NOT_FOUND", 404);
  });

  it("taking someone off removes only them and writes an audit-log entry", async () => {
    const r = await users.unassignControlFromUser(appPool, w.tLead, c, second);
    expect(r).toEqual({ removed: true });
    expect((await assigneesOf(c)).sort()).toEqual([w.contrib, w.tLead].sort());
    const log = await logFor(w, "control.unassigned", c);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: w.tLead, tenant_id: w.tA1, entity: "audit_control", entity_id: c, change: { userId: second } });
  });

  it("taking off someone who isn't assigned says so and logs nothing", async () => {
    expect(await users.unassignControlFromUser(appPool, w.tLead, c, second)).toEqual({ removed: false });
    expect(await logFor(w, "control.unassigned", c)).toHaveLength(1);
  });

  it("a contributor cannot take themselves or others off", async () => {
    const r = await users.unassignControlFromUser(appPool, w.contrib, c, w.contrib);
    expect(r).toEqual({ removed: false });
    expect(await assigneesOf(c)).toContain(w.contrib);
    expect(await logFor(w, "control.unassigned", c)).toHaveLength(1);
  });

  it("the person loses sight of the control once taken off", async () => {
    expect((await controls.listControls(appPool, w.contrib, w.auditA1)).map((x) => x.id)).toContain(c);
    await users.unassignControlFromUser(appPool, w.lead, c, w.contrib);
    expect((await controls.listControls(appPool, w.contrib, w.auditA1)).map((x) => x.id)).not.toContain(c);
  });

  it("the audit-log chain stays intact", async () => { expect(await chainBreak(w)).toBeNull(); });
});

describe("assignments over HTTP", () => {
  let w: World; let app: ReturnType<typeof createApp>; let auth: FakeTokenVerifier; let ids: string[];
  beforeAll(async () => {
    w = await makeWorld();
    auth = new FakeTokenVerifier();
    app = createApp({ pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
    ids = await allControlIds(w.auditA1);
  });
  const as_ = (u: string) => ({ Authorization: `Bearer ${auth.issue(u)}` });

  it("POST /audits/:id/assignments hands out controls and reports how many were new", async () => {
    const res = await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLead)).send({ userId: w.contrib, controlIds: ids.slice(0, 4) });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ assigned: 4 });
    const again = await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLead)).send({ userId: w.contrib, controlIds: ids.slice(2, 6) });
    expect(again.body).toEqual({ assigned: 2 });
  });

  it("GET /controls/:id/assignments lists the people", async () => {
    const res = await request(app).get(`/controls/${ids[0]}/assignments`).set(as_(w.lead));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ userId: w.contrib, role: "contributor" })]);
    expect(Object.keys(res.body[0]).sort()).toEqual(["email", "fullName", "role", "userId"]);
  });

  it("DELETE /controls/:id/assignments/:userId takes the person off", async () => {
    const res = await request(app).delete(`/controls/${ids[0]}/assignments/${w.contrib}`).set(as_(w.tLead));
    expect(res.body).toEqual({ removed: true });
    expect((await request(app).get(`/controls/${ids[0]}/assignments`).set(as_(w.tLead))).body).toEqual([]);
  });

  it("explains a refusal in plain words with a code", async () => {
    const res = await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLead)).send({ userId: w.viewer, controlIds: [ids[0]] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ASSIGNEE_ROLE");
    expect(res.body.error.message).toMatch(/contributors and leads/);
  });

  it("rejects malformed requests before they reach the database", async () => {
    const post = (body: unknown) => request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLead)).send(body as object);
    for (const bad of [
      {}, { userId: w.contrib }, { userId: w.contrib, controlIds: [] }, { userId: "nope", controlIds: [ids[0]] },
      { userId: w.contrib, controlIds: ["nope"] }, { userId: w.contrib, controlIds: "x" },
      { userId: w.contrib, controlIds: Array.from({ length: 201 }, () => ids[0]) },
    ]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
    }
  });

  it("accepts exactly 200 controls in a request (these don't exist, so it is 'not found', not 'too many')", async () => {
    const fake = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const res = await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLead)).send({ userId: w.contrib, controlIds: fake });
    expect(res.status).toBe(404);
  });

  it("needs a signed-in user", async () => {
    expect((await request(app).post(`/audits/${w.auditA1}/assignments`).send({ userId: w.contrib, controlIds: [ids[0]] })).status).toBe(401);
    expect((await request(app).get(`/controls/${ids[0]}/assignments`)).status).toBe(401);
  });

  it("refuses someone who may not assign, and someone from another client", async () => {
    expect((await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.auditor)).send({ userId: w.contrib, controlIds: [ids[9]] })).status).toBe(403);
    expect((await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.contrib)).send({ userId: w.contrib, controlIds: [ids[9]] })).status).toBe(404);
    expect((await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLead2)).send({ userId: w.contrib, controlIds: [ids[9]] })).status).toBe(404);
    expect((await request(app).post(`/audits/${w.auditA1}/assignments`).set(as_(w.tLeadB)).send({ userId: w.contrib, controlIds: [ids[9]] })).status).toBe(404);
    expect(await assigneesOf(ids[9])).toEqual([]);
  });
});
