import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, TENANT_USER } from "../test/renderApp";
import { MyControlsPage } from "./MyControlsPage";

const control = {
  id: "c-85", kind: "annex" as const, section: "A.8 Technological controls", controlRef: "A.8.5",
  title: "Secure authentication", effectiveEvidence: "MFA settings, login controls", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "awaiting_evidence" as const,
  dueDate: "2026-09-30", requirementChangedAt: null, fileCount: 0,
};

function mockAudit(controlsList = [control]) {
  server.use(
    http.get(`${API_BASE}/tenants/tenant-1/audits`, () => json([{ id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01" }])),
    http.get(`${API_BASE}/audits/a1/controls`, () => json(controlsList)),
  );
}

describe("MyControlsPage", () => {
  it("shows only applicable controls, with the due date and requirement text", async () => {
    mockAudit([control, { ...control, id: "c-na", controlRef: "A.7.4", applicable: false }]);
    renderApp(<MyControlsPage />, { user: TENANT_USER });
    expect(await screen.findByText("A.8.5 Secure authentication")).toBeInTheDocument();
    expect(screen.getByText("MFA settings, login controls")).toBeInTheDocument();
    expect(screen.getByText("Due 2026-09-30")).toBeInTheDocument();
    expect(screen.queryByText("A.7.4")).not.toBeInTheDocument();
  });

  it("uploads a file end to end: session, direct upload skipped for the in-memory backend, then confirm", async () => {
    mockAudit();
    const calls: string[] = [];
    server.use(
      http.post(`${API_BASE}/controls/c-85/upload-session`, () => {
        calls.push("session");
        return json({ uploadUrl: "memory://file-1", method: "PUT", headers: {}, providerFileId: "file-1", expiresAt: "2026-01-01" });
      }),
      http.post(`${API_BASE}/controls/c-85/uploads/confirm`, async ({ request }) => {
        calls.push("confirm");
        const body = (await request.json()) as { providerFileId: string };
        expect(body.providerFileId).toBe("file-1");
        return json({ id: "ef1", fileName: "mfa.pdf", scanStatus: "clean" }, 201);
      }),
    );
    renderApp(<MyControlsPage />, { user: TENANT_USER });
    await userEvent.click(await screen.findByText("Upload"));
    const dialog = await screen.findByRole("dialog", { name: "Upload evidence" });
    const file = new File(["hello"], "mfa.pdf", { type: "application/pdf" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(calls).toEqual(["session", "confirm"]));
    await screen.findByText("Uploaded.");
  });

  it("tells the person plainly when their file was flagged by malware scanning, and that it was moved to the trash", async () => {
    mockAudit();
    const message = "This file was flagged by malware scanning. It has not been recorded, and it has been moved to the trash of your storage so it can't be opened by mistake. Please check the file and try again.";
    server.use(
      http.post(`${API_BASE}/controls/c-85/upload-session`, () => json({ uploadUrl: "memory://file-1", method: "PUT", headers: {}, providerFileId: "file-1", expiresAt: "2026-01-01" })),
      http.post(`${API_BASE}/controls/c-85/uploads/confirm`, () => apiError(422, "INFECTED_FILE", message)),
    );
    renderApp(<MyControlsPage />, { user: TENANT_USER });
    await userEvent.click(await screen.findByText("Upload"));
    const dialog = await screen.findByRole("dialog", { name: "Upload evidence" });
    await userEvent.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, new File(["x"], "report.pdf", { type: "application/pdf" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(screen.queryByText("Uploaded.")).not.toBeInTheDocument();
  });

  it("submit is not offered until a file has been uploaded", async () => {
    mockAudit();
    renderApp(<MyControlsPage />, { user: TENANT_USER });
    await screen.findByText("A.8.5 Secure authentication");
    expect(screen.queryByText("Submit")).not.toBeInTheDocument();
  });

  it("submit becomes available and calls the submit endpoint once a file exists", async () => {
    mockAudit([{ ...control, fileCount: 1 }]);
    let submitted = false;
    server.use(http.post(`${API_BASE}/controls/c-85/submit`, () => { submitted = true; return json({ id: "c-85", status: "submitted" }); }));
    renderApp(<MyControlsPage />, { user: TENANT_USER });
    await userEvent.click(await screen.findByText("Submit"));
    await waitFor(() => expect(submitted).toBe(true));
  });

  describe("assigning work (client lead)", () => {
    const LEAD = { ...TENANT_USER, userId: "33333333-3333-3333-3333-333333333333", email: "lee@brightpath.test", name: "Lee", role: "tenant_lead" as const };

    it("a contributor has no Assign button", async () => {
      mockAudit();
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      await screen.findByText("A.8.5 Secure authentication");
      expect(screen.queryByRole("button", { name: /Details and assignment/ })).not.toBeInTheDocument();
    });

    it("a client lead can open a control and give it to someone", async () => {
      mockAudit();
      let body: unknown = null;
      server.use(
        http.get(`${API_BASE}/tenants/tenant-1/users`, () => json([{ id: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor", status: "active" }])),
        http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
        http.post(`${API_BASE}/controls/c-85/assignments`, async ({ request }) => { body = await request.json(); return json({}, 201); }),
      );
      renderApp(<MyControlsPage />, { user: LEAD });
      await userEvent.click(await screen.findByRole("button", { name: "Details and assignment for A.8.5" }));
      const section = await screen.findByRole("region", { name: "Assigned to" });
      await waitFor(() => expect(within(within(section).getByLabelText("Person to assign")).getAllByRole("option")).toHaveLength(2));
      await userEvent.selectOptions(within(section).getByLabelText("Person to assign"), "u-sam");
      await userEvent.click(within(section).getByRole("button", { name: "Assign" }));
      await waitFor(() => expect(body).toEqual({ userId: "u-sam" }));
    });
  });

  describe("audit cycles", () => {
    const cycles = [
      { id: "a2", name: "2027 surveillance", status: "in_progress", templateVersion: "1", createdAt: "2027-02-01T00:00:00.000Z" },
      { id: "a1", name: "2026 certification", status: "in_progress", templateVersion: "1", createdAt: "2026-02-01T00:00:00.000Z" },
    ];

    it("a client's person with two cycles can switch between them, and cannot start one", async () => {
      localStorage.clear();
      server.use(
        http.get(`${API_BASE}/tenants/tenant-1/audits`, () => json(cycles)),
        http.get(`${API_BASE}/audits/a2/controls`, () => json([{ ...control, id: "c-new", title: "This year's control" }])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([{ ...control, id: "c-old", title: "Last year's control" }])),
      );
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      expect(await screen.findByText("A.8.5 This year's control")).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByLabelText("Audit cycle"), "a1");
      expect(await screen.findByText("A.8.5 Last year's control")).toBeInTheDocument();
      expect(screen.queryByText("A.8.5 This year's control")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New audit cycle" })).not.toBeInTheDocument();
    });

    it("with a single cycle there is nothing to choose, so no chooser is shown", async () => {
      mockAudit();
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      await screen.findByText("A.8.5 Secure authentication");
      expect(screen.queryByLabelText("Audit cycle")).not.toBeInTheDocument();
    });
  });

  describe("a closed audit cycle", () => {
    const closed = { id: "a1", name: "ISO audit", status: "closed", templateVersion: "1", createdAt: "2026-01-01", closedAt: "2026-11-05T16:30:00.000Z", closedBy: null };
    const open = { ...closed, status: "in_progress", closedAt: null };
    const mockCycle = (audit: Record<string, unknown>, c = control) => server.use(
      http.get(`${API_BASE}/tenants/tenant-1/audits`, () => json([audit])),
      http.get(`${API_BASE}/audits/a1/controls`, () => json([c])),
    );

    it("says the cycle is closed and offers no Upload or Submit, even for a control that would otherwise take evidence", async () => {
      mockCycle(closed, { ...control, fileCount: 1 });
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      const notice = await screen.findByRole("region", { name: "Audit cycle closed" });
      expect(notice).toHaveTextContent("Closed on 2026-11-05.");
      await screen.findByText("A.8.5 Secure authentication");
      expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Reopen/ })).not.toBeInTheDocument(); // a client can't reopen
    });

    it("the same control on an open cycle does offer both (so the above is the lock)", async () => {
      mockCycle(open, { ...control, fileCount: 1 });
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      await screen.findByText("A.8.5 Secure authentication");
      expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Audit cycle closed" })).not.toBeInTheDocument();
    });

    it("a client lead gets View instead of Assign, and the drawer cannot change assignments or add comments", async () => {
      mockCycle(closed);
      server.use(
        http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/assignments`, () => json([{ userId: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor" }])),
        http.get(`${API_BASE}/tenants/tenant-1/users`, () => json([{ id: "u-lee", email: "lee@brightpath.test", fullName: "Lee", role: "contributor", status: "active" }])),
      );
      renderApp(<MyControlsPage />, { user: { ...TENANT_USER, role: "tenant_lead" } });
      expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole("button", { name: "Details and assignment for A.8.5" }));
      expect(screen.getByRole("button", { name: "Details and assignment for A.8.5" })).toHaveTextContent("View");
      const assigned = await screen.findByRole("region", { name: "Assigned to" });
      expect(assigned).toHaveTextContent("Sam Okafor");
      expect(within(assigned).queryByRole("button")).not.toBeInTheDocument();
      expect(within(assigned).queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Add a comment")).not.toBeInTheDocument();
    });

    it("on an open cycle that same client lead does see Assign", async () => {
      mockCycle(open);
      renderApp(<MyControlsPage />, { user: { ...TENANT_USER, role: "tenant_lead" } });
      expect(await screen.findByRole("button", { name: "Details and assignment for A.8.5" })).toHaveTextContent("Assign");
    });

    it("submitting from a page opened before the cycle was closed explains why it didn't work, and brings the page up to date", async () => {
      let current: Record<string, unknown> = open;
      server.use(
        http.get(`${API_BASE}/tenants/tenant-1/audits`, () => json([current])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([{ ...control, fileCount: 1 }])),
        http.post(`${API_BASE}/controls/c-85/submit`, () => { current = closed; return apiError(409, "AUDIT_CLOSED", "This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it."); }),
      );
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      await userEvent.click(await screen.findByRole("button", { name: "Submit" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/audit cycle is closed, so it can no longer be changed/);
      expect(await screen.findByRole("region", { name: "Audit cycle closed" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
    });

    it("any other failure to submit also shows a message instead of being lost", async () => {
      mockCycle(open, { ...control, fileCount: 1 });
      server.use(http.post(`${API_BASE}/controls/c-85/submit`, () => new Response("boom", { status: 500 })));
      renderApp(<MyControlsPage />, { user: TENANT_USER });
      await userEvent.click(await screen.findByRole("button", { name: "Submit" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Audit cycle closed" })).not.toBeInTheDocument();
    });
  });
});
