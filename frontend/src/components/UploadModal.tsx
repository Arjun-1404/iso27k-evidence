import { useRef, useState } from "react";
import { useApi } from "../api/ApiProvider";
import { uploadFile, ApiError } from "../api/client";
import type { ControlSummary } from "../api/types";

type Step = "idle" | "uploading" | "scanning" | "done" | "error";

export function UploadModal({ control, onClose, onUploaded }: { control: ControlSummary; onClose: () => void; onUploaded: () => void }) {
  const api = useApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setStep("uploading");
    setError(null);
    try {
      setStep("scanning");
      await uploadFile(api, control.id, file);
      setStep("done");
      onUploaded();
    } catch (e) {
      setStep("error");
      setError(e instanceof ApiError ? e.message : "Upload failed. Please try again.");
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" role="dialog" aria-label="Upload evidence">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold mb-1">Upload evidence</h2>
        <p className="text-xs text-gray-500 mb-4">{control.controlRef} {control.title}</p>
        <p className="text-xs text-teal-700 mb-3">{control.effectiveEvidence}</p>

        <div
          className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500 cursor-pointer mb-3"
          onClick={() => inputRef.current?.click()}
        >
          {file ? file.name : "Click to choose a file"}
          <input ref={inputRef} type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>

        {step === "scanning" && <p className="text-sm text-gray-500 mb-3">Uploading and scanning…</p>}
        {step === "done" && <p className="text-sm text-green-700 mb-3">Uploaded.</p>}
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">Close</button>
          {step !== "done" && (
            <button onClick={submit} disabled={!file || step === "uploading" || step === "scanning"} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
              Upload
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
