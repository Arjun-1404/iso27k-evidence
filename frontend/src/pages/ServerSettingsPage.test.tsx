import { describe, it, expect, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp } from "../test/renderApp";
import type { AuthUser } from "../auth/types";
import type { PlatformSettingsView, SettingsGroupView } from "../api/types";
import { ServerSettingsPage } from "./ServerSettingsPage";

const OWNER: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "owner@harbor.test", name: "Olivia Owner", role: "org_admin" };

const none = (group: SettingsGroupView["group"]): SettingsGroupView => ({ group, source: "none", locked: false, values: null, secretsSet: [], updatedAt: null, updatedBy: null, problem: null });
const view = (over: Partial<PlatformSettingsView> = {}, groups: Partial<Record<SettingsGroupView["group"], Partial<SettingsGroupView>>> = {}): PlatformSettingsView => ({
  canStoreSecrets: true, needsCode: false,
  groups: (["email", "scanner", "google"] as const).map((g) => ({ ...none(g), ...groups[g] })),
  ...over,
});
const SAVED_EMAIL: Partial<SettingsGroupView> = {
  source: "panel", secretsSet: ["password"], updatedAt: "2026-11-06T10:00:00Z", updatedBy: "owner@harbor.test",
  values: { host: "mail.example.test", port: 587, security: "starttls", user: "mailer", from: "noreply@firm.example" },
};

let current: PlatformSettingsView;
beforeEach(() => {
  current = view();
  server.use(
    http.get(`${API_BASE}/tenants`, () => json([])),
    http.get(`${API_BASE}/platform/owner`, () => json({ owner: true })),
    http.get(`${API_BASE}/platform/settings`, () => json(current)),
  );
});

/** Records what the page sends, and answers with `reply` (by default: the state with that group saved). */
function saveEndpoint(group: string, reply: () => Response | Promise<Response>) {
  const sent: unknown[] = [];
  server.use(http.put(`${API_BASE}/platform/settings/${group}`, async ({ request }) => { sent.push(await request.json()); return reply(); }));
  return sent;
}
const clearEndpoint = (group: string, reply: () => Response | Promise<Response>) => {
  const sent: unknown[] = [];
  server.use(http.post(`${API_BASE}/platform/settings/${group}/clear`, async ({ request }) => { sent.push(await request.json()); return reply(); }));
  return sent;
};
const card = async (name: string) => within(await screen.findByRole("region", { name }));
const typeInto = async (label: string | RegExp, text: string, scope: Pick<typeof screen, "getByLabelText"> = screen) => {
  const input = scope.getByLabelText(label);
  await userEvent.clear(input);
  await userEvent.type(input, text);
};

describe("ServerSettingsPage: who sees it", () => {
  it("tells anyone who isn't the owner so, and never asks for the settings", async () => {
    let asked = false;
    server.use(
      http.get(`${API_BASE}/platform/owner`, () => json({ owner: false })),
      http.get(`${API_BASE}/platform/settings`, () => { asked = true; return json(current); }),
    );
    renderApp(<ServerSettingsPage />, { user: OWNER });
    expect(await screen.findByText(/Only the owner of this installation/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Email" })).not.toBeInTheDocument();
    expect(asked).toBe(false);
  });

  it("shows the owner three cards, each saying whether it is set up", async () => {
    current = view({}, { email: SAVED_EMAIL });
    renderApp(<ServerSettingsPage />, { user: OWNER });
    await card("Email");
    expect(screen.getByTestId("status-email")).toHaveTextContent("Set up here");
    expect(screen.getByTestId("status-scanner")).toHaveTextContent("Not set up");
    expect(screen.getByTestId("status-google")).toHaveTextContent("Not set up");
    expect(screen.getByRole("heading", { name: "Malware scanning" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Google Drive app" })).toBeInTheDocument();
  });

  it("shows why the settings couldn't be loaded", async () => {
    server.use(http.get(`${API_BASE}/platform/settings`, () => apiError(403, "FORBIDDEN_ROLE", "Only the owner can do that.")));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the owner can do that.");
  });
});

describe("ServerSettingsPage: email", () => {
  it("shows what is saved, and says a password is saved without showing it", async () => {
    current = view({}, { email: SAVED_EMAIL });
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    expect(email.getByLabelText("Mail server")).toHaveValue("mail.example.test");
    expect(email.getByLabelText("Port")).toHaveValue("587");
    expect(email.getByLabelText("Encryption")).toHaveValue("starttls");
    expect(email.getByLabelText(/Username/)).toHaveValue("mailer");
    expect(email.getByLabelText("From address")).toHaveValue("noreply@firm.example");
    expect(email.getByLabelText("Password")).toHaveValue("");
    expect(email.getByLabelText("Password")).toHaveAttribute("placeholder", expect.stringMatching(/Saved/));
    expect(email.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("can't be saved until it is filled in and the owner's password is given", async () => {
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    const save = email.getByRole("button", { name: "Save email settings" });
    expect(save).toBeDisabled();
    await typeInto("Mail server", "smtp.example.com", email);
    await typeInto("From address", "noreply@firm.example", email);
    expect(save).toBeDisabled();
    await typeInto("Your password", "owner-password-1", email);
    expect(save).toBeEnabled();
  });

  it("can't be saved half filled in, even with the owner's password given", async () => {
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    const save = email.getByRole("button", { name: "Save email settings" });
    await typeInto("Your password", "owner-password-1", email);
    expect(save).toBeDisabled();                       // no server, no from address
    await typeInto("Mail server", "smtp.example.com", email);
    expect(save).toBeDisabled();                       // still no from address
    await typeInto("From address", "noreply@firm.example", email);
    expect(save).toBeEnabled();
    await userEvent.clear(email.getByLabelText("Mail server"));
    expect(save).toBeDisabled();                       // and blanking either one disables it again
  });

  it("saves, sends only what was filled in, then shows the new state and says no restart is needed", async () => {
    const sent = saveEndpoint("email", () => json(view({}, { email: SAVED_EMAIL })));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await typeInto("Mail server", " mail.example.test ", email);
    await typeInto(/Username/, "mailer", email);
    await typeInto("Password", "mail-pw-1", email);
    await typeInto("From address", "noreply@firm.example", email);
    await typeInto("Your password", "owner-password-1", email);
    await userEvent.click(email.getByRole("button", { name: "Save email settings" }));

    expect(await screen.findByText(/Saved\. The server is using these settings now/)).toBeInTheDocument();
    expect(sent).toEqual([{
      settings: { host: "mail.example.test", security: "starttls", from: "noreply@firm.example", user: "mailer", password: "mail-pw-1" },
      password: "owner-password-1",
    }]);
    expect(screen.getByTestId("status-email")).toHaveTextContent("Set up here");
    // Nothing secret stays in the form.
    const after = await card("Email");
    expect(after.getByLabelText("Your password")).toHaveValue("");
    expect(after.getByLabelText("Password")).toHaveValue("");
    expect(after.getByLabelText("Password")).toHaveAttribute("placeholder", expect.stringMatching(/Saved/));
  });

  it("leaves the mail password out of the request when it was left empty (the server keeps the stored one)", async () => {
    current = view({}, { email: SAVED_EMAIL });
    const sent = saveEndpoint("email", () => json(current));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await typeInto("Port", "2525", email);
    await typeInto("Your password", "owner-password-1", email);
    await userEvent.click(email.getByRole("button", { name: "Save email settings" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0] as { settings: Record<string, unknown> };
    expect(body.settings).not.toHaveProperty("password");
    expect(body.settings).toMatchObject({ port: "2525", user: "mailer" });
  });

  it("shows the server's explanation when something is wrong, and keeps what was typed", async () => {
    saveEndpoint("email", () => apiError(400, "VALIDATION", "The mail server should be just a server name like mail.example.com, without http:// or smtp:// or a path."));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await typeInto("Mail server", "smtp://mail.example.test", email);
    await typeInto("From address", "noreply@firm.example", email);
    await typeInto("Your password", "owner-password-1", email);
    await userEvent.click(email.getByRole("button", { name: "Save email settings" }));
    expect(await email.findByRole("alert")).toHaveTextContent(/without http:\/\/ or smtp:\/\//);
    expect(email.getByLabelText("Mail server")).toHaveValue("smtp://mail.example.test");
    expect(email.getByLabelText("Your password")).toHaveValue("owner-password-1");
    expect(screen.getByTestId("status-email")).toHaveTextContent("Not set up");
  });

  it("shows a wrong-password refusal", async () => {
    saveEndpoint("email", () => apiError(403, "INVALID_PASSWORD", "That password is not correct."));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await typeInto("Mail server", "mail.example.test", email);
    await typeInto("From address", "a@b.test", email);
    await typeInto("Your password", "wrong", email);
    await userEvent.click(email.getByRole("button", { name: "Save email settings" }));
    expect(await email.findByRole("alert")).toHaveTextContent("That password is not correct.");
  });

  it("offers the port that goes with the chosen encryption", async () => {
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    expect(email.getByLabelText("Port")).toHaveAttribute("placeholder", "587");
    await userEvent.selectOptions(email.getByLabelText("Encryption"), "tls");
    expect(email.getByLabelText("Port")).toHaveAttribute("placeholder", "465");
    await userEvent.selectOptions(email.getByLabelText("Encryption"), "none");
    expect(email.getByLabelText("Port")).toHaveAttribute("placeholder", "25");
  });

  it("asks for a code too when the owner uses two-step sign-in, and sends it", async () => {
    current = view({ needsCode: true });
    const sent = saveEndpoint("email", () => json(current));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await typeInto("Mail server", "mail.example.test", email);
    await typeInto("From address", "a@b.test", email);
    await typeInto("Your password", "owner-password-1", email);
    const save = email.getByRole("button", { name: "Save email settings" });
    expect(save).toBeDisabled(); // still needs the code
    await typeInto(/Code to confirm/, " 123456 ", email);
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ password: "owner-password-1", code: "123456" });
    // Neither the password nor the code is left sitting in the form afterwards (the card itself isn't rebuilt here,
    // because the same state comes back, so this is the form clearing itself).
    await screen.findByText(/Saved\. The server is using these settings now/);
    expect(email.getByLabelText("Your password")).toHaveValue("");
    expect(email.getByLabelText(/Code to confirm/)).toHaveValue("");
  });

  it("doesn't ask for a code when two-step sign-in is off", async () => {
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    expect(email.queryByLabelText(/Code to confirm/)).not.toBeInTheDocument();
  });

  it("says what a test email did, and where it went", async () => {
    current = view({}, { email: SAVED_EMAIL });
    server.use(http.post(`${API_BASE}/platform/settings/email/test`, () => json({ ok: true, sentTo: "owner@harbor.test" })));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await userEvent.click(email.getByRole("button", { name: "Send me a test email" }));
    expect(await email.findByRole("status")).toHaveTextContent("Sent a test message to owner@harbor.test");
  });

  it("shows why a test email failed", async () => {
    current = view({}, { email: SAVED_EMAIL });
    server.use(http.post(`${API_BASE}/platform/settings/email/test`, () => apiError(502, "EMAIL_TEST_FAILED", "The portal could not reach the mail server.")));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    await userEvent.click(email.getByRole("button", { name: "Send me a test email" }));
    expect(await email.findByRole("alert")).toHaveTextContent("could not reach the mail server");
  });

  it("offers no test button until mail is set up", async () => {
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    expect(email.queryByRole("button", { name: "Send me a test email" })).not.toBeInTheDocument();
  });
});

describe("ServerSettingsPage: removing saved settings", () => {
  it("needs the password, then returns the card to 'not set up'", async () => {
    current = view({}, { scanner: { source: "panel", values: { host: "clamav", port: 3310, timeoutSeconds: 60, maxFileMb: 25 }, updatedAt: "2026-11-06T10:00:00Z" } });
    const sent = clearEndpoint("scanner", () => json(view()));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const scanner = await card("Malware scanning");
    const remove = scanner.getByRole("button", { name: "Remove saved scanner settings" });
    expect(remove).toBeDisabled();
    await typeInto("Your password", "owner-password-1", scanner);
    await userEvent.click(remove);
    expect(await screen.findByText("Removed.")).toBeInTheDocument();
    expect(sent).toEqual([{ password: "owner-password-1" }]);
    expect(screen.getByTestId("status-scanner")).toHaveTextContent("Not set up");
    const after = await card("Malware scanning");
    expect(after.getByLabelText("Scanner host")).toHaveValue(""); // not left showing what was removed
    expect(after.queryByRole("button", { name: /Remove saved/ })).not.toBeInTheDocument();
  });

  it("is offered for saved settings that can't be used, with the reason", async () => {
    current = view({}, { email: { source: "none", problem: "What was saved here can't be read: the server's encryption key is missing or has changed. Enter the settings again." } });
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    expect(email.getByRole("alert")).toHaveTextContent(/encryption key is missing or has changed/);
    expect(screen.getByTestId("status-email")).toHaveTextContent("Saved settings can't be used");
    expect(email.getByRole("button", { name: "Remove saved email settings" })).toBeInTheDocument();
  });
});

describe("ServerSettingsPage: settings that come from the server's configuration", () => {
  it("are shown read-only, with the reason, and can't be edited or removed", async () => {
    current = view({}, { email: { source: "environment", locked: true, values: { host: "env-mail.test", port: 587, security: "starttls", user: "envuser", from: "noreply@env.example" } } });
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const email = await card("Email");
    expect(screen.getByTestId("status-email")).toHaveTextContent("locked");
    expect(email.getByText("env-mail.test")).toBeInTheDocument();
    expect(email.getByText("envuser")).toBeInTheDocument();
    expect(email.getByText(/server's configuration file/)).toBeInTheDocument();
    expect(email.queryByRole("form")).not.toBeInTheDocument();
    expect(email.queryByRole("button", { name: /Save|Remove/ })).not.toBeInTheDocument();
    // …but its test button still works, and the other cards are still editable.
    expect(email.getByRole("button", { name: "Send me a test email" })).toBeInTheDocument();
    expect((await card("Malware scanning")).getByRole("button", { name: "Save scanner settings" })).toBeInTheDocument();
  });
});

describe("ServerSettingsPage: a server without an encryption key", () => {
  it("says so, can't save what needs a secret, and can still save the scanner", async () => {
    current = view({ canStoreSecrets: false });
    renderApp(<ServerSettingsPage />, { user: OWNER });
    expect(await screen.findByText("This server has no encryption key.")).toBeInTheDocument();
    const email = await card("Email");
    await typeInto("Mail server", "mail.example.test", email);
    await typeInto("From address", "a@b.test", email);
    await typeInto("Your password", "owner-password-1", email);
    expect(email.getByRole("button", { name: "Save email settings" })).toBeDisabled();
    const google = await card("Google Drive app");
    expect(google.getByRole("button", { name: "Save Google app settings" })).toBeDisabled();
    const scanner = await card("Malware scanning");
    await typeInto("Scanner host", "clamav", scanner);
    await typeInto("Your password", "owner-password-1", scanner);
    expect(scanner.getByRole("button", { name: "Save scanner settings" })).toBeEnabled();
  });
});

describe("ServerSettingsPage: malware scanning", () => {
  it("saves with only what was filled in", async () => {
    const sent = saveEndpoint("scanner", () => json(view({}, { scanner: { source: "panel", values: { host: "clamav", port: 3310, timeoutSeconds: 60, maxFileMb: 25 }, updatedAt: "2026-11-06T10:00:00Z" } })));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const scanner = await card("Malware scanning");
    const save = scanner.getByRole("button", { name: "Save scanner settings" });
    expect(save).toBeDisabled();
    await typeInto("Scanner host", "clamav", scanner);
    await typeInto("Your password", "owner-password-1", scanner);
    await userEvent.click(save);
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(sent).toEqual([{ settings: { host: "clamav" }, password: "owner-password-1" }]);
    expect(screen.getByTestId("status-scanner")).toHaveTextContent("Set up here");
  });

  it("checks the scanner and says what it found", async () => {
    current = view({}, { scanner: { source: "panel", values: { host: "clamav", port: 3310, timeoutSeconds: 60, maxFileMb: 25 } } });
    server.use(http.post(`${API_BASE}/platform/settings/scanner/test`, () => json({ ok: true })));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const scanner = await card("Malware scanning");
    await userEvent.click(scanner.getByRole("button", { name: "Check the scanner" }));
    expect(await scanner.findByRole("status")).toHaveTextContent(/caught the standard antivirus test file/);
  });

  it("shows when the scanner is reachable but not actually catching anything", async () => {
    current = view({}, { scanner: { source: "panel", values: { host: "clamav", port: 3310, timeoutSeconds: 60, maxFileMb: 25 } } });
    server.use(http.post(`${API_BASE}/platform/settings/scanner/test`, () => apiError(502, "SCANNER_TEST_WEAK", "The scanner answered but did not report the standard antivirus test file as a virus.")));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const scanner = await card("Malware scanning");
    await userEvent.click(scanner.getByRole("button", { name: "Check the scanner" }));
    expect(await scanner.findByRole("alert")).toHaveTextContent(/did not report the standard antivirus test file/);
  });
});

describe("ServerSettingsPage: Google Drive app", () => {
  it("suggests the redirect address that matches this server, and fills it in on request", async () => {
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const google = await card("Google Drive app");
    expect(google.getByText(`${API_BASE}/oauth/google/callback`)).toBeInTheDocument();
    await userEvent.click(google.getByRole("button", { name: "Use this" }));
    expect(google.getByLabelText("Redirect address")).toHaveValue(`${API_BASE}/oauth/google/callback`);
    expect(google.queryByRole("button", { name: "Use this" })).not.toBeInTheDocument(); // already used
  });

  it("needs the client secret the first time, and sends it", async () => {
    const sent = saveEndpoint("google", () => json(view({}, { google: { source: "panel", secretsSet: ["clientSecret"], updatedAt: "2026-11-06T10:00:00Z", values: { clientId: "123-abc.apps.googleusercontent.com", redirectUri: `${API_BASE}/oauth/google/callback` } } })));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const google = await card("Google Drive app");
    await typeInto("Client ID", "123-abc.apps.googleusercontent.com", google);
    await userEvent.click(google.getByRole("button", { name: "Use this" }));
    await typeInto("Your password", "owner-password-1", google);
    const save = google.getByRole("button", { name: "Save Google app settings" });
    expect(save).toBeDisabled(); // no client secret yet
    await typeInto("Client secret", " GOCSPX-abc ", google);
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(sent).toEqual([{
      settings: { clientId: "123-abc.apps.googleusercontent.com", redirectUri: `${API_BASE}/oauth/google/callback`, clientSecret: "GOCSPX-abc" },
      password: "owner-password-1",
    }]);
    const after = await card("Google Drive app");
    expect(after.getByLabelText("Client secret")).toHaveValue("");
    expect(after.getByLabelText("Client secret")).toHaveAttribute("placeholder", expect.stringMatching(/Saved/));
  });

  it("lets the client ID change without retyping a saved secret", async () => {
    current = view({}, { google: { source: "panel", secretsSet: ["clientSecret"], values: { clientId: "old-id", redirectUri: `${API_BASE}/oauth/google/callback` } } });
    const sent = saveEndpoint("google", () => json(current));
    renderApp(<ServerSettingsPage />, { user: OWNER });
    const google = await card("Google Drive app");
    await typeInto("Client ID", "new-id", google);
    await typeInto("Your password", "owner-password-1", google);
    await userEvent.click(google.getByRole("button", { name: "Save Google app settings" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as { settings: Record<string, unknown> }).settings).toEqual({ clientId: "new-id", redirectUri: `${API_BASE}/oauth/google/callback` });
  });
});
