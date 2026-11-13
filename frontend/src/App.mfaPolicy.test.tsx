import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { server, http, json, apiError, API_BASE } from "./test/mswServer";
import { AuthProvider } from "./auth/AuthProvider";
import { ApiProvider } from "./api/ApiProvider";
import { TenantProvider } from "./api/TenantProvider";
import { FakeAuthClient } from "./auth/types";
import App from "./App";

const PRIYA = { userId: "11111111-1111-1111-1111-111111111111", email: "priya@harbor.test", name: "Priya Nair", role: "lead_auditor" };
const MARCO = { userId: "44444444-4444-4444-4444-444444444444", email: "marco@harbor.test", name: "Marco Rossi", role: "auditor" };
const REQUIRED = { enabled: false, recoveryRemaining: 0, available: true, required: true };
const URI = "otpauth://totp/Evidence%20Portal:priya%40harbor.test?secret=JBSWY3DPEHPK3PXP&issuer=Evidence%20Portal&algorithm=SHA1&digits=6&period=30";

async function open(route = "/dashboard") {
  const authClient = new FakeAuthClient();
  authClient.registerUser(PRIYA);
  authClient.registerUser(MARCO);
  await authClient.login(PRIYA.email);
  render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl={API_BASE} authClient={authClient}>
          <TenantProvider><App /></TenantProvider>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return authClient;
}

/** The server as it behaves for someone the organisation's policy covers who hasn't set two-step sign-in up. */
function refuseEverythingButSetUp() {
  server.use(http.get(`${API_BASE}/tenants`, () => apiError(403, "MFA_SETUP_REQUIRED", "Your organisation requires two-step sign-in.")));
}
const statuses = (...bodies: object[]) => {
  let i = 0;
  server.use(http.get(`${API_BASE}/auth/mfa`, () => json(bodies[Math.min(i++, bodies.length - 1)])));
};

beforeEach(() => localStorage.clear());

describe("when the organisation requires two-step sign-in and you haven't set it up", () => {
  it("the first refused request sends you to Security settings, with an explanation", async () => {
    refuseEverythingButSetUp(); statuses(REQUIRED);
    await open("/dashboard");
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(await screen.findByText(/Your organisation requires two-step sign-in\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
  });

  it("the rest of the menu is out of the way until it's done", async () => {
    refuseEverythingButSetUp(); statuses(REQUIRED);
    await open("/controls");
    await screen.findByText(/Your organisation requires two-step sign-in\./);
    expect(screen.getByRole("link", { name: "Security" })).toBeInTheDocument();
    for (const gone of ["Dashboard", "Tenants", "Controls", "Audit log", "Users"]) expect(screen.queryByRole("link", { name: gone })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument(); // you can always leave
  });

  it("setting it up gives the menu back straight away, and no more sending you back", async () => {
    refuseEverythingButSetUp();
    statuses(REQUIRED, { ...REQUIRED, enabled: true, recoveryRemaining: 10 });
    server.use(
      http.post(`${API_BASE}/auth/mfa/enroll`, () => json({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: URI })),
      http.post(`${API_BASE}/auth/mfa/enroll/confirm`, () => json({ recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] })),
    );
    await open("/dashboard");
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(await screen.findByLabelText(/6-digit code the app shows/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByText(/Save your recovery codes/);
    // confirmed: the server has stopped refusing, so the app stops steering
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Tenants" })).toBeInTheDocument();
  });

  it("if the organisation has since switched the rule off, the page notices and lets you go", async () => {
    refuseEverythingButSetUp();
    statuses({ ...REQUIRED, required: false });
    await open("/dashboard");
    await screen.findByRole("heading", { name: "Security" });
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument());
    expect(screen.queryByText(/Your organisation requires two-step sign-in\./)).not.toBeInTheDocument();
  });

  it("signing out clears it: the next person to sign in isn't steered anywhere", async () => {
    refuseEverythingButSetUp(); statuses(REQUIRED);
    const auth = await open("/dashboard");
    await screen.findByText(/Your organisation requires two-step sign-in\./);

    server.use(http.get(`${API_BASE}/tenants`, () => json([])));
    auth.logout();
    await screen.findByRole("heading", { name: "Sign in" });
    await userEvent.type(screen.getByLabelText("Work email"), MARCO.email);
    await userEvent.type(screen.getByLabelText("Password"), "whatever-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("link", { name: "Tenants" })).toBeInTheDocument();
  });
});

describe("for everyone else", () => {
  it("nothing is steered anywhere", async () => {
    server.use(http.get(`${API_BASE}/tenants`, () => json([])));
    await open("/dashboard");
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
  });

  it("another kind of refusal doesn't trigger it", async () => {
    server.use(http.get(`${API_BASE}/tenants`, () => apiError(403, "FORBIDDEN_ROLE", "You don't have access to do that.")));
    await open("/dashboard");
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByText(/Your organisation requires two-step sign-in\./)).not.toBeInTheDocument();
  });
});
