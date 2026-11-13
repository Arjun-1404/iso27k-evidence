import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { ControlsPage } from "./ControlsPage";

import type { ControlSummary } from "../api/types";

const baseControl: ControlSummary = {
  id: "c-85", kind: "annex" as const, section: "A.8 Technological controls", controlRef: "A.8.5",
  title: "Secure authentication", effectiveEvidence: "MFA settings, login controls", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "awaiting_evidence" as const,
  dueDate: null, requirementChangedAt: null, fileCount: 0,
};

function mockBaseline(extra: Partial<typeof baseControl> = {}) {
  server.use(
    http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
    http.get(`${API_BASE}/tenants/t1/audits`, () => json([{ id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01" }])),
    http.get(`${API_BASE}/audits/a1/controls`, () => json([{ ...baseControl, ...extra }])),
  );
}

describe("ControlsPage", () => {
  it("renders the grid with the control's evidence text and status", async () => {
    mockBaseline();
    renderApp(<ControlsPage />, { user: AUDITOR_USER });
    expect(await screen.findByText("A.8.5")).toBeInTheDocument();
    expect(screen.getByText("Secure authentication")).toBeInTheDocument();
    expect(screen.getByText("Awaiting evidence")).toBeInTheDocument();
  });

  it("a lead auditor edits the requirement and it's saved with the new text and file spec", async () => {
    mockBaseline();
    let patchBody: unknown = null;
    server.use(
      http.patch(`${API_BASE}/controls/c-85/requirement`, async ({ request }) => {
        patchBody = await request.json();
        return json({ id: "c-85" });
      }),
    );
    renderApp(<ControlsPage />, { user: AUDITOR_USER });
    await screen.findByText("A.8.5");

    await userEvent.click(screen.getByLabelText("Edit evidence required for A.8.5"));
    const dialog = await screen.findByRole("dialog", { name: /Evidence required/ });
    const textarea = within(dialog).getByLabelText("What the tenant should provide");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Up to 4 documents");
    await userEvent.click(within(dialog).getByText("Save"));

    await waitFor(() => expect(patchBody).toEqual({ evidenceText: "Up to 4 documents", fileSpec: { types: ["any"], maxFiles: 4 } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("remind is only available while evidence is outstanding, and calls the remind endpoint", async () => {
    mockBaseline();
    let reminded = false;
    server.use(http.post(`${API_BASE}/controls/c-85/remind`, () => { reminded = true; return json({ remindedCount: 1 }); }));
    renderApp(<ControlsPage />, { user: AUDITOR_USER });
    const remindButton = await screen.findByText("Remind");
    await userEvent.click(remindButton);
    await waitFor(() => expect(reminded).toBe(true));
  });

  it("tells the auditor when a reminder could not be emailed, and keeps Remind available to try again", async () => {
    mockBaseline();
    server.use(http.post(`${API_BASE}/controls/c-85/remind`, () =>
      new Response(JSON.stringify({ error: { code: "EMAIL_DELIVERY_FAILED", message: "The email could not be sent." } }), { status: 502 })));
    renderApp(<ControlsPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Remind"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/was not sent because the email could not be delivered.*try again/i);
    expect(screen.getByText("Remind")).toBeInTheDocument(); // not marked as reminded
  });

  it("accepting evidence opens the drawer, shows files, and posts an accept decision", async () => {
    mockBaseline({ status: "submitted", fileCount: 1 });
    server.use(
      http.get(`${API_BASE}/controls/c-85/files`, () => json([{ id: "f1", fileName: "mfa.pdf", sizeBytes: 2048, scanStatus: "clean", integrityStatus: "unchecked", uploadedAt: "2026-01-01", providerFileId: "p1" }])),
      http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
    );
    let reviewBody: unknown = null;
    server.use(http.post(`${API_BASE}/controls/c-85/reviews`, async ({ request }) => { reviewBody = await request.json(); return json({ id: "c-85", status: "accepted" }, 201); }));

    renderApp(<ControlsPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Review"));
    expect(await screen.findByText("mfa.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Accept"));
    await waitFor(() => expect(reviewBody).toEqual({ decision: "accept", reason: undefined }));
  });

  it("rejecting requires a reason before the confirm button is enabled", async () => {
    mockBaseline({ status: "submitted", fileCount: 1 });
    server.use(
      http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
      http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
    );
    renderApp(<ControlsPage />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByText("Review"));
    await userEvent.click(await screen.findByText("Reject"));
    const confirmButton = screen.getByText("Confirm reject");
    expect(confirmButton).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("Reason for rejecting"), "Blurry screenshot");
    expect(confirmButton).not.toBeDisabled();
  });

  describe("assigning controls to the client's people", () => {
    const sam = { id: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor", status: "active" };

    it("a lead auditor sees the assign panel, and it hands the whole audit to one person", async () => {
      mockBaseline();
      let body: unknown = null;
      server.use(
        http.get(`${API_BASE}/tenants/t1/users`, () => json([sam])),
        http.post(`${API_BASE}/audits/a1/assignments`, async ({ request }) => { body = await request.json(); return json({ assigned: 1 }, 201); }),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      const panel = await screen.findByRole("region", { name: "Assign controls" });
      await waitFor(() => expect(within(within(panel).getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
      await userEvent.selectOptions(within(panel).getByLabelText("Person"), "u-sam");
      await userEvent.click(within(panel).getByRole("button", { name: "Assign" }));
      await within(panel).findByRole("status");
      expect(body).toEqual({ userId: "u-sam", controlIds: ["c-85"] });
    });

    it("a read-only auditor is not shown the assign panel", async () => {
      mockBaseline();
      renderApp(<ControlsPage />, { user: { ...AUDITOR_USER, role: "auditor" } });
      await screen.findByText("A.8.5");
      expect(screen.queryByRole("region", { name: "Assign controls" })).not.toBeInTheDocument();
    });

    it("the control's drawer has an Assigned to section for a lead auditor, and none for a read-only auditor", async () => {
      mockBaseline({ status: "submitted", fileCount: 1 });
      server.use(
        http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/assignments`, () => json([{ userId: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor" }])),
      );
      const first = renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByText("Review"));
      expect(await screen.findByRole("region", { name: "Assigned to" })).toHaveTextContent("Sam Okafor (sam@brightpath.test)");
      first.unmount();

      renderApp(<ControlsPage />, { user: { ...AUDITOR_USER, role: "auditor" } });
      await userEvent.click(await screen.findByText("Review"));
      await screen.findByText("Accept");
      expect(screen.queryByRole("region", { name: "Assigned to" })).not.toBeInTheDocument();
    });
  });

  describe("audit cycles", () => {
    const cycles = [
      { id: "a2", name: "2027 surveillance", status: "in_progress", templateVersion: "1", createdAt: "2027-02-01T00:00:00.000Z" },
      { id: "a1", name: "2026 certification", status: "in_progress", templateVersion: "1", createdAt: "2026-02-01T00:00:00.000Z" },
    ];
    const old = { ...baseControl, id: "c-old", title: "Control from the first cycle" };
    const recent = { ...baseControl, id: "c-new", title: "Control from the second cycle" };
    function mockCycles() {
      localStorage.clear();
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => json(cycles)),
        http.get(`${API_BASE}/audits/a2/controls`, () => json([recent])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([old])),
      );
    }

    it("opens the newest cycle, and switching shows the other cycle's controls", async () => {
      mockCycles();
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      expect(await screen.findByText("Control from the second cycle")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Controls" }).nextElementSibling).toHaveTextContent("2027 surveillance");
      await userEvent.selectOptions(screen.getByLabelText("Audit cycle"), "a1");
      expect(await screen.findByText("Control from the first cycle")).toBeInTheDocument();
      expect(screen.queryByText("Control from the second cycle")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Controls" }).nextElementSibling).toHaveTextContent("2026 certification");
    });

    it("a lead auditor can start a new cycle, and the page moves to it", async () => {
      mockCycles();
      let list = cycles;
      const fresh = { id: "a3", name: "2028 recertification", status: "in_progress", templateVersion: "1", createdAt: "2028-02-01T00:00:00.000Z" };
      server.use(
        http.get(`${API_BASE}/tenants/t1/audits`, () => json(list)),
        http.get(`${API_BASE}/templates`, () => json([{ id: "tmpl", framework: "ISO 27001", version: "2022", name: "Default", isPlatformDefault: true }])),
        http.post(`${API_BASE}/tenants/t1/audits`, () => { list = [fresh, ...cycles]; return json(fresh, 201); }),
        http.get(`${API_BASE}/audits/a3/controls`, () => json([{ ...baseControl, id: "c-3", title: "Control from the third cycle" }])),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await screen.findByText("Control from the second cycle");
      // looking at an older cycle when the new one is started: the page must still move to the new one
      await userEvent.selectOptions(screen.getByLabelText("Audit cycle"), "a1");
      await screen.findByText("Control from the first cycle");
      await userEvent.click(screen.getByRole("button", { name: "New audit cycle" }));
      const form = await screen.findByRole("region", { name: "New audit cycle" });
      await waitFor(() => expect(within(form).getByLabelText("Template")).toHaveValue("tmpl"));
      await userEvent.click(within(form).getByRole("button", { name: "Create" }));
      expect(await screen.findByText("Control from the third cycle")).toBeInTheDocument();
      expect(screen.getByLabelText("Audit cycle")).toHaveValue("a3");
    });

    it("a read-only auditor can switch cycles but cannot start one", async () => {
      mockCycles();
      renderApp(<ControlsPage />, { user: { ...AUDITOR_USER, role: "auditor" } });
      await screen.findByText("Control from the second cycle");
      expect(screen.getByLabelText("Audit cycle")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New audit cycle" })).not.toBeInTheDocument();
    });
  });

  describe("closing an audit cycle", () => {
    const CLOSED_AT = "2026-11-05T16:30:00.000Z";
    const audit = (over: Record<string, unknown> = {}) => ({ id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01", closedAt: null, closedBy: null, ...over });
    const closedAudit = audit({ status: "closed", closedAt: CLOSED_AT, closedBy: "Priya Nair" });
    const mockCycle = (a: Record<string, unknown>, control: Partial<typeof baseControl> = {}) => server.use(
      http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
      http.get(`${API_BASE}/tenants/t1/audits`, () => json([a])),
      http.get(`${API_BASE}/audits/a1/controls`, () => json([{ ...baseControl, ...control }])),
      http.get(`${API_BASE}/tenants/t1/users`, () => json([{ id: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor", status: "active" }])),
    );

    it("a lead auditor can close an open cycle, and the page then shows it closed with every way of editing taken away", async () => {
      let current: Record<string, unknown> = audit();
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => json([current])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([{ ...baseControl, fileCount: 1 }])),
        http.get(`${API_BASE}/tenants/t1/users`, () => json([])),
        http.post(`${API_BASE}/audits/a1/close`, () => { current = closedAudit; return json(current); }),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await screen.findByText("A.8.5");
      // while open: editing is available
      expect(screen.getByLabelText("Edit evidence required for A.8.5")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remind" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Audit cycle closed" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
      expect(screen.getByText(/1 applicable control is not accepted yet/)).toBeInTheDocument(); // the heads-up uses the page's own controls
      await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));

      const notice = await screen.findByRole("region", { name: "Audit cycle closed" });
      expect(notice).toHaveTextContent("Closed on 2026-11-05 by Priya Nair.");
      expect(screen.queryByLabelText("Edit evidence required for A.8.5")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remind" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Assign controls" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close audit cycle" })).not.toBeInTheDocument();
      expect(screen.getByText("A.8.5")).toBeInTheDocument(); // everything is still there to read
      expect(screen.getByText("MFA settings, login controls")).toBeInTheDocument();
    });

    it("a closed cycle: no edit pencil, no Remind, no Review, no assign panel — only View", async () => {
      mockCycle(closedAudit, { status: "submitted", fileCount: 1 });
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      expect(await screen.findByRole("region", { name: "Audit cycle closed" })).toBeInTheDocument();
      await screen.findByText("A.8.5");
      expect(screen.queryByLabelText("Edit evidence required for A.8.5")).not.toBeInTheDocument();
      expect(screen.queryByText("Review")).not.toBeInTheDocument();
      expect(screen.queryByText("Remind")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Assign controls" })).not.toBeInTheDocument();
      expect(screen.getByText("View")).toBeInTheDocument();
    });

    it("the same controls on an open cycle do have Review, the pencil and the assign panel (so the above is the lock, not missing data)", async () => {
      mockCycle(audit(), { status: "submitted", fileCount: 1 });
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await screen.findByText("A.8.5");
      expect(screen.getByText("Review")).toBeInTheDocument();
      expect(screen.getByLabelText("Edit evidence required for A.8.5")).toBeInTheDocument();
      expect(await screen.findByRole("region", { name: "Assign controls" })).toBeInTheDocument();
    });

    it("the drawer of a closed cycle shows files and comments but has no comment box, no decision and no assignment changes", async () => {
      mockCycle(closedAudit, { status: "submitted", fileCount: 1 });
      server.use(
        http.get(`${API_BASE}/controls/c-85/files`, () => json([{ id: "f1", fileName: "mfa.pdf", sizeBytes: 2048, scanStatus: "clean", integrityStatus: "unchecked", uploadedAt: "2026-02-01", providerFileId: "p1" }])),
        http.get(`${API_BASE}/controls/c-85/comments`, () => json([{ id: "m1", type: "comment", body: "Looks complete", authorId: "x", createdAt: "2026-02-02" }])),
        http.get(`${API_BASE}/controls/c-85/assignments`, () => json([{ userId: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor" }])),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByText("View"));
      expect(await screen.findByText("mfa.pdf")).toBeInTheDocument();
      expect(screen.getByText("Looks complete")).toBeInTheDocument();
      expect(screen.getByText("This audit cycle is closed, so comments can't be added.")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Add a comment")).not.toBeInTheDocument();
      expect(screen.queryByText("Accept")).not.toBeInTheDocument();
      expect(screen.queryByText("Reject")).not.toBeInTheDocument();
      const assigned = await screen.findByRole("region", { name: "Assigned to" });
      expect(assigned).toHaveTextContent("Sam Okafor (sam@brightpath.test)");
      expect(assigned).toHaveTextContent("assignments can't be changed");
      expect(within(assigned).queryByRole("button")).not.toBeInTheDocument();
    });

    it("people who may not close a cycle are not offered the button, but see a closed cycle's notice", async () => {
      mockCycle(audit());
      const first = renderApp(<ControlsPage />, { user: { ...AUDITOR_USER, role: "auditor" } });
      await screen.findByText("A.8.5");
      expect(screen.queryByRole("button", { name: "Close audit cycle" })).not.toBeInTheDocument();
      first.unmount();

      mockCycle(closedAudit);
      renderApp(<ControlsPage />, { user: { ...AUDITOR_USER, role: "auditor" } });
      expect(await screen.findByRole("region", { name: "Audit cycle closed" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reopen audit cycle" })).not.toBeInTheDocument();
    });

    it("an organisation admin can reopen a closed cycle, with a reason, and editing comes back", async () => {
      let current: Record<string, unknown> = closedAudit; let body: unknown = null;
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => json([current])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([baseControl])),
        http.get(`${API_BASE}/tenants/t1/users`, () => json([])),
        http.post(`${API_BASE}/audits/a1/reopen`, async ({ request }) => { body = await request.json(); current = audit(); return json(current); }),
      );
      renderApp(<ControlsPage />, { user: { ...AUDITOR_USER, role: "org_admin" } });
      await userEvent.click(await screen.findByRole("button", { name: "Reopen audit cycle" }));
      await userEvent.type(screen.getByLabelText("Reason for reopening"), "Client sent a missing policy");
      await userEvent.click(screen.getByRole("button", { name: "Confirm reopen" }));
      expect(await screen.findByLabelText("Edit evidence required for A.8.5")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Audit cycle closed" })).not.toBeInTheDocument();
      expect(body).toEqual({ reason: "Client sent a missing policy" });
    });

    it("a reminder sent from a page that was opened before the cycle was closed explains why it didn't go out, and brings the page up to date", async () => {
      let current: Record<string, unknown> = audit(); let audits = 0;
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => { audits++; return json([current]); }),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([baseControl])),
        http.get(`${API_BASE}/tenants/t1/users`, () => json([])),
        http.post(`${API_BASE}/controls/c-85/remind`, () => { current = closedAudit; return apiError(409, "AUDIT_CLOSED", "This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it."); }),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByText("Remind"));
      expect(await screen.findByText(/audit cycle is closed, so it can no longer be changed/)).toBeInTheDocument();
      expect(await screen.findByRole("region", { name: "Audit cycle closed" })).toBeInTheDocument();
      expect(audits).toBeGreaterThanOrEqual(2);
    });

    it("a decision on a control in a cycle that was closed meanwhile shows the server's explanation, not a guess", async () => {
      mockCycle(audit(), { status: "submitted", fileCount: 1 });
      server.use(
        http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
        http.post(`${API_BASE}/controls/c-85/reviews`, () => apiError(409, "AUDIT_CLOSED", "This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.")),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByText("Review"));
      await userEvent.click(await screen.findByText("Accept"));
      expect(await screen.findByText(/audit cycle is closed, so it can no longer be changed/)).toBeInTheDocument();
    });

    it("a comment refused by the server is explained instead of silently lost", async () => {
      mockCycle(audit(), { status: "submitted", fileCount: 1 });
      server.use(
        http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
        http.get(`${API_BASE}/controls/c-85/comments`, () => json([])),
        http.post(`${API_BASE}/controls/c-85/comments`, () => apiError(409, "AUDIT_CLOSED", "This audit cycle is closed, so it can no longer be changed.")),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByText("Review"));
      await userEvent.type(await screen.findByPlaceholderText("Add a comment"), "A late thought");
      await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This audit cycle is closed, so it can no longer be changed.");
      expect(screen.getByPlaceholderText("Add a comment")).toHaveValue("A late thought"); // what was typed is kept
    });

    it("the heads-up before closing counts exactly the applicable controls that are not accepted", async () => {
      const mk = (id: string, ref: string, over: Partial<typeof baseControl>) => ({ ...baseControl, id, controlRef: ref, title: `Control ${ref}`, ...over });
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => json([audit()])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([
          mk("c1", "A.5.1", { status: "awaiting_evidence" }), mk("c2", "A.5.2", { status: "submitted", fileCount: 1 }),
          mk("c3", "A.5.3", { status: "accepted", fileCount: 1 }), mk("c4", "A.5.4", { applicable: false, status: "not_started" }),
          mk("c5", "A.5.5", { applicable: false, status: "accepted" }),
        ])),
        http.get(`${API_BASE}/tenants/t1/users`, () => json([])),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await screen.findByText("Control A.5.1");
      await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
      expect(screen.getByText(/2 applicable controls are not accepted yet\./)).toBeInTheDocument();
    });

    it("an old 'reminder not sent' message goes away when another reminder is tried", async () => {
      mockCycle(audit());
      let tries = 0;
      server.use(http.post(`${API_BASE}/controls/c-85/remind`, () => {
        tries++;
        return tries === 1 ? apiError(502, "EMAIL_DELIVERY_FAILED", "The email could not be sent.") : json({ remindedCount: 1 });
      }));
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByRole("button", { name: "Remind" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/was not sent/);
      await userEvent.click(screen.getByRole("button", { name: "Remind" }));
      await waitFor(() => expect(tries).toBe(2));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("switching to another cycle starts its Close button afresh: a half-finished close of the previous cycle isn't carried over", async () => {
      localStorage.clear();
      const cycles = [
        audit({ id: "a2", name: "2027 surveillance", createdAt: "2027-02-01T00:00:00.000Z" }),
        audit({ id: "a1", name: "2026 certification", createdAt: "2026-02-01T00:00:00.000Z" }),
      ];
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => json(cycles)),
        http.get(`${API_BASE}/audits/a2/controls`, () => json([baseControl])),
        http.get(`${API_BASE}/audits/a1/controls`, () => json([baseControl])),
        http.get(`${API_BASE}/tenants/t1/users`, () => json([])),
      );
      renderApp(<ControlsPage />, { user: AUDITOR_USER });
      await userEvent.click(await screen.findByRole("button", { name: "Close audit cycle" }));
      expect(screen.getByRole("heading", { name: "Close “2027 surveillance”?" })).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByLabelText("Audit cycle"), "a1");
      await waitFor(() => expect(screen.getByRole("heading", { name: "Controls" }).nextElementSibling).toHaveTextContent("2026 certification"));
      expect(await screen.findByRole("button", { name: "Close audit cycle" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Close “/ })).not.toBeInTheDocument();
    });
  });
});
