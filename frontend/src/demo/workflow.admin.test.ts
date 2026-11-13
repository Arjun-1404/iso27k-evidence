// @vitest-environment node
// Running the organisation: clients, people, where evidence is kept, the audit log, and the demo's own memory.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoBackend } from "./backend";
import { installDemoFetch } from "./install";
import { STORAGE_KEY, type KeyValueStore } from "./state";
import { makeKit, PEOPLE, refusal, tenantNamed, TEST_BASE_URL, FIXED_NOW, type Kit } from "./testkit";

let kit: Kit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.stop());

describe("clients", () => {
  it("an organisation admin adds a client, sets up its folder, starts an audit from the template, and the controls are there", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const created = await aoife.createTenant("Dunmore Dental Group", ["dunmore.example"]);
    expect(created).toMatchObject({ name: "Dunmore Dental Group", status: "active" });
    expect((await aoife.listTenants()).map((t) => t.name)).toContain("Dunmore Dental Group");

    const [template] = await aoife.listTemplates();
    expect(template).toMatchObject({ framework: "ISO/IEC 27001:2022" });
    expect(await refusal(aoife.createAudit(created.id, "no-such-template", "x"))).toMatchObject({ status: 404 });
    const audit = await aoife.createAudit(created.id, template!.id, "Stage 1 audit 2026");
    expect(audit).toMatchObject({ status: "in_progress", name: "Stage 1 audit 2026" });
    const controls = await aoife.listControls(audit.id);
    expect(controls).toHaveLength(117);
    expect(controls.every((c) => c.status === "not_started" && c.applicable && c.fileCount === 0)).toBe(true);

    // no folder yet: nothing can be uploaded until storage is set up for this client
    const c = controls[0]!;
    expect(await refusal(aoife.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 5 }))).toMatchObject({ code: "STORAGE_NOT_CONNECTED" });
    const root = await aoife.createTenantStorageRoot(created.id);
    expect(root.storageRootId).toBeTruthy();
    expect(await refusal(aoife.createTenantStorageRoot(created.id))).toMatchObject({ status: 409, code: "STORAGE_ROOT_EXISTS" });
    await aoife.requestUploadSession(c.id, { fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 5 });
  });

  it("only an organisation admin adds, archives or restores clients", async () => {
    const declan = await kit.as(PEOPLE.declan);
    expect(await refusal(declan.createTenant("Nope Ltd", ["nope.example"]))).toMatchObject({ status: 403 });
    const bw = await tenantNamed(declan, "Brightwave");
    expect(await refusal(declan.archiveTenant(bw.id))).toMatchObject({ status: 404 });
  });

  it("a client name and at least one allowed domain are required", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    expect(await refusal(aoife.createTenant("", ["x.example"]))).toMatchObject({ status: 400 });
    expect(await refusal(aoife.createTenant("Name only", []))).toMatchObject({ status: 400 });
  });

  it("the audit log is for admins and lead auditors only, newest first, and records what was done", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const before = await aoife.listAuditLog();
    expect(before.length).toBe(200); // capped, as on the real server
    await aoife.createTenant("Logged Ltd", ["logged.example"]);
    const after = await aoife.listAuditLog();
    expect(after[0]).toMatchObject({ action: "tenant.created", change: { name: "Logged Ltd" } });
    expect(BigInt(after[0]!.seq)).toBeGreaterThan(BigInt(before[0]!.seq));
    expect(after[0]!.actorId).toBeTruthy();

    for (const who of [PEOPLE.maeve, PEOPLE.ronan, PEOPLE.priya, PEOPLE.tom]) expect(await (await kit.as(who)).listAuditLog()).toEqual([]);
    expect((await (await kit.as(PEOPLE.declan)).listAuditLog()).length).toBe(200);
  });
});

describe("people", () => {
  it("an admin invites staff and a client lead invites their own team; addresses must be on the allowed domain", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const invited = await aoife.inviteAuditorUser("new.auditor@harbourview.example", "auditor");
    expect(invited).toMatchObject({ email: "new.auditor@harbourview.example", role: "auditor", status: "invited" });
    expect((await aoife.listOrgUsers()).map((u) => u.email)).toContain("new.auditor@harbourview.example");
    expect(await refusal(aoife.inviteAuditorUser("someone@elsewhere.example", "auditor"))).toMatchObject({ status: 422, code: "DOMAIN_NOT_ALLOWED" });
    expect(await refusal(aoife.inviteAuditorUser("not-an-address", "auditor"))).toMatchObject({ status: 422 });
    expect(await refusal(aoife.inviteAuditorUser("new.auditor@harbourview.example", "auditor"))).toMatchObject({ status: 409, code: "DUPLICATE" });

    const priya = await kit.as(PEOPLE.priya);
    const bw = await tenantNamed(priya, "Brightwave");
    const teammate = await priya.inviteTenantUser(bw.id, "new.hire@brightwave.example", "contributor");
    expect(teammate).toMatchObject({ role: "contributor", status: "invited" });
    expect(await refusal(priya.inviteTenantUser(bw.id, "outsider@corran.example", "contributor"))).toMatchObject({ code: "DOMAIN_NOT_ALLOWED" });
    expect(await refusal(priya.inviteTenantUser(bw.id, "boss@brightwave.example", "tenant_lead"))).toMatchObject({ status: 403 }); // leads are made by staff
    expect(await refusal(priya.inviteAuditorUser("x@harbourview.example", "auditor"))).toMatchObject({ status: 403 });
    expect(await priya.resendInvite(teammate.id)).toEqual({ id: teammate.id });
  });

  it("a contributor cannot invite anyone", async () => {
    const tom = await kit.as(PEOPLE.tom);
    const bw = await tenantNamed(tom, "Brightwave");
    expect(await refusal(tom.inviteTenantUser(bw.id, "friend@brightwave.example", "contributor"))).toMatchObject({ status: 403 });
  });

  it("switching a person off ends their sign-in; switching them on restores it", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const tomId = (await aoife.listTenantUsers((await tenantNamed(aoife, "Brightwave")).id)).find((u) => u.email === PEOPLE.tom)!.id;
    const tom = await kit.as(PEOPLE.tom);
    expect(await aoife.disableUser(tomId)).toMatchObject({ status: "disabled" });
    expect(await refusal(tom.listTenants())).toMatchObject({ status: 401 }); // the session they already had stops working too
    await expect(kit.as(PEOPLE.tom)).rejects.toThrow(/login failed/);
    expect(await aoife.reactivateUser(tomId)).toMatchObject({ status: "active" });
    expect(await tom.listTenants()).toHaveLength(1);
  });

  it("the people lists show the client's side only to those who may see it, and mfaEnabled only to admins", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const staff = await aoife.listOrgUsers();
    expect(staff.every((u) => typeof u.mfaEnabled === "boolean")).toBe(true);
    const declan = await kit.as(PEOPLE.declan);
    expect((await declan.listOrgUsers()).every((u) => u.mfaEnabled === undefined)).toBe(true);
    expect(await (await kit.as(PEOPLE.priya)).listOrgUsers()).toEqual([]);
  });
});

describe("where evidence is kept", () => {
  it("offers this server's disk, says why the others are not available in a demo, and locks once evidence exists", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    const o = await aoife.getStorageOptions();
    expect(o.current).toBe("local");
    expect(o.locked).toBe(true); // the sample data already has evidence files
    const byName = Object.fromEntries(o.options.map((x) => [x.provider, x]));
    expect(byName.local).toMatchObject({ available: true, connected: true });
    expect(byName.google_drive).toMatchObject({ available: false });
    expect(byName.s3).toMatchObject({ available: false });
    expect(byName.sharepoint!.unavailableReason).toMatch(/later release/);
    expect(await refusal(aoife.connectS3Storage({ endpoint: "https://s3.example", region: "eu-west-1", bucket: "b", accessKeyId: "a", secretAccessKey: "s" } as never))).toMatchObject({ status: 409, code: "DEMO_UNAVAILABLE" });
    expect(await refusal(aoife.chooseStorageProvider("s3"))).toMatchObject({ status: 409, code: "STORAGE_NOT_CONNECTED" });
    expect(await aoife.chooseStorageProvider("local")).toEqual({ provider: "local" });
  });

  it("only an organisation admin may look at or change it", async () => {
    for (const who of [PEOPLE.declan, PEOPLE.priya]) {
      const api = await kit.as(who);
      expect(await refusal(api.getStorageOptions())).toMatchObject({ status: 403 });
      expect(await refusal(api.connectLocalStorage())).toMatchObject({ status: 403 });
    }
  });

  it("the server settings page has nothing in it for a demo", async () => {
    const aoife = await kit.as(PEOPLE.aoife);
    expect(await aoife.getPlatformOwner()).toEqual({ owner: false });
    expect(await refusal(aoife.getPlatformSettings())).toMatchObject({ status: 403 });
  });
});

describe("the demo's memory", () => {
  function memoryStore(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  }

  it("keeps changes for the tab (so a page reload does not undo them) and Reset puts the sample world back", async () => {
    const store = memoryStore();
    const opts = { now: () => FIXED_NOW, store };
    const first = new DemoBackend(opts);
    const stop = installDemoFetch(first, { baseUrl: TEST_BASE_URL });
    try {
      const { ApiClient } = await import("../api/client");
      const login = await (await fetch(`${TEST_BASE_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: PEOPLE.aoife, password: "demo-password-123" }) })).json();
      const api = new ApiClient({ baseUrl: TEST_BASE_URL, getToken: async () => login.token });
      await api.createTenant("Survives Reload Ltd", ["reload.example"]);
      expect(store.data.has(STORAGE_KEY)).toBe(true);

      const afterReload = new DemoBackend(opts); // a new page load reads the same tab memory
      expect(afterReload.state.tenants.map((t) => t.name)).toContain("Survives Reload Ltd");

      afterReload.reset();
      expect(afterReload.state.tenants.map((t) => t.name)).not.toContain("Survives Reload Ltd");
      expect(new DemoBackend(opts).state.tenants.map((t) => t.name)).not.toContain("Survives Reload Ltd");
    } finally { stop(); }
  });

  it("starts fresh from the sample data when what was kept is damaged or from an older version", () => {
    for (const junk of ["not json", "{}", JSON.stringify({ version: 0, users: [], controls: [] }), "null"]) {
      const store = memoryStore();
      store.data.set(STORAGE_KEY, junk);
      expect(new DemoBackend({ now: () => FIXED_NOW, store }).state.users.length).toBeGreaterThan(5);
    }
  });

  it("works when the browser lets it keep nothing (private windows)", () => {
    const refusing: KeyValueStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const b = new DemoBackend({ now: () => FIXED_NOW, store: refusing });
    expect(() => b.persist()).not.toThrow();
    expect(() => b.reset()).not.toThrow();
  });

  it("two page loads at different times still show the sample as 'recent': dates move with the clock", async () => {
    const a = new DemoBackend({ now: () => FIXED_NOW, store: null });
    const b = new DemoBackend({ now: () => FIXED_NOW + 30 * 86_400_000, store: null });
    const latest = (s: DemoBackend) => s.state.log.map((e) => e.createdAt).sort().at(-1)!;
    expect(Date.parse(latest(b)) - Date.parse(latest(a))).toBe(30 * 86_400_000);
  });
});
