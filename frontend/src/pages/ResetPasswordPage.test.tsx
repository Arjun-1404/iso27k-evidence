import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { server, http, HttpResponse, json, apiError, API_BASE } from "../test/mswServer";
import { ApiProvider } from "../api/ApiProvider";
import { FakeAuthClient } from "../auth/types";
import { AuthProvider } from "../auth/AuthProvider";
import { ResetPasswordPage } from "./ResetPasswordPage";
import { LoginPage } from "./LoginPage";

const TOKEN = "a".repeat(64);

/** Shows where the router currently is, so tests can see what the page does to the address bar. */
function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname + l.search}</output>; }

function renderAt(path: string) {
  const authClient = new FakeAuthClient();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl={API_BASE} authClient={authClient}>
          <Where />
          <Routes>
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/forgot-password" element={<p>forgot page</p>} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const fill = async (pw: string, confirm = pw) => {
  await userEvent.type(screen.getByLabelText("New password"), pw);
  await userEvent.type(screen.getByLabelText("Confirm password"), confirm);
  await userEvent.click(screen.getByRole("button", { name: "Save new password" }));
};

describe("ResetPasswordPage", () => {
  it("sends the link's secret with the new password, then lands on sign-in with a success note", async () => {
    let sent: unknown = null;
    server.use(http.post(`${API_BASE}/auth/reset-password`, async ({ request }) => { sent = await request.json(); return json({ ok: true }); }));
    renderAt(`/reset-password?token=${TOKEN}`);
    await fill("a-brand-new-password-1");

    await waitFor(() => expect(sent).toEqual({ token: TOKEN, password: "a-brand-new-password-1" }));
    expect(await screen.findByText("Password changed. Sign in with your new password.")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/login?reset=1");
  });

  it("takes the secret out of the address bar as soon as the page has it", async () => {
    renderAt(`/reset-password?token=${TOKEN}`);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/reset-password$/));
    expect(screen.getByTestId("where").textContent).not.toContain(TOKEN);
    expect(screen.getByLabelText("New password")).toBeInTheDocument(); // ...and the form still works
  });

  it("still submits the secret after it was removed from the address bar", async () => {
    let sent: { token?: string } | null = null;
    server.use(http.post(`${API_BASE}/auth/reset-password`, async ({ request }) => { sent = await request.json() as { token?: string }; return json({ ok: true }); }));
    renderAt(`/reset-password?token=${TOKEN}`);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/reset-password$/));
    await fill("a-brand-new-password-1");
    await waitFor(() => expect(sent?.token).toBe(TOKEN));
  });

  it("catches mismatched and too-short passwords before calling the server", async () => {
    let called = 0;
    server.use(http.post(`${API_BASE}/auth/reset-password`, () => { called++; return json({ ok: true }); }));
    renderAt(`/reset-password?token=${TOKEN}`);
    await fill("a-brand-new-password-1", "a-different-password-2");
    expect(await screen.findByText("Those passwords don't match.")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("New password")); await userEvent.clear(screen.getByLabelText("Confirm password"));
    await fill("short");
    expect(await screen.findByText("Password must be at least 12 characters.")).toBeInTheDocument();
    expect(called).toBe(0);
  });

  it("shows the server's reason when it rejects the password, and lets them try another with the same link", async () => {
    let attempts = 0;
    server.use(http.post(`${API_BASE}/auth/reset-password`, () => {
      attempts++;
      return attempts === 1 ? apiError(422, "WEAK_PASSWORD", "That password is too common. Please choose another.") : json({ ok: true });
    }));
    renderAt(`/reset-password?token=${TOKEN}`);
    await fill("letmein12345");
    expect(await screen.findByText("That password is too common. Please choose another.")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("New password")); await userEvent.clear(screen.getByLabelText("Confirm password"));
    await fill("a-genuinely-better-password");
    await screen.findByText("Password changed. Sign in with your new password.");
  });

  it("an expired or already-used link gets a clear dead end with a way to ask for a new one", async () => {
    server.use(http.post(`${API_BASE}/auth/reset-password`, () => apiError(400, "INVALID_RESET", "This reset link is invalid or has expired. Request a new one.")));
    renderAt(`/reset-password?token=${TOKEN}`);
    await fill("a-brand-new-password-1");

    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or was already used/i);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Request a new link" }));
    expect(await screen.findByText("forgot page")).toBeInTheDocument();
  });

  it("opened with no link at all, there is nothing to fill in — only a way to get a link", async () => {
    renderAt("/reset-password");
    expect(screen.getByRole("alert")).toHaveTextContent(/open the link from your reset email/i);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toBeInTheDocument();
  });

  it("explains a failure to reach the server", async () => {
    server.use(http.post(`${API_BASE}/auth/reset-password`, () => HttpResponse.error()));
    renderAt(`/reset-password?token=${TOKEN}`);
    await fill("a-brand-new-password-1");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });
});
