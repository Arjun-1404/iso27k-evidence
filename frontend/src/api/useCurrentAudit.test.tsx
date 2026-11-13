import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import { useCurrentAudit } from "./useCurrentAudit";
import type { AuditSummary } from "./types";

const audit = (id: string, name: string): AuditSummary => ({ id, name, status: "in_progress", templateVersion: "2022", createdAt: "2026-01-01T00:00:00.000Z", closedAt: null, closedBy: null });
const NEWEST = audit("a3", "Newest");
const MIDDLE = audit("a2", "Middle");
const OLDEST = audit("a1", "Oldest");

function Probe({ tenantId }: { tenantId: string | null }) {
  const { data, audits, select, loading, error } = useCurrentAudit(tenantId);
  return (
    <div>
      <div data-testid="current">{data ? data.name : "none"}</div>
      <div data-testid="count">{audits.length}</div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error ?? ""}</div>
      {audits.map((a) => <button key={a.id} onClick={() => select(a.id)}>pick {a.name}</button>)}
    </div>
  );
}
/** Lets a test move between clients without remounting, the way choosing another client on a page does. */
function Switcher() {
  const [tenantId, setTenantId] = useState("t1");
  return <><button onClick={() => setTenantId("t2")}>switch client</button><Probe tenantId={tenantId} /></>;
}
const mockAudits = (tenantId: string, list: AuditSummary[]) => server.use(http.get(`${API_BASE}/tenants/${tenantId}/audits`, () => json(list)));
const current = () => screen.getByTestId("current").textContent;

beforeEach(() => { localStorage.clear(); });

describe("useCurrentAudit", () => {
  it("opens the newest cycle by default", async () => {
    mockAudits("t1", [NEWEST, MIDDLE, OLDEST]);
    renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("Newest"));
    expect(screen.getByTestId("count")).toHaveTextContent("3");
  });

  it("switches to the cycle the person picks, and remembers it for next time", async () => {
    mockAudits("t1", [NEWEST, MIDDLE, OLDEST]);
    const first = renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("Newest"));
    await userEvent.click(screen.getByRole("button", { name: "pick Oldest" }));
    expect(current()).toBe("Oldest");
    expect(localStorage.getItem("selectedAudit:t1")).toBe("a1");
    first.unmount();

    renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("Oldest"));
  });

  it("remembers the choice separately for each client", async () => {
    mockAudits("t1", [NEWEST, OLDEST]);
    mockAudits("t2", [audit("b2", "T2 newest"), audit("b1", "T2 oldest")]);
    localStorage.setItem("selectedAudit:t1", "a1");
    localStorage.setItem("selectedAudit:t2", "b1");
    renderApp(<Switcher />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("Oldest"));
    await userEvent.click(screen.getByRole("button", { name: "switch client" }));
    await waitFor(() => expect(current()).toBe("T2 oldest"));
    expect(localStorage.getItem("selectedAudit:t1")).toBe("a1"); // each client keeps its own
  });

  it("a client nothing was remembered for opens on its newest cycle", async () => {
    mockAudits("t1", [NEWEST, OLDEST]);
    mockAudits("t2", [audit("b2", "T2 newest"), audit("b1", "T2 oldest")]);
    localStorage.setItem("selectedAudit:t1", "a1");
    renderApp(<Switcher />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("Oldest"));
    await userEvent.click(screen.getByRole("button", { name: "switch client" }));
    await waitFor(() => expect(current()).toBe("T2 newest"));
    expect(localStorage.getItem("selectedAudit:t2")).toBeNull();
  });

  it("falls back to the newest when the remembered cycle no longer exists", async () => {
    localStorage.setItem("selectedAudit:t1", "deleted-long-ago");
    mockAudits("t1", [NEWEST, OLDEST]);
    renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("Newest"));
  });

  it("works without browser storage (private windows): still opens the newest and still lets the person switch", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    // an error escaping a click handler isn't a test failure by itself; it is reported on the window, so listen for it
    const escaped: unknown[] = [];
    const listen = (e: ErrorEvent) => { escaped.push(e.error); e.preventDefault(); };
    window.addEventListener("error", listen);
    try {
      mockAudits("t1", [NEWEST, OLDEST]);
      renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
      await waitFor(() => expect(current()).toBe("Newest"));
      await userEvent.click(screen.getByRole("button", { name: "pick Oldest" }));
      expect(current()).toBe("Oldest");
      expect(escaped).toEqual([]);
    } finally { window.removeEventListener("error", listen); get.mockRestore(); set.mockRestore(); }
  });

  it("with no client selected, there is nothing to show and nothing is asked of the server", async () => {
    let asked = false;
    server.use(http.get(`${API_BASE}/tenants/:id/audits`, () => { asked = true; return json([]); }));
    renderApp(<Probe tenantId={null} />, { user: AUDITOR_USER });
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(current()).toBe("none");
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    expect(screen.getByTestId("error")).toHaveTextContent("");
    expect(asked).toBe(false);
  });

  it("creates the first cycle from the platform default template when an auditor opens a client that has none", async () => {
    let body: unknown = null;
    mockAudits("t1", []);
    server.use(
      http.get(`${API_BASE}/templates`, () => json([
        { id: "t-custom", framework: "ISO 27001", version: "x", name: "Custom", isPlatformDefault: false },
        { id: "t-default", framework: "ISO 27001", version: "2022", name: "Default", isPlatformDefault: true },
      ])),
      http.post(`${API_BASE}/tenants/t1/audits`, async ({ request }) => { body = await request.json(); return json(audit("n1", "ISO 27001 audit"), 201); }),
    );
    renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
    await waitFor(() => expect(current()).toBe("ISO 27001 audit"));
    expect(body).toEqual({ templateId: "t-default", name: "ISO 27001 audit" });
  });

  it("does not create anything for a client-side user who finds no cycle", async () => {
    let posted = false;
    mockAudits("tenant-1", []);
    server.use(
      http.get(`${API_BASE}/templates`, () => apiError(403, "FORBIDDEN", "You don't have access to do that.")),
      http.post(`${API_BASE}/tenants/tenant-1/audits`, () => { posted = true; return json({}, 201); }),
    );
    renderApp(<Probe tenantId="tenant-1" />, { user: TENANT_USER });
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(current()).toBe("none");
    expect(screen.getByTestId("error")).toHaveTextContent("");
    expect(posted).toBe(false);
  });

  it("reports a failure to load rather than showing 'none' as if nothing were set up", async () => {
    server.use(http.get(`${API_BASE}/tenants/t1/audits`, () => apiError(500, "INTERNAL", "Something went wrong.")));
    renderApp(<Probe tenantId="t1" />, { user: AUDITOR_USER });
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Something went wrong."));
  });
});
