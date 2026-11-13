import { describe, it, expect, vi } from "vitest";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { ApiClient, ApiError, resolveUploadUrl, uploadFile } from "./client";

const clientWith = (token: string | null, onUnauthorized?: () => void, baseUrl = API_BASE) =>
  new ApiClient({ baseUrl, getToken: async () => token, onUnauthorized });

describe("resolveUploadUrl", () => {
  it("keeps a full address (Google's) exactly as it is", () => {
    const google = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";
    expect(resolveUploadUrl("https://api.example.com", google)).toBe(google);
  });

  it("puts the portal's own /uploads/… address on the API's address", () => {
    expect(resolveUploadUrl("https://api.example.com", "/uploads/abc.def")).toBe("https://api.example.com/uploads/abc.def");
    expect(resolveUploadUrl("http://localhost:3000", "/uploads/abc.def")).toBe("http://localhost:3000/uploads/abc.def");
  });

  it("keeps a path the API lives under, and doesn't double the slash", () => {
    expect(resolveUploadUrl("https://host.example.com/api", "/uploads/t")).toBe("https://host.example.com/api/uploads/t");
    expect(resolveUploadUrl("https://host.example.com/api/", "/uploads/t")).toBe("https://host.example.com/api/uploads/t");
  });

  it("falls back to the page's own address when the API address is empty (served from the same place)", () => {
    expect(resolveUploadUrl("", "/uploads/t")).toBe(`${window.location.origin}/uploads/t`);
  });
});

describe("uploadFile", () => {
  const file = new File(["hello evidence"], "policy.pdf", { type: "application/pdf" });
  const session = (uploadUrl: string) => ({ uploadUrl, method: "PUT", headers: {}, providerFileId: "pf-1", expiresAt: "2026-11-08T12:00:00.000Z" });

  it("sends a file kept on the server's disk or in S3 to the portal itself, then confirms it", async () => {
    let putBody = ""; let putAuth: string | null = "unset"; let confirmed = 0;
    server.use(
      http.post(`${API_BASE}/controls/c1/upload-session`, () => json(session("/uploads/signed.token"))),
      http.put(`${API_BASE}/uploads/signed.token`, async ({ request }) => { putBody = await request.text(); putAuth = request.headers.get("authorization"); return new Response(null, { status: 204 }); }),
      http.post(`${API_BASE}/controls/c1/uploads/confirm`, () => { confirmed++; return json({ id: "e1", fileName: "policy.pdf", scanStatus: "clean" }); }),
    );
    const done = await uploadFile(clientWith("jwt.ok"), "c1", file);
    expect(done).toMatchObject({ id: "e1", scanStatus: "clean" });
    expect(putBody).toBe("hello evidence");
    expect(putAuth).toBeNull(); // the signed link is the permission; the session token isn't sent along
    expect(confirmed).toBe(1);
  });

  it("sends a Google Drive upload to Google, untouched", async () => {
    const hit: string[] = [];
    server.use(
      http.post(`${API_BASE}/controls/c1/upload-session`, () => json(session("https://upload.google.test/resumable/abc"))),
      http.put("https://upload.google.test/resumable/abc", () => { hit.push("google"); return new Response(null, { status: 200 }); }),
      http.post(`${API_BASE}/controls/c1/uploads/confirm`, () => json({ id: "e1", fileName: "policy.pdf", scanStatus: "clean" })),
    );
    await uploadFile(clientWith("jwt.ok"), "c1", file);
    expect(hit).toEqual(["google"]);
  });

  it("says what the portal said when it refuses the upload, and does not confirm anything", async () => {
    let confirmed = 0;
    server.use(
      http.post(`${API_BASE}/controls/c1/upload-session`, () => json(session("/uploads/t"))),
      http.put(`${API_BASE}/uploads/t`, () => apiError(403, "UPLOAD_LINK_INVALID", "This upload link has expired or isn't valid. Choose the file again.")),
      http.post(`${API_BASE}/controls/c1/uploads/confirm`, () => { confirmed++; return json({}); }),
    );
    await expect(uploadFile(clientWith("jwt.ok"), "c1", file)).rejects.toMatchObject({ status: 403, code: "UPLOAD_LINK_INVALID", message: "This upload link has expired or isn't valid. Choose the file again." });
    expect(confirmed).toBe(0);
  });

  it("falls back to a plain sentence when the answer isn't one of ours (Google, or a proxy in between)", async () => {
    server.use(
      http.post(`${API_BASE}/controls/c1/upload-session`, () => json(session("https://upload.google.test/resumable/x"))),
      http.put("https://upload.google.test/resumable/x", () => new Response("<html>Bad gateway</html>", { status: 502 })),
    );
    const err = await uploadFile(clientWith("jwt.ok"), "c1", file).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: "STORAGE_UPLOAD_FAILED", message: "The upload to storage failed. Please try again." });
  });

  it("has nothing to send for the in-memory test storage, and still confirms", async () => {
    server.use(
      http.post(`${API_BASE}/controls/c1/upload-session`, () => json(session("memory://pf-1"))),
      http.post(`${API_BASE}/controls/c1/uploads/confirm`, () => json({ id: "e1", fileName: "policy.pdf", scanStatus: "clean" })),
    );
    await expect(uploadFile(clientWith("jwt.ok"), "c1", file)).resolves.toMatchObject({ id: "e1" });
  });
});

describe("ApiClient.downloadEvidence", () => {
  it("fetches the file with the person's session and hands back its bytes", async () => {
    let auth: string | null = null;
    server.use(http.get(`${API_BASE}/evidence/e1/download`, ({ request }) => {
      auth = request.headers.get("authorization");
      return new Response(new Uint8Array([1, 2, 3, 250]), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }));
    const blob = await clientWith("jwt.ok").downloadEvidence("e1");
    expect(auth).toBe("Bearer jwt.ok");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 250]);
  });

  it("throws the server's explanation when the file can't be had", async () => {
    server.use(http.get(`${API_BASE}/evidence/e1/download`, () => apiError(404, "NOT_FOUND", "File not found.")));
    await expect(clientWith("jwt.ok").downloadEvidence("e1")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND", message: "File not found." });
  });

  it("explains in words when the answer isn't one of ours", async () => {
    server.use(http.get(`${API_BASE}/evidence/e1/download`, () => new Response("bad gateway", { status: 502 })));
    await expect(clientWith("jwt.ok").downloadEvidence("e1")).rejects.toMatchObject({ status: 502, message: "The download failed (502)." });
  });

  it("ends the session on 401, as every other request does", async () => {
    server.use(http.get(`${API_BASE}/evidence/e1/download`, () => apiError(401, "UNAUTHENTICATED", "Invalid or expired session.")));
    const onUnauthorized = vi.fn();
    await expect(clientWith("jwt.old", onUnauthorized).downloadEvidence("e1")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("ApiClient: where evidence is kept", () => {
  it("sends each request to the address the server listens on, with the entered details", async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const record = (method: string, path: string, reply: unknown) =>
      (http as unknown as Record<string, (p: string, h: (a: { request: Request }) => unknown) => ReturnType<typeof http.get>>)[method.toLowerCase()](`${API_BASE}${path}`, async ({ request }) => {
        seen.push({ method, path, body: request.method === "GET" ? undefined : await request.json().catch(() => undefined) });
        return json(reply as Record<string, unknown>);
      });
    server.use(
      record("GET", "/org/storage-options", { current: "local", locked: false, options: [] }),
      record("POST", "/org/storage-connections/local", { id: "c", provider: "local", folder: "/x" }),
      record("POST", "/org/storage-connections/s3/test", { ok: true }),
      record("PUT", "/org/storage-connections/s3", { id: "c", provider: "s3", label: "b" }),
      record("PUT", "/org/storage-provider", { provider: "s3" }),
    );
    const api = clientWith("jwt.ok");
    const form = { endpoint: "", region: "eu-west-1", bucket: "bkt", accessKeyId: "AK", secretAccessKey: "SK", forcePathStyle: false, prefix: "" };
    await api.getStorageOptions();
    await api.connectLocalStorage();
    await api.testS3Storage(form);
    await api.connectS3Storage(form);
    await api.chooseStorageProvider("s3");
    expect(seen).toEqual([
      { method: "GET", path: "/org/storage-options", body: undefined },
      { method: "POST", path: "/org/storage-connections/local", body: undefined },
      { method: "POST", path: "/org/storage-connections/s3/test", body: form },
      { method: "PUT", path: "/org/storage-connections/s3", body: form },
      { method: "PUT", path: "/org/storage-provider", body: { provider: "s3" } },
    ]);
  });
});
