import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import { scanQr } from "../test/scanQr";
import { SecurityPage } from "./SecurityPage";

const URI = "otpauth://totp/Evidence%20Portal:priya%40harbor.test?secret=JBSWY3DPEHPK3PXP&issuer=Evidence%20Portal&algorithm=SHA1&digits=6&period=30";
const CODES = Array.from({ length: 10 }, (_, i) => `AAA${i}-BBB${i}-CCC${i}-DDD${i}`.replace(/[0189]/g, "2"));
const OFF = { enabled: false, recoveryRemaining: 0, available: true, required: false };
const on = (recoveryRemaining = 10) => ({ enabled: true, recoveryRemaining, available: true, required: false });

beforeEach(() => { server.use(http.get(`${API_BASE}/tenants`, () => json([]))); });

/** A status endpoint that answers with each body in turn, then keeps repeating the last. */
function statuses(...bodies: object[]) {
  let i = 0;
  server.use(http.get(`${API_BASE}/auth/mfa`, () => json(bodies[Math.min(i++, bodies.length - 1)])));
}

describe("SecurityPage: when two-step sign-in is off", () => {
  it("offers to set it up, and says what it is", async () => {
    statuses(OFF);
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
    expect(screen.getByText(/can't sign in without your phone/i)).toBeInTheDocument();
    expect(screen.queryByText(/Recovery codes left/)).not.toBeInTheDocument();
  });

  it("works for tenant-side users too", async () => {
    statuses(OFF);
    renderApp(<SecurityPage />, { user: TENANT_USER });
    expect(await screen.findByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
  });

  it("walks through: password, QR code and key, first code, recovery codes shown once, then On", async () => {
    statuses(OFF, on(10));
    const sent: Record<string, unknown> = {};
    server.use(
      http.post(`${API_BASE}/auth/mfa/enroll`, async ({ request }) => { sent.enroll = await request.json(); return json({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: URI }); }),
      http.post(`${API_BASE}/auth/mfa/enroll/confirm`, async ({ request }) => { sent.confirm = await request.json(); return json({ recoveryCodes: CODES }); }),
    );
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-step sign-in" }));

    // 1. confirm it's you
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // 2. the QR code and the same secret as text
    expect(await screen.findByRole("img", { name: /QR code for your authenticator app/ })).toBeInTheDocument();
    expect(sent.enroll).toEqual({ password: "my-password-123" });
    expect(screen.getByTestId("setup-key")).toHaveTextContent("JBSW Y3DP EHPK 3PXP");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    // 3. the first code turns it on
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/6-digit code the app shows/), " 123456 ");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText(/Save your recovery codes/)).toBeInTheDocument();
    expect(sent.confirm).toEqual({ code: "123456" });
    expect(screen.queryByTestId("setup-key")).not.toBeInTheDocument(); // the secret is gone from the page
    const list = screen.getByRole("list", { name: "Recovery codes" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(CODES);

    // 4. only after saying they've saved them can the person finish — and then the codes are gone
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /saved these codes/ }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Two-step sign-in is on.")).toBeInTheDocument();
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(screen.getByText(/Recovery codes left/)).toHaveTextContent("10");
    expect(screen.queryByText(CODES[0])).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Recovery codes" })).not.toBeInTheDocument();
  });

  it("the QR code on the page scans to exactly the address the server sent (what an authenticator app needs)", async () => {
    statuses(OFF);
    server.use(http.post(`${API_BASE}/auth/mfa/enroll`, () => json({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: URI })));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const qr = await screen.findByRole("img", { name: /QR code for your authenticator app/ });
    expect(scanQr(qr)).toBe(URI);
  });

  it("a wrong password is explained and nothing starts", async () => {
    statuses(OFF);
    server.use(http.post(`${API_BASE}/auth/mfa/enroll`, () => apiError(403, "INVALID_PASSWORD", "Incorrect password.")));
    const { authClient } = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password.");
    expect(screen.queryByRole("img", { name: /QR code/ })).not.toBeInTheDocument();
    expect(authClient.getUser()).not.toBeNull(); // a typo here does not sign the person out
  });

  it("a wrong first code is explained, and the QR code and key stay for another try", async () => {
    statuses(OFF);
    server.use(
      http.post(`${API_BASE}/auth/mfa/enroll`, () => json({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: URI })),
      http.post(`${API_BASE}/auth/mfa/enroll/confirm`, () => apiError(403, "INVALID_CODE", "That code didn't match.")),
    );
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(await screen.findByLabelText(/6-digit code the app shows/), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't match.");
    expect(screen.getByTestId("setup-key")).toBeInTheDocument();
    expect(screen.queryByText(/Save your recovery codes/)).not.toBeInTheDocument();
  });

  it("cancelling part-way leaves it off and drops the secret from the page", async () => {
    statuses(OFF);
    server.use(http.post(`${API_BASE}/auth/mfa/enroll`, () => json({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: URI })));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("setup-key");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
    expect(screen.queryByTestId("setup-key")).not.toBeInTheDocument();
  });

  it("when the server has no encryption key it says so instead of offering something that cannot work", async () => {
    statuses({ enabled: false, recoveryRemaining: 0, available: false });
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByText(/SECRET_ENCRYPTION_KEY/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up two-step sign-in" })).not.toBeInTheDocument();
  });

  it("if it is on but the server can't check codes, it says to use a recovery code", async () => {
    statuses({ enabled: true, recoveryRemaining: 4, available: false });
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByText(/can't check authenticator codes/)).toBeInTheDocument();
    expect(screen.getByText(/Use a recovery code/)).toBeInTheDocument();
  });

  it("shows a problem loading the status rather than a blank page", async () => {
    server.use(http.get(`${API_BASE}/auth/mfa`, () => apiError(500, "INTERNAL", "Unexpected error.")));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected error.");
  });
});

describe("SecurityPage: when two-step sign-in is on", () => {
  it("shows that it is on and how many recovery codes are left, with no warning while there are plenty", async () => {
    statuses(on(10));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(screen.getByText(/Recovery codes left/)).toHaveTextContent("10");
    expect(screen.queryByText(/running low/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no recovery codes left/)).not.toBeInTheDocument();
  });

  it("warns when they are running low, and more strongly when there are none", async () => {
    statuses(on(3));
    const a = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByText(/running low/)).toBeInTheDocument();
    a.unmount();
    statuses(on(0));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    expect(await screen.findByText(/no recovery codes left/)).toBeInTheDocument();
  });

  it("does not warn at four codes left", async () => {
    statuses(on(4));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await screen.findByText("On");
    expect(screen.queryByText(/running low/)).not.toBeInTheDocument();
  });

  it("turning it off needs the password and a code; success is confirmed and the page shows it off", async () => {
    statuses(on(10), OFF);
    let sent: unknown;
    server.use(http.post(`${API_BASE}/auth/mfa/disable`, async ({ request }) => { sent = await request.json(); return json({ ok: true }); }));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    const submit = screen.getByRole("button", { name: "Turn off" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    expect(submit).toBeDisabled(); // still needs a code
    await userEvent.type(screen.getByLabelText("Authenticator or recovery code"), "123456");
    await userEvent.click(submit);
    expect(await screen.findByText("Two-step sign-in is off.")).toBeInTheDocument();
    expect(sent).toEqual({ password: "my-password-123", code: "123456" });
    expect(await screen.findByRole("button", { name: "Set up two-step sign-in" })).toBeInTheDocument();
  });

  it("a code on its own is not enough to turn it off — the password is needed too", async () => {
    statuses(on(10));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Authenticator or recovery code"), "123456");
    expect(screen.getByRole("button", { name: "Turn off" })).toBeDisabled();
  });

  it("a wrong code or password when turning it off is explained, nothing changes, and the person stays signed in", async () => {
    statuses(on(10));
    server.use(http.post(`${API_BASE}/auth/mfa/disable`, () => apiError(403, "INVALID_CODE", "That code isn't right.")));
    const { authClient } = renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.type(screen.getByLabelText("Authenticator or recovery code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right.");
    expect(screen.queryByText("Two-step sign-in is off.")).not.toBeInTheDocument();
    expect(authClient.getUser()).not.toBeNull();
  });

  it("cancelling the turn-off form changes nothing and clears what was typed", async () => {
    statuses(on(10));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Turn off two-step sign-in" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("new recovery codes: needs the password and a code, then shows the new set once", async () => {
    statuses(on(2), on(10));
    let sent: unknown;
    server.use(http.post(`${API_BASE}/auth/mfa/recovery-codes`, async ({ request }) => { sent = await request.json(); return json({ recoveryCodes: CODES }); }));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Get new recovery codes" }));
    expect(screen.getByText(/old codes stop working/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.type(screen.getByLabelText("Authenticator or recovery code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Get new codes" }));
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(sent).toEqual({ password: "my-password-123", code: "123456" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    await userEvent.click(screen.getByRole("checkbox", { name: /saved these codes/ }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(/Recovery codes left/)).toHaveTextContent("10");
  });
});

describe("SecurityPage: keeping the recovery codes", () => {
  const original = { clipboard: Object.getOwnPropertyDescriptor(navigator, "clipboard"), create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  afterEach(() => {
    if (original.clipboard) Object.defineProperty(navigator, "clipboard", original.clipboard); else Reflect.deleteProperty(navigator, "clipboard");
    URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke;
    vi.restoreAllMocks();
  });

  async function showCodes() {
    statuses(on(2));
    server.use(http.post(`${API_BASE}/auth/mfa/recovery-codes`, () => json({ recoveryCodes: CODES })));
    renderApp(<SecurityPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "Get new recovery codes" }));
    await userEvent.type(screen.getByLabelText("Password"), "my-password-123");
    await userEvent.type(screen.getByLabelText("Authenticator or recovery code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Get new codes" }));
    await screen.findByRole("list", { name: "Recovery codes" });
  }

  it("Copy puts every code on the clipboard, one per line", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await showCodes();
    await userEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    expect(writeText).toHaveBeenCalledWith(CODES.join("\n"));
    expect(await screen.findByText("Recovery codes copied.")).toBeInTheDocument();
  });

  it("if copying is blocked it says how to do it by hand, rather than pretending", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) }, configurable: true });
    await showCodes();
    await userEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    expect(await screen.findByText(/copy them by hand/)).toBeInTheDocument();
    expect(screen.queryByText("Recovery codes copied.")).not.toBeInTheDocument();
  });

  it("Download saves a text file with every code in it", async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return "blob:codes"; });
    URL.revokeObjectURL = vi.fn();
    let downloadedAs = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloadedAs = this.download; });
    await showCodes();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blobs[0]); });
    for (const c of CODES) expect(text).toContain(c);
    expect(downloadedAs).toBe("evidence-portal-recovery-codes.txt");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:codes");
  });
});
