// The guided tour in the real app, the way a visitor uses it: open it from the banner, switch person with its buttons, do the
// work on the real screens, and watch the steps tick themselves.

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
import { startDemo, type RunningDemo } from "./index";

vi.setConfig({ testTimeout: 60_000 });

let demo: RunningDemo;

function openDemo(route = "/login") {
  demo = startDemo({ reload: () => {}, latencyMs: 0 });
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

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { demo?.stop(); });

const panel = () => screen.getByRole("region", { name: "Guided tour" });
const stepDone = (title: RegExp) => within(panel()).queryByRole("heading", { name: new RegExp(`${title.source}\\s*\\(done\\)`) });

describe("the guided tour panel", () => {
  it("starts closed behind an inviting button, opens to the steps, and closes again", async () => {
    openDemo();
    expect(screen.queryByRole("region", { name: "Guided tour" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Take the 3-minute tour" }));
    const p = panel();
    expect(within(p).getAllByRole("heading", { level: 3 })).toHaveLength(6);
    expect(within(p).getByRole("progressbar", { name: "Tour progress" })).toHaveAttribute("aria-valuenow", "0");
    expect(within(p).getByRole("button", { name: "Switch to Priya Shah" })).toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "Switch to Declan Walsh" })).toBeInTheDocument();
    await userEvent.click(within(p).getByRole("button", { name: "Close the tour" }));
    expect(screen.queryByRole("region", { name: "Guided tour" })).not.toBeInTheDocument();
  });

  it("the Switch buttons sign in as the right person and open the right page", async () => {
    openDemo();
    await userEvent.click(screen.getByRole("button", { name: "Take the 3-minute tour" }));
    await userEvent.click(within(panel()).getByRole("button", { name: "Switch to Priya Shah" }));
    expect(await screen.findByRole("heading", { name: "My controls" }, { timeout: 5000 })).toBeInTheDocument();
    await userEvent.click(within(panel()).getByRole("button", { name: "Switch to Declan Walsh" }));
    expect(await screen.findByRole("heading", { name: /Controls/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My controls" })).not.toBeInTheDocument();
    expect(await screen.findByText("A.8.8", {}, { timeout: 5000 })).toBeInTheDocument(); // the auditor's own table
  });

  it("the steps tick themselves as the visitor does the real work, all the way through", async () => {
    openDemo();
    await userEvent.click(screen.getByRole("button", { name: "Take the 3-minute tour" }));

    // 1 + 2: the client uploads, then submits
    await userEvent.click(within(panel()).getByRole("button", { name: "Switch to Priya Shah" }));
    await screen.findByRole("heading", { name: "My controls" }, { timeout: 5000 });
    const uploadButtons = await screen.findAllByRole("button", { name: "Upload" }, { timeout: 5000 });
    const row = uploadButtons[0]!.closest("li")!;
    await userEvent.click(uploadButtons[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Upload evidence" });
    await userEvent.upload(dialog.querySelector("input[type=file]") as HTMLInputElement, new File([new Uint8Array(64).fill(37)], "tour-evidence.pdf", { type: "application/pdf" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
    await within(dialog).findByText("Uploaded.", {}, { timeout: 5000 });
    await waitFor(() => expect(stepDone(/The client hands over evidence/)).toBeInTheDocument());
    expect(stepDone(/and sends it for review/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.click(await within(row).findByRole("button", { name: "Submit" }, { timeout: 5000 }));
    await waitFor(() => expect(stepDone(/and sends it for review/)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByRole("button", { name: "Tour 2/5" })).toBeInTheDocument();

    // 3: the auditor decides
    await userEvent.click(within(panel()).getByRole("button", { name: "Switch to Declan Walsh" }));
    const cell = await screen.findByText("A.8.8", {}, { timeout: 5000 });
    await userEvent.click(within(cell.closest("tr")!).getByRole("button", { name: "Review" }));
    await userEvent.click(await screen.findByText("Accept"));
    await waitFor(() => expect(stepDone(/The auditor decides/)).toBeInTheDocument(), { timeout: 5000 });

    // 4 + 5: the dashboard and the audit log
    expect(stepDone(/The dashboard moves/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    await waitFor(() => expect(stepDone(/The dashboard moves/)).toBeInTheDocument(), { timeout: 5000 });
    await userEvent.click(screen.getByRole("link", { name: "Audit log" }));
    await waitFor(() => expect(stepDone(/Every step is on the record/)).toBeInTheDocument(), { timeout: 5000 });

    expect(screen.getByRole("button", { name: "Tour 5/5" })).toBeInTheDocument();
    expect(within(panel()).getByRole("progressbar", { name: "Tour progress" })).toHaveAttribute("aria-valuenow", "5");
    expect(within(panel()).getByText(/That is the whole loop/)).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /^Switch to/ })).not.toBeInTheDocument(); // done steps drop their instructions
    expect(stepDone(/Bonus/)).not.toBeInTheDocument(); // the bonus is not required for the loop to be complete
  });

  it("Reset demo starts the tour over", async () => {
    openDemo();
    await userEvent.click(screen.getByRole("button", { name: "Take the 3-minute tour" }));
    await userEvent.click(within(panel()).getByRole("button", { name: "Switch to Declan Walsh" }));
    await screen.findByText("A.8.8", {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole("link", { name: "Audit log" }));
    await waitFor(() => expect(stepDone(/Every step is on the record/)).toBeInTheDocument(), { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: "Reset demo" }));
    await waitFor(() => expect(stepDone(/Every step is on the record/)).not.toBeInTheDocument());
    expect(demo.backend.tourSnapshot()).toEqual([]);
  });
});
