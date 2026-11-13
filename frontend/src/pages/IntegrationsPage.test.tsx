import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import type { AuthUser } from "../auth/types";
import { IntegrationsPage } from "./IntegrationsPage";

const ADMIN: AuthUser = { userId: "33333333-3333-3333-3333-333333333333", email: "admin@harbor.test", name: "Alex Admin", role: "org_admin" };
const ROUTE = "/settings/integrations";

const tenant = (id: string, name: string, storageRootId: string | null = null, status = "active") => ({ id, name, status, storageRootId });
const drive = (status: "active" | "revoked" | "error" = "active", accountLabel: string | null = "evidence@harbor.test") =>
  ({ id: "c1", provider: "google_drive", accountLabel, status });

type Conn = { provider: string; accountLabel?: string | null; status: string };
const SHAREPOINT = { provider: "sharepoint", available: false, unavailableReason: "SharePoint is coming in a later release.", connected: false };

/** What GET /org/storage-options answers: built from the connections the test has, with sensible defaults for the rest. */
function storageOptions(opts: { connections?: Conn[]; current?: string; locked?: boolean; local?: boolean; s3?: boolean; drive?: boolean } = {}) {
  const connections = opts.connections ?? [];
  const entry = (provider: string, available: boolean, reason: string) => {
    const c = connections.find((x) => x.provider === provider);
    return { provider, available, ...(available ? {} : { unavailableReason: reason }), connected: !!c, ...(c ? { status: c.status, ...(c.accountLabel ? { label: c.accountLabel } : {}) } : {}) };
  };
  return {
    current: opts.current ?? "google_drive",
    locked: opts.locked ?? false,
    options: [
      entry("google_drive", opts.drive ?? true, "The owner of this server has to enter the Google app details under Server settings first."),
      entry("local", opts.local ?? false, "The owner of this server has not allowed keeping evidence on its disk. They can do that by setting LOCAL_STORAGE_DIR in the server's .env file and restarting."),
      entry("s3", opts.s3 ?? true, "The owner of this server has to set SECRET_ENCRYPTION_KEY in the server's .env file (and restart) before S3 access keys can be stored."),
      SHAREPOINT,
    ],
  };
}

function mockOrg(opts: { connections?: unknown[]; tenants?: unknown[]; current?: string; locked?: boolean; local?: boolean; s3?: boolean; drive?: boolean } = {}) {
  server.use(
    http.get(`${API_BASE}/org/storage-options`, () => json(storageOptions({ ...opts, connections: (opts.connections ?? []) as Conn[] }))),
    http.get(`${API_BASE}/tenants`, () => json(opts.tenants ?? [])),
  );
}

describe("IntegrationsPage — Google Drive connection", () => {
  it("offers to connect when nothing is connected, and sends the browser to Google", async () => {
    mockOrg();
    server.use(http.post(`${API_BASE}/org/storage-connections/google/start`, () => json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" })));
    const redirect = vi.fn();
    renderApp(<IntegrationsPage redirect={redirect} />, { user: ADMIN, route: ROUTE });

    expect(await screen.findByTestId("drive-status")).toHaveTextContent("Not connected.");
    await userEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc"));
  });

  it("shows who it's connected as, and offers to reconnect rather than connect", async () => {
    mockOrg({ connections: [drive("active", "evidence@harbor.test")] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByTestId("drive-status")).toHaveTextContent("Connected as evidence@harbor.test.");
    expect(screen.getByRole("button", { name: "Reconnect Google Drive" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Connect Google Drive" })).not.toBeInTheDocument();
  });

  it("says plainly when access was lost, for both a revoked and an errored connection", async () => {
    for (const status of ["revoked", "error"] as const) {
      mockOrg({ connections: [drive(status)] });
      const { unmount } = renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
      expect(await screen.findByTestId("drive-status")).toHaveTextContent("Access was lost");
      expect(screen.getByRole("button", { name: "Reconnect Google Drive" })).toBeInTheDocument();
      unmount();
    }
  });

  it("shows the server's own explanation if the connection can't even be started", async () => {
    mockOrg();
    server.use(http.post(`${API_BASE}/org/storage-connections/google/start`, () =>
      apiError(503, "OAUTH_NOT_CONFIGURED", "Google Drive connection is not configured on this server.")));
    const redirect = vi.fn();
    renderApp(<IntegrationsPage redirect={redirect} />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Drive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google Drive connection is not configured on this server.");
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled(); // can try again
  });

  it("welcomes the person back after Google redirects here with ?connected=google_drive, showing the new connection", async () => {
    mockOrg({ connections: [drive()] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: `${ROUTE}?connected=google_drive` });
    expect(await screen.findByRole("status")).toHaveTextContent("Google Drive is connected.");
    await waitFor(() => expect(screen.getByTestId("drive-status")).toHaveTextContent("Connected as evidence@harbor.test."));
  });

  it("turns ?error=… into a sentence a person can act on", async () => {
    mockOrg();
    renderApp(<IntegrationsPage />, { user: ADMIN, route: `${ROUTE}?error=access_denied` });
    expect(await screen.findByRole("alert")).toHaveTextContent(/declined/i);
  });

  it("still shows something useful for an error code it has never seen", async () => {
    mockOrg();
    renderApp(<IntegrationsPage />, { user: ADMIN, route: `${ROUTE}?error=BRAND_NEW_CODE` });
    expect(await screen.findByRole("alert")).toHaveTextContent("BRAND_NEW_CODE");
  });

  it("only an org admin can use the page — anyone else is told so, and the page asks for no storage details", async () => {
    let storageRequests = 0;
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])), // the app-wide tenant picker loads this for every auditor-side user
      http.get(`${API_BASE}/org/storage-options`, () => { storageRequests++; return json(storageOptions()); }),
    );
    renderApp(<IntegrationsPage />, { user: AUDITOR_USER, route: ROUTE });
    expect(await screen.findByText(/Only an org admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Google Drive/ })).not.toBeInTheDocument();
    expect(storageRequests).toBe(0);
  });
});

describe("IntegrationsPage — tenant evidence folders", () => {
  it("lists active tenants, marking those that already have a folder, and hides archived ones", async () => {
    mockOrg({
      connections: [drive()],
      tenants: [tenant("t1", "Brightpath Ltd", "folder-1"), tenant("t2", "Harbor Foods"), tenant("t3", "Old Client", "folder-3", "archived")],
    });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByText("Brightpath Ltd")).toBeInTheDocument();
    expect(screen.getByText("Folder ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create folder for Harbor Foods" })).toBeEnabled();
    expect(screen.queryByText("Old Client")).not.toBeInTheDocument();
  });

  it("creates the folder, then shows it as ready", async () => {
    let created = false;
    server.use(
      http.get(`${API_BASE}/org/storage-options`, () => json(storageOptions({ connections: [drive()] }))),
      http.get(`${API_BASE}/tenants`, () => json([tenant("t2", "Harbor Foods", created ? "folder-9" : null)])),
      http.post(`${API_BASE}/tenants/t2/storage-root/create`, () => { created = true; return json({ id: "t2", storageRootId: "folder-9" }, 201); }),
    );
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Create folder for Harbor Foods" }));
    expect(await screen.findByText("Folder ready")).toBeInTheDocument();
    expect(created).toBe(true);
  });

  it("can't create folders until Drive is connected, and says why", async () => {
    mockOrg({ tenants: [tenant("t2", "Harbor Foods")] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const btn = await screen.findByRole("button", { name: "Create folder for Harbor Foods" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Connect Google Drive first");
  });

  it("can't create folders while access is lost either", async () => {
    mockOrg({ connections: [drive("revoked")], tenants: [tenant("t2", "Harbor Foods")] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByRole("button", { name: "Create folder for Harbor Foods" })).toBeDisabled();
  });

  it("shows the server's reason when folder creation fails, and lets the person retry", async () => {
    server.use(
      http.get(`${API_BASE}/org/storage-options`, () => json(storageOptions({ connections: [drive()] }))),
      http.get(`${API_BASE}/tenants`, () => json([tenant("t2", "Harbor Foods")])),
      http.post(`${API_BASE}/tenants/t2/storage-root/create`, () => apiError(409, "STORAGE_RECONNECT_REQUIRED", "Google Drive access was revoked or has expired.")),
    );
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Create folder for Harbor Foods" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google Drive access was revoked or has expired.");
    expect(screen.getByRole("button", { name: "Create folder for Harbor Foods" })).toBeEnabled();
  });

  it("guides the person when there are no tenants yet", async () => {
    mockOrg({ connections: [drive()], tenants: [] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByText(/No tenants yet/)).toBeInTheDocument();
  });
});

describe("IntegrationsPage — Google not set up on the server yet", () => {
  const NOT_SET_UP = () => apiError(503, "OAUTH_NOT_CONFIGURED", "Google Drive isn't set up on this server yet. The owner of this installation can add the Google app details under Server settings.");

  it("tells the installation owner where to fix it, with a link", async () => {
    mockOrg();
    server.use(
      http.get(`${API_BASE}/platform/owner`, () => json({ owner: true })),
      http.post(`${API_BASE}/org/storage-connections/google/start`, NOT_SET_UP),
    );
    renderApp(<IntegrationsPage redirect={vi.fn()} />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Drive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't set up on this server yet");
    await waitFor(() => expect(screen.getByRole("link", { name: "Open Server settings" })).toHaveAttribute("href", "/settings/server"));
  });

  it("tells anyone else the same thing, without a link they couldn't use", async () => {
    mockOrg();
    server.use(http.post(`${API_BASE}/org/storage-connections/google/start`, NOT_SET_UP));
    renderApp(<IntegrationsPage redirect={vi.fn()} />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Drive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The owner of this installation can add the Google app details under Server settings.");
    expect(screen.queryByRole("link", { name: "Open Server settings" })).not.toBeInTheDocument();
  });

  it("also points the owner there when Google sends them back with not_configured", async () => {
    mockOrg();
    server.use(http.get(`${API_BASE}/platform/owner`, () => json({ owner: true })));
    renderApp(<IntegrationsPage redirect={vi.fn()} />, { user: ADMIN, route: `${ROUTE}?error=not_configured` });
    expect(await screen.findByRole("alert")).toHaveTextContent("Server settings");
    await waitFor(() => expect(screen.getByRole("link", { name: "Open Server settings" })).toBeInTheDocument());
  });

  it("doesn't offer the link for unrelated problems", async () => {
    mockOrg();
    server.use(http.get(`${API_BASE}/platform/owner`, () => json({ owner: true })));
    renderApp(<IntegrationsPage redirect={vi.fn()} />, { user: ADMIN, route: `${ROUTE}?error=access_denied` });
    expect(await screen.findByRole("alert")).toHaveTextContent("access was declined");
    expect(screen.queryByRole("link", { name: "Open Server settings" })).not.toBeInTheDocument();
  });
});

const s3conn = (status = "active", accountLabel: string | null = "evidence-bucket @ minio.harbor.test") => ({ id: "c3", provider: "s3", accountLabel, status });
const localConn = (status = "active") => ({ id: "c2", provider: "local", accountLabel: "This server's disk", status });
const card = (name: RegExp) => within(screen.getByRole("region", { name }));

describe("IntegrationsPage — choosing where evidence is kept", () => {
  it("offers Google Drive, this server's disk, S3 and SharePoint, and marks the one in use", async () => {
    mockOrg({ connections: [drive()], local: true });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await screen.findByTestId("drive-status");
    for (const name of [/Google Drive/, /This server's disk/, /S3-compatible storage/, /SharePoint/]) expect(screen.getByRole("region", { name })).toBeInTheDocument();
    expect(card(/Google Drive/).getByText("In use")).toBeInTheDocument();
    expect(screen.getAllByText("In use")).toHaveLength(1);
  });

  it("shows SharePoint as coming later, with nothing to click", async () => {
    mockOrg();
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await screen.findByTestId("drive-status");
    const sp = card(/SharePoint/);
    expect(sp.getByText("Coming later")).toBeInTheDocument();
    expect(sp.getByText("SharePoint is coming in a later release.")).toBeInTheDocument();
    expect(sp.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains, instead of offering a button, when the server's owner hasn't allowed the disk", async () => {
    mockOrg({ local: false });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await screen.findByTestId("drive-status");
    expect(card(/This server's disk/).getByText(/LOCAL_STORAGE_DIR/)).toBeInTheDocument();
    expect(card(/This server's disk/).queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains the same way when S3 can't store keys because the server has no encryption key", async () => {
    mockOrg({ s3: false });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await screen.findByTestId("drive-status");
    expect(card(/S3-compatible storage/).getByText(/SECRET_ENCRYPTION_KEY/)).toBeInTheDocument();
    expect(card(/S3-compatible storage/).queryByRole("button")).not.toBeInTheDocument();
  });

  it("tells the installation owner where to fix Google, with a link, and nobody else", async () => {
    mockOrg({ drive: false });
    server.use(http.get(`${API_BASE}/platform/owner`, () => json({ owner: true })));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByTestId("google_drive-unavailable")).toHaveTextContent("Server settings");
    await waitFor(() => expect(card(/Google Drive/).getByRole("link", { name: "Open Server settings" })).toHaveAttribute("href", "/settings/server"));
    expect(card(/Google Drive/).queryByRole("button", { name: /Connect Google Drive/ })).not.toBeInTheDocument();
  });

  it("switches on the server's disk and says so; only the installation owner is shown the folder's location", async () => {
    for (const owner of [false, true]) {
      let current = "google_drive";
      let calls = 0;
      server.use(
        http.get(`${API_BASE}/org/storage-options`, () => json(storageOptions({ connections: current === "local" ? [localConn()] : [], current, local: true }))),
        http.get(`${API_BASE}/tenants`, () => json([])),
        http.get(`${API_BASE}/platform/owner`, () => json({ owner })),
        http.post(`${API_BASE}/org/storage-connections/local`, () => { calls++; current = "local"; return json({ id: "c2", provider: "local", folder: "/srv/evidence/Harbor [11111111]" }); }),
      );
      const { unmount } = renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
      await userEvent.click(await screen.findByRole("button", { name: "Use this server's disk" }));
      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent("Evidence will now be kept on this server's disk");
      if (owner) expect(status).toHaveTextContent("/srv/evidence/Harbor [11111111]"); else expect(status).not.toHaveTextContent("/srv/evidence");
      expect(calls).toBe(1);
      await waitFor(() => expect(card(/This server's disk/).getByText("In use")).toBeInTheDocument());
      expect(card(/This server's disk/).queryByRole("button", { name: /Use this server's disk/ })).not.toBeInTheDocument();
      unmount();
      server.resetHandlers();
    }
  });

  it("shows the server's reason when switching on the disk fails", async () => {
    mockOrg({ local: true });
    server.use(http.post(`${API_BASE}/org/storage-connections/local`, () => apiError(422, "LOCAL_STORAGE_UNUSABLE", "The server can't write to the evidence folder.")));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Use this server's disk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server can't write to the evidence folder.");
    expect(screen.getByRole("button", { name: "Use this server's disk" })).toBeEnabled();
  });

  it("switches to a storage that is already connected", async () => {
    let body: unknown;
    mockOrg({ connections: [drive(), s3conn()] });
    server.use(http.put(`${API_BASE}/org/storage-provider`, async ({ request }) => { body = await request.json(); return json({ provider: "s3" }); }));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Use S3-compatible storage" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Evidence will now be kept in your S3 bucket");
    expect(body).toEqual({ provider: "s3" });
  });

  it("switches to Google Drive from another storage, asking for Drive and nothing else", async () => {
    let body: unknown;
    mockOrg({ connections: [drive(), s3conn()], current: "s3" });
    server.use(http.put(`${API_BASE}/org/storage-provider`, async ({ request }) => { body = await request.json(); return json({ provider: "google_drive" }); }));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Use Google Drive" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Evidence will now be kept in Google Drive");
    expect(body).toEqual({ provider: "google_drive" });
  });

  it("doesn't call a storage 'in use' when its access has been lost", async () => {
    mockOrg({ connections: [drive("revoked")], current: "google_drive" });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await screen.findByTestId("drive-status");
    expect(screen.queryByText("In use")).not.toBeInTheDocument();
  });

  it("asks before a switch that would clear tenants' folders, and does nothing if the person backs out", async () => {
    let switched = 0;
    mockOrg({ connections: [drive(), s3conn()], tenants: [tenant("t1", "Brightpath Ltd", "folder-1"), tenant("t2", "Harbor Foods", "folder-2")] });
    server.use(http.put(`${API_BASE}/org/storage-provider`, () => { switched++; return json({ provider: "s3" }); }));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Use S3-compatible storage" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("clears the evidence folders already set up for 2 tenants");
    expect(switched).toBe(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(switched).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Use S3-compatible storage" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch storage" }));
    await waitFor(() => expect(switched).toBe(1));
  });

  it("doesn't ask when the switch would clear nothing", async () => {
    mockOrg({ connections: [drive(), s3conn()], tenants: [tenant("t1", "Brightpath Ltd")] });
    server.use(http.put(`${API_BASE}/org/storage-provider`, () => json({ provider: "s3" })));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Use S3-compatible storage" }));
    await screen.findByRole("status");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("IntegrationsPage — S3-compatible storage form", () => {
  async function openAndFill() {
    await userEvent.click(await screen.findByRole("button", { name: "Set up S3-compatible storage" }));
    const form = screen.getByRole("form", { name: "S3-compatible storage details" });
    const f = within(form);
    await userEvent.type(f.getByLabelText(/Service address/), "https://minio.harbor.test:9000");
    await userEvent.type(f.getByLabelText("Bucket"), "evidence-bucket");
    await userEvent.type(f.getByLabelText(/Folder inside the bucket/), "audits");
    await userEvent.type(f.getByLabelText("Access key ID"), "AKIAHARBOR");
    await userEvent.type(f.getByLabelText("Secret access key"), "s3cr3t/key+value");
    await userEvent.click(f.getByLabelText(/path-style/));
    return f;
  }
  const SENT = { endpoint: "https://minio.harbor.test:9000", region: "us-east-1", bucket: "evidence-bucket", accessKeyId: "AKIAHARBOR", secretAccessKey: "s3cr3t/key+value", forcePathStyle: true, prefix: "audits" };

  it("keeps Test and Save unavailable until the required details are entered", async () => {
    mockOrg();
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Set up S3-compatible storage" }));
    const f = within(screen.getByRole("form", { name: "S3-compatible storage details" }));
    expect(f.getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(f.getByRole("button", { name: "Save and use S3 storage" })).toBeDisabled();
    await userEvent.type(f.getByLabelText("Bucket"), "evidence-bucket");
    await userEvent.type(f.getByLabelText("Access key ID"), "AKIA");
    expect(f.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await userEvent.type(f.getByLabelText("Secret access key"), "secret");
    expect(f.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("hides the secret key while it is typed", async () => {
    mockOrg();
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Set up S3-compatible storage" }));
    expect(screen.getByLabelText("Secret access key")).toHaveAttribute("type", "password");
  });

  it("tests the details without saving anything", async () => {
    let tested: unknown; let saved = 0;
    mockOrg();
    server.use(
      http.post(`${API_BASE}/org/storage-connections/s3/test`, async ({ request }) => { tested = await request.json(); return json({ ok: true }); }),
      http.put(`${API_BASE}/org/storage-connections/s3`, () => { saved++; return json({}); }),
    );
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const f = await openAndFill();
    await userEvent.click(f.getByRole("button", { name: "Test connection" }));
    expect(await f.findByRole("status")).toHaveTextContent("The connection works. Nothing has been saved yet.");
    expect(tested).toEqual(SENT);
    expect(saved).toBe(0);
  });

  it("shows why a test failed right beside the form, and keeps what was typed", async () => {
    mockOrg();
    server.use(http.post(`${API_BASE}/org/storage-connections/s3/test`, () => apiError(422, "S3_CONNECTION_FAILED", "The bucket evidence-bucket doesn't exist, or these keys can't see it.")));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const f = await openAndFill();
    await userEvent.click(f.getByRole("button", { name: "Test connection" }));
    expect(await f.findByRole("alert")).toHaveTextContent("The bucket evidence-bucket doesn't exist");
    expect(f.getByLabelText("Bucket")).toHaveValue("evidence-bucket");
    expect(f.getByRole("button", { name: "Save and use S3 storage" })).toBeEnabled();
  });

  it("clears an old result once something is changed", async () => {
    mockOrg();
    server.use(http.post(`${API_BASE}/org/storage-connections/s3/test`, () => json({ ok: true })));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const f = await openAndFill();
    await userEvent.click(f.getByRole("button", { name: "Test connection" }));
    await f.findByRole("status");
    await userEvent.type(f.getByLabelText("Bucket"), "x");
    expect(f.queryByRole("status")).not.toBeInTheDocument();
  });

  it("saves, closes the form, says where evidence goes, and shows the bucket as in use", async () => {
    let body: unknown; let connected = false;
    server.use(
      http.get(`${API_BASE}/org/storage-options`, () => json(storageOptions({ connections: connected ? [s3conn()] : [], current: connected ? "s3" : "google_drive" }))),
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.put(`${API_BASE}/org/storage-connections/s3`, async ({ request }) => { body = await request.json(); connected = true; return json({ id: "c3", provider: "s3", label: "evidence-bucket @ minio.harbor.test" }); }),
    );
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const f = await openAndFill();
    await userEvent.click(f.getByRole("button", { name: "Save and use S3 storage" }));
    expect(await screen.findByRole("status")).toHaveTextContent("S3 storage is connected: evidence-bucket @ minio.harbor.test");
    expect(body).toEqual(SENT);
    await waitFor(() => expect(screen.queryByRole("form", { name: "S3-compatible storage details" })).not.toBeInTheDocument());
    await waitFor(() => expect(card(/S3-compatible storage/).getByText("In use")).toBeInTheDocument());
    expect(screen.getByTestId("s3-status")).toHaveTextContent("Connected to evidence-bucket @ minio.harbor.test.");
    // Re-opening the form shows nothing of what was entered: the secret is not kept in the page.
    await userEvent.click(screen.getByRole("button", { name: "Change S3 settings" }));
    expect(screen.getByLabelText("Secret access key")).toHaveValue("");
  });

  it("shows a refusal to save inside the form too, and the page stays as it was", async () => {
    mockOrg();
    server.use(http.put(`${API_BASE}/org/storage-connections/s3`, () => apiError(409, "STORAGE_LOCATION_LOCKED", "Evidence is already stored in the current bucket, so only the access keys can be changed here.")));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const f = await openAndFill();
    await userEvent.click(f.getByRole("button", { name: "Save and use S3 storage" }));
    expect(await f.findByRole("alert")).toHaveTextContent("only the access keys can be changed");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(f.getByLabelText("Access key ID")).toHaveValue("AKIAHARBOR");
  });

  it("can be closed without saving", async () => {
    mockOrg();
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Set up S3-compatible storage" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "S3-compatible storage details" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up S3-compatible storage" })).toBeInTheDocument();
  });

  it("keeps what was typed while asking to confirm a switch, and saves only after the person agrees", async () => {
    let body: unknown;
    mockOrg({ connections: [drive()], tenants: [tenant("t1", "Brightpath Ltd", "folder-1")] });
    server.use(http.put(`${API_BASE}/org/storage-connections/s3`, async ({ request }) => { body = await request.json(); return json({ id: "c3", provider: "s3", label: "evidence-bucket @ minio.harbor.test" }); }));
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const f = await openAndFill();
    await userEvent.click(f.getByRole("button", { name: "Save and use S3 storage" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(body).toBeUndefined();
    expect(f.getByLabelText("Bucket")).toHaveValue("evidence-bucket");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch storage" }));
    await waitFor(() => expect(body).toEqual(SENT));
  });
});

describe("IntegrationsPage — once evidence exists", () => {
  it("explains that the choice is fixed and offers no way to switch", async () => {
    mockOrg({ connections: [drive(), s3conn()], current: "s3", locked: true });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByRole("note")).toHaveTextContent("Evidence has already been uploaded in your S3 bucket, so this can't be changed any more");
    expect(card(/Google Drive/).getByText(/already kept somewhere else/)).toBeInTheDocument();
    expect(card(/Google Drive/).queryByRole("button")).not.toBeInTheDocument();
    expect(card(/This server's disk/).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Use / })).not.toBeInTheDocument();
  });

  it("still lets the keys be replaced, and says the bucket itself can't change", async () => {
    mockOrg({ connections: [s3conn()], current: "s3", locked: true });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    await userEvent.click(await screen.findByRole("button", { name: "Replace access keys" }));
    expect(screen.getByRole("form", { name: "S3-compatible storage details" })).toHaveTextContent("Only the access keys can change");
  });

  it("still lets Google Drive be reconnected when that is where the evidence is", async () => {
    mockOrg({ connections: [drive("revoked")], current: "google_drive", locked: true });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByRole("button", { name: "Reconnect Google Drive" })).toBeEnabled();
    expect(card(/S3-compatible storage/).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("IntegrationsPage — evidence folders follow the storage in use", () => {
  it("offers to create folders on the server's disk when that is the storage", async () => {
    mockOrg({ connections: [localConn()], current: "local", local: true, tenants: [tenant("t2", "Harbor Foods")] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    const btn = await screen.findByRole("button", { name: "Create folder for Harbor Foods" });
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent("Create folder on this server's disk");
    expect(screen.getByText(/inside your organisation's folder on this server/)).toBeInTheDocument();
  });

  it("offers to create them in the bucket when that is the storage", async () => {
    mockOrg({ connections: [s3conn()], current: "s3", tenants: [tenant("t2", "Harbor Foods")] });
    renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
    expect(await screen.findByRole("button", { name: "Create folder for Harbor Foods" })).toHaveTextContent("Create folder in the S3 bucket");
  });

  it("says what has to happen first when the chosen storage isn't set up", async () => {
    for (const [current, hint] of [["local", "Switch on this server's disk first"], ["s3", "Set up S3 storage first"]] as const) {
      mockOrg({ current, tenants: [tenant("t2", "Harbor Foods")] });
      const { unmount } = renderApp(<IntegrationsPage />, { user: ADMIN, route: ROUTE });
      const btn = await screen.findByRole("button", { name: "Create folder for Harbor Foods" });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("title", hint);
      unmount();
    }
  });
});
