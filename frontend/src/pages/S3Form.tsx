import { useState } from "react";
import { ApiError } from "../api/client";
import type { S3Form as S3Values } from "../api/types";

const EMPTY: S3Values = { endpoint: "", region: "us-east-1", bucket: "", accessKeyId: "", secretAccessKey: "", forcePathStyle: false, prefix: "" };

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const INPUT = "mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm";

/**
 * The details for an S3-compatible storage (Amazon S3, or MinIO, Wasabi, Backblaze B2, Cloudflare R2, Ceph…).
 *
 * Nothing typed here is read back from the server: the secret access key is stored encrypted and never shown again,
 * so changing any setting means entering them again. "Test" proves the details work without saving anything.
 */
export function S3Form({ locked, onTest, onSave, onCancel }: {
  /** Evidence already lives in the bucket: only the keys may change, so the bucket, folder and address must stay as they are. */
  locked: boolean;
  onTest: (form: S3Values) => Promise<void>;
  /** Resolves true once saved; false if the page is first asking the person to confirm (the details stay in the form). Rejects with the reason it failed. */
  onSave: (form: S3Values) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<S3Values>(EMPTY);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const set = <K extends keyof S3Values>(key: K, value: S3Values[K]) => { setForm((f) => ({ ...f, [key]: value })); setResult(null); };
  const complete = form.region.trim() !== "" && form.bucket.trim() !== "" && form.accessKeyId.trim() !== "" && form.secretAccessKey !== "";

  async function test() {
    setBusy("test");
    setResult(null);
    try {
      await onTest(form);
      setResult({ kind: "ok", text: "The connection works. Nothing has been saved yet." });
    } catch (e) {
      setResult({ kind: "error", text: message(e, "Couldn't test the connection. Please try again.") });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setResult(null);
    try {
      if (await onSave(form)) setForm(EMPTY); // the secret key does not stay in the page once it has been handed over
    } catch (e) {
      setResult({ kind: "error", text: message(e, "Couldn't save the connection. Please try again.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (complete && !busy) void save(); }}
      className="mt-4 space-y-3 border-t border-gray-100 pt-4"
      aria-label="S3-compatible storage details"
    >
      {locked && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Evidence is already stored in this bucket, so the bucket, folder and address have to stay exactly as they are. Only the access keys can change.
        </p>
      )}
      <label className="block text-sm">
        <span className="font-medium">Service address <span className="font-normal text-gray-500">(leave empty for Amazon S3)</span></span>
        <input value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://minio.example.com:9000" inputMode="url" autoComplete="off" spellCheck={false} className={INPUT} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Region</span>
          <input value={form.region} onChange={(e) => set("region", e.target.value)} autoComplete="off" spellCheck={false} className={INPUT} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Bucket</span>
          <input value={form.bucket} onChange={(e) => set("bucket", e.target.value)} autoComplete="off" spellCheck={false} className={INPUT} />
        </label>
      </div>
      <label className="block text-sm">
        <span className="font-medium">Folder inside the bucket <span className="font-normal text-gray-500">(optional)</span></span>
        <input value={form.prefix} onChange={(e) => set("prefix", e.target.value)} placeholder="evidence" autoComplete="off" spellCheck={false} className={INPUT} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Access key ID</span>
          <input value={form.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} autoComplete="off" spellCheck={false} className={INPUT} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Secret access key</span>
          <input type="password" value={form.secretAccessKey} onChange={(e) => set("secretAccessKey", e.target.value)} autoComplete="new-password" spellCheck={false} className={INPUT} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={form.forcePathStyle} onChange={(e) => set("forcePathStyle", e.target.checked)} className="mt-1" />
        <span>My service needs path-style addresses <span className="text-gray-500">(MinIO and most services you run yourself do; Amazon S3 does not)</span></span>
      </label>
      <p className="text-xs text-gray-500">
        The access key needs to list, read, write and delete files in the bucket. The secret key is stored encrypted and is never shown again.
      </p>

      {result && (
        <p role={result.kind === "error" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${result.kind === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-800"}`}>
          {result.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void test()} disabled={!complete || busy !== null} className="rounded-lg border border-teal-600 px-4 py-1.5 text-sm font-semibold text-teal-700 disabled:opacity-40">
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <button type="submit" disabled={!complete || busy !== null} className="rounded-lg bg-teal-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy === "save" ? "Saving…" : "Save and use S3 storage"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy !== null} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">Cancel</button>
      </div>
    </form>
  );
}
