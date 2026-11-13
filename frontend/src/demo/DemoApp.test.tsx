// The whole real web app, running on the demo's pretend server, the way a visitor meets it (in a simulated browser).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { ApiProvider } from "../api/ApiProvider";
import { TenantProvider } from "../api/TenantProvider";
import { PlatformOwnerProvider } from "../api/PlatformOwnerProvider";
import { BuiltInAuthClient } from "../auth/builtInAuthClient";
import { DemoModeProvider } from "../demoContext";
import { DEMO_API_BASE_URL, startDemo, type RunningDemo } from "./index";
import { DEMO_PASSWORD, SIGN_IN_ACCOUNTS } from "./accounts";

// Typing into forms character by character in a simulated browser is slow; the pretend server itself is instant.
vi.setConfig({ testTimeout: 30_000 });

let demo: RunningDemo;
let reloads = 0;

function openDemo(route = "/login") {
  demo = startDemo({ reload: () => { reloads++; }, latencyMs: 0 });
  const client = new BuiltInAuthClient(demo.apiBaseUrl);
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider client={client}>
        <ApiProvider baseUrl={demo.apiBaseUrl} authClient={client}>
          <PlatformOwnerProvider><TenantProvider>
            <DemoModeProvider value={demo.mode}>{demo.banner}<App /></DemoModeProvider>
          </TenantProvider></PlatformOwnerProvider>
        </ApiProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); reloads = 0; });
afterEach(() => { demo?.stop(); });

const signInAs = (label: RegExp) => userEvent.click(screen.getByRole("button", { name: label }));

describe("the sign-in page", () => {
  it("says it is a demo, and offers one-click sign-in for each made-up person", () => {
    openDemo();
    expect(screen.getByRole("region", { name: "About this demo" })).toHaveTextContent(/made up/);
    expect(screen.getByRole("link", { name: "Get the code" })).toHaveAttribute("href", "https://github.com/Arjun-1404/iso27k-evidence");
    for (const a of SIGN_IN_ACCOUNTS) expect(screen.getByRole("button", { name: new RegExp(a.fullName) })).toBeInTheDocument();
    expect(DEMO_API_BASE_URL).toMatch(/\.invalid$/); // can never reach a real server
  });

  it("still has the ordinary form, which accepts the demo password and refuses a wrong one", async () => {
    openDemo();
    await userEvent.type(screen.getByLabelText("Work email"), "priya.shah@brightwave.example");
    await userEvent.type(screen.getByLabelText("Password"), "not-the-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Incorrect email or password.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Password"));
    await userEvent.type(screen.getByLabelText("Password"), DEMO_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "My controls" }, { timeout: 5000 })).toBeInTheDocument();
  });

  it("five wrong tries lock only that account; the others carry on working", async () => {
    openDemo();
    for (let i = 0; i < 5; i++) {
      await userEvent.clear(screen.getByLabelText("Work email"));
      await userEvent.type(screen.getByLabelText("Work email"), "ines.rocha@corran.example");
      await userEvent.clear(screen.getByLabelText("Password"));
      await userEvent.type(screen.getByLabelText("Password"), `wrong-password-${i}`);
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByText("Incorrect email or password.");
    }
    await userEvent.clear(screen.getByLabelText("Password"));
    await userEvent.type(screen.getByLabelText("Password"), DEMO_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many failed attempts/)).toBeInTheDocument();
    await signInAs(/Client lead/);
    expect(await screen.findByRole("heading", { name: "My controls" }, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("a visitor trying each person", () => {
  it("the lead auditor lands on the dashboard of the live audit: 117 controls, 48.2% complete", async () => {
    openDemo();
    await signInAs(/Lead auditor/);
    expect(await screen.findByText("Completion", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText("48.2")).toBeInTheDocument();
    expect(screen.getByText(/117 items · 5 marked not applicable/)).toBeInTheDocument();
    expect(screen.getAllByText(/surveillance audit 2026/).length).toBeGreaterThan(0);
  });

  it("the organisation admin can see all three clients, including the archived one, and the audit log", async () => {
    openDemo();
    await signInAs(/Organisation admin/);
    await screen.findByText("Completion", {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole("link", { name: "Tenants" }));
    expect((await screen.findAllByText("Old Mill Foods", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Corran Logistics").length).toBeGreaterThan(0);
    expect(screen.getByText("archived")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Audit log" }));
    expect((await screen.findAllByText(/^control\.submitted/, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
  });

  it("a contributor sees their own controls only, and none of the staff menus", async () => {
    openDemo();
    await signInAs(/Client contributor/);
    await screen.findByRole("heading", { name: "My controls" }, { timeout: 5000 });
    expect(await screen.findByText(/34 applicable/)).toBeInTheDocument(); // not all 112: only what was handed to him
    expect(screen.queryByRole("link", { name: "Tenants" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
  });

  it("signing out returns to the sign-in page with the demo panel still there", async () => {
    openDemo();
    await signInAs(/Auditor ·/);
    await screen.findByText("Completion", {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: /Lead auditor/ })).toBeInTheDocument();
  });
});

describe("doing the real work through the screens", () => {
  it("the lead auditor reviews a submitted control: Review, then Accept, and the table shows it accepted", async () => {
    openDemo();
    await signInAs(/Lead auditor/);
    await screen.findByText("Completion", {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole("link", { name: "Controls" }));
    const cell = await screen.findByText("A.8.8", {}, { timeout: 5000 });
    const row = cell.closest("tr")!;
    expect(within(row).getByText("Submitted")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Review" }));
    await userEvent.click(await screen.findByText("Accept"));
    await waitFor(() => expect(within(screen.getByText("A.8.8").closest("tr")!).getByText("Accepted")).toBeInTheDocument(), { timeout: 5000 });
    // and the pretend server recorded it, the way the real one would
    const a88 = demo.backend.state.controls.find((c) => c.controlRef === "A.8.8" && demo.backend.state.audits.find((x) => x.id === c.auditId)!.status === "in_progress" && demo.backend.state.audits.find((x) => x.id === c.auditId)!.name.includes("2026") && demo.backend.state.tenants.find((t) => t.id === c.tenantId)!.name.startsWith("Brightwave"))!;
    expect(a88.status).toBe("accepted");
    expect(demo.backend.state.reviews.at(-1)).toMatchObject({ controlId: a88.id, decision: "accept" });
  }, 20000);

  it("closing the audit cycle turns the controls page read-only", async () => {
    openDemo();
    await signInAs(/Lead auditor/);
    await screen.findByText("Completion", {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole("link", { name: "Controls" }));
    await screen.findByText("A.8.8", {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: "Close audit cycle" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, close it" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(demo.backend.state.audits.filter((a) => a.status === "closed")).toHaveLength(2);
  }, 20000);
});

describe("Reset demo", () => {
  it("puts the sample world back, forgets who was signed in, and reloads", async () => {
    openDemo();
    await signInAs(/Organisation admin/);
    await screen.findByText("Completion", {}, { timeout: 5000 });
    demo.backend.state.tenants.push({ id: "extra", name: "Added by visitor", status: "active", storageRootId: null, allowedDomains: ["x.example"] });
    localStorage.setItem("selectedTenantId", "extra");
    localStorage.setItem("selectedAudit:extra", "x");
    localStorage.setItem("unrelated", "keep");
    await userEvent.click(screen.getByRole("button", { name: "Reset demo" }));
    expect(demo.backend.state.tenants.map((t) => t.name)).not.toContain("Added by visitor");
    expect(localStorage.getItem("selectedTenantId")).toBeNull();
    expect(localStorage.getItem("selectedAudit:extra")).toBeNull();
    expect(localStorage.getItem("evidence-portal-session")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(reloads).toBe(1);
    expect(window.location.hash).toBe("#/login");
  });
});
