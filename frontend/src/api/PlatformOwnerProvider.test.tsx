import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import type { AuthUser } from "../auth/types";
import { AppShell } from "../components/AppShell";

const ADMIN: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "admin@harbor.test", name: "Alex Admin", role: "org_admin" };

/** Counts how often the app asks whether the signed-in person is the owner of the installation. */
function ownerEndpoint(reply: () => Response | Promise<Response>) {
  const state = { asked: 0 };
  server.use(http.get(`${API_BASE}/platform/owner`, () => { state.asked++; return reply(); }));
  return state;
}

describe("the Server settings menu item", () => {
  beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });

  it("is shown to the owner of the installation", async () => {
    ownerEndpoint(() => json({ owner: true }));
    renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    expect(await screen.findByRole("link", { name: "Server settings" })).toHaveAttribute("href", "/settings/server");
  });

  it("is not shown to an organisation admin who isn't the owner", async () => {
    const asked = ownerEndpoint(() => json({ owner: false }));
    renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    await waitFor(() => expect(asked.asked).toBe(1));
    expect(screen.queryByRole("link", { name: "Server settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Integrations" })).toBeInTheDocument(); // the rest of the menu is unaffected
  });

  it("isn't shown while the answer is still on its way", () => {
    ownerEndpoint(() => new Promise<Response>(() => undefined));
    renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    expect(screen.queryByRole("link", { name: "Server settings" })).not.toBeInTheDocument();
  });

  it("is hidden, quietly, if the answer can't be had", async () => {
    const asked = ownerEndpoint(() => apiError(500, "INTERNAL", "Something broke."));
    renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    await waitFor(() => expect(asked.asked).toBe(1));
    expect(screen.queryByRole("link", { name: "Server settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is never even asked about for people who can't be the owner (only organisation admins can)", async () => {
    const asked = ownerEndpoint(() => json({ owner: true }));
    for (const who of [AUDITOR_USER, TENANT_USER]) {
      const r = renderApp(<AppShell>x</AppShell>, { user: who });
      // Give a (wrongly) made request time to reach the server before looking at the count.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(asked.asked).toBe(0);
      expect(screen.queryByRole("link", { name: "Server settings" })).not.toBeInTheDocument();
      r.unmount();
    }
  });

  it("an answer about one person is never used for the next person who signs in", async () => {
    let calls = 0;
    server.use(http.get(`${API_BASE}/platform/owner`, () => (++calls === 1 ? json({ owner: true }) : new Promise<Response>(() => undefined))));
    const { authClient } = renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    await screen.findByRole("link", { name: "Server settings" });
    const other: AuthUser = { userId: "44444444-4444-4444-4444-444444444444", email: "other@harbor.test", name: "Other Admin", role: "org_admin" };
    authClient.registerUser(other);
    await authClient.login(other.email);
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.queryByRole("link", { name: "Server settings" })).not.toBeInTheDocument(); // not the first person's "yes"
  });

  it("does not follow the person to someone else's session", async () => {
    ownerEndpoint(() => json({ owner: true }));
    const { authClient } = renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    await screen.findByRole("link", { name: "Server settings" });
    authClient.logout();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Server settings" })).not.toBeInTheDocument());
  });
});
