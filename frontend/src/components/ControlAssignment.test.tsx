import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { ControlAssignment } from "./ControlAssignment";
import type { ControlAssignee, ControlSummary, OrgUser } from "../api/types";

const control: ControlSummary = {
  id: "c-85", kind: "annex", section: "A.8 Technological controls", controlRef: "A.8.5",
  title: "Secure authentication", effectiveEvidence: "MFA settings", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "awaiting_evidence",
  dueDate: null, requirementChangedAt: null, fileCount: 0,
};

const person = (over: Partial<OrgUser> & { id: string; email: string }): OrgUser =>
  ({ fullName: null, role: "contributor", status: "active", ...over });

const SAM = person({ id: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor" });
const LEE = person({ id: "u-lee", email: "lee@brightpath.test", role: "tenant_lead" });
const VIEWER = person({ id: "u-vi", email: "viewer@brightpath.test", role: "viewer" });
const DASH = person({ id: "u-da", email: "dash@brightpath.test", role: "tenant_dashboard" });
const GONE = person({ id: "u-gone", email: "gone@brightpath.test", status: "disabled" });
const INVITED = person({ id: "u-inv", email: "new@brightpath.test", status: "invited" });

function mockPeople(users: OrgUser[], assigned: ControlAssignee[] = []) {
  server.use(
    http.get(`${API_BASE}/tenants/t1/users`, () => json(users)),
    http.get(`${API_BASE}/controls/c-85/assignments`, () => json(assigned)),
  );
}
const asAssignee = (u: OrgUser): ControlAssignee => ({ userId: u.id, email: u.email, fullName: u.fullName, role: u.role });

const renderIt = () => renderApp(<ControlAssignment control={control} tenantId="t1" />, { user: AUDITOR_USER });
const options = () => within(screen.getByLabelText("Person to assign")).getAllByRole("option").map((o) => o.textContent);

describe("ControlAssignment", () => {
  it("lists who the control is assigned to, by name and address", async () => {
    mockPeople([SAM, LEE], [asAssignee(SAM)]);
    renderIt();
    expect(await screen.findByText("Sam Okafor (sam@brightpath.test)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove sam@brightpath.test" })).toBeInTheDocument();
  });

  it("says plainly when no one is assigned yet", async () => {
    mockPeople([SAM]);
    renderIt();
    expect(await screen.findByText("No one yet.")).toBeInTheDocument();
  });

  it("explains who sees what, since that is the reason to assign", async () => {
    mockPeople([SAM]);
    renderIt();
    expect(await screen.findByText(/Contributors only see the controls assigned to them/)).toBeInTheDocument();
  });

  it("offers only people who do the work: contributors and client leads, not viewers, dashboards or disabled people", async () => {
    mockPeople([SAM, LEE, VIEWER, DASH, GONE, INVITED]);
    renderIt();
    await screen.findByLabelText("Person to assign");
    expect(options()).toEqual([
      "Choose a person…",
      "Sam Okafor (sam@brightpath.test)",
      "lee@brightpath.test",
      "new@brightpath.test",
    ]);
  });

  it("does not offer someone who already has the control", async () => {
    mockPeople([SAM, LEE], [asAssignee(SAM)]);
    renderIt();
    await screen.findByText("Sam Okafor (sam@brightpath.test)");
    await waitFor(() => expect(options()).toEqual(["Choose a person…", "lee@brightpath.test"]));
  });

  it("assigning is disabled until a person is chosen", async () => {
    mockPeople([SAM]);
    renderIt();
    await screen.findByLabelText("Person to assign");
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Person to assign"), "u-sam");
    expect(screen.getByRole("button", { name: "Assign" })).toBeEnabled();
  });

  it("assigns the chosen person and then shows them in the list", async () => {
    let assigned: ControlAssignee[] = [];
    server.use(
      http.get(`${API_BASE}/tenants/t1/users`, () => json([SAM, LEE])),
      http.get(`${API_BASE}/controls/c-85/assignments`, () => json(assigned)),
      http.post(`${API_BASE}/controls/c-85/assignments`, async ({ request }) => {
        const body = (await request.json()) as { userId: string };
        assigned = [asAssignee(SAM)];
        return json({ controlId: "c-85", targetUserId: body.userId }, 201);
      }),
    );
    renderIt();
    await userEvent.selectOptions(await screen.findByLabelText("Person to assign"), "u-sam");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    // (look in the list itself: until they are assigned, the same text is also an option in the chooser)
    expect(await within(screen.getByRole("list")).findByText("Sam Okafor (sam@brightpath.test)")).toBeInTheDocument();
    await waitFor(() => expect(options()).toEqual(["Choose a person…", "lee@brightpath.test"]));
    expect(screen.getByLabelText("Person to assign")).toHaveValue(""); // ready for the next person
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled(); // and nothing is silently still "chosen"
  });

  it("sends exactly the chosen person, not someone else", async () => {
    const seen: unknown[] = [];
    mockPeople([SAM, LEE]);
    server.use(http.post(`${API_BASE}/controls/c-85/assignments`, async ({ request }) => { seen.push(await request.json()); return json({}, 201); }));
    renderIt();
    await userEvent.selectOptions(await screen.findByLabelText("Person to assign"), "u-lee");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(seen).toEqual([{ userId: "u-lee" }]));
  });

  it("removes a person and refreshes the list", async () => {
    let assigned = [asAssignee(SAM)];
    let removedUser = "";
    server.use(
      http.get(`${API_BASE}/tenants/t1/users`, () => json([SAM])),
      http.get(`${API_BASE}/controls/c-85/assignments`, () => json(assigned)),
      http.delete(`${API_BASE}/controls/c-85/assignments/:userId`, ({ params }) => { removedUser = String(params.userId); assigned = []; return json({ removed: true }); }),
    );
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Remove sam@brightpath.test" }));
    expect(await screen.findByText("No one yet.")).toBeInTheDocument();
    expect(removedUser).toBe("u-sam");
    await waitFor(() => expect(options()).toEqual(["Choose a person…", "Sam Okafor (sam@brightpath.test)"]));
  });

  it("shows the server's reason when assigning fails, and keeps the choice so it can be retried", async () => {
    mockPeople([SAM]);
    server.use(http.post(`${API_BASE}/controls/c-85/assignments`, () => apiError(403, "FORBIDDEN_ROLE", "You don't have access to do that.")));
    renderIt();
    await userEvent.selectOptions(await screen.findByLabelText("Person to assign"), "u-sam");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have access to do that.");
    expect(screen.getByLabelText("Person to assign")).toHaveValue("u-sam");
    expect(screen.getByRole("button", { name: "Assign" })).toBeEnabled();
  });

  it("clears an earlier error when the next attempt works", async () => {
    mockPeople([SAM]);
    let calls = 0;
    server.use(http.post(`${API_BASE}/controls/c-85/assignments`, () => (++calls === 1 ? apiError(500, "INTERNAL", "Something went wrong.") : json({}, 201))));
    renderIt();
    await userEvent.selectOptions(await screen.findByLabelText("Person to assign"), "u-sam");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("with no one to assign, tells the user how to get people in", async () => {
    mockPeople([]);
    renderIt();
    expect(await screen.findByText(/Invite the client's people under Users/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Person to assign")).not.toBeInTheDocument();
  });

  it("when everyone is already assigned, says so instead of showing an empty chooser", async () => {
    mockPeople([SAM], [asAssignee(SAM)]);
    renderIt();
    expect(await screen.findByText("Everyone who can be assigned already is.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Person to assign")).not.toBeInTheDocument();
  });

  it("reports a failure to load who is assigned", async () => {
    server.use(
      http.get(`${API_BASE}/tenants/t1/users`, () => json([SAM])),
      http.get(`${API_BASE}/controls/c-85/assignments`, () => apiError(404, "NOT_FOUND", "Control not found or not visible to you.")),
    );
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Control not found or not visible to you.");
  });

  it("reports a failure to load the client's people", async () => {
    server.use(
      http.get(`${API_BASE}/tenants/t1/users`, () => apiError(403, "FORBIDDEN_ROLE", "You don't have access to do that.")),
      http.get(`${API_BASE}/controls/c-85/assignments`, () => json([])),
    );
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have access to do that.");
  });

  describe("on a closed audit cycle (read-only)", () => {
    const renderReadOnly = () => renderApp(<ControlAssignment control={control} tenantId="t1" readOnly />, { user: AUDITOR_USER });

    it("still shows who it is assigned to, but with nothing to remove and no one to add", async () => {
      mockPeople([SAM, LEE], [asAssignee(SAM)]);
      renderReadOnly();
      const list = await screen.findByText("Sam Okafor (sam@brightpath.test)");
      expect(list).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove sam@brightpath.test" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Person to assign")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
    });

    it("says why, instead of the usual explanation of who sees what", async () => {
      mockPeople([SAM], [asAssignee(SAM)]);
      renderReadOnly();
      expect(await screen.findByText("This audit cycle is closed, so assignments can't be changed.")).toBeInTheDocument();
      expect(screen.queryByText(/Contributors only see the controls assigned to them/)).not.toBeInTheDocument();
    });

    it("does not tell the reader there is no one to assign (they couldn't anyway), whether or not anyone is assigned", async () => {
      mockPeople([], []);
      renderReadOnly();
      await screen.findByText("No one yet.");
      expect(screen.queryByText(/There is no one to assign yet/)).not.toBeInTheDocument();
      expect(screen.queryByText(/already is\./)).not.toBeInTheDocument();
    });
  });
});
