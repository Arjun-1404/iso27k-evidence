// @vitest-environment node
// The guided tour: which requests tick which step, that a step ticks only for something that really happened, and that
// the ticks live and die with the demo's own state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadFile } from "../api/client";
import { DemoBackend } from "./backend";
import { DEMO_PASSWORD } from "./accounts";
import { auditOf, makeKit, pdfFile, PEOPLE, refusal, type Kit } from "./testkit";
import { MAIN_STEPS, TOUR_STEPS, tourStepFor } from "./tour";
import { stepAt, totpAtStep } from "./totp";
import type { KeyValueStore } from "./state";

let kit: Kit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.stop());

const client = { role: "tenant_lead" as const, tenantId: "t1" };
const auditor = { role: "lead_auditor" as const, tenantId: null };
const admin = { role: "org_admin" as const, tenantId: null };
const maeve = { role: "auditor" as const, tenantId: null };

describe("which request ticks which step", () => {
  it("an upload and a submit count only when a client's person does them", () => {
    expect(tourStepFor("POST", "/controls/abc/uploads/confirm", client, [])).toBe("upload");
    expect(tourStepFor("POST", "/controls/abc/uploads/confirm", auditor, [])).toBeNull();
    expect(tourStepFor("POST", "/controls/abc/submit", client, [])).toBe("submit");
    expect(tourStepFor("POST", "/controls/abc/submit", auditor, [])).toBeNull();
  });

  it("a review counts only when the audit firm's person does it", () => {
    expect(tourStepFor("POST", "/controls/abc/reviews", auditor, [])).toBe("review");
    expect(tourStepFor("POST", "/controls/abc/reviews", maeve, [])).toBe("review");
    expect(tourStepFor("POST", "/controls/abc/reviews", client, [])).toBeNull();
  });

  it("the dashboard counts only after something has been reviewed", () => {
    expect(tourStepFor("GET", "/audits/xyz/dashboard", auditor, [])).toBeNull();
    expect(tourStepFor("GET", "/audits/xyz/dashboard", auditor, ["upload", "submit"])).toBeNull();
    expect(tourStepFor("GET", "/audits/xyz/dashboard", auditor, ["review"])).toBe("dashboard");
    expect(tourStepFor("GET", "/audits/xyz/dashboard", client, ["review"])).toBe("dashboard");
  });

  it("the audit log counts only for the two roles that can read it", () => {
    expect(tourStepFor("GET", "/audit-log", auditor, [])).toBe("audit-log");
    expect(tourStepFor("GET", "/audit-log", admin, [])).toBe("audit-log");
    expect(tourStepFor("GET", "/audit-log", maeve, [])).toBeNull(); // she is shown an empty list
    expect(tourStepFor("GET", "/audit-log", client, [])).toBeNull();
  });

  it("confirming two-step sign-in is the bonus step; starting it is not", () => {
    expect(tourStepFor("POST", "/auth/mfa/enroll/confirm", client, [])).toBe("two-step");
    expect(tourStepFor("POST", "/auth/mfa/enroll", client, [])).toBeNull();
  });

  it("other requests, other methods and a signed-out visitor tick nothing", () => {
    expect(tourStepFor("GET", "/controls/abc/files", client, [])).toBeNull();
    expect(tourStepFor("GET", "/controls/abc/submit", client, [])).toBeNull();
    expect(tourStepFor("POST", "/controls/abc/submit", null, [])).toBeNull();
    expect(tourStepFor("POST", "/controls/abc/submitx", client, [])).toBeNull();
  });

  it("the list of steps has five main ones and the bonus last, each with its instruction", () => {
    expect(MAIN_STEPS).toHaveLength(5);
    expect(TOUR_STEPS.at(-1)).toMatchObject({ id: "two-step", bonus: true });
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const s of TOUR_STEPS) expect(s.how.length).toBeGreaterThan(20);
  });
});

describe("the pretend server ticking the steps", () => {
  it("walks the whole story: upload, submit, review, dashboard, audit log", async () => {
    expect(kit.backend.tourSnapshot()).toEqual([]);

    const priya = await kit.as(PEOPLE.priya);
    const audit = await auditOf(priya, "Brightwave", "open");
    const c = (await priya.listControls(audit.id)).find((x) => x.applicable && x.status === "not_started" && x.fileCount === 0)!;
    await uploadFile(priya, c.id, pdfFile());
    expect(kit.backend.tourSnapshot()).toEqual(["upload"]);
    await priya.submitControl(c.id);
    expect(kit.backend.tourSnapshot()).toEqual(["upload", "submit"]);

    const declan = await kit.as(PEOPLE.declan);
    await declan.getDashboard(audit.id); // looked at before anything was reviewed: does not count
    expect(kit.backend.tourSnapshot()).toEqual(["upload", "submit"]);
    await declan.review(c.id, "accept");
    expect(kit.backend.tourSnapshot()).toEqual(["upload", "submit", "review"]);
    await declan.getDashboard(audit.id);
    await declan.listAuditLog();
    expect(kit.backend.tourSnapshot()).toEqual(["upload", "submit", "review", "dashboard", "audit-log"]);
    expect(MAIN_STEPS.every((s) => kit.backend.tourSnapshot().includes(s.id))).toBe(true);
  });

  it("a step is ticked once, and a repeat of it changes nothing", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const audit = await auditOf(priya, "Brightwave", "open");
    const [a, b] = (await priya.listControls(audit.id)).filter((x) => x.applicable && x.status === "not_started" && x.fileCount === 0);
    await uploadFile(priya, a!.id, pdfFile("one.pdf"));
    const first = kit.backend.tourSnapshot();
    await uploadFile(priya, b!.id, pdfFile("two.pdf"));
    expect(kit.backend.tourSnapshot()).toBe(first); // the very same array: nothing was replaced
  });

  it("a refused request ticks nothing", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const audit = await auditOf(priya, "Brightwave", "open");
    const c = (await priya.listControls(audit.id)).find((x) => x.applicable && x.status === "not_started" && x.fileCount === 0)!;
    expect(await refusal(priya.submitControl(c.id))).toMatchObject({ code: "EVIDENCE_REQUIRED" }); // nothing uploaded yet
    expect(kit.backend.tourSnapshot()).toEqual([]);
    const maeve = await kit.as(PEOPLE.maeve);
    await maeve.listAuditLog(); // she is shown nothing
    expect(kit.backend.tourSnapshot()).toEqual([]);
  });

  it("turning on two-step sign-in ticks the bonus step", async () => {
    const priya = await kit.as(PEOPLE.priya);
    const { secret } = await priya.startMfaEnrollment(DEMO_PASSWORD);
    expect(kit.backend.tourSnapshot()).toEqual([]); // started, not finished
    await priya.confirmMfaEnrollment(await totpAtStep(secret, stepAt(kit.clock.now)));
    expect(kit.backend.tourSnapshot()).toEqual(["two-step"]);
  });

  it("tells a watcher when a step is ticked and when the demo is reset, and stops when asked", async () => {
    let calls = 0;
    const stop = kit.backend.subscribeTour(() => { calls++; });
    const declan = await kit.as(PEOPLE.declan);
    await declan.listAuditLog();
    expect(calls).toBe(1);
    kit.backend.reset();
    expect(calls).toBe(2);
    expect(kit.backend.tourSnapshot()).toEqual([]);
    stop();
    kit.backend.reset();
    expect(calls).toBe(2);
  });
});

describe("the ticks live in the tab's own copy", () => {
  function memoryStore(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  }

  it("survive a reload of the page (a new server reading the same tab) and are cleared by Reset demo", async () => {
    const store = memoryStore();
    const first = new DemoBackend({ store });
    const res = await first.handle({ method: "POST", path: "/auth/login", token: null, body: { email: PEOPLE.declan, password: DEMO_PASSWORD } });
    const token = (res.json as { token: string }).token;
    await first.handle({ method: "GET", path: "/audit-log", token });
    expect(first.tourSnapshot()).toEqual(["audit-log"]);

    const reloaded = new DemoBackend({ store });
    expect(reloaded.tourSnapshot()).toEqual(["audit-log"]);

    reloaded.reset();
    expect(new DemoBackend({ store }).tourSnapshot()).toEqual([]);
  });

  it("an older copy of the state with no tour in it still loads, with nothing ticked", () => {
    const store = memoryStore();
    const seeded = new DemoBackend({ store });
    const old = { ...seeded.state } as Record<string, unknown>;
    delete old.tour;
    store.data.set("iso27k-demo-state", JSON.stringify(old));
    expect(new DemoBackend({ store }).tourSnapshot()).toEqual([]);
  });
});
