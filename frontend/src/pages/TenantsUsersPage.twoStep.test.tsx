import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { TenantsUsersPage } from "./TenantsUsersPage";

beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });

const user = (id: string, email: string, extra: object = {}) => ({ id, email, fullName: null, role: "auditor", status: "active", ...extra });

describe("TenantsUsersPage: two-step sign-in column (organisation admins)", () => {
  it("shows who has it on and off — only when the server tells it (an admin's view)", async () => {
    server.use(http.get(`${API_BASE}/users`, () => json([user("u1", "on@harbor.test", { mfaEnabled: true }), user("u2", "off@harbor.test", { mfaEnabled: false })])));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByText(/on@harbor.test/);
    expect(screen.getAllByText("Two-step on")).toHaveLength(1);
    expect(screen.getAllByText("Two-step off")).toHaveLength(1);
  });

  it("shows nothing about it to anyone the server doesn't tell", async () => {
    server.use(http.get(`${API_BASE}/users`, () => json([user("u1", "a@harbor.test"), user("u2", "b@harbor.test")])));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByText(/a@harbor.test/);
    expect(screen.queryByText(/Two-step/)).not.toBeInTheDocument();
    expect(screen.queryByText("Reset two-step")).not.toBeInTheDocument();
  });

  it("offers Reset only for people who have it on", async () => {
    server.use(http.get(`${API_BASE}/users`, () => json([user("u1", "on@harbor.test", { mfaEnabled: true }), user("u2", "off@harbor.test", { mfaEnabled: false })])));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByText(/on@harbor.test/);
    expect(screen.getAllByText("Reset two-step")).toHaveLength(1);
  });

  it("never offers it for yourself", async () => {
    server.use(http.get(`${API_BASE}/users`, () => json([user(AUDITOR_USER.userId, "priya@harbor.test", { mfaEnabled: true }), user("u2", "other@harbor.test", { mfaEnabled: true })])));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await screen.findByText(/priya@harbor.test/);
    expect(screen.getAllByText("Reset two-step")).toHaveLength(1); // just the other person's
  });

  it("needs a second click to confirm, then resets, refreshes the list and says what happened", async () => {
    let enabled = true;
    server.use(http.get(`${API_BASE}/users`, () => json([user("u1", "lost-phone@harbor.test", { mfaEnabled: enabled })])));
    let resets = 0;
    server.use(http.post(`${API_BASE}/users/u1/reset-mfa`, () => { resets++; enabled = false; return json({ reset: true }); }));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Reset two-step"));
    expect(resets).toBe(0); // one click only asks
    await userEvent.click(screen.getByText("Confirm reset"));
    expect(await screen.findByText(/reset for lost-phone@harbor.test/)).toHaveTextContent(/signed out everywhere/);
    expect(resets).toBe(1);
    await waitFor(() => expect(screen.getByText("Two-step off")).toBeInTheDocument());
    expect(screen.queryByText("Confirm reset")).not.toBeInTheDocument();
  });

  it("Cancel backs out without calling the server", async () => {
    server.use(http.get(`${API_BASE}/users`, () => json([user("u1", "x@harbor.test", { mfaEnabled: true })])));
    let called = false;
    server.use(http.post(`${API_BASE}/users/u1/reset-mfa`, () => { called = true; return json({ reset: true }); }));
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Reset two-step"));
    await userEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Reset two-step")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("shows an error if the reset fails, and leaves things as they were", async () => {
    server.use(
      http.get(`${API_BASE}/users`, () => json([user("u1", "x@harbor.test", { mfaEnabled: true })])),
      http.post(`${API_BASE}/users/u1/reset-mfa`, () => apiError(403, "FORBIDDEN_ROLE", "Only an organisation admin can reset someone else's two-step sign-in.")),
    );
    renderApp(<TenantsUsersPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Reset two-step"));
    await userEvent.click(screen.getByText("Confirm reset"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reset two-step sign-in for that user.");
    expect(screen.getByText("Two-step on")).toBeInTheDocument();
  });
});
