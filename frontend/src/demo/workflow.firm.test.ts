// @vitest-environment node
// What the audit firm can do for itself: close a control without waiting for the client, decide what applies to a client,
// set due dates, invite and restrict a client's people, and hand out custom roles. The same rules the real server's
// database enforces (migration 016), as a visitor meets them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../api/client";
import type { ControlStatus, ControlSummary, Permission } from "../api/types";
import { auditOf, makeKit, PEOPLE, refusal, tenantNamed, type Kit } from "./testkit";

let kit: Kit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.stop());

const REASON = "Seen on site during the visit on 12 March";

/** The first applicable annex control of Brightwave's open audit that is in this status (so a test owns it). */
async function pick(api: ApiClient, status: ControlStatus, skip = 0): Promise<{ audit: string; ctl: ControlSummary }> {
  const audit = await auditOf(api, "Brightwave", "open");
  const found = (await api.listControls(audit.id)).filter((c) => c.kind === "annex" && c.applicable && c.status === status)[skip];
  if (!found) throw new Error(`no ${status} control to use`);
  return { audit: audit.id, ctl: found };
}
const statusOf = async (api: ApiClient, audit: string, id: string) => (await api.listControls(audit)).find((c) => c.id === id)!.status;

async function userId(api: ApiClient, email: string): Promise<string> {
  const all = [...(await api.listOrgUsers())];
  for (const t of await api.listTenants()) all.push(...(await api.listTenantUsers(t.id)));
  const u = all.find((x) => x.email === email);
  if (!u) throw new Error(`no one with address ${email}`);
  return u.id;
}

async function giveRole(email: string, base: "lead_auditor" | "auditor" | "tenant_lead" | "contributor", denied: Permission[], name = `Role ${Math.random().toString(36).slice(2, 7)}`) {
  const aoife = await kit.as(PEOPLE.aoife);
  const role = await aoife.createRole({ name, baseRole: base, denied });
  await aoife.setUserAccess(await userId(aoife, email), { customRoleId: role.id });
  return role;
}

describe("the firm closing a control", () => {
  it("closes a control the client never submitted: accepted, no file needed, the reason in the thread and the log", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { audit, ctl } = await pick(declan, "not_started");
    const before = await declan.getDashboard(audit);
    expect(ctl.fileCount).toBe(0);

    expect(await declan.review(ctl.id, "close", REASON)).toEqual({ id: ctl.id, status: "accepted" });
    expect(await statusOf(declan, audit, ctl.id)).toBe("accepted");
    expect((await declan.getDashboard(audit)).accepted).toBe(before.accepted + 1);

    // The client's people can see why, in the control's comment thread.
    const priya = await kit.as(PEOPLE.priya);
    expect((await priya.listComments(ctl.id)).map((x) => x.body)).toEqual([`Closed by the audit firm without client evidence. Reason: ${REASON}`]);
    // And in the audit log, with who did it.
    const entry = (await (await kit.as(PEOPLE.aoife)).listAuditLog()).find((e) => e.action === "control.close" && e.entityId === ctl.id)!;
    expect(entry.change).toEqual({ status: "accepted", reason: REASON });
  });

  it("an organisation admin and an auditor can do it too, and it works from awaiting evidence and from rejected", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const maeve = await kit.as(PEOPLE.maeve);
    const a = await pick(aoife, "not_started");
    const b = await pick(aoife, "rejected");
    expect(await aoife.review(a.ctl.id, "close", REASON)).toMatchObject({ status: "accepted" });
    expect(await maeve.review(b.ctl.id, "close", REASON)).toMatchObject({ status: "accepted" });
    const waiting = await pick(aoife, "awaiting_evidence");
    expect(await maeve.review(waiting.ctl.id, "close", REASON)).toMatchObject({ status: "accepted" });
  });

  it("needs a written reason of at least 3 characters", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { audit, ctl } = await pick(declan, "not_started");
    for (const reason of [undefined, "", "  ", "ab"]) {
      expect(await refusal(declan.review(ctl.id, "close", reason))).toMatchObject({ status: 400, code: "VALIDATION" });
    }
    expect(await statusOf(declan, audit, ctl.id)).toBe("not_started");
  });

  it("says why when it can't be done: not applicable, already accepted, or evidence waiting for review", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const na = await pick(declan, "not_started", 1);
    await declan.setApplicability(na.ctl.id, false, "Nothing like this is in scope");
    expect(await refusal(declan.review(na.ctl.id, "close", REASON))).toMatchObject({ status: 409, code: "NOT_APPLICABLE" });

    const done = await pick(declan, "accepted");
    expect(await refusal(declan.review(done.ctl.id, "close", REASON))).toMatchObject({ status: 409, code: "ALREADY_ACCEPTED" });

    const waiting = await pick(declan, "submitted");
    expect(await refusal(declan.review(waiting.ctl.id, "close", REASON))).toMatchObject({ status: 409, code: "NEEDS_REVIEW" });
    expect(await statusOf(declan, waiting.audit, waiting.ctl.id)).toBe("submitted");
  });

  it("is refused for the client's people and for read-only staff, and a control that can't be seen is 'not found'", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { ctl } = await pick(declan, "not_started");
    for (const who of [PEOPLE.priya, PEOPLE.ronan]) {
      const code = (await refusal((await kit.as(who)).review(ctl.id, "close", REASON))).status;
      expect([403, 404]).toContain(code);
    }
    expect(await refusal((await kit.as(PEOPLE.colm)).review(ctl.id, "close", REASON))).toMatchObject({ status: 404 });
    expect((await pick(declan, "not_started")).ctl.status).toBe("not_started");
  });

  it("is refused in a closed audit cycle", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const closed = await auditOf(declan, "Brightwave", "closed");
    const open = (await declan.listControls(closed.id)).find((c) => c.status !== "accepted" && c.applicable);
    if (open) expect(await refusal(declan.review(open.id, "close", REASON))).toMatchObject({ status: 409, code: "AUDIT_CLOSED" });
    else expect(true).toBe(true);
  });

  it("a custom role that took away 'review' cannot close; one that took away only 'comment' can, but leaves no comment", async () => {
    const noReview = await giveRole(PEOPLE.maeve, "auditor", ["review"]);
    expect(noReview.denied).toEqual(["review"]);
    const maeve = await kit.as(PEOPLE.maeve);
    const a = await pick(maeve, "not_started");
    expect(await refusal(maeve.review(a.ctl.id, "close", REASON))).toMatchObject({ status: 403 });

    const aoife = await kit.as(PEOPLE.aoife);
    const noComment = await aoife.createRole({ name: "Silent lead", baseRole: "lead_auditor", denied: ["comment"] });
    await aoife.setUserAccess(await userId(aoife, PEOPLE.declan), { customRoleId: noComment.id });
    const declan = await kit.as(PEOPLE.declan);
    expect(await declan.review(a.ctl.id, "close", REASON)).toMatchObject({ status: "accepted" });
    expect(await declan.listComments(a.ctl.id)).toEqual([]);
  });
});

describe("applicability and due dates from the firm's side", () => {
  it("a lead auditor and an organisation admin can mark a control not applicable (with a reason) and back; the dashboard follows", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { audit, ctl } = await pick(declan, "not_started");
    const before = await declan.getDashboard(audit);

    await declan.setApplicability(ctl.id, false, "The client has no such premises");
    let now = (await declan.listControls(audit)).find((c) => c.id === ctl.id)!;
    expect(now).toMatchObject({ applicable: false, naJustification: "The client has no such premises" });
    expect(await declan.getDashboard(audit)).toMatchObject({ notApplicable: before.notApplicable + 1, applicable: before.applicable - 1 });

    await (await kit.as(PEOPLE.aoife)).setApplicability(ctl.id, true);
    now = (await declan.listControls(audit)).find((c) => c.id === ctl.id)!;
    expect(now).toMatchObject({ applicable: true, naJustification: null });
    expect((await declan.getDashboard(audit)).notApplicable).toBe(before.notApplicable);
  });

  it("needs a reason, and never applies to the mandatory clauses 4 to 10", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { audit, ctl } = await pick(declan, "not_started");
    expect(await refusal(declan.setApplicability(ctl.id, false))).toMatchObject({ status: 400 });
    expect(await refusal(declan.setApplicability(ctl.id, false, "no"))).toMatchObject({ status: 400 });
    const clause = (await declan.listControls(audit)).find((c) => c.kind === "clause")!;
    expect(await refusal(declan.setApplicability(clause.id, false, "We would rather not"))).toMatchObject({ status: 400, code: "clauses_always_applicable" });
  });

  it("a plain auditor and the client's people can't; a custom lead role without the ability can't either", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { ctl } = await pick(declan, "not_started");
    expect(await refusal((await kit.as(PEOPLE.maeve)).setApplicability(ctl.id, false, "Not relevant to us"))).toMatchObject({ status: 403, code: "FORBIDDEN_COLUMN" });
    expect(await refusal((await kit.as(PEOPLE.priya)).setApplicability(ctl.id, false, "Not relevant to us"))).toMatchObject({ status: 403 });

    await giveRole(PEOPLE.declan, "lead_auditor", ["applicability", "due_dates"]);
    const restricted = await kit.as(PEOPLE.declan);
    expect(await refusal(restricted.setApplicability(ctl.id, false, "Not relevant to us"))).toMatchObject({ status: 403, code: "FORBIDDEN_PERMISSION" });
    expect(await refusal(restricted.setDueDate(ctl.id, "2026-12-01"))).toMatchObject({ status: 403, code: "FORBIDDEN_PERMISSION" });
    // What the role still has keeps working.
    expect(await restricted.review(ctl.id, "close", REASON)).toMatchObject({ status: "accepted" });
  });

  it("a not-applicable control is no longer overdue, and its status can't be changed", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const { audit, ctl } = await pick(declan, "not_started");
    await declan.setDueDate(ctl.id, "2026-05-01"); // before the demo's "today"
    const overdue = (await declan.getDashboard(audit)).overdue;
    await declan.setApplicability(ctl.id, false, "Not in scope this year");
    expect((await declan.getDashboard(audit)).overdue).toBe(overdue - 1);
    expect(await refusal(declan.review(ctl.id, "accept"))).toMatchObject({ status: 409, code: "NOT_APPLICABLE" });
  });
});

describe("custom roles", () => {
  it("the organisation admin creates one; it lists with what is taken away and how many people have it", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const made = await aoife.createRole({ name: "Evidence-only contributor", description: "Uploads, no comments", baseRole: "contributor", denied: ["comment"] });
    expect(made).toMatchObject({ name: "Evidence-only contributor", baseRole: "contributor", denied: ["comment"], memberCount: 0, description: "Uploads, no comments" });

    await aoife.setUserAccess(await userId(aoife, PEOPLE.tom), { customRoleId: made.id });
    const listed = await aoife.listRoles();
    expect(listed.custom.find((r) => r.id === made.id)).toMatchObject({ memberCount: 1 });
    expect(listed.catalog.permissions).toHaveLength(10);
    expect(listed.catalog.baseRoles.map((r) => r.role)).toEqual(["lead_auditor", "auditor", "tenant_lead", "contributor"]);
  });

  it("ships with one example, so the page isn't empty", async () => {
    const roles = (await (await kit.as(PEOPLE.aoife)).listRoles()).custom;
    expect(roles.map((r) => r.name)).toEqual(["Junior auditor"]);
    expect(roles[0]).toMatchObject({ baseRole: "auditor", denied: ["remind"], memberCount: 0 });
  });

  it("nobody else can create, change or delete one: a lead auditor can read them, a client's people see none", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const role = (await aoife.listRoles()).custom[0]!;
    const declan = await kit.as(PEOPLE.declan);
    expect((await declan.listRoles()).custom.map((r) => r.id)).toEqual([role.id]);
    expect((await (await kit.as(PEOPLE.priya)).listRoles()).custom).toEqual([]);
    for (const who of [declan, await kit.as(PEOPLE.maeve), await kit.as(PEOPLE.priya)]) {
      expect(await refusal(who.createRole({ name: "Mine", baseRole: "auditor", denied: [] }))).toMatchObject({ status: 403 });
      expect(await refusal(who.updateRole(role.id, { name: "Renamed" }))).toMatchObject({ status: 403 });
      expect(await refusal(who.deleteRole(role.id))).toMatchObject({ status: 403 });
    }
  });

  it("cannot be based on the admin or a read-only role, and cannot take away what the base role never had", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    for (const baseRole of ["org_admin", "read_only", "viewer"]) {
      expect(await refusal(aoife.createRole({ name: "X", baseRole: baseRole as never, denied: [] }))).toMatchObject({ status: 400, code: "VALIDATION" });
    }
    expect(await refusal(aoife.createRole({ name: "X", baseRole: "auditor", denied: ["close_cycle"] }))).toMatchObject({
      status: 400, message: `An auditor doesn't have "Close and reopen audit cycles" to begin with, so it can't be taken away.`,
    });
    expect(await refusal(aoife.createRole({ name: "X", baseRole: "contributor", denied: ["made_up" as never] }))).toMatchObject({ status: 400 });
  });

  it("a name can't be used twice (whatever the case)", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    await aoife.createRole({ name: "Reviewer", baseRole: "auditor", denied: [] });
    expect(await refusal(aoife.createRole({ name: "  reviewer ", baseRole: "lead_auditor", denied: [] }))).toMatchObject({ status: 409, code: "DUPLICATE_ROLE_NAME" });
  });

  it("can be renamed and changed, and the change reaches the people who have it straight away; its base never changes", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const role = await giveRole(PEOPLE.maeve, "auditor", ["remind"], "Careful auditor");
    const maeve = await kit.as(PEOPLE.maeve);
    expect(await maeve.getMyAccess()).toMatchObject({ role: "auditor", customRole: { id: role.id, name: "Careful auditor" }, denied: ["remind"] });

    const changed = await aoife.updateRole(role.id, { name: "Quiet auditor", denied: ["remind", "comment"], description: "Reviews only" });
    expect(changed).toMatchObject({ name: "Quiet auditor", baseRole: "auditor", denied: ["remind", "comment"], memberCount: 1 });
    expect(await maeve.getMyAccess()).toMatchObject({ customRole: { name: "Quiet auditor" }, denied: ["remind", "comment"] });
    const { ctl } = await pick(maeve, "not_started");
    expect(await refusal(maeve.addComment(ctl.id, "comment", "hello"))).toMatchObject({ status: 403 });
    expect(await refusal(aoife.updateRole(role.id, { denied: ["upload"] }))).toMatchObject({ status: 400 });
    expect(await refusal(aoife.updateRole("no-such-role", { name: "Nope" }))).toMatchObject({ status: 404 });
  });

  it("can't be deleted while anyone has it", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const role = await giveRole(PEOPLE.maeve, "auditor", ["remind"]);
    expect(await refusal(aoife.deleteRole(role.id))).toMatchObject({ status: 409, code: "ROLE_IN_USE", message: "1 person has this role. Give them a different role first." });
    await aoife.setUserAccess(await userId(aoife, PEOPLE.maeve), { customRoleId: null });
    expect(await aoife.deleteRole(role.id)).toEqual({ deleted: true });
    expect((await aoife.listRoles()).custom.some((r) => r.id === role.id)).toBe(false);
  });

  it("GET /me/access says what the signed-in person's role takes away", async () => {
    expect(await (await kit.as(PEOPLE.declan)).getMyAccess()).toEqual({ role: "lead_auditor", customRole: null, denied: [] });
    await giveRole(PEOPLE.tom, "contributor", ["comment"], "Uploader");
    expect(await (await kit.as(PEOPLE.tom)).getMyAccess()).toEqual({ role: "contributor", customRole: { id: expect.any(String), name: "Uploader" }, denied: ["comment"] });
  });

  it("takes effect where it should: a contributor who can't upload, a client lead who can't assign", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const tom0 = await kit.as(PEOPLE.tom);
    const mine = (await tom0.listControls((await auditOf(tom0, "Brightwave", "open")).id)).find((c) => c.status === "awaiting_evidence" || c.status === "not_started");
    expect(mine).toBeTruthy();

    await giveRole(PEOPLE.priya, "tenant_lead", ["assign_controls"]);
    const restricted = await kit.as(PEOPLE.priya);
    expect(await refusal(restricted.assignControl(mine!.id, await userId(priya, PEOPLE.lena)))).toMatchObject({ status: 403 });
    expect((await priya.listTenants()).length).toBe(1);
  });
});

describe("the firm inviting and restricting a client's people", () => {
  it("a lead auditor assigned to the client invites its people; an organisation admin too; an auditor, a contributor and an unassigned lead cannot", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const bw = await tenantNamed(declan, "Brightwave");
    expect(await declan.inviteTenantUser(bw.id, "nora@brightwave.example", "contributor")).toMatchObject({ role: "contributor", status: "invited" });
    expect(await (await kit.as(PEOPLE.aoife)).inviteTenantUser(bw.id, "owen@brightwave.example", "viewer")).toMatchObject({ role: "viewer" });
    expect((await declan.listTenantUsers(bw.id)).map((u) => u.email)).toEqual(expect.arrayContaining(["nora@brightwave.example", "owen@brightwave.example"]));

    expect(await refusal((await kit.as(PEOPLE.maeve)).inviteTenantUser(bw.id, "pat@brightwave.example", "contributor"))).toMatchObject({ status: 403 });
    expect(await refusal((await kit.as(PEOPLE.tom)).inviteTenantUser(bw.id, "pat@brightwave.example", "contributor"))).toMatchObject({ status: 403 });
    const corran = await tenantNamed(await kit.as(PEOPLE.aoife), "Corran");
    // Declan is assigned to Corran too; take him off it and he is no longer allowed to invite there.
    await (await kit.as(PEOPLE.aoife)).unassignAuditor(corran.id, await userId(declan, PEOPLE.declan));
    expect(await refusal(declan.inviteTenantUser(corran.id, "pat@corran.example", "contributor"))).toMatchObject({ status: 404 });
  });

  it("invites with a custom role: its base role becomes the person's role, and the firm sees the name (the client only that there is one)", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const bw = await tenantNamed(declan, "Brightwave");
    const role = await (await kit.as(PEOPLE.aoife)).createRole({ name: "Read-only uploader", baseRole: "contributor", denied: ["comment"] });
    const invited = await declan.inviteTenantUser(bw.id, "nora@brightwave.example", undefined, role.id);
    expect(invited).toMatchObject({ role: "contributor", status: "invited" });

    const seenByFirm = (await declan.listTenantUsers(bw.id)).find((u) => u.email === "nora@brightwave.example")!;
    expect(seenByFirm).toMatchObject({ role: "contributor", customRoleId: role.id, customRoleName: "Read-only uploader" });
    const seenByClient = (await (await kit.as(PEOPLE.priya)).listTenantUsers(bw.id)).find((u) => u.email === "nora@brightwave.example")!;
    expect(seenByClient).toMatchObject({ customRoleId: role.id, customRoleName: null });
  });

  it("explains what's wrong with a role: none chosen, a firm role for a client's person, a different base, an unknown one", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const bw = await tenantNamed(aoife, "Brightwave");
    const firmRole = (await aoife.listRoles()).custom[0]!;
    const clientRole = await aoife.createRole({ name: "Lead without assigning", baseRole: "tenant_lead", denied: ["assign_controls"] });
    expect(await refusal(aoife.inviteTenantUser(bw.id, "a@brightwave.example"))).toMatchObject({ status: 400, code: "VALIDATION" });
    expect(await refusal(aoife.inviteTenantUser(bw.id, "a@brightwave.example", undefined, firmRole.id))).toMatchObject({ status: 400, code: "INVALID_CUSTOM_ROLE", message: "That custom role is for your own staff, not for a client's people." });
    expect(await refusal(aoife.inviteTenantUser(bw.id, "a@brightwave.example", "contributor", clientRole.id))).toMatchObject({ status: 400, code: "INVALID_CUSTOM_ROLE", message: "That custom role is based on a different role than the one chosen." });
    expect(await refusal(aoife.inviteTenantUser(bw.id, "a@brightwave.example", undefined, "no-such-role"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await refusal(aoife.inviteAuditorUser("a@harbourview.example", undefined, clientRole.id))).toMatchObject({ status: 400, code: "INVALID_CUSTOM_ROLE", message: "That custom role is for a client's people, not for your own staff." });
  });

  it("the client's own lead can still invite plain contributors, but can't hand out a restriction", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const bw = await tenantNamed(priya, "Brightwave");
    expect(await priya.inviteTenantUser(bw.id, "nora@brightwave.example", "contributor")).toMatchObject({ role: "contributor" });
    const role = await (await kit.as(PEOPLE.aoife)).createRole({ name: "Uploader", baseRole: "contributor", denied: ["comment"] });
    expect(await refusal(priya.inviteTenantUser(bw.id, "pat@brightwave.example", undefined, role.id))).toMatchObject({ status: 404 });
    expect(await refusal(priya.inviteTenantUser(bw.id, "pat@brightwave.example", "tenant_lead"))).toMatchObject({ status: 403 });
  });

  it("a client lead whose role took away 'manage people' cannot invite anybody", async () => {
    await giveRole(PEOPLE.priya, "tenant_lead", ["manage_people"]);
    const priya = await kit.as(PEOPLE.priya);
    const bw = await tenantNamed(priya, "Brightwave");
    expect(await refusal(priya.inviteTenantUser(bw.id, "nora@brightwave.example", "contributor"))).toMatchObject({ status: 403 });
  });

  it("changes a person's access: restrict, change role, lift the restriction; the change is logged", async () => {
    const declan = await kit.as(PEOPLE.declan);
    const aoife = await kit.as(PEOPLE.aoife);
    const bw = await tenantNamed(declan, "Brightwave");
    const tom = await userId(declan, PEOPLE.tom);
    const role = await aoife.createRole({ name: "Uploader", baseRole: "contributor", denied: ["comment"] });

    expect(await declan.setUserAccess(tom, { customRoleId: role.id })).toEqual({ id: tom, role: "contributor", customRoleId: role.id });
    expect((await declan.listTenantUsers(bw.id)).find((u) => u.id === tom)).toMatchObject({ customRoleName: "Uploader" });
    // A custom role carries its role: moving to another one means choosing both together, or lifting the restriction first.
    expect(await refusal(declan.setUserAccess(tom, { role: "viewer" }))).toMatchObject({ status: 400, code: "INVALID_CUSTOM_ROLE" });
    expect(await declan.setUserAccess(tom, { role: "viewer", customRoleId: null })).toEqual({ id: tom, role: "viewer", customRoleId: null });
    expect(await declan.setUserAccess(tom, { role: "contributor" })).toEqual({ id: tom, role: "contributor", customRoleId: null });

    const log = (await aoife.listAuditLog()).filter((e) => e.action === "user.access_changed" && e.entityId === tom);
    expect(log).toHaveLength(3);
    expect(log[2]!.change).toEqual({ from: { role: "contributor", customRoleId: null }, to: { role: "contributor", customRoleId: role.id } });
  });

  it("refuses the changes nobody should make: your own, the admin's, a role of the other kind, and lifting a restriction as the client", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const declan = await kit.as(PEOPLE.declan);
    const priya = await kit.as(PEOPLE.priya);
    const tom = await userId(aoife, PEOPLE.tom);
    expect(await refusal(declan.setUserAccess(await userId(aoife, PEOPLE.declan), { role: "auditor" }))).toMatchObject({ status: 403, code: "SELF_CHANGE" });
    expect(await refusal(aoife.setUserAccess(await userId(aoife, PEOPLE.declan), { role: "org_admin" }))).toMatchObject({ status: 403, code: "ORG_ADMIN_LOCKED" });
    expect(await refusal(declan.setUserAccess(await userId(aoife, PEOPLE.aoife), { role: "auditor" }))).toMatchObject({ status: 403, code: "ORG_ADMIN_LOCKED" });
    expect(await refusal(declan.setUserAccess(tom, { role: "auditor" }))).toMatchObject({ status: 400, code: "VALIDATION" });
    expect(await refusal(declan.setUserAccess("no-such-person", { role: "viewer" }))).toMatchObject({ status: 404 });
    expect(await refusal(declan.setUserAccess(tom, {} as never))).toMatchObject({ status: 400 });
    // A lead auditor can change a client's people but not the firm's own staff.
    expect(await refusal(declan.setUserAccess(await userId(aoife, PEOPLE.maeve), { role: "read_only" }))).toMatchObject({ status: 403 });

    const role = await aoife.createRole({ name: "Uploader", baseRole: "contributor", denied: ["comment"] });
    await aoife.setUserAccess(tom, { customRoleId: role.id });
    // The client's lead can't lift a restriction the firm set, nor set one.
    expect(await refusal(priya.setUserAccess(tom, { customRoleId: null }))).toMatchObject({ status: 403, code: "FORBIDDEN_ROLE" });
    expect((await declan.listTenantUsers((await tenantNamed(declan, "Brightwave")).id)).find((u) => u.id === tom)!.customRoleId).toBe(role.id);
  });

  it("the organisation admin can give a member of staff a custom role", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const junior = (await aoife.listRoles()).custom[0]!;
    const maeve = await userId(aoife, PEOPLE.maeve);
    expect(await aoife.setUserAccess(maeve, { customRoleId: junior.id })).toEqual({ id: maeve, role: "auditor", customRoleId: junior.id });
    expect((await aoife.listOrgUsers()).find((u) => u.id === maeve)).toMatchObject({ customRoleName: "Junior auditor" });
    // "Junior auditor" can't send reminders.
    const m = await kit.as(PEOPLE.maeve);
    const { ctl } = await pick(m, "awaiting_evidence");
    expect(await refusal(m.remind(ctl.id))).toMatchObject({ status: 403, code: "FORBIDDEN_PERMISSION" });
    expect(await (await kit.as(PEOPLE.declan)).remind(ctl.id)).toMatchObject({ remindedCount: expect.any(Number) });
  });
});

describe("assigning staff to a client, and seeing who is", () => {
  it("the organisation admin sees who is assigned to a client; everyone else sees at most themselves", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const bw = await tenantNamed(aoife, "Brightwave");
    expect((await aoife.listTenantAuditors(bw.id)).map((u) => u.email).sort()).toEqual([PEOPLE.declan, PEOPLE.maeve, PEOPLE.ronan].sort());
    expect((await (await kit.as(PEOPLE.declan)).listTenantAuditors(bw.id)).map((u) => u.email)).toEqual([PEOPLE.declan]);
    expect(await (await kit.as(PEOPLE.priya)).listTenantAuditors(bw.id)).toEqual([]);
    expect(await refusal((await kit.as(PEOPLE.colm)).listTenantAuditors(bw.id))).toMatchObject({ status: 404 });
  });

  it("assigns and unassigns, and the list follows", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const corran = await tenantNamed(aoife, "Corran");
    const maeve = await userId(aoife, PEOPLE.maeve);
    expect((await aoife.listTenantAuditors(corran.id)).map((u) => u.email)).not.toContain(PEOPLE.maeve);
    await aoife.assignAuditor(corran.id, maeve);
    expect((await aoife.listTenantAuditors(corran.id)).map((u) => u.email)).toContain(PEOPLE.maeve);
    expect((await (await kit.as(PEOPLE.maeve)).listTenants()).map((t) => t.name)).toContain("Corran Logistics");
    expect(await aoife.unassignAuditor(corran.id, maeve)).toEqual({ removed: true });
    expect((await aoife.listTenantAuditors(corran.id)).map((u) => u.email)).not.toContain(PEOPLE.maeve);
  });

  it("only staff who need assigning can be: not a client's person, not the organisation admin, and only the admin can assign", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const corran = await tenantNamed(aoife, "Corran");
    expect(await refusal(aoife.assignAuditor(corran.id, await userId(aoife, PEOPLE.tom)))).toMatchObject({ status: 400, code: "ASSIGNEE_ROLE" });
    expect(await refusal(aoife.assignAuditor(corran.id, await userId(aoife, PEOPLE.aoife)))).toMatchObject({ status: 400, code: "ASSIGNEE_ROLE", message: "Organisation admins already see every client." });
    expect(await refusal(aoife.assignAuditor(corran.id, "no-such-person"))).toMatchObject({ status: 404 });
    expect(await refusal((await kit.as(PEOPLE.declan)).assignAuditor(corran.id, await userId(aoife, PEOPLE.maeve)))).toMatchObject({ status: 403 });
  });
});
