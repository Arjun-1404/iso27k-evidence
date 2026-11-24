import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import type { AuthUser } from "../auth/types";
import { TenantsUsersPage } from "./TenantsUsersPage";

describe("TenantsUsersPage", () => {
  it("lists tenants and users, and creates a new tenant", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: null }])),
      http.get(`${API_BASE}/users`, () => json([{ id: "u1", email: "auditor@harbor.test", fullName: null, role: "auditor", status: "active" }])),
    );
    let created: unknown = null;
    server.use(http.post(`${API_BASE}/tenants`, async ({ request }) => { created = await request.json(); return json({ id: "t2", name: "New Co", status: "active" }, 201); }));

    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    expect(await screen.findByText("Brightpath Ltd")).toBeInTheDocument();
    expect(screen.getByText(/auditor@harbor.test/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Tenant name"), "New Co");
    await userEvent.type(screen.getByPlaceholderText("Allowed email domain"), "newco.test");
    await userEvent.click(screen.getByText("Add tenant"));
    await waitFor(() => expect(created).toEqual({ name: "New Co", allowedDomains: ["newco.test"] }));
  });

  it("disables and reactivates a user", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/users`, () => json([{ id: "u1", email: "auditor@harbor.test", fullName: null, role: "auditor", status: "active" }])),
    );
    let disabledCalled = false;
    server.use(http.post(`${API_BASE}/users/u1/disable`, () => { disabledCalled = true; return json({ id: "u1", status: "disabled" }); }));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Disable"));
    await waitFor(() => expect(disabledCalled).toBe(true));
  });

  it("offers Resend invite for an invited user, never Disable, and not Resend for an active user", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/users`, () => json([
        { id: "u1", email: "pending@harbor.test", fullName: null, role: "auditor", status: "invited" },
        { id: "u2", email: "active@harbor.test", fullName: null, role: "auditor", status: "active" },
      ])),
    );
    let resent = false;
    server.use(http.post(`${API_BASE}/users/u1/resend-invite`, () => { resent = true; return json({ id: "u1" }); }));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByText(/pending@harbor.test/);
    expect(screen.getAllByText("Resend invite")).toHaveLength(1);
    expect(screen.getAllByText("Disable")).toHaveLength(1); // only the active user gets Disable
    await userEvent.click(screen.getByText("Resend invite"));
    await waitFor(() => expect(resent).toBe(true));
  });

  it("shows an error instead of failing silently when disabling a user fails", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/users`, () => json([{ id: "u1", email: "auditor@harbor.test", fullName: null, role: "auditor", status: "active" }])),
      http.post(`${API_BASE}/users/u1/disable`, () => new Response(JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }), { status: 500 })),
    );
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Disable"));
    expect(await screen.findByText("Could not disable that user.")).toBeInTheDocument();
  });

  it("says so when an invite was saved but its email could not be sent, and points at Resend", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/users`, () => json([])),
      http.post(`${API_BASE}/users`, () => json({ id: "u9", email: "new@harbor.test", role: "auditor", status: "invited", emailSent: false }, 201)),
    );
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.type(await screen.findByPlaceholderText("Work email"), "new@harbor.test");
    await userEvent.click(screen.getByText("Invite"));
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent(/new@harbor.test was invited, but the invitation email could not be sent/);
    expect(note).toHaveTextContent(/Resend invite/);
  });

  it("confirms plainly when the invitation email went out", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/users`, () => json([])),
      http.post(`${API_BASE}/users`, () => json({ id: "u9", email: "new@harbor.test", role: "auditor", status: "invited", emailSent: true }, 201)),
    );
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.type(await screen.findByPlaceholderText("Work email"), "new@harbor.test");
    await userEvent.click(screen.getByText("Invite"));
    expect(await screen.findByRole("status")).toHaveTextContent("Invitation sent to new@harbor.test.");
  });

  it("explains a failed resend as a mail-server problem, not a generic error", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/users`, () => json([{ id: "u1", email: "pending@harbor.test", fullName: null, role: "auditor", status: "invited" }])),
      http.post(`${API_BASE}/users/u1/resend-invite`, () => new Response(JSON.stringify({ error: { code: "EMAIL_DELIVERY_FAILED", message: "The email could not be sent." } }), { status: 502 })),
    );
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Resend invite"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/email could not be sent.*mail server settings/i);
  });
});

describe("TenantsUsersPage: a client's people and the auditors assigned to it", () => {
  const ADMIN: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "admin@harbor.test", name: "Alex Admin", role: "org_admin" };
  const TENANT = { id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: null };
  const CLIENT_PERSON = { id: "u-sam", email: "sam@brightpath.test", fullName: "Sam", role: "contributor", status: "active" };

  function mockPage(extra: unknown[] = []) {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([TENANT])),
      http.get(`${API_BASE}/users`, () => json(extra)),
      http.get(`${API_BASE}/roles`, () => json({ custom: [], catalog: { permissions: [], baseRoles: [] } })),
      http.get(`${API_BASE}/tenants/t1/users`, () => json([CLIENT_PERSON])),
      http.get(`${API_BASE}/tenants/t1/auditors`, () => json([])),
    );
  }

  it("opens a client's People panel from the Tenants list, so the firm invites the client's people itself", async () => {
    mockPage();
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    const toggle = await screen.findByRole("button", { name: "People at Brightpath Ltd" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("sam@brightpath.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite to Brightpath Ltd" })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByText("sam@brightpath.test")).not.toBeInTheDocument();
  });

  it("only an organisation admin gets the Auditors panel; one panel is open at a time", async () => {
    mockPage();
    const first = renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByRole("button", { name: "People at Brightpath Ltd" });
    expect(screen.queryByRole("button", { name: "Auditors assigned to Brightpath Ltd" })).not.toBeInTheDocument();
    first.unmount();

    renderApp(<TenantsUsersPage />, { user: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: "People at Brightpath Ltd" }));
    await screen.findByText("sam@brightpath.test");
    await userEvent.click(screen.getByRole("button", { name: "Auditors assigned to Brightpath Ltd" }));
    expect(await screen.findByRole("region", { name: "Auditors assigned to Brightpath Ltd" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "People at Brightpath Ltd" })).not.toBeInTheDocument();
  });

  it("an organisation admin can give a member of staff another role, with the custom roles listed below the built-in ones", async () => {
    mockPage([{ id: "a-1", email: "ann@harbor.test", fullName: null, role: "auditor", status: "active", customRoleId: "r1", customRoleName: "Junior auditor" }]);
    server.use(http.get(`${API_BASE}/roles`, () => json({
      custom: [{ id: "r1", name: "Junior auditor", description: null, baseRole: "auditor", denied: ["remind"], memberCount: 1 }, { id: "r2", name: "Uploader", description: null, baseRole: "contributor", denied: [], memberCount: 0 }],
      catalog: { permissions: [], baseRoles: [] },
    })));
    const seen: unknown[] = [];
    server.use(http.patch(`${API_BASE}/users/a-1/access`, async ({ request }) => { seen.push(await request.json()); return json({ id: "a-1", role: "lead_auditor", customRoleId: null }); }));
    renderApp(<TenantsUsersPage />, { user: ADMIN });
    expect((await screen.findAllByText("Junior auditor")).length).toBeGreaterThan(0); // the badge beside the name
    await userEvent.click(screen.getByRole("button", { name: "Change access for ann@harbor.test" }));
    const select = screen.getByLabelText("Role for ann@harbor.test");
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Junior auditor (auditor)");
    expect(options).not.toContain("Uploader (contributor)"); // a role for a client's people
    expect(options).not.toContain("Organisation admin"); // that role can't be handed out here
    await userEvent.selectOptions(select, "role:lead_auditor");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(seen).toEqual([{ role: "lead_auditor", customRoleId: null }]));
    expect(await screen.findByRole("status")).toHaveTextContent("ann@harbor.test's access was changed.");
  });

  it("a lead auditor gets no way to change the firm's own staff", async () => {
    mockPage([{ id: "a-1", email: "ann@harbor.test", fullName: null, role: "auditor", status: "active" }]);
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByText(/ann@harbor.test/);
    expect(screen.queryByRole("button", { name: "Change access for ann@harbor.test" })).not.toBeInTheDocument();
  });
});
