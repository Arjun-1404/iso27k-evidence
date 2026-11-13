import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import { useSelectedTenant } from "./TenantProvider";

function Probe() {
  const { tenants, selectedTenantId, selectTenant, loading, error } = useSelectedTenant();
  return (
    <div>
      <div data-testid="selected">{selectedTenantId ?? "none"}</div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error ?? ""}</div>
      {tenants.map((t) => <button key={t.id} onClick={() => selectTenant(t.id)}>choose {t.name}</button>)}
    </div>
  );
}
const TENANTS = [
  { id: "t1", name: "Brightpath", status: "active", storageRootId: null },
  { id: "t2", name: "Harbor", status: "active", storageRootId: null },
];
const mockTenants = () => server.use(http.get(`${API_BASE}/tenants`, () => json(TENANTS)));
const selected = () => screen.getByTestId("selected").textContent;

beforeEach(() => { localStorage.clear(); });

describe("TenantProvider", () => {
  it("an auditor starts on the first client", async () => {
    mockTenants();
    renderApp(<Probe />, { user: AUDITOR_USER });
    await waitFor(() => expect(selected()).toBe("t1"));
  });

  it("remembers the client an auditor chose, and opens on it next time", async () => {
    mockTenants();
    const first = renderApp(<Probe />, { user: AUDITOR_USER });
    await userEvent.click(await screen.findByRole("button", { name: "choose Harbor" }));
    expect(selected()).toBe("t2");
    expect(localStorage.getItem("selectedTenantId")).toBe("t2");
    first.unmount();
    renderApp(<Probe />, { user: AUDITOR_USER });
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(selected()).toBe("t2");
  });

  it("ignores a remembered client that no longer exists", async () => {
    localStorage.setItem("selectedTenantId", "long-gone");
    mockTenants();
    renderApp(<Probe />, { user: AUDITOR_USER });
    await waitFor(() => expect(selected()).toBe("t1"));
  });

  it("works without browser storage (private windows): starts on the first client and still lets the auditor choose", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    const escaped: unknown[] = [];
    const listen = (e: ErrorEvent) => { escaped.push(e.error); e.preventDefault(); };
    window.addEventListener("error", listen);
    try {
      mockTenants();
      renderApp(<Probe />, { user: AUDITOR_USER });
      await waitFor(() => expect(selected()).toBe("t1"));
      await userEvent.click(screen.getByRole("button", { name: "choose Harbor" }));
      expect(selected()).toBe("t2");
      expect(escaped).toEqual([]); // the storage error didn't escape the click
    } finally { window.removeEventListener("error", listen); get.mockRestore(); set.mockRestore(); }
  });

  it("a client's own person is simply on their own client, without asking for a list", async () => {
    let asked = false;
    server.use(http.get(`${API_BASE}/tenants`, () => { asked = true; return json(TENANTS); }));
    renderApp(<Probe />, { user: TENANT_USER });
    await waitFor(() => expect(selected()).toBe("tenant-1"));
    expect(asked).toBe(false);
  });

  it("says why the list couldn't be loaded instead of looking like there are no clients", async () => {
    server.use(http.get(`${API_BASE}/tenants`, () => apiError(500, "INTERNAL", "Something went wrong.")));
    renderApp(<Probe />, { user: AUDITOR_USER });
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Something went wrong."));
  });
});
