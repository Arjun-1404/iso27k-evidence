import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.ts";
import { attachmentHeader } from "../src/http/contentDisposition.ts";

const SAVED = { ...process.env };
const MANAGED = ["DATABASE_URL", "JWT_SECRET", "LOCAL_STORAGE_DIR", "STORAGE_ALLOW_PRIVATE_ADDRESSES"];
function env(vars: Record<string, string> = {}) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, { DATABASE_URL: "postgres://x@localhost/x", JWT_SECRET: "j" }, vars);
}
afterEach(() => { for (const k of MANAGED) delete process.env[k]; Object.assign(process.env, SAVED); });

describe("config: LOCAL_STORAGE_DIR", () => {
  it("is off by default, and the empty value docker compose passes means off too", () => {
    env(); expect(loadConfig().localStorageDir).toBeUndefined();
    env({ LOCAL_STORAGE_DIR: "" }); expect(loadConfig().localStorageDir).toBeUndefined();
  });

  it("accepts a full path, in Linux or Windows spelling", () => {
    for (const ok of ["/srv/evidence", "/var/lib/evidence-portal/files", "D:/EvidenceFiles", "C:\\evidence-data", "\\\\fileserver\\share\\evidence"]) {
      env({ LOCAL_STORAGE_DIR: ok }); expect(loadConfig().localStorageDir, ok).toBe(ok);
    }
  });

  it("refuses a relative path, the top of a drive, and anything containing '..' — with a message that says what to write", () => {
    for (const bad of ["evidence", "./evidence", "../evidence", "~/evidence", "/", "C:\\", "D:/", "/srv/../etc", "C:\\data\\..\\Windows"]) {
      env({ LOCAL_STORAGE_DIR: bad });
      expect(() => loadConfig(), bad).toThrow(/LOCAL_STORAGE_DIR/);
    }
    env({ LOCAL_STORAGE_DIR: "evidence" });
    expect(() => loadConfig()).toThrow(/full path/);
  });
});

describe("config: STORAGE_ALLOW_PRIVATE_ADDRESSES", () => {
  it("is off unless switched on", () => {
    env(); expect(loadConfig().allowPrivateStorageAddresses).toBe(false);
    env({ STORAGE_ALLOW_PRIVATE_ADDRESSES: "" }); expect(loadConfig().allowPrivateStorageAddresses).toBe(false);
    env({ STORAGE_ALLOW_PRIVATE_ADDRESSES: "false" }); expect(loadConfig().allowPrivateStorageAddresses).toBe(false);
  });

  it("reads yes/no spellings, and refuses anything unclear rather than guessing", () => {
    for (const on of ["true", "TRUE", "yes", "1", "on"]) { env({ STORAGE_ALLOW_PRIVATE_ADDRESSES: on }); expect(loadConfig().allowPrivateStorageAddresses, on).toBe(true); }
    for (const off of ["false", "no", "0", "off"]) { env({ STORAGE_ALLOW_PRIVATE_ADDRESSES: off }); expect(loadConfig().allowPrivateStorageAddresses, off).toBe(false); }
    for (const bad of ["maybe", "2", "enabled", "y"]) {
      env({ STORAGE_ALLOW_PRIVATE_ADDRESSES: bad });
      expect(() => loadConfig(), bad).toThrow(/STORAGE_ALLOW_PRIVATE_ADDRESSES must be true or false/);
    }
  });
});

describe("download header", () => {
  it("a plain name is carried as it is", () => {
    expect(attachmentHeader("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it("quotes, semicolons, slashes, line breaks and non-ASCII letters can't break out of the header or the name", () => {
    const nasty = ['a"b.pdf', "a;b.pdf", "../../etc/passwd", "a\r\nSet-Cookie: x=1", "Zoë – naïve ☃.pdf", "'quoted'(x)*.pdf", "%0d%0a.pdf", ".hidden", "x".repeat(400) + ".pdf"];
    for (const name of nasty) {
      const h = attachmentHeader(name);
      expect(h, name).not.toMatch(/[\r\n]/);
      expect(h, name).toMatch(/^attachment; filename="[A-Za-z0-9._ -]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]*$/);
      const ascii = h.match(/filename="([^"]*)"/)![1];
      expect(ascii.startsWith("."), name).toBe(false);
      expect(ascii.length, name).toBeLessThanOrEqual(150);
      const encoded = h.match(/filename\*=UTF-8''(.*)$/)![1];
      expect(decodeURIComponent(encoded), name).toBe(name);   // the real name survives for browsers that read it
    }
  });

  it("an empty name still gets a usable one", () => {
    expect(attachmentHeader("")).toMatch(/filename="download"/);
    expect(attachmentHeader("***")).toMatch(/filename="___"/);
  });
});
