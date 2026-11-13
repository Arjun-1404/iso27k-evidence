import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
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
