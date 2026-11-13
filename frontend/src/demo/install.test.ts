// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoBackend } from "./backend";
import { installDemoFetch } from "./install";
import { FIXED_NOW, makeKit, PEOPLE, TEST_BASE_URL } from "./testkit";

const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) stops.pop()!(); vi.restoreAllMocks(); });

function install(latencyMs?: number) {
  const backend = new DemoBackend({ now: () => FIXED_NOW, store: null });
  stops.push(installDemoFetch(backend, { baseUrl: TEST_BASE_URL, latencyMs }));
  return backend;
}

describe("the fetch wrapper", () => {
  it("hands every address that is not the demo's own straight to the browser's real fetch, untouched", async () => {
    const real = vi.fn(async () => new Response("from the real network", { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = real as unknown as typeof fetch;
    try {
      install();
      const res = await fetch("https://example.org/anything", { method: "POST", body: "x" });
      expect(await res.text()).toBe("from the real network");
      expect(real).toHaveBeenCalledWith("https://example.org/anything", { method: "POST", body: "x" });
      // an address that only looks similar is not the demo's either
      await fetch("https://api.demo.invalid.evil.example/auth/login");
      expect(real).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("puts the real fetch back when stopped", async () => {
    const original = globalThis.fetch;
    const stop = installDemoFetch(new DemoBackend({ now: () => FIXED_NOW, store: null }), { baseUrl: TEST_BASE_URL });
    expect(globalThis.fetch).not.toBe(original);
    stop();
    expect(globalThis.fetch).toBe(original);
  });

  it("answers an unknown page with the API's own kind of error, and a malformed body as a refusal, not a crash", async () => {
    install();
    const nope = await fetch(`${TEST_BASE_URL}/no/such/page`, { method: "GET" });
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ error: { code: "NOT_FOUND", message: "There is no such page in the API." } });
    const bad = await fetch(`${TEST_BASE_URL}/auth/login`, { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    const wrongShape = await fetch(`${TEST_BASE_URL}/auth/login`, { method: "POST", body: JSON.stringify({ email: 5 }) });
    expect(wrongShape.status).toBe(400);
    const malformed = await fetch(`${TEST_BASE_URL}/audits/%E0%A4%A/controls`, { method: "GET", headers: { Authorization: "Bearer x" } });
    expect([400, 401]).toContain(malformed.status);
  });

  it("ignores the query string, accepts a Request object, and reads the method from it", async () => {
    install();
    const res = await fetch(new Request(`${TEST_BASE_URL}/platform/owner?x=1`, { method: "GET", headers: { Authorization: "Bearer nope" } }));
    expect(res.status).toBe(401); // reached the route (which needs a session) rather than falling through
  });

  it("an unexpected failure inside the demo is a 500 with a plain message, never a thrown error in the page", async () => {
    const backend = install();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(backend, "userByEmail").mockImplementation(() => { throw new Error("boom"); });
    const res = await fetch(`${TEST_BASE_URL}/auth/login`, { method: "POST", body: JSON.stringify({ email: PEOPLE.priya, password: "x" }) });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(spy).toHaveBeenCalled();
  });

  it("can pretend the network takes a moment, and a request abandoned meanwhile is dropped (as when a screen closes)", async () => {
    install(40);
    const t0 = Date.now();
    await fetch(`${TEST_BASE_URL}/platform/owner`, { headers: { Authorization: "Bearer x" } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    const controller = new AbortController();
    const pending = fetch(`${TEST_BASE_URL}/platform/owner`, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an upload is read as raw bytes, not as JSON", async () => {
    const kit = makeKit();
    try {
      const api = await kit.as(PEOPLE.priya);
      const audit = (await api.listTenantAudits((await api.listTenants())[0]!.id)).find((a) => a.status === "in_progress")!;
      const c = (await api.listControls(audit.id)).find((x) => x.applicable && x.fileCount === 0)!;
      const session = await api.requestUploadSession(c.id, { fileName: "a.txt", mimeType: "text/plain", sizeBytes: 4 });
      const put = await fetch(`${TEST_BASE_URL}${session.uploadUrl}`, { method: session.method, body: new Blob(["{no}"]) });
      expect(put.status).toBe(204);
      expect(put.body).toBeNull();
    } finally { kit.stop(); }
  });
});
