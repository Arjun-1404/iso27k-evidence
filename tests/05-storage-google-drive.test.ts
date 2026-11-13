import { describe, it, expect } from "vitest";
import { GoogleDriveProvider, explainDriveRefusal } from "../src/storage/googleDrive.ts";
import { FakeDriveApi } from "../src/storage/fakeDriveApi.ts";
import { StorageError } from "../src/storage/types.ts";

const noSleep = { retries: 3, baseDelayMs: 1, sleep: async () => undefined };
function setup() {
  const api = new FakeDriveApi();
  const provider = new GoogleDriveProvider(async () => "fake-token", api.fetcher, noSleep);
  return { api, provider };
}

describe("GoogleDriveProvider: folder find-or-create", () => {
  it("creates a folder once and reuses it on a second call (idempotent)", async () => {
    const { api, provider } = setup();
    const a = await provider.findOrCreateFolder("root-1", "A.8.5");
    const b = await provider.findOrCreateFolder("root-1", "A.8.5");
    expect(a.id).toBe(b.id);
    expect(api.calls.filter((c) => c.method === "POST" && c.url.startsWith("/drive/v3/files?"))).toHaveLength(1);
  });

  it("does not reuse a folder with the same name under a different root", async () => {
    const { provider } = setup();
    const a = await provider.findOrCreateFolder("root-1", "A.8.5");
    const b = await provider.findOrCreateFolder("root-2", "A.8.5");
    expect(a.id).not.toBe(b.id);
  });

  it("finds a folder that already exists (seeded outside the app, e.g. created manually)", async () => {
    const { api, provider } = setup();
    api.seedFolder("preexisting-1", "A.8.7", "root-9");
    const r = await provider.findOrCreateFolder("root-9", "A.8.7");
    expect(r.id).toBe("preexisting-1");
  });

  it("escapes single quotes in folder and control names so they cannot break the Drive query", async () => {
    const { api, provider } = setup();
    const r1 = await provider.findOrCreateFolder("root-1", "Bob's Controls");
    const r2 = await provider.findOrCreateFolder("root-1", "Bob's Controls");
    expect(r1.id).toBe(r2.id);
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("GoogleDriveProvider: where a file is, and downloads through the portal", () => {
  it("metadata says which folder a file sits in", async () => {
    const { provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    const other = await provider.findOrCreateFolder("root-1", "A.8.6");
    const a = await provider.createUploadSession(folder.id, "a.pdf", "application/pdf", 10);
    const b = await provider.createUploadSession(other.id, "b.pdf", "application/pdf", 10);
    expect((await provider.getFileMetadata(a.providerFileId)).folderId).toBe(folder.id);
    expect((await provider.getFileMetadata(b.providerFileId)).folderId).toBe(other.id);
    expect((await provider.listFiles(folder.id)).map((f) => f.folderId)).toEqual([folder.id]);
  });

  it("opens a file as a stream with its size, type and name; the bytes are the file's own", async () => {
    const { api, provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    const s = await provider.createUploadSession(folder.id, "mfa.pdf", "application/pdf", 5);
    api.seedFileContent(s.providerFileId, new Uint8Array([1, 2, 3, 4, 5]));
    const opened = await provider.openFile(s.providerFileId);
    expect(opened).toMatchObject({ fileName: "mfa.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(c as Buffer);
    expect([...Buffer.concat(chunks)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("a file that is gone is 'not found', not an empty download", async () => {
    const { provider } = setup();
    await expect(provider.openFile("nope")).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });
  });
});

describe("GoogleDriveProvider: uploads", () => {
  it("creates a resumable upload session with a pre-allocated file id", async () => {
    const { provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    const session = await provider.createUploadSession(folder.id, "mfa.pdf", "application/pdf", 1234);
    expect(session.method).toBe("PUT");
    expect(session.uploadUrl).toContain(session.providerFileId);
    expect(session.providerFileId).toMatch(/^file-/);
  });

  it("reads back metadata including checksum once the upload has completed", async () => {
    const { provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    const session = await provider.createUploadSession(folder.id, "mfa.pdf", "application/pdf", 1234);
    const meta = await provider.getFileMetadata(session.providerFileId);
    expect(meta.name).toBe("mfa.pdf");
    expect(meta.hash).toBeTruthy();
    expect(meta.hashAlgo).toBe("md5");
  });

  it("lists files placed in a folder, and only that folder", async () => {
    const { provider } = setup();
    const f1 = await provider.findOrCreateFolder("root-1", "A.8.5");
    const f2 = await provider.findOrCreateFolder("root-1", "A.8.7");
    await provider.createUploadSession(f1.id, "one.pdf", "application/pdf", 10);
    await provider.createUploadSession(f1.id, "two.pdf", "application/pdf", 20);
    await provider.createUploadSession(f2.id, "other.pdf", "application/pdf", 30);
    const list = await provider.listFiles(f1.id);
    expect(list.map((f) => f.name).sort()).toEqual(["one.pdf", "two.pdf"]);
  });

  it("paginates through more files than fit on one page", async () => {
    const { api, provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    for (let i = 0; i < 5; i++) await provider.createUploadSession(folder.id, `f${i}.pdf`, "application/pdf", 1);
    const originalList = api.fetcher;
    const paged: typeof originalList = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/drive/v3/files" && (init?.method ?? "GET") === "GET" && !url.search.includes("mimeType")) {
        url.searchParams.set("pageSize", "2");
      }
      return originalList(url.toString(), init);
    };
    const paginatedProvider = new GoogleDriveProvider(async () => "fake-token", paged, noSleep);
    const list = await paginatedProvider.listFiles(folder.id);
    expect(list).toHaveLength(5);
  });

  it("detects a file that changed in storage after the fact (integrity check use case)", async () => {
    const { api, provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.7");
    const session = await provider.createUploadSession(folder.id, "coverage.xlsx", "application/vnd.ms-excel", 10);
    const before = await provider.getFileMetadata(session.providerFileId);
    api.mutateFile(session.providerFileId, { md5Checksum: "changed-hash", headRevisionId: "2" });
    const after = await provider.getFileMetadata(session.providerFileId);
    expect(after.hash).not.toBe(before.hash);
    expect(after.version).not.toBe(before.version);
  });

  it("downloads a file's bytes and mime type (used by the malware-scanning step)", async () => {
    const { api, provider } = setup();
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    const session = await provider.createUploadSession(folder.id, "mfa.pdf", "application/pdf", 3);
    api.seedFileContent(session.providerFileId, new TextEncoder().encode("hi!"));
    const dl = await provider.downloadFile(session.providerFileId);
    expect(Buffer.from(dl.bytes).toString("utf8")).toBe("hi!");
    expect(dl.mimeType).toBe("application/pdf");
  });
});

describe("GoogleDriveProvider: resilience and error mapping", () => {
  it("retries on a transient 500 and succeeds", async () => {
    const { api, provider } = setup();
    api.queueFailure(500, 2);
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    expect(folder.id).toBeTruthy();
  });

  it("retries on 429 rate limiting", async () => {
    const { api, provider } = setup();
    api.queueFailure(429, 1);
    const folder = await provider.findOrCreateFolder("root-1", "A.8.5");
    expect(folder.id).toBeTruthy();
  });

  it("gives up after exhausting retries and raises a retryable StorageError", async () => {
    const { api, provider } = setup();
    api.queueFailure(500, 10);
    await expect(provider.findOrCreateFolder("root-1", "A.8.5")).rejects.toMatchObject({ name: "StorageError", code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("maps a permission error to a non-retryable StorageError and does not retry it", async () => {
    const { api, provider } = setup();
    api.queueFailure(403, 1);
    await expect(provider.findOrCreateFolder("root-1", "A.8.5")).rejects.toMatchObject({ code: "PERMISSION_DENIED", retryable: false });
    expect(api.calls).toHaveLength(1);   // no retry burned on a permanent error
  });

  it("maps a missing file to NOT_FOUND", async () => {
    const { provider } = setup();
    await expect(provider.getFileMetadata("does-not-exist")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("StorageError is a real Error instance usable with instanceof", async () => {
    const { api, provider } = setup();
    api.queueFailure(403, 1);
    try {
      await provider.findOrCreateFolder("root-1", "x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});

/** Answers shaped like the ones Google really sends (field names and wording as documented for Drive v3). */
const GOOGLE = {
  apiOff: { error: { code: 403, message: "Google Drive API has not been used in project 123456789 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123456789 then retry. If you enabled this API recently, wait a few minutes.", errors: [{ message: "Google Drive API has not been used in project 123456789 before or it is disabled.", domain: "usageLimits", reason: "accessNotConfigured", extendedHelp: "https://console.developers.google.com" }], status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "drive.googleapis.com" } }] } },
  apiOffNewStyleOnly: { error: { code: 403, message: "Drive API disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } },
  scope: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
  full: { error: { code: 403, message: "The user's Drive storage quota has been exceeded.", errors: [{ message: "The user's Drive storage quota has been exceeded.", domain: "usageLimits", reason: "storageQuotaExceeded" }] } },
  slow: { error: { code: 403, message: "User Rate Limit Exceeded.", errors: [{ message: "User Rate Limit Exceeded.", domain: "usageLimits", reason: "userRateLimitExceeded" }] } },
  badToken: { error: { code: 401, message: "Invalid Credentials", errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError", location: "Authorization", locationType: "header" }], status: "UNAUTHENTICATED" } },
  other: { error: { code: 403, message: "The caller does not have permission", errors: [{ message: "The caller does not have permission", domain: "global", reason: "forbidden" }] } },
};

describe("GoogleDriveProvider: a refusal says why, and what to do", () => {
  const refuse = async (status: number, body: unknown) => {
    const { api, provider } = setup();
    api.queueFailure(status, 1, body);
    const e = await provider.createRootFolder("Evidence Portal").then(() => null, (err) => err as StorageError);
    return { e, calls: api.calls.length };
  };

  it("the Drive API being switched off is named, with the steps and Google's own link; not retried", async () => {
    const { e, calls } = await refuse(403, GOOGLE.apiOff);
    expect(e).toMatchObject({ name: "StorageError", code: "PERMISSION_DENIED", retryable: false });
    expect(e!.message).toMatch(/^Drive permission denied \(403\): the Google Drive API is switched off/);
    expect(e!.message).toContain("APIs & Services");
    expect(e!.message).toContain("Enable");
    expect(e!.message).toContain("Direct link: https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123456789");
    expect(e!.message).not.toContain("then retry");     // the link stops before Google's sentence continues
    expect(calls).toBe(1);
  });

  it("recognises it from the newer details block alone, and makes no link up", async () => {
    const { e } = await refuse(403, GOOGLE.apiOffNewStyleOnly);
    expect(e!.message).toContain("switched off in your Google Cloud project");
    expect(e!.message).not.toContain("Direct link");
  });

  it("a missing Drive permission says to reconnect and keep it ticked", async () => {
    const { e } = await refuse(403, GOOGLE.scope);
    expect(e!.message).toContain("did not give the portal the Drive permission");
    expect(e!.message).toContain("disconnect Google Drive, connect it again");
  });

  it("a full Drive says so", async () => {
    const { e } = await refuse(403, GOOGLE.full);
    expect(e!.message).toContain("no Drive storage left");
  });

  it("a withdrawn connection (401) says to reconnect", async () => {
    const { e } = await refuse(401, GOOGLE.badToken);
    expect(e!.message).toMatch(/^Drive permission denied \(401\): Google no longer accepts the saved connection/);
  });

  it("an unknown reason passes Google's own words through, shortened", async () => {
    const { e } = await refuse(403, GOOGLE.other);
    expect(e!.message).toBe('Drive permission denied (403): Google said "The caller does not have permission" [Google: forbidden]');
    const long = await refuse(403, { error: { message: "x".repeat(1000) } });
    expect(long.e!.message.length).toBeLessThan(330);
  });

  it("an empty or non-JSON answer still gives the plain message", async () => {
    expect((await refuse(403, "")).e!.message).toBe("Drive permission denied (403).");
    expect((await refuse(403, "<html>Forbidden</html>")).e!.message).toBe("Drive permission denied (403).");
    expect((await refuse(403, "null")).e!.message).toBe("Drive permission denied (403).");
    expect((await refuse(403, { error: "just a string" })).e!.message).toBe("Drive permission denied (403).");
  });

  it("Google's rate limit, which it sends as 403, is waited out and retried, not reported as a permission problem", async () => {
    const { api, provider } = setup();
    api.queueFailure(403, 2, GOOGLE.slow);
    const folder = await provider.createRootFolder("Evidence Portal");
    expect(folder.id).toBeTruthy();
    expect(api.calls).toHaveLength(3);
  });

  it("...and when it never lets up, that is reported as the retryable unavailable error", async () => {
    const { api, provider } = setup();
    api.queueFailure(403, 10, GOOGLE.slow);
    await expect(provider.createRootFolder("x")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(api.calls).toHaveLength(4);
  });

  it("all three of Google's rate-limit reasons are waited out", async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded"]) {
      const { api, provider } = setup();
      api.queueFailure(403, 1, { error: { errors: [{ reason }] } });
      expect((await provider.createRootFolder("x")).id, reason).toBeTruthy();
      expect(api.calls, reason).toHaveLength(2);
    }
  });

  it("a link at the end of Google's sentence loses the full stop, and a repeated reason is shown once", () => {
    const m = explainDriveRefusal(403, JSON.stringify({ error: { message: "Not enabled. Visit https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=7.", errors: [{ reason: "accessNotConfigured" }, { reason: "accessNotConfigured" }] } })).message;
    expect(m).toContain("Direct link: https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=7 [Google: accessNotConfigured]");
  });

  it("explainDriveRefusal never throws, whatever it is given", () => {
    for (const body of ["", "{", "[]", "123", '{"error":null}', '{"error":{"errors":"x","details":5}}', '{"error":{"errors":[null,1,"a"],"details":[{"reason":7}]}}']) {
      expect(explainDriveRefusal(403, body).message).toMatch(/^Drive permission denied \(403\)/);
    }
  });
});
