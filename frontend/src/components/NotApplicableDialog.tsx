import { useState } from "react";
import { ApiError } from "../api/client";
import type { ControlSummary } from "../api/types";

export const MIN_REASON = 3;

/**
 * Asks why a control doesn't apply to this client before marking it so. The reason is required (the server insists too)
 * and is kept with the control, because an auditor will be asked about it later. Nothing is changed until the person
 * confirms, so cancelling leaves the control as it was.
 */
export function NotApplicableDialog({ control, initialReason = "", onConfirm, onCancel }: {
  control: ControlSummary;
  initialReason?: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = reason.trim().length >= MIN_REASON;

  async function confirm() {
    setBusy(true); setError(null);
    try { await onConfirm(reason.trim()); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-label={`Mark ${control.controlRef} not applicable`} className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold mb-1">Mark {control.controlRef} not applicable</h2>
        <p className="text-sm text-gray-600 mb-3">{control.title}</p>
        <p className="text-xs text-gray-500 mb-3">
          The client won't be asked for evidence for this control, and it won't count towards their progress. Say why it doesn't apply: the reason is kept with the control.
        </p>
        <label htmlFor="na-reason" className="block text-xs font-semibold text-gray-500 mb-1">Why doesn't it apply?</label>
        <textarea id="na-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus
          placeholder="For example: the company has no physical premises, so this doesn't apply."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2" />
        {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>
          <button type="button" onClick={() => void confirm()} disabled={busy || !ok} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
            {busy ? "Saving…" : "Mark not applicable"}
          </button>
        </div>
      </div>
    </div>
  );
}
