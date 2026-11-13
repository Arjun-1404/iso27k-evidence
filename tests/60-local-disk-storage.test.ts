import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { LocalDiskProvider } from "../src/storage/localDisk.ts";
import { isSafeSegment, safeFileName, safeSegment, splitStoredPath } from "../src/storage/safeNames.ts";
import { StorageError, type UploadTarget } from "../src/storage/types.ts";
import { auditFolderName } from "../src/services/folderNames.ts";

let tmp: string; let base: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-disk-")); base = path.join(tmp, "org one"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const urls: UploadTarget[] = [];
const make = (opts: { now?: () => number; dir?: string; reservations?: Map<string, number> } = {}) =>
  new LocalDiskProvider({ baseDir: opts.dir ?? base, now: opts.now, reservations: opts.reservations, makeUploadUrl: (t) => { urls.push(t); return `/uploads/${t.providerFileId}`; } });
const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const rejects = (p: Promise<unknown>) => p.then(() => null, (e) => e as StorageError);

/** Announces and delivers one file; returns its id. */
async function store(p: LocalDiskProvider, folder: string, name: string, content: string) {
  const s = await p.createUploadSession(folder, name, "application/pdf", Buffer.byteLength(content));
  await p.receiveUpload(urls[urls.length - 1], body(content));
  return s.providerFileId;
}

describe("names that are safe on a real disk, including Windows", () => {
  it("safeSegment turns anything into an acceptable name", () => {
    const nasty = ["../../etc/passwd", "..", ".", "...", "a/b\\c", "CON", "nul.txt", "com1", "LPT9.pdf", "name.", "name ", "  spaced   out  ", "a:b*c?d\"e<f>g|h", ".hidden", "\u0000\u001f", "", "   ", "é".repeat(500), "x".repeat(500)];
    for (const raw of nasty) {
      const s = safeSegment(raw);
      expect(isSafeSegment(s), `${JSON.stringify(raw)} -> ${JSON.stringify(s)}`).toBe(true);
      expect(Array.from(s).length).toBeLessThanOrEqual(80);
    }
    expect(safeSegment("Evidence Portal – Acme Ltd")).toBe("Evidence Portal – Acme Ltd");
    expect(safeSegment("A.8.5")).toBe("A.8.5");
    expect(safeSegment("../../etc")).toBe("__-..-etc");
  });

  it("the exact outcomes people will see", () => {
    expect(safeSegment("CON")).toBe("_CON");
    expect(safeSegment("name. ")).toBe("name");
    expect(safeSegment(".hidden")).toBe("_hidden");
    expect(safeSegment("a/b")).toBe("a-b");
    expect(safeSegment("Q1: plan?")).toBe("Q1- plan-");
    expect(safeSegment("")).toBe("Untitled");
    expect(safeSegment("é".normalize("NFD"))).toBe("é".normalize("NFC"));
  });

  it("a long audit name is shortened without losing the code that tells two cycles apart", () => {
    const name = auditFolderName("Surveillance audit ".repeat(20), "1a2b3c4d-0000-0000-0000-000000000000");
    const s = safeSegment(name);
    expect(s.endsWith("[1a2b3c4d]")).toBe(true);
    expect(Array.from(s).length).toBeLessThanOrEqual(80);
    expect(isSafeSegment(s)).toBe(true);
    expect(safeSegment(auditFolderName("Surveillance audit", "1a2b3c4d-x"))).toBe("Surveillance audit [1a2b3c4d]");
  });

  it("safeFileName keeps the ending when it has to shorten", () => {
    const s = safeFileName(`${"report ".repeat(40)}.pdf`);
    expect(s.endsWith(".pdf")).toBe(true);
    expect(Array.from(s).length).toBeLessThanOrEqual(100);
    expect(safeFileName("mfa-settings.pdf")).toBe("mfa-settings.pdf");
    expect(safeFileName("CON.pdf")).toBe("_CON.pdf");
    expect(safeFileName("..pdf")).toMatch(/pdf$/);
    expect(isSafeSegment(safeFileName("../../x.pdf"))).toBe(true);
    expect(safeFileName("a:b.pdf")).toBe("a-b.pdf");
    expect(safeFileName("noextension")).toBe("noextension");
  });

  it("isSafeSegment / splitStoredPath refuse everything that could escape or be refused", () => {
    for (const bad of ["", ".", "..", ".hidden", "a/b", "a\\b", "c:", "x:y", "nul", "COM3", "lpt1.txt", "a.", "a ", "a\u0000b", "a\nb", "e\u0301", 5, null, undefined]) {
      expect(isSafeSegment(bad), String(bad)).toBe(false);
    }
    for (const bad of ["../x", "a/../b", "/abs", "a//b", "a/./b", "a\\b", "C:/x", "a/b/", "", "x".repeat(2000)]) {
      expect(splitStoredPath(bad), bad).toBeNull();
    }
    expect(splitStoredPath("Client/Audit [1a2b3c4d]/A.8.5/report.pdf")).toEqual(["Client", "Audit [1a2b3c4d]", "A.8.5", "report.pdf"]);
  });
});

describe("folders", () => {
  it("makes a client's root folder, then audit and control folders under it; asking again finds the same ones", async () => {
    const p = make();
    const root = await p.createRootFolder("Evidence Portal – Acme");
    const a = await p.findOrCreateFolder(root.id, "Audit [1a2b3c4d]");
    const c = await p.findOrCreateFolder(a.id, "A.8.5");
    expect(c.id).toBe("Evidence Portal – Acme/Audit [1a2b3c4d]/A.8.5");
    expect((await p.findOrCreateFolder(a.id, "A.8.5")).id).toBe(c.id);
    expect(fs.statSync(path.join(base, "Evidence Portal – Acme", "Audit [1a2b3c4d]", "A.8.5")).isDirectory()).toBe(true);
  });

  it("the base folder is created if it isn't there yet (even several levels down)", async () => {
    const p = make({ dir: path.join(tmp, "a", "b", "c") });
    await p.createRootFolder("X");
    expect(fs.existsSync(path.join(tmp, "a", "b", "c", "X"))).toBe(true);
  });

  it("two clients with the same name get two different folders", async () => {
    const p = make();
    const a = await p.createRootFolder("Evidence Portal – Acme"); const b = await p.createRootFolder("Evidence Portal – Acme");
    expect(a.id).not.toBe(b.id);
    expect(b.id).toBe("Evidence Portal – Acme (2)");
  });

  it("hostile folder names stay inside", async () => {
    const p = make();
    const root = await p.createRootFolder("../../outside");
    const sub = await p.findOrCreateFolder(root.id, "../../../escape");
    expect(fs.realpathSync(path.join(base, ...sub.id.split("/"))).startsWith(fs.realpathSync(base))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "outside"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "escape"))).toBe(false);
  });

  it("asking under a folder that doesn't exist is 'not found', not a surprise folder", async () => {
    const p = make();
    expect(await rejects(p.findOrCreateFolder("Nope", "x"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await rejects(p.createUploadSession("Nope", "x.pdf", "application/pdf", 1))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("uploads through the portal", () => {
  it("announces an upload, receives the bytes, and the file is on the disk under its own name", async () => {
    const p = make();
    const root = await p.createRootFolder("Acme"); const folder = await p.findOrCreateFolder(root.id, "A.8.5");
    const s = await p.createUploadSession(folder.id, "mfa-settings.pdf", "application/pdf", 5);
    expect(s).toMatchObject({ method: "PUT", providerFileId: "Acme/A.8.5/mfa-settings.pdf" });
    expect(s.uploadUrl).toBe("/uploads/Acme/A.8.5/mfa-settings.pdf");
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fs.existsSync(path.join(base, "Acme", "A.8.5", "mfa-settings.pdf"))).toBe(false);    // not yet: nothing has arrived

    await p.receiveUpload(urls[urls.length - 1], body("hello"));
    expect(fs.readFileSync(path.join(base, "Acme", "A.8.5", "mfa-settings.pdf"), "utf8")).toBe("hello");
  });

  it("the same file name twice gives two files, never an overwrite — even when both are announced before either arrives", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const s1 = await p.createUploadSession(folder.id, "report.pdf", "application/pdf", 3);
    const t1 = urls[urls.length - 1];
    const s2 = await p.createUploadSession(folder.id, "report.pdf", "application/pdf", 3);
    const t2 = urls[urls.length - 1];
    expect(s1.providerFileId).toBe("Acme/A.8.5/report.pdf");
    expect(s2.providerFileId).toBe("Acme/A.8.5/report (2).pdf");
    await p.receiveUpload(t2, body("two")); await p.receiveUpload(t1, body("one"));
    expect(fs.readFileSync(path.join(base, "Acme", "A.8.5", "report.pdf"), "utf8")).toBe("one");
    expect(fs.readFileSync(path.join(base, "Acme", "A.8.5", "report (2).pdf"), "utf8")).toBe("two");
    const s3 = await p.createUploadSession(folder.id, "report.pdf", "application/pdf", 3);
    expect(s3.providerFileId).toBe("Acme/A.8.5/report (3).pdf");
  });

  it("a reserved name is handed out again once its time is up", async () => {
    let t = 1_000_000;
    const p = make({ now: () => t });
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    expect((await p.createUploadSession(folder.id, "r.pdf", "application/pdf", 1)).providerFileId).toBe("Acme/A.8.5/r.pdf");
    expect((await p.createUploadSession(folder.id, "r.pdf", "application/pdf", 1)).providerFileId).toBe("Acme/A.8.5/r (2).pdf");
    t += 61 * 60 * 1000;
    expect((await p.createUploadSession(folder.id, "r.pdf", "application/pdf", 1)).providerFileId).toBe("Acme/A.8.5/r.pdf");
  });

  it("delivering the same announcement twice does not overwrite the first", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    await p.createUploadSession(folder.id, "r.pdf", "application/pdf", 3);
    const target = urls[urls.length - 1];
    await p.receiveUpload(target, body("one"));
    const err = await rejects(p.receiveUpload(target, body("two")));
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ code: "ALREADY_EXISTS" });
    expect(fs.readFileSync(path.join(base, "Acme", "A.8.5", "r.pdf"), "utf8")).toBe("one");
  });

  it("names promised in one request are still taken in the next, when the providers share their reservations", async () => {
    const shared = new Map<string, number>();
    const p1 = make({ reservations: shared });
    const folder = await p1.findOrCreateFolder((await p1.createRootFolder("Acme")).id, "A.8.5");
    const p2 = make({ reservations: shared });                       // a later request builds its own provider
    const s1 = await p1.createUploadSession(folder.id, "r.pdf", "application/pdf", 3);
    const s2 = await p2.createUploadSession(folder.id, "r.pdf", "application/pdf", 3);
    expect([s1.providerFileId, s2.providerFileId]).toEqual(["Acme/A.8.5/r.pdf", "Acme/A.8.5/r (2).pdf"]);
    const unshared = await make().createUploadSession(folder.id, "r.pdf", "application/pdf", 3);
    expect(unshared.providerFileId).toBe("Acme/A.8.5/r.pdf");        // (without sharing, the second announcement would get the same name)
  });

  it("a file shorter or longer than announced is refused and leaves nothing behind", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    for (const [content, why] of [["12", "shorter"], ["12345678", "longer"]] as const) {
      await p.createUploadSession(folder.id, `${why}.pdf`, "application/pdf", 5);
      const err = await rejects(p.receiveUpload(urls[urls.length - 1], body(content)));
      expect(err, why).toMatchObject({ code: "INVALID_REQUEST" });
      expect(fs.existsSync(path.join(base, "Acme", "A.8.5", `${why}.pdf`)), why).toBe(false);
    }
  });

  it("a connection that breaks in the middle leaves nothing behind", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    await p.createUploadSession(folder.id, "cut.pdf", "application/pdf", 10);
    const broken = new Readable({ read() { this.push(Buffer.from("abc")); setImmediate(() => this.destroy(new Error("connection reset"))); } });
    expect(await rejects(p.receiveUpload(urls[urls.length - 1], broken))).toBeTruthy();
    expect(fs.readdirSync(path.join(base, "Acme", "A.8.5"))).toEqual([]);
  });

  it("an announcement for a path that doesn't match its folder is refused", async () => {
    const p = make();
    await p.createRootFolder("Acme");
    const bad: UploadTarget = { providerFileId: "Acme/other/x.pdf", folderId: "Acme", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    expect(await rejects(p.receiveUpload(bad, body("x")))).toMatchObject({ code: "INVALID_REQUEST" });
    const escape: UploadTarget = { providerFileId: "Acme/../../x.pdf", folderId: "Acme/..", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    expect(await rejects(p.receiveUpload(escape, body("x")))).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fs.existsSync(path.join(tmp, "x.pdf"))).toBe(false);
  });

  it("an uploaded file's name can't hurt: separators, device names and dots are made harmless", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    for (const name of ["../../evil.pdf", "CON.pdf", "a:b.pdf", ".htaccess.pdf", "x".repeat(300) + ".pdf"]) {
      const id = await store(p, folder.id, name, "data");
      const real = fs.realpathSync(path.join(base, ...id.split("/")));
      expect(real.startsWith(fs.realpathSync(path.join(base, "Acme", "A.8.5")) + path.sep), name).toBe(true);
    }
    expect(fs.readdirSync(tmp).sort()).toEqual(["org one"]);
  });
});

describe("reading back", () => {
  it("metadata carries a SHA-256 of the content, the size, the folder and a type from the name", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, folder.id, "policy.pdf", "the content");
    const m = await p.getFileMetadata(id);
    expect(m).toMatchObject({ providerFileId: id, name: "policy.pdf", sizeBytes: 11, mimeType: "application/pdf", hashAlgo: "sha256", hash: sha("the content"), version: sha("the content"), folderId: "Acme/A.8.5" });
    expect(m.modifiedAt).toBeInstanceOf(Date);
  });

  it("changing the content changes the fingerprint; touching or rewriting the same content does not", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, folder.id, "policy.pdf", "original");
    const before = await p.getFileMetadata(id);
    const abs = path.join(base, ...id.split("/"));
    fs.utimesSync(abs, new Date(0), new Date(0));
    fs.writeFileSync(abs, "original");
    const same = await p.getFileMetadata(id);
    expect([same.hash, same.version]).toEqual([before.hash, before.version]);
    fs.writeFileSync(abs, "tampered");
    const changed = await p.getFileMetadata(id);
    expect(changed.hash).not.toBe(before.hash); expect(changed.version).not.toBe(before.version);
  });

  it("a deleted file is 'not found' (which is how the integrity check learns it is missing)", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, folder.id, "gone.pdf", "x");
    fs.unlinkSync(path.join(base, ...id.split("/")));
    expect(await rejects(p.getFileMetadata(id))).toMatchObject({ code: "NOT_FOUND" });
    expect(await rejects(p.downloadFile(id))).toMatchObject({ code: "NOT_FOUND" });
    expect(await rejects(p.openFile(id))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a folder is not a file", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    expect(await rejects(p.getFileMetadata(folder.id))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("downloadFile returns the bytes; openFile streams them with the name, size and type", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, folder.id, "sheet.xlsx", "spreadsheet bytes");
    const d = await p.downloadFile(id);
    expect(Buffer.from(d.bytes).toString()).toBe("spreadsheet bytes");
    expect(d.mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const o = await p.openFile(id);
    expect(o).toMatchObject({ sizeBytes: 17, fileName: "sheet.xlsx", mimeType: d.mimeType });
    const chunks: Buffer[] = []; for await (const c of o.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("spreadsheet bytes");
  });

  it("lists the files in a folder, sorted, without hidden files or sub-folders", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    await store(p, folder.id, "b.pdf", "b"); await store(p, folder.id, "a.pdf", "aa");
    fs.writeFileSync(path.join(base, "Acme", "A.8.5", ".DS_Store"), "x");
    fs.mkdirSync(path.join(base, "Acme", "A.8.5", "sub"));
    const list = await p.listFiles(folder.id);
    expect(list.map((f) => [f.name, f.sizeBytes])).toEqual([["a.pdf", 2], ["b.pdf", 1]]);
  });

  it("an unknown file type is a plain download", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    fs.writeFileSync(path.join(base, "Acme", "A.8.5", "odd.bin"), "x");
    expect((await p.getFileMetadata("Acme/A.8.5/odd.bin")).mimeType).toBe("application/octet-stream");
    void folder;
  });
});

describe("nothing outside the evidence folder can be reached", () => {
  it("every way of naming a path outside is refused before the disk is touched", async () => {
    const p = make();
    await p.createRootFolder("Acme");
    fs.writeFileSync(path.join(tmp, "secret.txt"), "top secret");
    for (const id of ["../secret.txt", "Acme/../../secret.txt", "/etc/passwd", "..\\secret.txt", "C:/Windows/win.ini", "Acme//x", "", "Acme/./x"]) {
      for (const call of [() => p.getFileMetadata(id), () => p.downloadFile(id), () => p.openFile(id), () => p.quarantineFile(id), () => p.listFiles(id), () => p.createUploadSession(id, "x.pdf", "application/pdf", 1), () => p.findOrCreateFolder(id, "x")]) {
        expect(await rejects(call()), `${id}`).toMatchObject({ name: "StorageError", code: "INVALID_REQUEST" });
      }
    }
    expect(fs.readFileSync(path.join(tmp, "secret.txt"), "utf8")).toBe("top secret");
  });

  it.skipIf(process.platform === "win32")("a link inside the evidence folder that leads out is not followed — for reading, listing or writing", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const outside = path.join(tmp, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.pdf"), "top secret");
    fs.symlinkSync(outside, path.join(base, "Acme", "A.8.5", "link"));                        // a folder link
    fs.symlinkSync(path.join(outside, "secret.pdf"), path.join(base, "Acme", "A.8.5", "file.pdf"));   // a file link
    for (const call of [
      () => p.getFileMetadata("Acme/A.8.5/file.pdf"), () => p.downloadFile("Acme/A.8.5/file.pdf"), () => p.openFile("Acme/A.8.5/file.pdf"),
      () => p.getFileMetadata("Acme/A.8.5/link/secret.pdf"), () => p.listFiles("Acme/A.8.5/link"),
      () => p.findOrCreateFolder("Acme/A.8.5/link", "new"), () => p.createUploadSession("Acme/A.8.5/link", "x.pdf", "application/pdf", 1),
      () => p.quarantineFile("Acme/A.8.5/file.pdf"),
    ]) {
      expect(await rejects(call())).toMatchObject({ code: "PERMISSION_DENIED" });
    }
    const target: UploadTarget = { providerFileId: "Acme/A.8.5/link/new.pdf", folderId: "Acme/A.8.5/link", fileName: "new.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    expect(await rejects(p.receiveUpload(target, body("x")))).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fs.readdirSync(outside)).toEqual(["secret.pdf"]);
    expect(fs.readFileSync(path.join(outside, "secret.pdf"), "utf8")).toBe("top secret");
    void folder;
  });

  it.skipIf(process.platform === "win32")("uploading onto a file name that is a link to somewhere else never writes through it", async () => {
    const p = make();
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const outside = path.join(tmp, "victim.txt"); fs.writeFileSync(outside, "keep me");
    await p.createUploadSession(folder.id, "trap.pdf", "application/pdf", 3);
    const target = urls[urls.length - 1];
    fs.symlinkSync(outside, path.join(base, "Acme", "A.8.5", "trap.pdf"));                   // planted between announcing and arriving
    expect(await rejects(p.receiveUpload(target, body("bad")))).toBeTruthy();
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
  });
});

describe("quarantine", () => {
  it("moves a flagged file out of the evidence folders into a quarantine folder on the same disk", async () => {
    const p = make({ now: () => Date.UTC(2026, 10, 8, 12, 0, 0) });
    const folder = await p.findOrCreateFolder((await p.createRootFolder("Acme")).id, "A.8.5");
    const id = await store(p, folder.id, "bad.pdf", "malware-ish");
    await p.quarantineFile(id);
    expect(fs.existsSync(path.join(base, "Acme", "A.8.5", "bad.pdf"))).toBe(false);
    const q = fs.readdirSync(path.join(base, "_quarantine"));
    expect(q).toEqual(["2026-11-08T12-00-00-000Z-bad.pdf"]);
    expect(fs.readFileSync(path.join(base, "_quarantine", q[0]), "utf8")).toBe("malware-ish");
    expect(await rejects(p.getFileMetadata(id))).toMatchObject({ code: "NOT_FOUND" });
    expect((await p.listFiles(folder.id))).toEqual([]);
  });

  it("quarantining something that isn't there says so", async () => {
    const p = make();
    await p.createRootFolder("Acme");
    expect(await rejects(p.quarantineFile("Acme/missing.pdf"))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a folder the portal can't use says what is wrong in plain words", () => {
  it.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))("a read-only evidence folder", async () => {
    const p = make();
    const root = await p.createRootFolder("Acme");
    fs.chmodSync(path.join(base, "Acme"), 0o500);
    try {
      const err = await rejects(p.findOrCreateFolder(root.id, "A.8.5"));
      expect(err).toMatchObject({ code: "PERMISSION_DENIED" });
      expect(err!.message).toContain("LOCAL_STORAGE_DIR");
    } finally { fs.chmodSync(path.join(base, "Acme"), 0o700); }
  });

  it("the base folder being a file is reported, not a crash", async () => {
    fs.writeFileSync(path.join(tmp, "iamafile"), "x");
    const p = make({ dir: path.join(tmp, "iamafile", "sub") });
    const err = await rejects(p.createRootFolder("X"));
    expect(err).toBeInstanceOf(StorageError);
  });
});
