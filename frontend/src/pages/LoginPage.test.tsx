import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { AuthProvider } from "../auth/AuthProvider";
import { ApiProvider } from "../api/ApiProvider";
import { BuiltInAuthClient } from "../auth/builtInAuthClient";
import { LoginPage } from "./LoginPage";

function renderLogin() {
  const authClient = new BuiltInAuthClient(API_BASE);
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl={API_BASE} authClient={authClient}>
          <LoginPage />
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  it("shows the real backend message for the wrong password, not a generic one", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => apiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.")));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Work email"), "x@x.test");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Incorrect email or password.")).toBeInTheDocument();
  });

  it("shows a locked-account message distinctly from a wrong-password one", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => apiError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Please try again in a few minutes.")));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Work email"), "x@x.test");
    await userEvent.type(screen.getByLabelText("Password"), "whatever");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many failed attempts/)).toBeInTheDocument();
  });

  it("the submit button is disabled until both fields have something in them", async () => {
    renderLogin();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Work email"), "x@x.test");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Password"), "a-password");
    expect(screen.getByRole("button", { name: "Sign in" })).not.toBeDisabled();
  });

  it("shows the accepted-invite success message when arriving from accept-invite", async () => {
    const authClient = new BuiltInAuthClient(API_BASE);
    render(
      <MemoryRouter initialEntries={["/login?accepted=1"]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl={API_BASE} authClient={authClient}><LoginPage /></ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Password set. Sign in below.")).toBeInTheDocument();
  });

  it("a successful login clears any previous error and does not show one", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => json({ token: "jwt.ok", userId: "u1", role: "auditor", tenantId: null })));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Work email"), "x@x.test");
    await userEvent.type(screen.getByLabelText("Password"), "a-correct-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByText(/Incorrect|Too many/)).not.toBeInTheDocument());
  });
});

describe("LoginPage: forgotten passwords", () => {
  it("links to the reset page from beside the password field", () => {
    renderLogin();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
  });

  it("confirms a finished reset when sent back here with ?reset=1", () => {
    const authClient = new BuiltInAuthClient(API_BASE);
    render(
      <MemoryRouter initialEntries={["/login?reset=1"]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl={API_BASE} authClient={authClient}><LoginPage /></ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Password changed. Sign in with your new password.")).toBeInTheDocument();
  });

  it("shows no such note on an ordinary visit", () => {
    renderLogin();
    expect(screen.queryByText(/Password changed/)).not.toBeInTheDocument();
  });
});
