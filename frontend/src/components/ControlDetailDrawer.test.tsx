import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { ControlDetailDrawer } from "./ControlDetailDrawer";
import { saveBlob } from "./saveBlob";
import type { ControlSummary } from "../api/types";

// A test browser has no real downloads; what matters is what the drawer hands over to be saved.
vi.mock("./saveBlob", () => ({ saveBlob: vi.fn() }));

const control: ControlSummary = {
  id: "c-85", kind: "annex", section: "A.8 Technological controls", controlRef: "A.8.5",
  title: "Secure authentication", effectiveEvidence: "MFA settings", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "submitted",
  dueDate: null, requirementChangedAt: null, fileCount: 1,
};

function mockDrawerData() {
  server.use(
    http.get(`${API_BASE}/controls/c-85/files`, () => json([])),
    http.get(`${API_BASE}/controls/c-85/comments`, () => json([{ id: "m1", type: "comment", body: "Please add the screenshot", createdAt: "2026-10-01T09:00:00.000Z" }])),
    http.get(`${API_BASE}/controls/c-85/assignments`, () => json([{ userId: "u-sam", email: "sam@brightpath.test", fullName: "Sam Okafor", role: "contributor" }])),
    http.get(`${API_BASE}/tenants/t1/users`, () => json([{ id: "u-lee", email: "lee@brightpath.test", fullName: "Lee", role: "contributor", status: "active" }])),
  );
}

const show = (props: { canReview: boolean; readOnly?: boolean }) =>
  renderApp(<ControlDetailDrawer control={control} assignTenantId="t1" onClose={() => {}} onChanged={() => {}} {...props} />, { user: AUDITOR_USER });

describe("ControlDetailDrawer on an open cycle", () => {
  it("lets a reviewer accept or reject a submitted control, and lets anyone comment", async () => {
    mockDrawerData();
    show({ canReview: true });
    expect(await screen.findByText("Please add the screenshot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add a comment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add comment" })).toBeInTheDocument();
    expect(screen.queryByText(/closed/)).not.toBeInTheDocument();
  });

  it("shows no decision to someone who may not review", async () => {
    mockDrawerData();
    show({ canReview: false });
    await screen.findByText("Please add the screenshot");
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
});

describe("ControlDetailDrawer on a closed cycle (readOnly)", () => {
  it("still shows the comments and who the control is assigned to", async () => {
    mockDrawerData();
    show({ canReview: true, readOnly: true });
    expect(await screen.findByText("Please add the screenshot")).toBeInTheDocument();
    expect(await screen.findByText("Sam Okafor (sam@brightpath.test)")).toBeInTheDocument();
  });

  it("offers no decision even to a reviewer — the drawer enforces this itself, whatever the page passes", async () => {
    mockDrawerData();
    show({ canReview: true, readOnly: true });
    await screen.findByText("Please add the screenshot");
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("replaces the comment box with an explanation", async () => {
    mockDrawerData();
    show({ canReview: false, readOnly: true });
    await screen.findByText("Please add the screenshot");
    expect(screen.getByText("This audit cycle is closed, so comments can't be added.")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Add a comment")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("shows the assignments but gives no way to change them", async () => {
    mockDrawerData();
    show({ canReview: false, readOnly: true });
    const assigned = await screen.findByRole("region", { name: "Assigned to" });
    await within(assigned).findByText("Sam Okafor (sam@brightpath.test)");
    expect(within(assigned).queryByRole("button")).not.toBeInTheDocument();
    expect(within(assigned).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(assigned).getByText("This audit cycle is closed, so assignments can't be changed.")).toBeInTheDocument();
  });
});

describe("ControlDetailDrawer comments", () => {
  it("an error from one attempt to comment is gone when the next attempt is made", async () => {
    mockDrawerData();
    let tries = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server.use(http.post(`${API_BASE}/controls/c-85/comments`, async () => {
      tries++;
      if (tries === 1) return apiError(409, "AUDIT_CLOSED", "Refused the first time.");
      await gate;
      return json({ id: "m2" });
    }));
    show({ canReview: false });
    await userEvent.type(await screen.findByPlaceholderText("Add a comment"), "A late thought");
    await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refused the first time.");
    await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(tries).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // while the second attempt is on its way
    release();
  });
});

describe("ControlDetailDrawer downloads", () => {
  const FILES = [
    { id: "e1", fileName: "access-policy.pdf", sizeBytes: 20480, scanStatus: "clean", integrityStatus: "unchanged", uploadedAt: "2026-10-01T09:00:00.000Z", providerFileId: "pf1" },
    { id: "e2", fileName: "screenshot.png", sizeBytes: 4096, scanStatus: "clean", integrityStatus: "unchanged", uploadedAt: "2026-10-02T09:00:00.000Z", providerFileId: "pf2" },
  ];
  beforeEach(() => { vi.mocked(saveBlob).mockClear(); });

  function mockFiles() {
    mockDrawerData();
    server.use(http.get(`${API_BASE}/controls/c-85/files`, () => json(FILES)));
  }

  it("offers a Download button on every file, named after the file", async () => {
    mockFiles();
    show({ canReview: true });
    expect(await screen.findByRole("button", { name: "Download access-policy.pdf" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download screenshot.png" })).toBeEnabled();
  });

  it("fetches the file and hands it to be saved under its own name", async () => {
    mockFiles();
    let asked = "";
    server.use(http.get(`${API_BASE}/evidence/e2/download`, ({ request }) => {
      asked = request.url;
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }));
    show({ canReview: true });
    await userEvent.click(await screen.findByRole("button", { name: "Download screenshot.png" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    const [blob, name] = vi.mocked(saveBlob).mock.calls[0];
    expect(name).toBe("screenshot.png");
    expect(Array.from(new Uint8Array(await (blob as Blob).arrayBuffer()))).toEqual([137, 80, 78, 71]);
    expect(asked).toBe(`${API_BASE}/evidence/e2/download`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("works for a closed audit cycle too, since reading is all it does", async () => {
    mockFiles();
    server.use(http.get(`${API_BASE}/evidence/e1/download`, () => new Response(new Uint8Array([1]), { status: 200 })));
    show({ canReview: false, readOnly: true });
    await userEvent.click(await screen.findByRole("button", { name: "Download access-policy.pdf" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
  });

  it("says why when the storage can't give the file, next to that file only, and saves nothing", async () => {
    mockFiles();
    server.use(http.get(`${API_BASE}/evidence/e1/download`, () => apiError(404, "STORAGE_NOT_FOUND", "The file is no longer in the storage.")));
    show({ canReview: true });
    await userEvent.click(await screen.findByRole("button", { name: "Download access-policy.pdf" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The file is no longer in the storage.");
    expect(alert.closest("li")).toHaveTextContent("access-policy.pdf");
    expect(alert.closest("li")).not.toHaveTextContent("screenshot.png");
    expect(saveBlob).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download access-policy.pdf" })).toBeEnabled(); // can try again
  });

  it("clears the message from an earlier attempt when the next one starts", async () => {
    mockFiles();
    let tries = 0;
    server.use(http.get(`${API_BASE}/evidence/e1/download`, () => {
      tries++;
      return tries === 1 ? apiError(503, "STORAGE_UNAVAILABLE", "Storage is not reachable right now.") : new Response(new Uint8Array([1]), { status: 200 });
    }));
    show({ canReview: true });
    await userEvent.click(await screen.findByRole("button", { name: "Download access-policy.pdf" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Download access-policy.pdf" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
