import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { server, http, json, apiError, API_BASE } from "./test/mswServer";
import { AuthProvider } from "./auth/AuthProvider";
import { ApiProvider } from "./api/ApiProvider";
import { TenantProvider } from "./api/TenantProvider";
import { FakeAuthClient } from "./auth/types";
import App from "./App";

function renderAtLogin() {
  const authClient = new FakeAuthClient();
  authClient.registerUser({ userId: "u1", email: "priya@harbor.test", name: "Priya Nair", role: "lead_auditor" });
  authClient.registerUser({ userId: "u2", email: "sam@brightpath.test", name: "Sam Okafor", role: "contributor", tenantId: "t1" });
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl="http://test-api.local" authClient={authClient}>
          <TenantProvider><App /></TenantProvider>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("App routing", () => {
  it("an unauthenticated visit to a protected route redirects to login", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider client={new FakeAuthClient()}>
          <ApiProvider baseUrl="http://test-api.local" authClient={new FakeAuthClient()}>
            <TenantProvider><App /></TenantProvider>
          </ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("an auditor-side login lands on the dashboard", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
    );
    renderAtLogin();
    await userEvent.type(screen.getByLabelText("Work email"), "priya@harbor.test");
    await userEvent.type(screen.getByLabelText("Password"), "whatever-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page"));
  });

  it("a tenant-side login lands on My controls, not the auditor dashboard", async () => {
    server.use(
      http.get(`${API_BASE}/tenants/t1/audits`, () => json([])),
      http.get(`${API_BASE}/templates`, () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "You don't have access to do that." } }), { status: 403 })),
    );
    renderAtLogin();
    await userEvent.type(screen.getByLabelText("Work email"), "sam@brightpath.test");
    await userEvent.type(screen.getByLabelText("Password"), "whatever-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "My controls" })).toHaveAttribute("aria-current", "page"));
  });

  it("the password-reset pages are reachable while signed out (they are the way back in)", async () => {
    const authClient = new FakeAuthClient();
    const open = (path: string) => render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl="http://test-api.local" authClient={authClient}>
            <TenantProvider><App /></TenantProvider>
          </ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const first = open("/forgot-password");
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    first.unmount();
    open(`/reset-password?token=${"b".repeat(64)}`);
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
  });

  it("when the server stops accepting a signed-in session (e.g. the password was reset elsewhere), the person is sent to sign in", async () => {
    server.use(http.all(`${API_BASE}/*`, () => apiError(401, "UNAUTHENTICATED", "Invalid or expired session.")));
    const authClient = new FakeAuthClient();
    authClient.registerUser({ userId: "u1", email: "priya@harbor.test", name: "Priya Nair", role: "lead_auditor" });
    await authClient.login("priya@harbor.test");
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl={API_BASE} authClient={authClient}>
            <TenantProvider><App /></TenantProvider>
          </ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(authClient.getUser()).toBeNull();
  });
});

describe("App routing: security settings", () => {
  it("a signed-in person can open /settings/security", async () => {
    server.use(
      http.get("http://test-api.local/tenants", () => json([])),
      http.get("http://test-api.local/auth/mfa", () => json({ enabled: false, recoveryRemaining: 0, available: true })),
    );
    const authClient = new FakeAuthClient();
    authClient.registerUser({ userId: "u1", email: "priya@harbor.test", name: "Priya Nair", role: "lead_auditor" });
    await authClient.login("priya@harbor.test");
    render(
      <MemoryRouter initialEntries={["/settings/security"]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl="http://test-api.local" authClient={authClient}>
            <TenantProvider><App /></TenantProvider>
          </ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
  });

  it("a signed-out visitor is sent to sign in instead", async () => {
    const authClient = new FakeAuthClient();
    render(
      <MemoryRouter initialEntries={["/settings/security"]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl="http://test-api.local" authClient={authClient}>
            <TenantProvider><App /></TenantProvider>
          </ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
