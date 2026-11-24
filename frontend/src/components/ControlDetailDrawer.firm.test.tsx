// What the audit firm can do from a control's panel: close it without client evidence, say whether it applies, set its due date.

import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { AccessProvider } from "../api/AccessProvider";
import { ControlDetailDrawer } from "./ControlDetailDrawer";
import type { ControlSummary } from "../api/types";

const base: ControlSummary = {
  id: "c1", kind: "annex", section: "A.7 Physical controls", controlRef: "A.7.4", title: "Physical security monitoring", effectiveEvidence: "CCTV policy",
  effectiveFileSpec: {}, isOverridden: false, applicable: true, naJustification: null, status: "not_started", dueDate: null, requirementChangedAt: null, fileCount: 0,
};

function mockData() {
  server.use(
    http.get(`${API_BASE}/controls/c1/files`, () => json([])),
    http.get(`${API_BASE}/controls/c1/comments`, () => json([])),
    http.get(`${API_BASE}/controls/c1/assignments`, () => json([])),
    http.get(`${API_BASE}/tenants`, () => json([])),
  );
}

type Props = Partial<Parameters<typeof ControlDetailDrawer>[0]>;
function show(control: Partial<ControlSummary> = {}, props: Props = {}) {
  mockData();
  const onChanged = vi.fn(); const onClose = vi.fn();
  renderApp(
    <AccessProvider><ControlDetailDrawer control={{ ...base, ...control }} canReview onClose={onClose} onChanged={onChanged} {...props} /></AccessProvider>,
    { user: AUDITOR_USER },
  );
  return { onChanged, onClose };
}
const closeButton = () => screen.queryByRole("button", { name: "Close without client evidence" });

describe("closing a control without client evidence", () => {
  it.each(["not_started", "awaiting_evidence", "rejected"] as const)("is offered for a control that is %s", async (status) => {
    show({ status });
    expect(await screen.findByRole("button", { name: "Close without client evidence" })).toBeInTheDocument();
  });

  it("is offered for a control put back under review only when it has no file", async () => {
    show({ status: "under_review", fileCount: 0 });
    expect(await screen.findByRole("button", { name: "Close without client evidence" })).toBeInTheDocument();
  });

  it.each([
    ["submitted: the reviewer accepts or rejects it instead", { status: "submitted" as const, fileCount: 1 }, {}],
    ["under review with a file", { status: "under_review" as const, fileCount: 1 }, {}],
    ["already accepted", { status: "accepted" as const }, {}],
    ["not applicable", { applicable: false, naJustification: "n/a" }, {}],
    ["for someone who may not review", {}, { canReview: false }],
    ["in a closed cycle", {}, { readOnly: true }],
  ])("is not offered when it is %s", async (_why, control, props) => {
    show(control, props);
    await screen.findByText(/Files in the storage folder/);
    expect(closeButton()).not.toBeInTheDocument();
  });

  it("asks for the reason first, and closes with it", async () => {
    const seen: unknown[] = [];
    server.use(http.post(`${API_BASE}/controls/c1/reviews`, async ({ request }) => { seen.push(await request.json()); return json({ id: "c1", status: "accepted" }, 201); }));
    const { onChanged, onClose } = show();
    await userEvent.click(await screen.findByRole("button", { name: "Close without client evidence" }));
    const confirm = screen.getByRole("button", { name: "Confirm close" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason for closing"), "ab");
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason for closing"), "  Seen on site on 12 March ");
    expect(confirm).toBeEnabled();
    expect(seen).toEqual([]);
    await userEvent.click(confirm);
    await waitFor(() => expect(seen).toEqual([{ decision: "close", reason: "ab  Seen on site on 12 March" }]));
    await waitFor(() => { expect(onChanged).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1); });
  });

  it("cancelling forgets what was typed", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Close without client evidence" }));
    await userEvent.type(screen.getByLabelText("Reason for closing"), "Something");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Close without client evidence" }));
    expect(screen.getByLabelText("Reason for closing")).toHaveValue("");
  });

  it("says what the server said when it refuses, and stays open", async () => {
    server.use(http.post(`${API_BASE}/controls/c1/reviews`, () => apiError(409, "NEEDS_REVIEW", "The client has submitted evidence for this control. Review it and accept or reject it instead.")));
    const { onClose } = show();
    await userEvent.click(await screen.findByRole("button", { name: "Close without client evidence" }));
    await userEvent.type(screen.getByLabelText("Reason for closing"), "Seen on site");
    await userEvent.click(screen.getByRole("button", { name: "Confirm close" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The client has submitted evidence for this control.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an accepted control with no files says it was closed by the firm", async () => {
    show({ status: "accepted", fileCount: 0 });
    expect(await screen.findByText(/Closed by the audit firm without evidence from the client/)).toBeInTheDocument();
  });

  it("is hidden from a reviewer whose role took away 'review'", async () => {
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "auditor", customRole: { id: "r", name: "Look only" }, denied: ["review"] })));
    // The page works out canReview from the role and the ability, as ControlsPage does; the drawer trusts what it is given.
    show({}, { canReview: false });
    await screen.findByText(/Files in the storage folder/);
    expect(closeButton()).not.toBeInTheDocument();
  });
});

describe("applicability in the control's panel", () => {
  it("a person who may set it gets a Yes / No choice", async () => {
    show({}, { canSetApplicability: true });
    expect(await screen.findByLabelText("Applicable: A.7.4")).toHaveValue("yes");
  });

  it("a not-applicable control shows as such to everyone, with the reason", async () => {
    show({ applicable: false, naJustification: "No physical premises" }, { canReview: false });
    expect(await screen.findByText("No")).toBeInTheDocument();
    expect(screen.getByText("No physical premises")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("is not shown at all to someone who can't set it, for a control that applies", async () => {
    show();
    await screen.findByText(/Files in the storage folder/);
    expect(screen.queryByRole("region", { name: "Applicability" })).not.toBeInTheDocument();
  });

  it("has no choice for a mandatory clause", async () => {
    show({ kind: "clause", controlRef: "4.1" }, { canSetApplicability: true });
    await screen.findByText(/Files in the storage folder/);
    expect(screen.queryByRole("region", { name: "Applicability" })).not.toBeInTheDocument();
  });

  it("changes nothing in a closed cycle", async () => {
    show({}, { canSetApplicability: true, readOnly: true });
    expect(await screen.findByText("Yes")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("due dates in the control's panel", () => {
  const dueInput = () => screen.getByLabelText("Due date", { selector: "input" }) as HTMLInputElement;

  it("sets a due date", async () => {
    const seen: unknown[] = [];
    server.use(http.patch(`${API_BASE}/controls/c1/due-date`, async ({ request }) => { seen.push(await request.json()); return json({ id: "c1" }); }));
    const { onChanged } = show({}, { canSetDueDate: true });
    await screen.findByLabelText("Due date", { selector: "input" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // unchanged
    await userEvent.type(dueInput(), "2026-12-01");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(seen).toEqual([{ dueDate: "2026-12-01" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Due date set to 2026-12-01.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("clears one that was set", async () => {
    const seen: unknown[] = [];
    server.use(http.patch(`${API_BASE}/controls/c1/due-date`, async ({ request }) => { seen.push(await request.json()); return json({ id: "c1" }); }));
    show({ dueDate: "2026-12-01" }, { canSetDueDate: true });
    expect(await screen.findByLabelText("Due date", { selector: "input" })).toHaveValue("2026-12-01");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(seen).toEqual([{ dueDate: null }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Due date cleared.");
  });

  it("shows the server's reason when it can't be saved", async () => {
    server.use(http.patch(`${API_BASE}/controls/c1/due-date`, () => apiError(403, "FORBIDDEN_PERMISSION", "your role does not allow changing due dates")));
    const { onChanged } = show({}, { canSetDueDate: true });
    await screen.findByLabelText("Due date", { selector: "input" });
    await userEvent.type(dueInput(), "2026-12-01");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("your role does not allow changing due dates");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("is read-only text for someone who can't set it, and absent when there is none", async () => {
    show({ dueDate: "2026-12-01" });
    expect(await screen.findByText("Due 2026-12-01")).toBeInTheDocument();
    expect(screen.queryByLabelText("Due date", { selector: "input" })).not.toBeInTheDocument();
  });

  it("is not offered for a control that doesn't apply", async () => {
    show({ applicable: false, naJustification: "n/a here" }, { canSetDueDate: true });
    await screen.findByText(/Files in the storage folder/);
    expect(screen.queryByLabelText("Due date", { selector: "input" })).not.toBeInTheDocument();
  });
});

describe("comments for a role that can't comment", () => {
  it("replaces the comment box with a plain line", async () => {
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "contributor", customRole: { id: "r", name: "Uploader" }, denied: ["comment"] })));
    show();
    expect(await screen.findByText("Your role doesn't include adding comments.")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Add a comment")).not.toBeInTheDocument();
  });
});
