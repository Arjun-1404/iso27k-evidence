import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { ApplicabilityControl } from "./ApplicabilityControl";
import type { ControlSummary } from "../api/types";

const control = (over: Partial<ControlSummary> = {}): ControlSummary => ({
  id: "c1", kind: "annex", section: "A.7 Physical", controlRef: "A.7.1", title: "Physical security perimeters", effectiveEvidence: "x", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "not_started", dueDate: null, requirementChangedAt: null, fileCount: 0, ...over,
});

function record() {
  const seen: unknown[] = [];
  server.use(http.patch(`${API_BASE}/controls/c1/applicability`, async ({ request }) => { seen.push(await request.json()); return json({ id: "c1" }); }));
  return seen;
}
const show = (c: ControlSummary, props: { editable?: boolean; onChanged?: () => void; compact?: boolean } = {}) =>
  renderApp(<ApplicabilityControl control={c} editable={props.editable ?? true} onChanged={props.onChanged ?? (() => {})} compact={props.compact} />, { user: AUDITOR_USER });

describe("ApplicabilityControl", () => {
  it("is a Yes / No choice that shows the current answer", () => {
    show(control());
    const select = screen.getByLabelText("Applicable: A.7.1");
    expect(select).toHaveValue("yes");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Yes", "No"]);
  });

  it("mandatory clauses always apply, so they get no choice", () => {
    show(control({ kind: "clause", controlRef: "4.1" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("people who may not change it see the answer as text, with the reason", () => {
    show(control({ applicable: false, naJustification: "No physical premises" }), { editable: false });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getByText("No physical premises")).toBeInTheDocument();
  });

  it("choosing No asks why first and changes nothing until the reason is given", async () => {
    const seen = record();
    const onChanged = vi.fn();
    show(control(), { onChanged });
    await userEvent.selectOptions(screen.getByLabelText("Applicable: A.7.1"), "no");

    const dialog = await screen.findByRole("dialog", { name: "Mark A.7.1 not applicable" });
    expect(seen).toEqual([]);
    const confirm = screen.getByRole("button", { name: "Mark not applicable" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why doesn't it apply?"), "ab");
    expect(confirm).toBeDisabled(); // three characters at least
    await userEvent.type(screen.getByLabelText("Why doesn't it apply?"), "c");
    expect(confirm).toBeEnabled();
    expect(dialog).toBeInTheDocument();

    await userEvent.click(confirm);
    await waitFor(() => expect(seen).toEqual([{ applicable: false, naJustification: "abc" }]));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancelling leaves the control as it was and sends nothing", async () => {
    const seen = record();
    const onChanged = vi.fn();
    show(control(), { onChanged });
    await userEvent.selectOptions(screen.getByLabelText("Applicable: A.7.1"), "no");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Applicable: A.7.1")).toHaveValue("yes");
    expect(seen).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("choosing Yes on a not-applicable control brings it back at once", async () => {
    const seen = record();
    const onChanged = vi.fn();
    show(control({ applicable: false, naJustification: "Out of scope" }), { onChanged });
    expect(screen.getByLabelText("Applicable: A.7.1")).toHaveValue("no");
    await userEvent.selectOptions(screen.getByLabelText("Applicable: A.7.1"), "yes");
    await waitFor(() => expect(seen).toEqual([{ applicable: true }]));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("the reason of a not-applicable control can be changed, starting from the current one", async () => {
    const seen = record();
    show(control({ applicable: false, naJustification: "Out of scope" }));
    await userEvent.click(screen.getByRole("button", { name: "Change the reason for A.7.1" }));
    const box = await screen.findByLabelText("Why doesn't it apply?");
    expect(box).toHaveValue("Out of scope");
    await userEvent.clear(box);
    await userEvent.type(box, "The client has no premises");
    await userEvent.click(screen.getByRole("button", { name: "Mark not applicable" }));
    await waitFor(() => expect(seen).toEqual([{ applicable: false, naJustification: "The client has no premises" }]));
  });

  it("says what the server said when it refuses, and keeps the question open", async () => {
    server.use(http.patch(`${API_BASE}/controls/c1/applicability`, () => apiError(403, "FORBIDDEN_PERMISSION", "your role does not allow changing whether a control applies")));
    const onChanged = vi.fn();
    show(control(), { onChanged });
    await userEvent.selectOptions(screen.getByLabelText("Applicable: A.7.1"), "no");
    await userEvent.type(await screen.findByLabelText("Why doesn't it apply?"), "Not relevant");
    await userEvent.click(screen.getByRole("button", { name: "Mark not applicable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("your role does not allow changing whether a control applies");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("in a table cell the reason isn't repeated under the choice", () => {
    show(control({ applicable: false, naJustification: "Out of scope" }), { compact: true });
    expect(screen.queryByText("Out of scope")).not.toBeInTheDocument();
  });
});
