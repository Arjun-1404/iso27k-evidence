import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { ApiProvider } from "../api/ApiProvider";
import { FakeAuthClient } from "../auth/types";
import { AcceptInvitePage } from "./AcceptInvitePage";
import { LoginPage } from "./LoginPage";
import { AuthProvider } from "../auth/AuthProvider";

function renderAt(path: string) {
  const authClient = new FakeAuthClient();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl={API_BASE} authClient={authClient}>
          <Routes>
            <Route path="/accept-invite" element={<AcceptInvitePage />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("AcceptInvitePage", () => {
  it("pre-fills the invite code from the URL and submits it with the new password", async () => {
    let sentBody: unknown = null;
    server.use(http.post(`${API_BASE}/auth/accept-invite`, async ({ request }) => {
      sentBody = await request.json();
      return json({ token: "jwt.new", userId: "u9" });
    }));
    renderAt("/accept-invite?token=abc123def456");

    expect(screen.getByLabelText("Invite code")).toHaveValue("abc123def456");
    await userEvent.type(screen.getByLabelText("New password"), "a-strong-password-1");
    await userEvent.type(screen.getByLabelText("Confirm password"), "a-strong-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(sentBody).toEqual({ token: "abc123def456", password: "a-strong-password-1" }));
    // redirects to login with a success message
    await screen.findByText("Password set. Sign in below.");
  });

  it("catches mismatched passwords client-side, before calling the backend at all", async () => {
    let called = false;
    server.use(http.post(`${API_BASE}/auth/accept-invite`, () => { called = true; return json({ token: "x", userId: "u9" }); }));
    renderAt("/accept-invite?token=abc123");
    await userEvent.type(screen.getByLabelText("New password"), "a-strong-password-1");
    await userEvent.type(screen.getByLabelText("Confirm password"), "a-different-password-2");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("Those passwords don't match.")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("shows the backend's real message for an invalid or expired invite", async () => {
    server.use(http.post(`${API_BASE}/auth/accept-invite`, () => apiError(400, "INVALID_INVITE", "This invite link is invalid or has expired. Ask your administrator to resend it.")));
    renderAt("/accept-invite?token=expired-token");
    await userEvent.type(screen.getByLabelText("New password"), "a-strong-password-1");
    await userEvent.type(screen.getByLabelText("Confirm password"), "a-strong-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText(/This invite link is invalid or has expired/)).toBeInTheDocument();
  });

  it("allows manually entering an invite code when there's no token in the URL", async () => {
    renderAt("/accept-invite");
    expect(screen.getByLabelText("Invite code")).toHaveValue("");
    await userEvent.type(screen.getByLabelText("Invite code"), "typed-in-manually");
    expect(screen.getByLabelText("Invite code")).toHaveValue("typed-in-manually");
  });
});
