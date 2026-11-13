import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { BulkAssign } from "./BulkAssign";
import type { ControlSummary, OrgUser } from "../api/types";

const ctl = (id: string, section: string, over: Partial<ControlSummary> = {}): ControlSummary => ({
  id, kind: "annex", section, controlRef: id.toUpperCase(), title: `Control ${id}`, effectiveEvidence: "x", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "not_started", dueDate: null, requirementChangedAt: null, fileCount: 0, ...over,
});
const CONTROLS = [
  ctl("c1", "A.5 Organizational"), ctl("c2", "A.5 Organizational"), ctl("c3", "A.5 Organizational", { applicable: false, naJustification: "No such thing" }),
  ctl("c4", "A.8 Technological"), ctl("c5", "A.8 Technological"),
];
const person = (over: Partial<OrgUser> & { id: string; email: string }): OrgUser => ({ fullName: null, role: "contributor", status: "active", ...over });
const SAM = person({ id: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor" });
const LEE = person({ id: "u-lee", email: "lee@brightpath.test", role: "tenant_lead" });
const VIEWER = person({ id: "u-vi", email: "viewer@brightpath.test", role: "viewer" });

function mockPeople(users: OrgUser[]) { server.use(http.get(`${API_BASE}/tenants/t1/users`, () => json(users))); }
const renderIt = (controls = CONTROLS) => renderApp(<BulkAssign auditId="a1" tenantId="t1" controls={controls} />, { user: AUDITOR_USER });
const scopeOptions = () => within(screen.getByLabelText("Controls")).getAllByRole("option").map((o) => o.textContent);

describe("BulkAssign", () => {
  it("offers all applicable controls, then each section, with counts that leave out not-applicable controls", async () => {
    mockPeople([SAM]);
    renderIt();
    await screen.findByLabelText("Person");
    expect(scopeOptions()).toEqual(["All applicable controls (4)", "A.5 Organizational (2)", "A.8 Technological (2)"]);
  });

  it("offers only people who do the work", async () => {
    mockPeople([SAM, LEE, VIEWER, person({ id: "u-x", email: "off@brightpath.test", status: "disabled" })]);
    renderIt();
    const select = await screen.findByLabelText("Person");
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a person…", "Sam Okafor (sam@brightpath.test)", "lee@brightpath.test",
    ]));
  });

  it("cannot assign until a person is chosen", async () => {
    mockPeople([SAM]);
    renderIt();
    await screen.findByLabelText("Person");
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    expect(screen.getByRole("button", { name: "Assign" })).toBeEnabled();
  });

  it("assigns every applicable control to the chosen person in one request", async () => {
    mockPeople([SAM]);
    const seen: { url: string; body: unknown }[] = [];
    server.use(http.post(`${API_BASE}/audits/a1/assignments`, async ({ request }) => {
      seen.push({ url: request.url, body: await request.json() });
      return json({ assigned: 4 }, 201);
    }));
    renderIt();
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("status")).toHaveTextContent("4 controls assigned to Sam Okafor (sam@brightpath.test).");
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ userId: "u-sam", controlIds: ["c1", "c2", "c4", "c5"] }); // the not-applicable c3 is left out
  });

  it("sends the person that was chosen, not the first one in the list", async () => {
    mockPeople([SAM, LEE]);
    let body: { userId: string } | null = null;
    server.use(http.post(`${API_BASE}/audits/a1/assignments`, async ({ request }) => { body = (await request.json()) as { userId: string }; return json({ assigned: 4 }, 201); }));
    renderIt();
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(3));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-lee");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("status")).toHaveTextContent("4 controls assigned to lee@brightpath.test.");
    expect(body).toEqual({ userId: "u-lee", controlIds: ["c1", "c2", "c4", "c5"] });
  });

  it("assigns just one section when that is chosen", async () => {
    mockPeople([SAM]);
    let body: unknown = null;
    server.use(http.post(`${API_BASE}/audits/a1/assignments`, async ({ request }) => { body = await request.json(); return json({ assigned: 2 }, 201); }));
    renderIt();
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    await userEvent.selectOptions(screen.getByLabelText("Controls"), "A.8 Technological");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await screen.findByRole("status");
    expect(body).toEqual({ userId: "u-sam", controlIds: ["c4", "c5"] });
  });

  it("says how many were already assigned, and uses the singular for one", async () => {
    mockPeople([SAM]);
    server.use(http.post(`${API_BASE}/audits/a1/assignments`, () => json({ assigned: 1 }, 201)));
    renderIt();
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    await userEvent.selectOptions(screen.getByLabelText("Controls"), "A.5 Organizational");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 control assigned to Sam Okafor (sam@brightpath.test) (1 already were).");
  });

  it("shows the server's reason when it fails, as an alert rather than a success message", async () => {
    mockPeople([SAM]);
    server.use(http.post(`${API_BASE}/audits/a1/assignments`, () => apiError(403, "FORBIDDEN_ROLE", "You don't have access to do that.")));
    renderIt();
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have access to do that.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("with no one to assign to, points at the Users page instead of showing an unusable form", async () => {
    mockPeople([VIEWER]);
    renderIt();
    expect(await screen.findByText(/first invite them under/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Person")).not.toBeInTheDocument();
  });

  it("with nothing applicable, offers nothing to assign", async () => {
    mockPeople([SAM]);
    renderIt([ctl("c3", "A.5 Organizational", { applicable: false, naJustification: "n/a here" })]);
    await waitFor(() => expect(within(screen.getByLabelText("Person")).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
  });
});
