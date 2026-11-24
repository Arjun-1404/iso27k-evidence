import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { AccessProvider } from "../api/AccessProvider";
import { TenantPeoplePanel } from "./TenantPeoplePanel";
import { TenantAuditorsPanel } from "./TenantAuditorsPanel";
import type { CustomRole, OrgUser, Tenant } from "../api/types";

const TENANT: Tenant = { id: "t1", name: "Brightpath", status: "active", storageRootId: null };
const person = (over: Partial<OrgUser> & { id: string; email: string }): OrgUser => ({ fullName: null, role: "contributor", status: "active", ...over });
const SAM = person({ id: "u-sam", email: "sam@brightpath.test" });
const LEE = person({ id: "u-lee", email: "lee@brightpath.test", role: "tenant_lead", customRoleId: "r1", customRoleName: "Open book" });
const PENDING = person({ id: "u-new", email: "new@brightpath.test", status: "invited" });
const ROLES: CustomRole[] = [
  { id: "r1", name: "Open book", description: null, baseRole: "tenant_lead", denied: [], memberCount: 1 },
  { id: "r2", name: "Uploader", description: null, baseRole: "contributor", denied: ["comment"], memberCount: 0 },
  { id: "r3", name: "Junior auditor", description: null, baseRole: "auditor", denied: ["remind"], memberCount: 0 },
];
const CATALOG = { permissions: [], baseRoles: [] };

function mockServer(people: OrgUser[]) {
  server.use(
    http.get(`${API_BASE}/tenants/t1/users`, () => json(people)),
    http.get(`${API_BASE}/roles`, () => json({ custom: ROLES, catalog: CATALOG })),
  );
}
const show = (tenant: Tenant = TENANT) => renderApp(<AccessProvider><TenantPeoplePanel tenant={tenant} /></AccessProvider>, { user: AUDITOR_USER });

describe("TenantPeoplePanel", () => {
  it("lists the client's people with their role, status and custom role", async () => {
    mockServer([SAM, LEE, PENDING]);
    show();
    const list = await screen.findByRole("list");
    expect(await within(list).findByText("sam@brightpath.test")).toBeInTheDocument();
    expect(within(list).getByText("Open book")).toBeInTheDocument();
    expect(within(list).getAllByText("Client lead").length).toBeGreaterThan(0);
    expect(within(list).getByText("invited")).toBeInTheDocument();
  });

  it("invites a person with a built-in role", async () => {
    mockServer([SAM]);
    const seen: unknown[] = [];
    server.use(http.post(`${API_BASE}/tenants/t1/users`, async ({ request }) => { seen.push(await request.json()); return json({ id: "u-n", email: "nora@brightpath.test", role: "viewer", status: "invited", emailSent: true }, 201); }));
    show();
    await userEvent.type(await screen.findByLabelText("Email of the person to invite to Brightpath"), "nora@brightpath.test");
    await userEvent.selectOptions(screen.getByLabelText("Role for the person invited to Brightpath"), "role:viewer");
    await userEvent.click(screen.getByRole("button", { name: "Invite to Brightpath" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Invitation sent to nora@brightpath.test.");
    expect(seen).toEqual([{ email: "nora@brightpath.test", role: "viewer" }]);
  });

  it("offers only the custom roles for a client's people, and invites with one", async () => {
    mockServer([SAM]);
    const seen: unknown[] = [];
    server.use(http.post(`${API_BASE}/tenants/t1/users`, async ({ request }) => { seen.push(await request.json()); return json({ id: "u-n", email: "nora@brightpath.test", role: "contributor", status: "invited" }, 201); }));
    show();
    const select = await screen.findByLabelText("Role for the person invited to Brightpath");
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toContain("Uploader (contributor)"));
    expect(within(select).queryByRole("option", { name: /Junior auditor/ })).not.toBeInTheDocument(); // a role for the firm's own staff
    await userEvent.type(screen.getByLabelText("Email of the person to invite to Brightpath"), "nora@brightpath.test");
    await userEvent.selectOptions(select, "custom:r2");
    expect(screen.getByText("Like a contributor, but can't: comment.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Invite to Brightpath" }));
    await waitFor(() => expect(seen).toEqual([{ email: "nora@brightpath.test", customRoleId: "r2" }]));
  });

  it("says when the invitation was saved but the email couldn't be sent", async () => {
    mockServer([SAM]);
    server.use(http.post(`${API_BASE}/tenants/t1/users`, () => json({ id: "u-n", email: "nora@brightpath.test", role: "contributor", status: "invited", emailSent: false }, 201)));
    show();
    await userEvent.type(await screen.findByLabelText("Email of the person to invite to Brightpath"), "nora@brightpath.test");
    await userEvent.click(screen.getByRole("button", { name: "Invite to Brightpath" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/could not be sent/);
  });

  it("shows the server's reason when an invite is refused", async () => {
    mockServer([SAM]);
    server.use(http.post(`${API_BASE}/tenants/t1/users`, () => apiError(422, "DOMAIN_NOT_ALLOWED", "elsewhere.example")));
    show();
    await userEvent.type(await screen.findByLabelText("Email of the person to invite to Brightpath"), "nora@elsewhere.example");
    await userEvent.click(screen.getByRole("button", { name: "Invite to Brightpath" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("elsewhere.example");
  });

  it("changes a person's access: restrict with a custom role", async () => {
    mockServer([SAM]);
    const seen: unknown[] = [];
    server.use(http.patch(`${API_BASE}/users/u-sam/access`, async ({ request }) => { seen.push(await request.json()); return json({ id: "u-sam", role: "contributor", customRoleId: "r2" }); }));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Change access for sam@brightpath.test" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // nothing chosen yet
    await userEvent.selectOptions(screen.getByLabelText("Role for sam@brightpath.test"), "custom:r2");
    await userEvent.click(save);
    expect(await screen.findByRole("status")).toHaveTextContent("sam@brightpath.test's access was changed.");
    expect(seen).toEqual([{ customRoleId: "r2" }]);
  });

  it("lifting a restriction sends the built-in role and clears the custom one", async () => {
    mockServer([LEE]);
    const seen: unknown[] = [];
    server.use(http.patch(`${API_BASE}/users/u-lee/access`, async ({ request }) => { seen.push(await request.json()); return json({ id: "u-lee", role: "tenant_lead", customRoleId: null }); }));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Change access for lee@brightpath.test" }));
    await userEvent.selectOptions(screen.getByLabelText("Role for lee@brightpath.test"), "role:tenant_lead");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(seen).toEqual([{ role: "tenant_lead", customRoleId: null }]));
  });

  it("doesn't let you change your own access", async () => {
    mockServer([person({ id: AUDITOR_USER.userId, email: AUDITOR_USER.email, role: "tenant_lead" })]);
    show();
    await screen.findByText(AUDITOR_USER.email);
    expect(screen.queryByRole("button", { name: `Change access for ${AUDITOR_USER.email}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
  });

  it("switches a person off and resends a pending invite", async () => {
    mockServer([SAM, PENDING]);
    const disabled = vi.fn(); const resent = vi.fn();
    server.use(
      http.post(`${API_BASE}/users/u-sam/disable`, () => { disabled(); return json({ id: "u-sam", status: "disabled" }); }),
      http.post(`${API_BASE}/users/u-new/resend-invite`, () => { resent(); return json({ id: "u-new" }); }),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Disable" }));
    await waitFor(() => expect(disabled).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole("button", { name: "Resend invite" }));
    await waitFor(() => expect(resent).toHaveBeenCalled());
  });

  it("an archived client can't take new people", async () => {
    mockServer([SAM]);
    show({ ...TENANT, status: "archived" });
    await screen.findByText("sam@brightpath.test");
    expect(screen.getByText(/archived, so people can't be invited/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Invite to/ })).not.toBeInTheDocument();
  });

  it("a person whose role took away 'manage people' sees the people but no way to change them", async () => {
    mockServer([SAM]);
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "lead_auditor", customRole: { id: "x", name: "Hands off" }, denied: ["manage_people"] })));
    show();
    await screen.findByText("sam@brightpath.test");
    await waitFor(() => expect(screen.getByText("Your role doesn't include inviting or changing people.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Invite to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change access for/ })).not.toBeInTheDocument();
  });
});

describe("TenantAuditorsPanel", () => {
  const STAFF = [
    person({ id: "a-1", email: "ann@firm.test", role: "auditor", fullName: "Ann Auditor" }),
    person({ id: "a-2", email: "bob@firm.test", role: "lead_auditor", customRoleId: "r3", customRoleName: "Junior lead" }),
    person({ id: "a-3", email: "boss@firm.test", role: "org_admin" }),
    person({ id: "a-4", email: "off@firm.test", role: "auditor", status: "disabled" }),
  ];
  const showAuditors = () => renderApp(<TenantAuditorsPanel tenant={TENANT} />, { user: AUDITOR_USER });

  it("lists who is assigned, and offers the staff who are not (never an admin or a switched-off account)", async () => {
    server.use(http.get(`${API_BASE}/tenants/t1/auditors`, () => json([STAFF[0]])), http.get(`${API_BASE}/users`, () => json(STAFF)));
    showAuditors();
    expect(await screen.findByText(/Ann Auditor/)).toBeInTheDocument();
    const select = await screen.findByLabelText("Auditor to assign to Brightpath");
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a person…", "bob@firm.test · Lead auditor"]));
  });

  it("assigns someone and removes someone", async () => {
    let assigned = [STAFF[0]!];
    const puts: string[] = []; const deletes: string[] = [];
    server.use(
      http.get(`${API_BASE}/tenants/t1/auditors`, () => json(assigned)),
      http.get(`${API_BASE}/users`, () => json(STAFF)),
      http.put(`${API_BASE}/tenants/t1/auditors/:id`, ({ params }) => { puts.push(String(params.id)); assigned = [...assigned, STAFF[1]!]; return json({ auditorUserId: params.id, tenantId: "t1" }); }),
      http.delete(`${API_BASE}/tenants/t1/auditors/:id`, ({ params }) => { deletes.push(String(params.id)); assigned = assigned.filter((a) => a.id !== params.id); return json({ removed: true }); }),
    );
    showAuditors();
    const select = await screen.findByLabelText("Auditor to assign to Brightpath");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(select, "a-2");
    await userEvent.click(screen.getByRole("button", { name: "Assign to Brightpath" }));
    await waitFor(() => expect(puts).toEqual(["a-2"]));
    expect(await screen.findByText(/Junior lead/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove ann@firm.test from Brightpath" }));
    await waitFor(() => expect(deletes).toEqual(["a-1"]));
  });

  it("says plainly when no one is assigned, and when there is no one left to assign", async () => {
    server.use(http.get(`${API_BASE}/tenants/t1/auditors`, () => json([])), http.get(`${API_BASE}/users`, () => json([STAFF[2]])));
    showAuditors();
    expect(await screen.findByText(/No one is assigned yet, so only organisation admins can see this client/)).toBeInTheDocument();
    expect(await screen.findByText(/There are no auditors to assign yet/)).toBeInTheDocument();
  });

  it("shows the server's reason when an assignment is refused", async () => {
    server.use(
      http.get(`${API_BASE}/tenants/t1/auditors`, () => json([])), http.get(`${API_BASE}/users`, () => json(STAFF)),
      http.put(`${API_BASE}/tenants/t1/auditors/:id`, () => apiError(403, "FORBIDDEN", "You don't have access to do that.")),
    );
    showAuditors();
    const select = await screen.findByLabelText("Auditor to assign to Brightpath");
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(1));
    await userEvent.selectOptions(select, "a-1");
    await userEvent.click(screen.getByRole("button", { name: "Assign to Brightpath" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have access to do that.");
  });
});
