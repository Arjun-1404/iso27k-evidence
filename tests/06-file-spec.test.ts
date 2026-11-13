import { describe, it, expect } from "vitest";
import { validateFile, MAX_UPLOAD_BYTES, DEFAULT_MAX_FILES_PER_CONTROL } from "../src/services/fileSpec.ts";

const pdf = { fileName: "evidence.pdf", mimeType: "application/pdf", sizeBytes: 1000 };

describe("validateFile", () => {
  it("accepts an allowed type within the size limit", () => {
    expect(validateFile(pdf, undefined, 0)).toEqual({ ok: true });
  });

  it("rejects an executable regardless of any auditor-configured spec (the allowlist cannot be widened)", () => {
    const exe = { fileName: "run.exe", mimeType: "application/x-msdownload", sizeBytes: 1000 };
    expect(validateFile(exe, { types: ["any"] }, 0).ok).toBe(false);
  });

  it("rejects HTML and SVG (stored-XSS risk) even though nothing in the platform allowlist names them", () => {
    const html = { fileName: "page.html", mimeType: "text/html", sizeBytes: 100 };
    const svg = { fileName: "pic.svg", mimeType: "image/svg+xml", sizeBytes: 100 };
    expect(validateFile(html, undefined, 0).ok).toBe(false);
    expect(validateFile(svg, undefined, 0).ok).toBe(false);
  });

  it("rejects a mismatched extension and mime type (renamed file attack)", () => {
    const spoofed = { fileName: "evidence.pdf", mimeType: "application/x-msdownload", sizeBytes: 100 };
    expect(validateFile(spoofed, undefined, 0).ok).toBe(false);
    const spoofed2 = { fileName: "evidence.exe", mimeType: "application/pdf", sizeBytes: 100 };
    expect(validateFile(spoofed2, undefined, 0).ok).toBe(false);
  });

  it("rejects path separators, control characters, empty or overlong names", () => {
    for (const name of ["../evidence.pdf", "a/b.pdf", "a\\b.pdf", "bad\x00name.pdf", "   .pdf", "x".repeat(300) + ".pdf"]) {
      expect(validateFile({ fileName: name, mimeType: "application/pdf", sizeBytes: 10 }, undefined, 0).ok, name).toBe(false);
    }
  });

  it("rejects zero-byte and oversized files", () => {
    expect(validateFile({ ...pdf, sizeBytes: 0 }, undefined, 0).ok).toBe(false);
    expect(validateFile({ ...pdf, sizeBytes: MAX_UPLOAD_BYTES + 1 }, undefined, 0).ok).toBe(false);
    expect(validateFile({ ...pdf, sizeBytes: MAX_UPLOAD_BYTES }, undefined, 0).ok).toBe(true);
  });

  it("an auditor's file-type category narrows what's accepted, both ways", () => {
    const png = { fileName: "screenshot.png", mimeType: "image/png", sizeBytes: 100 };
    expect(validateFile(png, { types: ["image"] }, 0).ok).toBe(true);
    expect(validateFile(pdf, { types: ["image"] }, 0).ok).toBe(false);
    expect(validateFile(pdf, { types: ["document"] }, 0).ok).toBe(true);
  });

  it("'any' in the spec still means the platform allowlist, not literally any file", () => {
    const exe = { fileName: "run.exe", mimeType: "application/x-msdownload", sizeBytes: 100 };
    expect(validateFile(exe, { types: ["any"] }, 0).ok).toBe(false);
    expect(validateFile(pdf, { types: ["any"] }, 0).ok).toBe(true);
  });

  it("enforces the default max file count, and an auditor's override of it", () => {
    expect(validateFile(pdf, undefined, DEFAULT_MAX_FILES_PER_CONTROL - 1).ok).toBe(true);
    expect(validateFile(pdf, undefined, DEFAULT_MAX_FILES_PER_CONTROL).ok).toBe(false);
    expect(validateFile(pdf, { maxFiles: 2 }, 1).ok).toBe(true);
    expect(validateFile(pdf, { maxFiles: 2 }, 2).ok).toBe(false);
  });
});
