import type { Fetcher } from "./googleDrive.ts";

interface FakeFile {
  id: string; name: string; parentId: string; mimeType: string;
  size: number; md5Checksum: string; headRevisionId: string; webViewLink: string; modifiedTime: string;
  isFolder: boolean;
  trashed?: boolean;
}

/**
 * A fetch-compatible in-memory stand-in for the Google Drive v3 REST API. It understands exactly the
 * requests GoogleDriveProvider makes, so tests exercise the real request/response shapes and our
 * retry/pagination/error-mapping logic, without any network access.
 */
export class FakeDriveApi {
  private files = new Map<string, FakeFile>();
  private content = new Map<string, Uint8Array>();
  private nextId = 1;
  private queuedStatuses: { status: number; body: unknown }[] = [];
  /** Every request seen, including the Authorization header it carried (so tests can prove WHICH
   *  organisation's credential was used for a call). */
  calls: { method: string; url: string; auth: string; origin?: string }[] = [];

  /** Makes the next N requests fail with the given HTTP status before succeeding. `body` is what Google would put in its
   *  answer (default: a bare "simulated failure"); pass a real-looking error to test how it is explained. */
  queueFailure(status: number, times = 1, body: unknown = { error: { message: "simulated failure" } }): void {
    for (let i = 0; i < times; i++) this.queuedStatuses.push({ status, body });
  }

  /** Directly seeds a folder, e.g. to represent the tenant's pre-existing root folder. */
  seedFolder(id: string, name: string, parentId = ""): void {
    this.files.set(id, { id, name, parentId, mimeType: "application/vnd.google-apps.folder", size: 0, md5Checksum: "", headRevisionId: "", webViewLink: "", modifiedTime: new Date().toISOString(), isFolder: true });
  }

  fetcher: Fetcher = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    this.calls.push({ method, url: url.pathname + url.search, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""), origin: (init?.headers as Record<string, string> | undefined)?.Origin });

    if (this.queuedStatuses.length > 0) {
      const { status, body } = this.queuedStatuses.shift()!;
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "retry-after": "0" } });
    }

    if (url.pathname === "/drive/v3/files" && method === "GET") return this.handleList(url);
    if (url.pathname === "/drive/v3/files" && method === "POST") return this.handleCreateFolder(init);
    if (url.pathname === "/drive/v3/files/generateIds") return this.handleGenerateIds(url);
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") return this.handleUploadInit(init);
    const metaMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (metaMatch && method === "GET" && url.searchParams.get("alt") === "media") return this.handleDownload(metaMatch[1]);
    if (metaMatch && method === "GET") return this.handleGetMetadata(metaMatch[1]);
    if (metaMatch && method === "PATCH") return this.handlePatch(metaMatch[1], init);

    return new Response(JSON.stringify({ error: { message: `unhandled fake Drive route: ${method} ${url.pathname}` } }), { status: 500 });
  };

  private handleList(url: URL): Response {
    const q = url.searchParams.get("q") ?? "";
    // Drive query values escape ' and \ with a backslash; match up to the first UNescaped quote, then undo it.
    const unescape = (v: string) => v.replace(/\\(.)/g, "$1");
    const parentMatch = q.match(/'((?:\\.|[^'\\])*)' in parents/);
    const nameMatch = q.match(/name = '((?:\\.|[^'\\])*)'/);
    if (parentMatch) parentMatch[1] = unescape(parentMatch[1]);
    if (nameMatch) nameMatch[1] = unescape(nameMatch[1]);
    const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'");
    const excludeTrashed = q.includes("trashed = false");
    let results = [...this.files.values()].filter((f) => (!parentMatch || f.parentId === parentMatch[1]) && (!folderOnly || f.isFolder) && !(excludeTrashed && f.trashed));
    if (nameMatch) results = results.filter((f) => f.name === nameMatch[1]);
    const pageSize = Number(url.searchParams.get("pageSize") ?? "100");
    const pageToken = url.searchParams.get("pageToken");
    const start = pageToken ? Number(pageToken) : 0;
    const page = results.slice(start, start + pageSize);
    const nextPageToken = start + pageSize < results.length ? String(start + pageSize) : undefined;
    const shape = (f: FakeFile) => (folderOnly ? { id: f.id, name: f.name } : toApiShape(f));
    return json({ files: page.map(shape), ...(nextPageToken ? { nextPageToken } : {}) });
  }

  private async handleCreateFolder(init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body ?? "{}")) as { name: string; parents?: string[] };
    const id = `folder-${this.nextId++}`;
    this.files.set(id, { id, name: body.name, parentId: body.parents?.[0] ?? "", mimeType: "application/vnd.google-apps.folder", size: 0, md5Checksum: "", headRevisionId: "", webViewLink: "", modifiedTime: new Date().toISOString(), isFolder: true });
    return json({ id });
  }

  private handleGenerateIds(url: URL): Response {
    const count = Number(url.searchParams.get("count") ?? "1");
    return json({ ids: Array.from({ length: count }, () => `file-${this.nextId++}`) });
  }

  private async handleUploadInit(init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: string; name: string; parents: string[] };
    this.files.set(body.id, {
      id: body.id, name: body.name, parentId: body.parents[0],
      mimeType: (init?.headers as Record<string, string>)?.["X-Upload-Content-Type"] ?? "application/octet-stream",
      size: Number((init?.headers as Record<string, string>)?.["X-Upload-Content-Length"] ?? "0"),
      md5Checksum: `md5-of-${body.id}`, headRevisionId: "1", webViewLink: `https://drive.example/${body.id}`, modifiedTime: new Date().toISOString(), isFolder: false,
    });
    return new Response(null, { status: 200, headers: { location: `https://upload.googleapis.example/session/${body.id}` } });
  }

  private handleGetMetadata(id: string): Response {
    const f = this.files.get(id);
    if (!f) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    return json(toApiShape(f));
  }

  private async handlePatch(id: string, init?: RequestInit): Promise<Response> {
    const f = this.files.get(id);
    if (!f) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { trashed?: boolean };
    if (typeof body.trashed === "boolean") f.trashed = body.trashed;
    return json({ id });
  }

  /** Test-only: whether a file is in the trash. */
  isTrashed(id: string): boolean {
    return this.files.get(id)?.trashed === true;
  }

  private handleDownload(id: string): Response {
    const f = this.files.get(id);
    if (!f) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    const bytes = this.content.get(id) ?? new TextEncoder().encode(`fake content for ${f.name}`);
    return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": f.mimeType } });
  }

  /** Test-only: sets what downloadFile() returns for a given file id. */
  seedFileContent(id: string, bytes: Uint8Array): void {
    this.content.set(id, bytes);
    const f = this.files.get(id);
    if (f) f.size = bytes.length;     // like the real thing, the size Drive reports is the size of what it holds
  }

  /** Test-only: simulates the file's content changing after upload (a new revision, new checksum). */
  mutateFile(id: string, patch: Partial<Pick<FakeFile, "md5Checksum" | "headRevisionId" | "size">>): void {
    const f = this.files.get(id);
    if (f) Object.assign(f, patch);
  }
}

function toApiShape(f: FakeFile) {
  return { id: f.id, name: f.name, size: String(f.size), mimeType: f.mimeType, md5Checksum: f.md5Checksum, headRevisionId: f.headRevisionId, webViewLink: f.webViewLink, modifiedTime: f.modifiedTime, parents: f.parentId ? [f.parentId] : [] };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
