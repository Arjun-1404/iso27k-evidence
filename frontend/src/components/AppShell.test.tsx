import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import type { AuthUser } from "../auth/types";
import { AppShell } from "./AppShell";

const ADMIN: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "admin@harbor.test", name: "Alex Admin", role: "org_admin" };

describe("AppShell navigation", () => {
  // The app-wide TenantProvider loads the tenant list for any auditor-side user.
  beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });

  it("shows Integrations to an org admin", () => {
    renderApp(<AppShell>x</AppShell>, { user: ADMIN });
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute("href", "/settings/integrations");
  });

  it("hides Integrations from other auditor-side roles and from tenant users", () => {
    const a = renderApp(<AppShell>x</AppShell>, { user: AUDITOR_USER });
    expect(screen.queryByRole("link", { name: "Integrations" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tenants" })).toBeInTheDocument(); // the rest of the nav is unchanged
    a.unmount();
    renderApp(<AppShell>x</AppShell>, { user: TENANT_USER });
    expect(screen.queryByRole("link", { name: "Integrations" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My controls" })).toBeInTheDocument();
  });
});

describe("AppShell navigation: Security", () => {
  beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });

  it("everyone can reach their own security settings, whichever side they are on", () => {
    for (const who of [AUDITOR_USER, ADMIN, TENANT_USER]) {
      const r = renderApp(<AppShell>x</AppShell>, { user: who });
      expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("href", "/settings/security");
      r.unmount();
    }
  });
});

// On a phone the menu hides behind a button (the CSS does the hiding; what can be tested here is the button's state and
// that the menu closes once a page is chosen, so it never sits over the page that was just opened).
describe("AppShell on a small screen", () => {
  beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });

  it("opens with the Menu button and closes with its own close button", async () => {
    renderApp(<AppShell>x</AppShell>, { user: AUDITOR_USER });
    const menu = screen.getByRole("button", { name: "Open menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveAttribute("aria-controls", "app-sidebar");
    expect(document.getElementById("app-sidebar")).toHaveClass("hidden");
    await userEvent.click(menu);
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("app-sidebar")).toHaveClass("fixed");
    await userEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("app-sidebar")).not.toHaveClass("fixed");
  });

  it("closes when a page is chosen from it", async () => {
    renderApp(<AppShell>x</AppShell>, { user: AUDITOR_USER });
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.click(screen.getByRole("link", { name: "Controls" }));
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when the dimmed page behind it is tapped", async () => {
    const { container } = renderApp(<AppShell>x</AppShell>, { user: AUDITOR_USER });
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.click(container.querySelector("[aria-hidden=true].fixed")!);
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("still has Sign out and every link for the person's role, however the menu is shown", () => {
    renderApp(<AppShell>x</AppShell>, { user: TENANT_USER });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["My controls", "Dashboard", "Security"]);
  });
});
