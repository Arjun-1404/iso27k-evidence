import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { RolesPage } from "./RolesPage";
import type { CustomRole, RoleCatalog } from "../api/types";
import type { AuthUser } from "../auth/types";

const ADMIN: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "admin@harbor.test", name: "Alex Admin", role: "org_admin" };

const CATALOG: RoleCatalog = {
  permissions: [
    { key: "review", label: "Review controls", hint: "Accept, reject or close a control." },
    { key: "remind", label: "Send reminders", hint: "Email the client." },
    { key: "comment", label: "Comment", hint: "Add comments to a control." },
    { key: "upload", label: "Upload and submit evidence", hint: "Add evidence files." },
  ],
  baseRoles: [
    { role: "lead_auditor", side: "firm", allowed: ["review", "remind", "comment"] },
    { role: "auditor", side: "firm", allowed: ["review", "remind", "comment"] },
    { role: "tenant_lead", side: "client", allowed: ["upload", "comment"] },
    { role: "contributor", side: "client", allowed: ["upload", "comment"] },
  ],
};
const JUNIOR: CustomRole = { id: "r1", name: "Junior auditor", description: "Reviews, no reminders", baseRole: "auditor", denied: ["remind"], memberCount: 2 };
const OPEN: CustomRole = { id: "r2", name: "Open book", description: null, baseRole: "tenant_lead", denied: [], memberCount: 0 };

function mockRoles(custom: CustomRole[]) {
  server.use(http.get(`${API_BASE}/tenants`, () => json([])), http.get(`${API_BASE}/roles`, () => json({ custom, catalog: CATALOG })));
}
const show = (user: AuthUser = ADMIN) => renderApp(<RolesPage />, { user });

describe("RolesPage", () => {
  it("lists the custom roles with their base role, how many people have them, and what is taken away", async () => {
    mockRoles([JUNIOR, OPEN]);
    show();
    const roles = await screen.findByRole("region", { name: "Custom roles" });
    expect(await within(roles).findByText("Junior auditor")).toBeInTheDocument();
    expect(within(roles).getByText("Based on auditor · 2 people have it")).toBeInTheDocument();
    expect(within(roles).getByText("Reviews, no reminders")).toBeInTheDocument();
    expect(within(roles).getByText("Send reminders.")).toBeInTheDocument();
    expect(within(roles).getByText("Based on client lead · 0 people have it")).toBeInTheDocument();
    expect(within(roles).getByText(/Nothing is taken away: the same as client lead/)).toBeInTheDocument();
  });

  it("explains the built-in roles, so nobody has to guess what 'viewer' means", async () => {
    mockRoles([]);
    show();
    const builtIn = await screen.findByRole("region", { name: "Built-in roles" });
    for (const name of ["Organisation admin", "Lead auditor", "Auditor", "Read-only reviewer", "Dashboard only", "Client lead", "Contributor", "Viewer", "Client dashboard"]) {
      expect(within(builtIn).getByText(name)).toBeInTheDocument();
    }
    expect(await screen.findByText("No custom roles yet.")).toBeInTheDocument();
  });

  it("creates a role: ticks are what the role keeps, so what is unticked is sent as taken away", async () => {
    mockRoles([]);
    const seen: unknown[] = [];
    server.use(http.post(`${API_BASE}/roles`, async ({ request }) => {
      seen.push(await request.json());
      return json({ id: "r9", name: "Quiet auditor", description: null, baseRole: "auditor", denied: ["remind", "comment"], memberCount: 0 }, 201);
    }));
    show();
    await screen.findByText("New custom role");
    const create = screen.getByRole("button", { name: "Create role" });
    expect(create).toBeDisabled(); // a name first
    await userEvent.type(screen.getByLabelText("Name"), "Quiet auditor");
    await userEvent.click(screen.getByLabelText(/Send reminders/));
    await userEvent.click(screen.getByLabelText(/^Comment/));
    await userEvent.click(create);
    await waitFor(() => expect(seen).toEqual([{ name: "Quiet auditor", description: null, baseRole: "auditor", denied: ["remind", "comment"] }]));
    expect(await screen.findByRole("status")).toHaveTextContent('The role "Quiet auditor" was created.');
  });

  it("choosing another base role starts again from everything that role can do", async () => {
    mockRoles([]);
    show();
    await screen.findByText("New custom role");
    await userEvent.click(screen.getByLabelText(/Send reminders/));
    expect(screen.getByLabelText(/Send reminders/)).not.toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText("Based on"), "contributor");
    expect(screen.queryByLabelText(/Send reminders/)).not.toBeInTheDocument(); // a contributor never had it
    expect(screen.getByLabelText(/Upload and submit evidence/)).toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText("Based on"), "auditor");
    expect(screen.getByLabelText(/Send reminders/)).toBeChecked();
  });

  it("shows the server's reason when a role is refused", async () => {
    mockRoles([]);
    server.use(http.post(`${API_BASE}/roles`, () => apiError(409, "DUPLICATE_ROLE_NAME", "A custom role with that name already exists.")));
    show();
    await userEvent.type(await screen.findByLabelText("Name"), "Quiet auditor");
    await userEvent.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A custom role with that name already exists.");
  });

  it("edits a role: the base can't be changed, and changes are saved as what is taken away", async () => {
    mockRoles([JUNIOR]);
    const seen: unknown[] = [];
    server.use(http.patch(`${API_BASE}/roles/r1`, async ({ request }) => { seen.push(await request.json()); return json({ ...JUNIOR, name: "Junior reviewer", denied: ["remind", "comment"] }); }));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Junior auditor" }));
    const form = screen.getByRole("region", { name: "Custom roles" });
    expect(within(form).getByLabelText("Based on", { selector: "#edit-r1-base" })).toBeDisabled();
    expect(within(form).getByLabelText(/Send reminders/, { selector: "#edit-r1-remind" })).not.toBeChecked();
    await userEvent.clear(within(form).getByLabelText("Name", { selector: "#edit-r1-name" }));
    await userEvent.type(within(form).getByLabelText("Name", { selector: "#edit-r1-name" }), "Junior reviewer");
    await userEvent.click(within(form).getByLabelText(/^Comment/, { selector: "#edit-r1-comment" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(seen).toEqual([{ name: "Junior reviewer", description: "Reviews, no reminders", denied: ["remind", "comment"] }]));
    expect(await screen.findByRole("status")).toHaveTextContent("applies to everyone who has it straight away");
  });

  it("deleting asks to confirm, and says why when someone still has the role", async () => {
    mockRoles([JUNIOR, OPEN]);
    let deleted = 0;
    server.use(http.delete(`${API_BASE}/roles/:id`, ({ params }) => {
      if (params.id === "r1") return apiError(409, "ROLE_IN_USE", "2 people have this role. Give those people a different role first.");
      deleted += 1;
      return json({ deleted: true });
    }));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Junior auditor" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("2 people have this role. Give those people a different role first.");

    await userEvent.click(screen.getByRole("button", { name: "Delete Open book" }));
    expect(deleted).toBe(0); // asked first
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(deleted).toBe(1));
    expect(await screen.findByRole("status")).toHaveTextContent('The role "Open book" was deleted.');
  });

  it("someone who is not an organisation admin can read the roles but not change them", async () => {
    mockRoles([JUNIOR]);
    show(AUDITOR_USER);
    expect(await screen.findByText("Junior auditor")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Only an organisation admin can create or change custom roles.");
    expect(screen.queryByRole("button", { name: "Create role" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Junior auditor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Junior auditor" })).not.toBeInTheDocument();
  });
});
