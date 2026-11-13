import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import { SecurityPage } from "./SecurityPage";

const OFF = { enabled: false, recoveryRemaining: 0, available: true, required: false };
const ON = { enabled: true, recoveryRemaining: 10, available: true, required: false };
const FRESH = { token: "jwt.fresh", userId: AUDITOR_USER.userId, role: "lead_auditor", tenantId: null };

beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });
const status = (body: object) => server.use(http.get(`${API_BASE}/auth/mfa`, () => json(body)));

/** Records what the page sends to the change-password endpoint. */
function endpoint(reply: () => Response | Promise<Response> = () => json(FRESH)) {
  const sent: unknown[] = [];
  server.use(http.post(`${API_BASE}/auth/change-password`, async ({ request }) => { sent.push(await request.json()); return reply(); }));
  return sent;
}
const fill = async (current: string, next: string, again: string = next, code?: string) => {
  await userEvent.type(await screen.findByLabelText("Current password"), current);
  await userEvent.type(screen.getByLabelText("New password"), next);
  await userEvent.type(screen.getByLabelText("New password again"), again);
  if (code !== undefined) await userEvent.type(screen.getByLabelText(/Code to confirm/), code);
};
const submit = () => userEvent.click(screen.getByRole("button", { name: "Change password" }));

describe("SecurityPage: changing your password", () => {
  it("is offered to everyone, auditor side or client side", async () => {
    status(OFF);
    const a = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByRole("form", { name: "Change password" })).toBeInTheDocument();
    a.unmount();
    renderApp(<SecurityPage />, { user: TENANT_USER });
    expect(await screen.findByRole("form", { name: "Change password" })).toBeInTheDocument();
  });

  it("asks for a code only when two-step sign-in is on", async () => {
    status(OFF);
    const a = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await screen.findByLabelText("Current password");
    expect(screen.queryByLabelText(/Code to confirm/)).not.toBeInTheDocument();
    a.unmount();
    status(ON);
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByLabelText(/Code to confirm/)).toBeInTheDocument();
  });

  it("can't be sent until everything it needs is filled in", async () => {
    status(ON);
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    const button = await screen.findByRole("button", { name: "Change password" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Current password"), "old-password-1");
    await userEvent.type(screen.getByLabelText("New password"), "brand-new-password-1");
    await userEvent.type(screen.getByLabelText("New password again"), "brand-new-password-1");
    expect(button).toBeDisabled(); // still needs the code
    await userEvent.type(screen.getByLabelText(/Code to confirm/), "123456");
    expect(button).toBeEnabled();
  });

  it("changes it, swaps in the fresh session, clears the form and says other devices were signed out", async () => {
    status(OFF);
    const sent = endpoint();
    const { authClient } = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    const swap = vi.spyOn(authClient, "replaceSession");
    await fill("old-password-1", "brand-new-password-1");
    await submit();
    expect(await screen.findByText("Password changed. Any other devices have been signed out.")).toBeInTheDocument();
    expect(sent).toEqual([{ currentPassword: "old-password-1", newPassword: "brand-new-password-1" }]);
    expect(swap).toHaveBeenCalledWith(FRESH);
    for (const label of ["Current password", "New password", "New password again"]) expect(screen.getByLabelText(label)).toHaveValue("");
    expect(authClient.getUser()).not.toBeNull();
  });

  it("sends the code (trimmed) when two-step sign-in is on", async () => {
    status(ON);
    const sent = endpoint();
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await fill("old-password-1", "brand-new-password-1", undefined, " 123456 ");
    await submit();
    await screen.findByText(/Password changed/);
    expect(sent).toEqual([{ currentPassword: "old-password-1", newPassword: "brand-new-password-1", code: "123456" }]);
    expect(screen.getByLabelText(/Code to confirm/)).toHaveValue("");
  });

  it("checks the two new passwords match, and the length, before sending anything", async () => {
    status(OFF);
    const sent = endpoint();
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await fill("old-password-1", "brand-new-password-1", "brand-new-password-2");
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("The two new passwords don't match.");

    await userEvent.clear(screen.getByLabelText("New password"));
    await userEvent.clear(screen.getByLabelText("New password again"));
    await userEvent.type(screen.getByLabelText("New password"), "short");
    await userEvent.type(screen.getByLabelText("New password again"), "short");
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent("at least 12 characters");
    expect(sent).toEqual([]);
  });

  it("explains a refusal in the server's words, keeps what was typed, and does not sign anyone out", async () => {
    status(OFF);
    endpoint(() => apiError(403, "INVALID_PASSWORD", "Incorrect password."));
    const { authClient } = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    const swap = vi.spyOn(authClient, "replaceSession");
    await fill("wrong-password-1", "brand-new-password-1");
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password.");
    expect(swap).not.toHaveBeenCalled();
    expect(screen.getByLabelText("New password")).toHaveValue("brand-new-password-1"); // no retyping everything
    expect(screen.queryByText(/Password changed/)).not.toBeInTheDocument();
    expect(authClient.getUser()).not.toBeNull();
  });

  it.each([
    [422, "SAME_PASSWORD", "Choose a password that is different from your current one."],
    [422, "WEAK_PASSWORD", "That password is too common. Please choose another."],
    [403, "INVALID_CODE", "That code didn't match."],
    [423, "ACCOUNT_LOCKED", "Too many attempts. Try again later."],
    [409, "NO_LOCAL_PASSWORD", "Your account signs in through your organisation's single sign-on, so its password is managed there."],
    [409, "PASSWORD_CHANGED_ELSEWHERE", "Your password was changed somewhere else a moment ago."],
  ])("shows the server's message for %s %s", async (status_, code, message) => {
    status(OFF);
    endpoint(() => apiError(status_, code, message));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await fill("old-password-1", "brand-new-password-1");
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("the success message goes away when the next attempt fails", async () => {
    status(OFF);
    let n = 0;
    endpoint(() => (++n === 1 ? json(FRESH) : apiError(403, "INVALID_PASSWORD", "Incorrect password.")));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await fill("old-password-1", "brand-new-password-1");
    await submit();
    await screen.findByText(/Password changed/);
    await fill("old-password-1", "another-new-password-1");
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password.");
    expect(screen.queryByText(/Password changed/)).not.toBeInTheDocument();
  });

  it("is not offered while the organisation is still waiting for you to set up two-step sign-in", async () => {
    status({ ...OFF, required: true });
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await screen.findByText(/Your organisation requires two-step sign-in/);
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });
});
