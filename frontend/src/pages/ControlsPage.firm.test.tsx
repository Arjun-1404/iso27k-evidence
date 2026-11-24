// The Controls page from the audit firm's side: the Yes / No applicability column, closing a control, and what a custom role hides.

import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { AccessProvider } from "../api/AccessProvider";
import { ControlsPage } from "./ControlsPage";
import type { ControlSummary, Permission } from "../api/types";

const control = (over: Partial<ControlSummary> = {}): ControlSummary => ({
  id: "c-74", kind: "annex", section: "A.7 Physical controls", controlRef: "A.7.4", title: "Physical security monitoring", effectiveEvidence: "CCTV policy", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "awaiting_evidence", dueDate: null, requirementChangedAt: null, fileCount: 0, ...over,
});

function mockAudit(controls: ControlSummary[]) {
  server.use(
    http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
    http.get(`${API_BASE}/tenants/t1/audits`, () => json([{ id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01" }])),
    http.get(`${API_BASE}/audits/a1/controls`, () => json(controls)),
    http.get(`${API_BASE}/controls/:id/files`, () => json([])),
    http.get(`${API_BASE}/controls/:id/comments`, () => json([])),
  );
}
function takeAway(...denied: Permission[]) {
  server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "lead_auditor", customRole: { id: "r", name: "Restricted" }, denied })));
}
const show = (role: "lead_auditor" | "auditor" | "org_admin" = "lead_auditor") =>
  renderApp(<AccessProvider><ControlsPage /></AccessProvider>, { user: { ...AUDITOR_USER, role } });

describe("the Applicable column", () => {
  it("is a Yes / No choice for a lead auditor", async () => {
    mockAudit([control()]);
    show();
    expect(await screen.findByLabelText("Applicable: A.7.4")).toHaveValue("yes");
  });

  it("marking a control No asks why, saves it, and the row then shows N/A with no way to chase or close it", async () => {
    let controls = [control()];
    mockAudit(controls);
    const seen: unknown[] = [];
    server.use(
      http.patch(`${API_BASE}/controls/c-74/applicability`, async ({ request }) => {
        const body = (await request.json()) as { naJustification: string };
        seen.push(body);
        controls = [control({ applicable: false, naJustification: body.naJustification })];
        return json({ id: "c-74" });
      }),
      http.get(`${API_BASE}/audits/a1/controls`, () => json(controls)),
    );
    show();
    await userEvent.selectOptions(await screen.findByLabelText("Applicable: A.7.4"), "no");
    await userEvent.type(await screen.findByLabelText("Why doesn't it apply?"), "The client has no premises");
    await userEvent.click(screen.getByRole("button", { name: "Mark not applicable" }));
    await waitFor(() => expect(seen).toEqual([{ applicable: false, naJustification: "The client has no premises" }]));
    const row = (await screen.findByText("N/A")).closest("tr")!;
    expect(within(row).getByLabelText("Applicable: A.7.4")).toHaveValue("no");
    expect(within(row).queryByRole("button", { name: "Remind" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Close A\.7\.4/ })).not.toBeInTheDocument();
  });

  it("an auditor, who can't change it, sees Yes or No as text", async () => {
    mockAudit([control(), control({ id: "c-75", controlRef: "A.7.5", applicable: false, naJustification: "Not in scope" })]);
    show("auditor");
    await screen.findByText("A.7.4");
    expect(screen.queryByLabelText(/^Applicable:/)).not.toBeInTheDocument(); // (the client picker is also a dropdown, so look for this one by name)
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("a lead auditor whose role took away 'applicability' sees text too", async () => {
    takeAway("applicability");
    mockAudit([control()]);
    show();
    await screen.findByText("A.7.4");
    await waitFor(() => expect(screen.queryByLabelText("Applicable: A.7.4")).not.toBeInTheDocument());
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });
});

describe("closing from the list", () => {
  it("a reviewer sees Close… on a control the client still owes evidence for, which opens its panel", async () => {
    mockAudit([control()]);
    show("auditor");
    await userEvent.click(await screen.findByRole("button", { name: "Close A.7.4 without client evidence" }));
    expect(await screen.findByRole("button", { name: "Close without client evidence" })).toBeInTheDocument();
  });

  it("closing it from the panel sends the reason and reloads the list", async () => {
    let controls = [control()];
    mockAudit(controls);
    const seen: unknown[] = [];
    server.use(
      http.post(`${API_BASE}/controls/c-74/reviews`, async ({ request }) => { seen.push(await request.json()); controls = [control({ status: "accepted" })]; return json({ id: "c-74", status: "accepted" }, 201); }),
      http.get(`${API_BASE}/audits/a1/controls`, () => json(controls)),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Close A.7.4 without client evidence" }));
    await userEvent.click(await screen.findByRole("button", { name: "Close without client evidence" }));
    await userEvent.type(screen.getByLabelText("Reason for closing"), "Seen on site");
    await userEvent.click(screen.getByRole("button", { name: "Confirm close" }));
    await waitFor(() => expect(seen).toEqual([{ decision: "close", reason: "Seen on site" }]));
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
  });

  it("is not there for a reviewer whose role took away 'review' (and they lose Accept / Reject too)", async () => {
    takeAway("review");
    mockAudit([control(), control({ id: "c-75", controlRef: "A.7.5", status: "submitted", fileCount: 1 })]);
    show();
    await screen.findByText("A.7.5");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /without client evidence/ })).not.toBeInTheDocument();
  });
});

describe("what other custom roles hide", () => {
  it("no Remind button once 'remind' is taken away", async () => {
    takeAway("remind");
    mockAudit([control()]);
    show();
    await screen.findByText("A.7.4");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remind" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Close A\.7\.4/ })).toBeInTheDocument(); // what it still has stays
  });

  it("no pencil to change the evidence asked for once 'requirements' is taken away", async () => {
    takeAway("requirements");
    mockAudit([control()]);
    show();
    await screen.findByText("A.7.4");
    await waitFor(() => expect(screen.queryByLabelText("Edit evidence required for A.7.4")).not.toBeInTheDocument());
  });

  it("no due-date box in the panel once 'due_dates' is taken away", async () => {
    takeAway("due_dates");
    mockAudit([control()]);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Close A.7.4 without client evidence" }));
    await screen.findByText(/Files in the storage folder/);
    expect(screen.queryByLabelText("Due date", { selector: "input" })).not.toBeInTheDocument();
  });

  it("with nothing taken away a lead auditor has the pencil, the due-date box and the choice", async () => {
    mockAudit([control()]);
    show();
    expect(await screen.findByLabelText("Edit evidence required for A.7.4")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close A.7.4 without client evidence" }));
    expect(await screen.findByLabelText("Due date", { selector: "input" })).toBeInTheDocument();
  });
});
