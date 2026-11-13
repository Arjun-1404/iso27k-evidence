import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import { DashboardPage } from "./DashboardPage";

const dashboard = {
  total: 117, applicable: 105, notApplicable: 12, accepted: 52, overdue: 4, completionPct: 49.5,
  byStatus: [{ status: "accepted", count: 52 }, { status: "awaiting_evidence", count: 14 }],
  bySection: [{ section: "A.8 Technological controls", applicable: 31, accepted: 9 }],
};

describe("DashboardPage", () => {
  it("shows the auditor's tenant selector and the selected tenant's numbers", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
      http.get(`${API_BASE}/tenants/t1/audits`, () => json([{ id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01" }])),
      http.get(`${API_BASE}/audits/a1/dashboard`, () => json(dashboard)),
    );
    renderApp(<DashboardPage />, { user: AUDITOR_USER });

    expect(await screen.findByText("Brightpath Ltd", { selector: "option" })).toBeInTheDocument();
    expect(await screen.findAllByText("52")).toHaveLength(2);
    expect(screen.getAllByText("Accepted").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/117 items/)).toBeInTheDocument();
  });

  it("creates a first audit automatically when the tenant has none yet, then shows its numbers", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: null }])),
      http.get(`${API_BASE}/tenants/t1/audits`, () => json([])),
      http.get(`${API_BASE}/templates`, () => json([{ id: "tmpl-1", framework: "ISO/IEC 27001:2022", version: "1", name: "Default", isPlatformDefault: true }])),
      http.post(`${API_BASE}/tenants/t1/audits`, () => json({ id: "a-new", name: "ISO/IEC 27001:2022 audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01" }, 201)),
      http.get(`${API_BASE}/audits/a-new/dashboard`, () => json(dashboard)),
    );
    renderApp(<DashboardPage />, { user: AUDITOR_USER });
    expect(await screen.findAllByText("52")).toHaveLength(2);
  });

  it("a tenant user sees their own tenant's dashboard with no tenant selector", async () => {
    server.use(
      http.get(`${API_BASE}/tenants/tenant-1/audits`, () => json([{ id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01" }])),
      http.get(`${API_BASE}/audits/a1/dashboard`, () => json(dashboard)),
    );
    renderApp(<DashboardPage />, { user: TENANT_USER });
    expect(await screen.findAllByText("52")).toHaveLength(2);
    expect(screen.queryByLabelText("Tenant")).not.toBeInTheDocument();
  });

  it("shows an error message instead of crashing when the API call fails", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: null }])),
      http.get(`${API_BASE}/tenants/t1/audits`, () => new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }), { status: 500 })),
    );
    renderApp(<DashboardPage />, { user: AUDITOR_USER });
    await waitFor(() => expect(screen.getByText(/Something went wrong/)).toBeInTheDocument());
  });

  it("when the tenant list itself can't be loaded, says so — it does not claim there is simply no audit", async () => {
    server.use(http.get(`${API_BASE}/tenants`, () => new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Unexpected error." } }), { status: 500 })));
    renderApp(<DashboardPage />, { user: AUDITOR_USER });
    expect(await screen.findByText("Unexpected error.")).toBeInTheDocument();
    expect(screen.queryByText(/No audit has been set up/)).not.toBeInTheDocument();
  });

  describe("audit cycles", () => {
    it("shows the numbers of the cycle that is chosen", async () => {
      localStorage.clear();
      server.use(
        http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
        http.get(`${API_BASE}/tenants/t1/audits`, () => json([
          { id: "a2", name: "2027 surveillance", status: "in_progress", templateVersion: "1", createdAt: "2027-02-01T00:00:00.000Z" },
          { id: "a1", name: "2026 certification", status: "in_progress", templateVersion: "1", createdAt: "2026-02-01T00:00:00.000Z" },
        ])),
        http.get(`${API_BASE}/audits/a2/dashboard`, () => json({ ...dashboard, accepted: 7, total: 117 })),
        http.get(`${API_BASE}/audits/a1/dashboard`, () => json({ ...dashboard, accepted: 99, total: 117 })),
      );
      renderApp(<DashboardPage />, { user: AUDITOR_USER });
      await waitFor(() => expect(screen.getAllByText("7").length).toBeGreaterThan(0));
      await userEvent.selectOptions(screen.getByLabelText("Audit cycle"), "a1");
      await waitFor(() => expect(screen.getAllByText("99").length).toBeGreaterThan(0));
      expect(screen.queryByText("7")).not.toBeInTheDocument();
    });
  });

  describe("a closed audit cycle", () => {
    const mock = (audit: Record<string, unknown>) => server.use(
      http.get(`${API_BASE}/tenants`, () => json([{ id: "t1", name: "Brightpath Ltd", status: "active", storageRootId: "root" }])),
      http.get(`${API_BASE}/tenants/t1/audits`, () => json([audit])),
      http.get(`${API_BASE}/audits/a1/dashboard`, () => json(dashboard)),
    );
    const base = { id: "a1", name: "ISO audit", status: "in_progress", templateVersion: "1", createdAt: "2026-01-01", closedAt: null, closedBy: null };

    it("shows that the cycle is closed, with the numbers still there, and no way to reopen it from here", async () => {
      mock({ ...base, status: "closed", closedAt: "2026-11-05T16:30:00.000Z", closedBy: "Priya Nair" });
      renderApp(<DashboardPage />, { user: AUDITOR_USER });
      const notice = await screen.findByRole("region", { name: "Audit cycle closed" });
      expect(notice).toHaveTextContent("Closed on 2026-11-05 by Priya Nair.");
      expect(await screen.findByText(/117 items/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Reopen/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close audit cycle" })).not.toBeInTheDocument();
    });

    it("shows no notice for an open cycle", async () => {
      mock(base);
      renderApp(<DashboardPage />, { user: AUDITOR_USER });
      await screen.findByText(/117 items/);
      expect(screen.queryByRole("region", { name: "Audit cycle closed" })).not.toBeInTheDocument();
    });
  });
});
