import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { server, http, json, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { AuditLogPage } from "./AuditLogPage";

describe("AuditLogPage", () => {
  it("renders log entries with their action and timestamp", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/audit-log`, () => json([
        { seq: "5", tenantId: "t1", actorId: "u1", action: "control.accept", entity: "audit_control", entityId: "c-85-uuid", change: {}, createdAt: "2026-01-01T12:00:00.000Z" },
      ])),
    );
    renderApp(<AuditLogPage />, { user: AUDITOR_USER });
    expect(await screen.findByText(/control.accept/)).toBeInTheDocument();
  });

  it("shows an empty state rather than nothing when there's nothing to see", async () => {
    server.use(
      http.get(`${API_BASE}/tenants`, () => json([])),
      http.get(`${API_BASE}/audit-log`, () => json([])),
    );
    renderApp(<AuditLogPage />, { user: AUDITOR_USER });
    expect(await screen.findByText(/Nothing logged yet/)).toBeInTheDocument();
  });
});
