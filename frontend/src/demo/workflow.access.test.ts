// @vitest-environment node
// Who can see what, and who can do what: the same rules the real server's database enforces, as a visitor meets them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditOf, control, makeKit, PEOPLE, refusal, tenantNamed, type Kit } from "./testkit";
import type { DemoUser } from "./state";
import { DEMO_PASSWORD } from "./accounts";
import type { Role } from "../api/types";

let kit: Kit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.stop());

let addedPeople = 0;
function addPerson(role: Role, email: string, tenantId: string | null): DemoUser {
  // (no dots in the id: a session token is "demo.<id>.<n>")
  const u: DemoUser = { id: `test-${++addedPeople}`, email, fullName: email, role, status: "active", tenantId, password: DEMO_PASSWORD, failedLogins: 0, lockedUntil: null, sessionEpoch: 0, mfa: null };
  kit.backend.state.users.push(u);
  return u;
}

describe("which clients each person can see", () => {
  it.each([
    ["aoife (org admin)", PEOPLE.aoife, ["Brightwave Software Ltd", "Corran Logistics", "Old Mill Foods"]],
    ["declan (lead auditor, assigned to two)", PEOPLE.declan, ["Brightwave Software Ltd", "Corran Logistics"]],
    ["maeve (auditor, assigned to one)", PEOPLE.maeve, ["Brightwave Software Ltd"]],
    ["ronan (read-only, assigned to one)", PEOPLE.ronan, ["Brightwave Software Ltd"]],
    ["priya (client lead)", PEOPLE.priya, ["Brightwave Software Ltd"]],
    ["colm (another client's lead)", PEOPLE.colm, ["Corran Logistics"]],
  ])("%s", async (_who, email, expected) => {
    const api = await kit.as(email);
    expect((await api.listTenants()).map((t) => t.name)).toEqual(expected);
  });

  it("a client's people cannot read another client's audits, controls or users", async () => {
    const colm = await kit.as(PEOPLE.colm);
    const declan = await kit.as(PEOPLE.declan);
    const bw = await tenantNamed(declan, "Brightwave");
    const bwAudit = await auditOf(declan, "Brightwave", "open");
    expect(await colm.listTenantAudits(bw.id)).toEqual([]);
    expect(await refusal(colm.getAudit(bwAudit.id))).toMatchObject({ status: 404 });
    expect(await colm.listControls(bwAudit.id)).toEqual([]);
    expect(await refusal(colm.getDashboard(bwAudit.id))).toMatchObject({ status: 404 });
    expect(await colm.listTenantUsers(bw.id)).toEqual([]);
  });

  it("an auditor not assigned to a client cannot see it at all", async () => {
    const maeve = await kit.as(PEOPLE.maeve);
    const aoife = await kit.as(PEOPLE.aoife);
    const corran = await tenantNamed(aoife, "Corran");
    const corranAudit = (await aoife.listTenantAudits(corran.id))[0]!;
    expect(await maeve.listTenantAudits(corran.id)).toEqual([]);
    expect(await refusal(maeve.getAudit(corranAudit.id))).toMatchObject({ status: 404 });
    expect(await maeve.listControls(corranAudit.id)).toEqual([]);
  });

  it("assigning and unassigning an auditor changes what they can see straight away", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const maeve = await kit.as(PEOPLE.maeve);
    const corran = await tenantNamed(aoife, "Corran");
    const maeveId = (await aoife.listOrgUsers()).find((u) => u.email === PEOPLE.maeve)!.id;
    await aoife.assignAuditor(corran.id, maeveId);
    expect((await maeve.listTenants()).map((t) => t.name)).toContain("Corran Logistics");
    expect(await aoife.unassignAuditor(corran.id, maeveId)).toEqual({ removed: true });
    expect((await maeve.listTenants()).map((t) => t.name)).not.toContain("Corran Logistics");
    expect(await aoife.unassignAuditor(corran.id, maeveId)).toEqual({ removed: false });
  });
});

describe("what a contributor can see and do", () => {
  it("sees only the controls assigned to them, and can see who else is on one", async () => {
    const tom = await kit.as(PEOPLE.tom);
    const priya = await kit.as(PEOPLE.priya);
    const audit = await auditOf(priya, "Brightwave", "open");
    const all = await priya.listControls(audit.id);
    const mine = await tom.listControls(audit.id);
    expect(all.length).toBe(117);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(all.length);
    const c = mine[0]!;
    const assignees = await tom.listControlAssignees(c.id);
    expect(assignees.map((a) => a.email)).toEqual([PEOPLE.tom]); // told about themselves only
  });

  it("cannot read or change a control that is not theirs", async () => {
    const tom = await kit.as(PEOPLE.tom);
    const priya = await kit.as(PEOPLE.priya);
    const audit = await auditOf(priya, "Brightwave", "open");
    const mineIds = new Set((await tom.listControls(audit.id)).map((c) => c.id));
    const notMine = (await priya.listControls(audit.id)).find((c) => !mineIds.has(c.id) && c.applicable)!;
    expect(await tom.listFiles(notMine.id)).toEqual([]);
    expect(await tom.listComments(notMine.id)).toEqual([]);
    expect(await refusal(tom.submitControl(notMine.id))).toMatchObject({ status: 404 });
    expect(await refusal(tom.addComment(notMine.id, "comment", "hi"))).toMatchObject({ status: 404 });
  });

  it("cannot hand out controls, close cycles or change settings", async () => {
    const tom = await kit.as(PEOPLE.tom);
    const audit = await auditOf(tom, "Brightwave", "open");
    const c = (await tom.listControls(audit.id))[0]!;
    const tomId = (await (await kit.as(PEOPLE.priya)).listTenantUsers((await tenantNamed(tom, "Brightwave")).id)).find((u) => u.email === PEOPLE.tom)!.id;
    expect(await refusal(tom.assignControl(c.id, tomId))).toMatchObject({ status: 403 });
    expect(await refusal(tom.closeAudit(audit.id))).toMatchObject({ status: 403 });
    expect(await refusal(tom.setApplicability(c.id, false, "nope nope"))).toMatchObject({ status: 403 });
    expect(await refusal(tom.createTenant("X", ["x.example"]))).toMatchObject({ status: 403 });
    expect(await refusal(tom.getStorageOptions())).toMatchObject({ status: 403 });
    expect(await tom.listAuditLog()).toEqual([]);
  });

  it("cannot review: accepting is for staff", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const submitted = (await declan.listControls(audit.id)).find((c) => c.status === "submitted")!;
    const priya = await kit.as(PEOPLE.priya);
    expect(await refusal(priya.review(submitted.id, "accept"))).toMatchObject({ status: 403 });
  });
});

describe("read-only and dashboard-only roles", () => {
  it("a read-only auditor sees everything for their client but can change nothing", async () => {
    const ronan = await kit.as(PEOPLE.ronan);
    const audit = await auditOf(ronan, "Brightwave", "open");
    const controls = await ronan.listControls(audit.id);
    expect(controls.length).toBe(117);
    const submitted = controls.find((c) => c.status === "submitted")!;
    expect(await refusal(ronan.review(submitted.id, "accept"))).toMatchObject({ status: 403 });
    expect(await refusal(ronan.addComment(submitted.id, "comment", "hello"))).toMatchObject({ status: 403 });
    expect(await refusal(ronan.closeAudit(audit.id))).toMatchObject({ status: 403 });
  });

  it("a viewer on the client's side reads but cannot record evidence, submit or comment", async () => {
    const sam = await kit.as(PEOPLE.sam);
    const audit = await auditOf(sam, "Brightwave", "open");
    const c = (await sam.listControls(audit.id))[0]!;
    // As on the real server, the refusal comes when the file is recorded (the database's insert rule), not when the link is made.
    const session = await sam.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    const put = await fetch(`https://api.demo.invalid${session.uploadUrl}`, { method: "PUT", body: new Blob([new Uint8Array(5)]) });
    expect(put.status).toBe(204);
    expect(await refusal(sam.confirmUpload(c.id, session.providerFileId))).toMatchObject({ status: 403 });
    expect(await sam.listFiles(c.id)).toEqual(expect.not.arrayContaining([expect.objectContaining({ fileName: "a.pdf" })]));
    expect(await refusal(sam.submitControl(c.id))).toMatchObject({ status: 404 });
    expect(await refusal(sam.addComment(c.id, "comment", "hello"))).toMatchObject({ status: 403 });
  });

  it("dashboard-only people get the numbers and nothing else", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const bw = await tenantNamed(aoife, "Brightwave");
    const audit = await auditOf(aoife, "Brightwave", "open");
    addPerson("tenant_dashboard", "board@brightwave.example", bw.id);
    const board = await kit.as("board@brightwave.example");
    const d = await board.getDashboard(audit.id);
    expect(d.total).toBe(117);
    expect(await board.listControls(audit.id)).toEqual([]);
    const c = (await aoife.listControls(audit.id))[0]!;
    expect(await board.listFiles(c.id)).toEqual([]);
    expect(await board.listComments(c.id)).toEqual([]);
    expect(await refusal(board.submitControl(c.id))).toMatchObject({ status: 404 });
  });

  it("an archived client is read-only for everybody and its people cannot sign work in", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const bw = await tenantNamed(aoife, "Brightwave");
    const audit = await auditOf(aoife, "Brightwave", "open");
    const submitted = (await aoife.listControls(audit.id)).find((c) => c.status === "submitted")!;
    await aoife.archiveTenant(bw.id);
    expect(await refusal(aoife.review(submitted.id, "accept"))).toMatchObject({ status: 403 });
    expect(await refusal(aoife.closeAudit(audit.id))).toMatchObject({ status: 409, code: "TENANT_INACTIVE" });
    await aoife.reactivateTenant(bw.id);
    expect(await aoife.review(submitted.id, "accept")).toMatchObject({ status: "accepted" });
  });
});

describe("the dashboard", () => {
  it("is computed from the controls, the same way for every role that may read it", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const priya = await kit.as(PEOPLE.priya);
    const audit = await auditOf(declan, "Brightwave", "open");
    const controls = await declan.listControls(audit.id);
    const d = await declan.getDashboard(audit.id);
    expect(await priya.getDashboard(audit.id)).toEqual(d);

    const applicable = controls.filter((c) => c.applicable);
    expect(d.total).toBe(controls.length);
    expect(d.applicable).toBe(applicable.length);
    expect(d.notApplicable).toBe(controls.length - applicable.length);
    const accepted = applicable.filter((c) => c.status === "accepted").length;
    expect(d.accepted).toBe(accepted);
    expect(d.completionPct).toBe(Math.round((1000 * accepted) / applicable.length) / 10);
    expect(d.byStatus.reduce((n, s) => n + s.count, 0)).toBe(applicable.length);
    expect(d.bySection.reduce((n, s) => n + s.applicable, 0)).toBe(applicable.length);
    const overdue = applicable.filter((c) => c.dueDate && c.dueDate < "2026-06-10" && c.status !== "accepted").length;
    expect(d.overdue).toBe(overdue);
  });

  it("moves when a control is accepted", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    const before = await declan.getDashboard(audit.id);
    const submitted = (await declan.listControls(audit.id)).find((c) => c.status === "submitted")!;
    await declan.review(submitted.id, "accept");
    const after = await declan.getDashboard(audit.id);
    expect(after.accepted).toBe(before.accepted + 1);
    expect(after.completionPct).toBeGreaterThan(before.completionPct);
  });
});

describe("assigning controls", () => {
  it("only to a client's contributors or leads, one by one or in bulk; unassigning takes the control away from them", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const bw = await tenantNamed(priya, "Brightwave");
    const audit = await auditOf(priya, "Brightwave", "open");
    const users = await priya.listTenantUsers(bw.id);
    const lena = users.find((u) => u.email === PEOPLE.lena)!;
    const sam = users.find((u) => u.email === PEOPLE.sam)!;
    const controls = await priya.listControls(audit.id);
    const [a, b] = controls.slice(40, 42) as [typeof controls[0], typeof controls[0]];

    expect(await refusal(priya.assignControl(a.id, sam.id))).toMatchObject({ status: 400, code: "ASSIGNEE_ROLE" });
    expect(await priya.assignControlsBulk(audit.id, lena.id, [a.id, b.id])).toEqual({ assigned: 2 });
    expect(await priya.assignControlsBulk(audit.id, lena.id, [a.id, b.id])).toEqual({ assigned: 0 }); // already theirs
    const lenaApi = await kit.as(PEOPLE.lena);
    expect((await lenaApi.listControls(audit.id)).map((c) => c.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await priya.unassignControl(a.id, lena.id)).toEqual({ removed: true });
    expect((await lenaApi.listControls(audit.id)).map((c) => c.id)).not.toContain(a.id);
    expect(await refusal(priya.assignControlsBulk(audit.id, lena.id, []))).toMatchObject({ status: 400 });
    expect(await refusal(priya.assignControlsBulk(audit.id, lena.id, ["nonsense"]))).toMatchObject({ status: 404 });
  });

  it("cannot give a client's control to someone from another client", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const declan = await kit.as(PEOPLE.declan);
    const colmId = (await declan.listTenantUsers((await tenantNamed(declan, "Corran")).id)).find((u) => u.email === PEOPLE.colm)!.id;
    const audit = await auditOf(priya, "Brightwave", "open");
    const c = (await priya.listControls(audit.id))[0]!;
    const refused = await refusal(priya.assignControl(c.id, colmId));
    expect([400, 404]).toContain(refused.status);
  });
});

describe("the sample data tells a story a reviewer can follow", () => {
  it("has the hand-written controls", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const audit = await auditOf(declan, "Brightwave", "open");
    expect((await control(declan, audit.id, "A.5.1")).status).toBe("accepted");
    expect((await control(declan, audit.id, "A.6.3")).status).toBe("rejected");
    expect((await control(declan, audit.id, "6.1.3")).status).toBe("rejected");
    expect((await control(declan, audit.id, "A.8.8")).status).toBe("submitted");
    expect((await control(declan, audit.id, "A.8.13")).status).toBe("under_review");
    const na = (await declan.listControls(audit.id)).filter((c) => !c.applicable).map((c) => c.controlRef).sort();
    expect(na).toEqual(["A.7.1", "A.7.12", "A.7.2", "A.7.3", "A.7.5"]);
  });
});
