import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { server, http, HttpResponse, json, apiError, API_BASE } from "../test/mswServer";
import { ApiProvider } from "../api/ApiProvider";
import { FakeAuthClient } from "../auth/types";
import { AuthProvider } from "../auth/AuthProvider";
import { ForgotPasswordPage } from "./ForgotPasswordPage";

function renderPage() {
  const authClient = new FakeAuthClient();
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl={API_BASE} authClient={authClient}>
          <Routes>
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/login" element={<p>login page</p>} />
          </Routes>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const ask = async (address: string) => {
  await userEvent.type(screen.getByLabelText("Work email"), address);
  await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
};

describe("ForgotPasswordPage", () => {
  it("sends the address (trimmed) and then says a link has been emailed, with how long it lasts", async () => {
    let sent: unknown = null;
    server.use(http.post(`${API_BASE}/auth/forgot-password`, async ({ request }) => {
      sent = await request.json();
      return json({ message: "If an account exists…" }, 202);
    }));
    renderPage();
    await ask("  priya@harbor.test  ");

    const status = await screen.findByRole("status");
    expect(sent).toEqual({ email: "priya@harbor.test" });
    expect(status).toHaveTextContent("If an account exists for priya@harbor.test");
    expect(status).toHaveTextContent("expires in 1 hour");
    expect(screen.queryByLabelText("Work email")).not.toBeInTheDocument(); // the form is gone: one ask at a time
  });

  it("never claims the address has an account — the wording is conditional either way", async () => {
    server.use(http.post(`${API_BASE}/auth/forgot-password`, () => json({ message: "If an account exists…" }, 202)));
    renderPage();
    await ask("nobody@nowhere.test");
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/if an account exists/i);
    expect(status.textContent).not.toMatch(/we('|’)ve sent you|account found|no account/i);
  });

  it("points people who were invited but never set a password at their administrator", async () => {
    server.use(http.post(`${API_BASE}/auth/forgot-password`, () => json({ message: "x" }, 202)));
    renderPage();
    await ask("new.person@firm.test");
    expect(await screen.findByText(/ask your administrator to resend your invite/i)).toBeInTheDocument();
  });

  it("shows the server's message when asked too often, and keeps the form so they can try later", async () => {
    server.use(http.post(`${API_BASE}/auth/forgot-password`, () => apiError(429, "RATE_LIMITED", "Too many requests. Please wait a few minutes and try again.")));
    renderPage();
    await ask("priya@harbor.test");
    expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toHaveValue("priya@harbor.test");
  });

  it("explains a failure to reach the server rather than failing silently", async () => {
    server.use(http.post(`${API_BASE}/auth/forgot-password`, () => HttpResponse.error()));
    renderPage();
    await ask("priya@harbor.test");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  it("the button stays disabled until there is an address, and offers a way back to sign in", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.test");
    expect(screen.getByRole("button", { name: "Send reset link" })).not.toBeDisabled();
    await userEvent.click(screen.getByRole("link", { name: "Back to sign in" }));
    await waitFor(() => expect(screen.getByText("login page")).toBeInTheDocument());
  });
});
