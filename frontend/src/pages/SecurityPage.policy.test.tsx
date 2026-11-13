import { describe, it, expect, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import type { AuthUser } from "../auth/types";
import { SecurityPage } from "./SecurityPage";

const ADMIN: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "admin@harbor.test", name: "Alex Admin", role: "org_admin" };
const OFF = { enabled: false, recoveryRemaining: 0, available: true, required: false };
const ON = { enabled: true, recoveryRemaining: 10, available: true, required: false };
const policy = (over: object = {}) => ({ policy: "off", available: true, staff: { total: 4, enrolled: 1 }, everyone: { total: 9, enrolled: 3 }, ...over });

beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });
const status = (body: object) => server.use(http.get(`${API_BASE}/auth/mfa`, () => json(body)));
const serve = (body: object) => {
  let reads = 0;
  server.use(http.get(`${API_BASE}/org/mfa-policy`, () => { reads++; return json(body); }));
  return () => reads;
};
const card = async () => within(await screen.findByRole("region", { name: "Organisation policy" }));

describe("SecurityPage: when the organisation requires two-step sign-in", () => {
  it("someone it covers who hasn't set it up is told, and is offered the set-up", async () => {
    status({ ...OFF, required: true });
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your organisation requires two-step sign-in.");
    expect(screen.getByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
  });

  it("someone who has it on is told it's required, and can't turn it off — but can still get new codes", async () => {
    status({ ...ON, required: true });
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByText("Required by your organisation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off two-step sign-in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get new recovery codes" })).toBeInTheDocument();
    expect(screen.getByText(/an organisation admin can reset it/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("when it isn't required, nothing changes: turning it off is there, and there's no banner", async () => {
    status(ON);
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByRole("button", { name: "Turn off two-step sign-in" })).toBeInTheDocument();
    expect(screen.queryByText("Required by your organisation")).not.toBeInTheDocument();
  });
});

describe("SecurityPage: the organisation policy (organisation admins)", () => {
  it("is for organisation admins only — nobody else is even asked", async () => {
    status(ON);
    const reads = serve(policy());
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await screen.findByRole("button", { name: "Turn off two-step sign-in" });
    expect(screen.queryByRole("region", { name: "Organisation policy" })).not.toBeInTheDocument();
    expect(reads()).toBe(0);
  });

  it("is not asked for (and not shown) while the admin themselves still has to set two-step sign-in up", async () => {
    status({ ...OFF, required: true });
    const reads = serve(policy());
    renderApp(<SecurityPage />, { user: ADMIN });
    await screen.findByText(/Your organisation requires/);
    expect(screen.queryByRole("region", { name: "Organisation policy" })).not.toBeInTheDocument();
    expect(reads()).toBe(0);
  });

  it("shows the current setting and how far along people are", async () => {
    status(ON); serve(policy({ policy: "staff" }));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    expect(await c.findByRole("radio", { name: /^Staff only/ })).toBeChecked();
    expect(c.getByRole("radio", { name: /^Off/ })).not.toBeChecked();
    expect(c.getByText("1 of 4 people have set it up")).toBeInTheDocument();
    expect(c.getByText("3 of 9 people have set it up")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Save policy" })).toBeDisabled(); // nothing changed yet
  });

  it("says 'person has' for one", async () => {
    status(ON); serve(policy({ staff: { total: 1, enrolled: 1 } }));
    renderApp(<SecurityPage />, { user: ADMIN });
    expect(await (await card()).findByText("1 of 1 person has set it up")).toBeInTheDocument();
  });

  it("changes it: warns what will happen first, sends only the choice, and shows the new state", async () => {
    status(ON); serve(policy());
    const sent: unknown[] = [];
    server.use(http.put(`${API_BASE}/org/mfa-policy`, async ({ request }) => {
      sent.push(await request.json());
      return json(policy({ policy: "everyone", everyone: { total: 9, enrolled: 4 } }));
    }));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    await userEvent.click(await c.findByRole("radio", { name: /^Everyone/ }));
    expect(c.getByText(/can't do anything else until they have/)).toBeInTheDocument();
    expect(c.getByText(/at least two organisation admins/)).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Save policy" }));
    expect(await c.findByText("Policy saved.")).toBeInTheDocument();
    expect(sent).toEqual([{ policy: "everyone" }]);
    expect(c.getByRole("radio", { name: /^Everyone/ })).toBeChecked();
    expect(c.getByText("4 of 9 people have set it up")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Save policy" })).toBeDisabled();
    expect(c.queryByText(/can't do anything else until they have/)).not.toBeInTheDocument();
  });

  it("switching it off needs no warning and says so", async () => {
    status(ON); serve(policy({ policy: "staff" }));
    server.use(http.put(`${API_BASE}/org/mfa-policy`, () => json(policy({ policy: "off" }))));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    await userEvent.click(await c.findByRole("radio", { name: /^Off/ }));
    expect(c.queryByText(/can't do anything else until they have/)).not.toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Save policy" }));
    expect(await c.findByText("Two-step sign-in is no longer required.")).toBeInTheDocument();
  });

  it("shows the server's reason if it is refused, and keeps the choice", async () => {
    status(ON); serve(policy());
    server.use(http.put(`${API_BASE}/org/mfa-policy`, () => apiError(409, "MFA_ADMIN_NEEDS_MFA", "Turn on two-step sign-in for your own account first.")));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    await userEvent.click(await c.findByRole("radio", { name: /^Staff only/ }));
    await userEvent.click(c.getByRole("button", { name: "Save policy" }));
    expect(await c.findByRole("alert")).toHaveTextContent("Turn on two-step sign-in for your own account first.");
    expect(c.getByRole("radio", { name: /^Staff only/ })).toBeChecked();
    expect(c.queryByText("Policy saved.")).not.toBeInTheDocument();
  });

  it("an admin who hasn't turned it on for themselves can't pick 'staff' or 'everyone' — and is told why", async () => {
    status(OFF); serve(policy());
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    expect(await c.findByRole("radio", { name: /^Staff only/ })).toBeDisabled();
    expect(c.getByRole("radio", { name: /^Everyone/ })).toBeDisabled();
    expect(c.getByRole("radio", { name: /^Off/ })).toBeEnabled();
    expect(c.getByText(/Turn on two-step sign-in for your own account first/)).toBeInTheDocument();
  });

  it("when the server can't do two-step sign-in it can't be required — and says why", async () => {
    status({ ...ON, available: false }); serve(policy({ available: false }));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    expect(await c.findByRole("radio", { name: /^Staff only/ })).toBeDisabled();
    expect(c.getByText(/SECRET_ENCRYPTION_KEY/)).toBeInTheDocument();
  });

  it("a setting that is already on stays selectable and switch-off-able even if the server has since lost its key", async () => {
    status({ ...ON, available: false }); serve(policy({ policy: "staff", available: false }));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    expect(await c.findByRole("radio", { name: /^Staff only/ })).toBeEnabled();
    expect(c.getByRole("radio", { name: /^Off/ })).toBeEnabled();
  });

  it("says so if the policy can't be loaded", async () => {
    status(ON);
    server.use(http.get(`${API_BASE}/org/mfa-policy`, () => apiError(403, "FORBIDDEN_ROLE", "Only an organisation admin can see or change the two-step sign-in policy.")));
    renderApp(<SecurityPage />, { user: ADMIN });
    const c = await card();
    expect(await c.findByRole("alert")).toHaveTextContent("Only an organisation admin");
    expect(c.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
  });
});
