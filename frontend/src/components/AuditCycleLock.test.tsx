import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, HttpResponse, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { AuditCycleLock, CAN_CLOSE_CYCLE } from "./AuditCycleLock";
import type { AuditSummary } from "../api/types";

const open: AuditSummary = { id: "a1", name: "2027 surveillance", status: "in_progress", templateVersion: "2022", createdAt: "2027-02-01T09:00:00.000Z", closedAt: null, closedBy: null };
const closed: AuditSummary = { ...open, status: "closed", closedAt: "2027-11-05T16:30:00.000Z", closedBy: "Priya Nair" };

function show(audit: AuditSummary, props: Partial<Parameters<typeof AuditCycleLock>[0]> = {}) {
  const onChanged = vi.fn();
  renderApp(<AuditCycleLock audit={audit} canManage onChanged={onChanged} {...props} />, { user: AUDITOR_USER });
  return { onChanged };
}

describe("who may close or reopen a cycle", () => {
  it("is organisation admins and lead auditors", () => {
    expect([...CAN_CLOSE_CYCLE].sort()).toEqual(["lead_auditor", "org_admin"]);
  });
});

describe("AuditCycleLock on an open cycle", () => {
  it("shows nothing to someone who may not close it", () => {
    const { container } = renderApp(<AuditCycleLock audit={open} canManage={false} />, { user: AUDITOR_USER });
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a Close button, and explains what closing does before anything happens", async () => {
    show(open);
    expect(screen.queryByText(/read-only/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    expect(screen.queryByRole("button", { name: "Close audit cycle" })).not.toBeInTheDocument(); // replaced by the confirmation
    expect(screen.getByRole("heading", { name: "Close “2027 surveillance”?" })).toBeInTheDocument();
    expect(screen.getByText(/read-only/)).toHaveTextContent(/Nobody can upload evidence, review, comment, assign controls or change anything in it/);
    expect(screen.getByText(/read-only/)).toHaveTextContent(/audit log/);
    expect(screen.getByText(/read-only/)).toHaveTextContent(/reopen it later \(with a reason\)/);
    expect(screen.getByRole("button", { name: "Yes, close it" })).toBeEnabled();
  });

  it("cancelling goes back to the Close button and sends nothing", async () => {
    let called = false;
    server.use(http.post(`${API_BASE}/audits/a1/close`, () => { called = true; return json(closed); }));
    show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Close audit cycle" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, close it" })).not.toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("says how many applicable controls are still not accepted — singular and plural — and nothing when all are", async () => {
    const view = renderApp(<AuditCycleLock audit={open} canManage notAccepted={1} />, { user: AUDITOR_USER });
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    expect(screen.getByText(/1 applicable control is not accepted yet\. It will stay as it is\./)).toBeInTheDocument();
    view.unmount();

    const two = renderApp(<AuditCycleLock audit={open} canManage notAccepted={12} />, { user: AUDITOR_USER });
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    expect(screen.getByText(/12 applicable controls are not accepted yet\. They will stay as they are\./)).toBeInTheDocument();
    two.unmount();

    renderApp(<AuditCycleLock audit={open} canManage notAccepted={0} />, { user: AUDITOR_USER });
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    expect(screen.queryByText(/not accepted yet/)).not.toBeInTheDocument();
  });

  it("confirming closes the cycle and hands the updated cycle to the page", async () => {
    server.use(http.post(`${API_BASE}/audits/a1/close`, () => json(closed)));
    const { onChanged } = show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(closed));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the server's explanation when closing is refused, and lets the person try again", async () => {
    server.use(http.post(`${API_BASE}/audits/a1/close`, () => apiError(403, "FORBIDDEN_ROLE", "Only a lead auditor or an organisation admin can close or reopen an audit cycle.")));
    const { onChanged } = show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only a lead auditor or an organisation admin can close or reopen an audit cycle.");
    expect(screen.getByRole("button", { name: "Yes, close it" })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("is disabled while the request is on its way, so it can't be sent twice", async () => {
    let calls = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server.use(http.post(`${API_BASE}/audits/a1/close`, async () => { calls++; await gate; return json(closed); }));
    show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    const busy = await screen.findByRole("button", { name: "Closing…" });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    release();
    await waitFor(() => expect(calls).toBe(1));
  });

  it("shows a general message when the failure isn't a server explanation (the connection dropped)", async () => {
    server.use(http.post(`${API_BASE}/audits/a1/close`, () => HttpResponse.error()));
    show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That didn't work. Please try again.");
    expect(screen.getByRole("button", { name: "Yes, close it" })).toBeEnabled(); // not left stuck on 'Closing…'
  });

  it("clears an earlier error as soon as it is tried again", async () => {
    let calls = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server.use(http.post(`${API_BASE}/audits/a1/close`, async () => {
      calls++;
      if (calls === 1) return apiError(409, "AUDIT_CLOSED", "First attempt refused.");
      await gate;
      return json(closed);
    }));
    show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("First attempt refused.");
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    await screen.findByRole("button", { name: "Closing…" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // while the second attempt is on its way
    release();
    await waitFor(() => expect(calls).toBe(2));
  });

  it("an error shown for one attempt is gone after cancelling and starting again", async () => {
    server.use(http.post(`${API_BASE}/audits/a1/close`, () => apiError(409, "AUDIT_CLOSED", "Refused this time.")));
    show(open);
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AuditCycleLock on a closed cycle", () => {
  it("says it is closed, when and by whom, and what that means", () => {
    show(closed, { canManage: false });
    const notice = screen.getByRole("region", { name: "Audit cycle closed" });
    expect(notice).toHaveTextContent("This audit cycle is closed.");
    expect(notice).toHaveTextContent("Closed on 2027-11-05 by Priya Nair.");
    expect(notice).toHaveTextContent("Nothing in it can be changed: no uploads, reviews, comments or assignments. You can still look at everything.");
  });

  it("leaves out 'by …' when the viewer can't see who closed it", () => {
    show({ ...closed, closedBy: null }, { canManage: false });
    const notice = screen.getByRole("region", { name: "Audit cycle closed" });
    expect(notice).toHaveTextContent("Closed on 2027-11-05. Nothing in it");
    expect(notice).not.toHaveTextContent(" by ");
  });

  it("still reads sensibly without a closing time", () => {
    show({ ...closed, closedAt: null, closedBy: null }, { canManage: false });
    expect(screen.getByRole("region", { name: "Audit cycle closed" })).not.toHaveTextContent("Closed on");
  });

  it("has no way to reopen it for someone who may not", () => {
    show(closed, { canManage: false });
    expect(screen.queryByRole("button", { name: /Reopen/ })).not.toBeInTheDocument();
  });

  it("asks for a reason before reopening, which must be at least 3 characters once trimmed", async () => {
    show(closed);
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    const confirm = screen.getByRole("button", { name: "Confirm reopen" });
    expect(confirm).toBeDisabled();
    const reason = screen.getByLabelText("Reason for reopening");
    expect(screen.getByText(/written to the audit log, together with your name/)).toBeInTheDocument();
    await userEvent.type(reason, "  ab  ");
    expect(confirm).toBeDisabled();
    await userEvent.clear(reason);
    await userEvent.type(reason, "abc");
    expect(confirm).toBeEnabled(); // exactly three characters is enough
    await userEvent.clear(reason);
    await userEvent.type(reason, "   x   y ");
    expect(confirm).toBeEnabled(); // inner spaces count; only the ends are trimmed
    await userEvent.clear(reason);
    await userEvent.type(reason, "     ");
    expect(confirm).toBeDisabled();
  });

  it("sends the trimmed reason and tells the page", async () => {
    let body: unknown = null;
    server.use(http.post(`${API_BASE}/audits/a1/reopen`, async ({ request }) => { body = await request.json(); return json(open); }));
    const { onChanged } = show(closed);
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    await userEvent.type(screen.getByLabelText("Reason for reopening"), "  Client sent the missing policy ");
    await userEvent.click(screen.getByRole("button", { name: "Confirm reopen" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(open));
    expect(body).toEqual({ reason: "Client sent the missing policy" });
    // (the page normally swaps the whole notice out now; here the cycle is still shown closed, so check it started over)
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    expect(screen.getByLabelText("Reason for reopening")).toHaveValue("");
  });

  it("shows the server's explanation if reopening is refused, and keeps the reason typed", async () => {
    server.use(http.post(`${API_BASE}/audits/a1/reopen`, () => apiError(409, "AUDIT_NOT_CLOSED", "This audit cycle isn't closed.")));
    const { onChanged } = show(closed);
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    await userEvent.type(screen.getByLabelText("Reason for reopening"), "Because");
    await userEvent.click(screen.getByRole("button", { name: "Confirm reopen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This audit cycle isn't closed.");
    expect(screen.getByLabelText("Reason for reopening")).toHaveValue("Because");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("cancelling closes the form and forgets the reason", async () => {
    show(closed);
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    await userEvent.type(screen.getByLabelText("Reason for reopening"), "Because");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Reason for reopening")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    expect(screen.getByLabelText("Reason for reopening")).toHaveValue("");
  });

  it("cancelling also forgets an error from a refused attempt", async () => {
    server.use(http.post(`${API_BASE}/audits/a1/reopen`, () => apiError(409, "AUDIT_NOT_CLOSED", "This audit cycle isn't closed.")));
    show(closed);
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    await userEvent.type(screen.getByLabelText("Reason for reopening"), "Because");
    await userEvent.click(screen.getByRole("button", { name: "Confirm reopen" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("limits the reason to what the server accepts", async () => {
    show(closed);
    await userEvent.click(screen.getByRole("button", { name: "Reopen audit cycle" }));
    expect(screen.getByLabelText("Reason for reopening")).toHaveAttribute("maxlength", "1000");
  });
});
