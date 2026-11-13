import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { AuthProvider } from "../auth/AuthProvider";
import { ApiProvider } from "../api/ApiProvider";
import { BuiltInAuthClient } from "../auth/builtInAuthClient";
import { LoginPage } from "./LoginPage";

beforeEach(() => localStorage.clear());

function renderFlow() {
  const authClient = new BuiltInAuthClient(API_BASE);
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider client={authClient}>
        <ApiProvider baseUrl={API_BASE} authClient={authClient}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>HOME</div>} />
          </Routes>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return authClient;
}

const SESSION = { token: "jwt.session", userId: "u1", role: "lead_auditor", tenantId: null };
function wire(verify: (b: { mfaToken: string; code: string }) => Response = () => json(SESSION)) {
  const seen: Array<{ path: string; body: any }> = [];
  server.use(
    http.post(`${API_BASE}/auth/login`, async ({ request }) => { seen.push({ path: "login", body: await request.json() }); return json({ mfaRequired: true, mfaToken: "challenge.1" }); }),
    http.post(`${API_BASE}/auth/mfa/verify`, async ({ request }) => { const b = (await request.json()) as { mfaToken: string; code: string }; seen.push({ path: "verify", body: b }); return verify(b); }),
  );
  return seen;
}

async function passwordStep() {
  await userEvent.type(screen.getByLabelText("Work email"), "priya@harbor.test");
  await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Two-step sign-in" });
}

describe("LoginPage: the second step", () => {
  it("asks for the code after the password, and no longer shows the password", async () => {
    wire();
    renderFlow();
    await passwordStep();
    expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Authentication code")).toHaveFocus();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByText("correct-horse-battery")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
  });

  it("sends the challenge and the (trimmed) code, then lands on the home page signed in", async () => {
    const seen = wire();
    const client = renderFlow();
    await passwordStep();
    await userEvent.type(screen.getByLabelText("Authentication code"), " 123456 ");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    expect(seen.find((s) => s.path === "verify")!.body).toEqual({ mfaToken: "challenge.1", code: "123456" });
    expect(client.getUser()?.userId).toBe("u1");
  });

  it("a wrong code shows the server's message, stays on this step, and can be retried", async () => {
    let n = 0;
    wire(() => (++n === 1 ? apiError(401, "INVALID_CODE", "That code isn't right. Check the latest code in your authenticator app, or use a recovery code.") : json(SESSION)));
    renderFlow();
    await passwordStep();
    await userEvent.type(screen.getByLabelText("Authentication code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't right/);
    expect(screen.getByRole("heading", { name: "Two-step sign-in" })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Authentication code"));
    await userEvent.type(screen.getByLabelText("Authentication code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("a locked account says so, and stays on this step", async () => {
    wire(() => apiError(423, "MFA_LOCKED", "Too many incorrect codes. Two-step sign-in is locked for this account for 15 minutes."));
    renderFlow();
    await passwordStep();
    await userEvent.type(screen.getByLabelText("Authentication code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/locked/);
    expect(screen.getByRole("heading", { name: "Two-step sign-in" })).toBeInTheDocument();
  });

  it("when the sign-in has expired it goes back to the password, with the reason shown, and the email still filled in", async () => {
    wire(() => apiError(401, "INVALID_MFA_TOKEN", "Your sign-in has expired. Please enter your password again."));
    renderFlow();
    await passwordStep();
    await userEvent.type(screen.getByLabelText("Authentication code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/expired/);
    expect(screen.getByLabelText("Work email")).toHaveValue("priya@harbor.test");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("a recovery code can be used instead: the field changes, is cleared, and the typed code is sent as is", async () => {
    const seen = wire();
    renderFlow();
    await passwordStep();
    await userEvent.type(screen.getByLabelText("Authentication code"), "12");
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    const field = screen.getByLabelText("Recovery code");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "XXXX-XXXX-XXXX-XXXX");
    expect(screen.getByText(/works only once/i)).toBeInTheDocument();
    await userEvent.type(field, "abcd-efgh-ijkl-mnop");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    expect(seen.find((s) => s.path === "verify")!.body.code).toBe("abcd-efgh-ijkl-mnop");
  });

  it("and back again to the authenticator code", async () => {
    wire();
    renderFlow();
    await passwordStep();
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    await userEvent.click(screen.getByRole("button", { name: "Use my authenticator app instead" }));
    expect(screen.getByLabelText("Authentication code")).toBeInTheDocument();
  });

  it("Back returns to the password step, forgets the half-finished sign-in, and keeps the email", async () => {
    const seen = wire();
    renderFlow();
    await passwordStep();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toHaveValue("priya@harbor.test");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    // signing in again starts a fresh challenge
    await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Two-step sign-in" });
    expect(seen.filter((s) => s.path === "login")).toHaveLength(2);
    expect(seen.filter((s) => s.path === "verify")).toHaveLength(0);
  });

  it("an error from the code step does not follow the person back to the password step", async () => {
    wire(() => apiError(401, "INVALID_CODE", "That code isn't right."));
    renderFlow();
    await passwordStep();
    await userEvent.type(screen.getByLabelText("Authentication code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't right/);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a wrong password never gets as far as the code step", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => apiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.")));
    renderFlow();
    await userEvent.type(screen.getByLabelText("Work email"), "x@x.test");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(screen.queryByRole("heading", { name: "Two-step sign-in" })).not.toBeInTheDocument();
  });

  it("an ordinary account still goes straight home", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => json(SESSION)));
    renderFlow();
    await userEvent.type(screen.getByLabelText("Work email"), "x@x.test");
    await userEvent.type(screen.getByLabelText("Password"), "a-fine-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("HOME")).toBeInTheDocument());
  });
});
