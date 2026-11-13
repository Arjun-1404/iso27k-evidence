import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import type { AuditSummary } from "../api/types";

/** Who may close and reopen a cycle (the database enforces the same). */
export const CAN_CLOSE_CYCLE = new Set(["org_admin", "lead_auditor"]);

const day = (iso: string) => iso.slice(0, 10);
const MIN_REASON = 3;

/**
 * What a closed audit cycle looks like, and the means to close and reopen one.
 *
 * Closed: a notice saying nothing in the cycle can be changed. Open: nothing, except for people who may close it, who get
 * a button that first explains what closing does. Reopening asks for a reason, which the server writes to the audit log.
 * Put a `key` on it so that switching to another cycle starts from a clean state.
 */
export function AuditCycleLock({ audit, canManage, notAccepted = 0, onChanged }: {
  audit: AuditSummary;
  canManage: boolean;
  /** How many applicable controls are not yet accepted: shown as a heads-up before closing. */
  notAccepted?: number;
  /** Called with the cycle as it is after a successful close or reopen, so the page can refresh. */
  onChanged?: (audit: AuditSummary) => void;
}) {
  const api = useApi();
  const [step, setStep] = useState<"idle" | "confirm-close" | "reopen">("idle");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<AuditSummary>) {
    setBusy(true); setError(null);
    try {
      const updated = await action();
      setStep("idle"); setReason("");
      onChanged?.(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const cancel = () => { setStep("idle"); setReason(""); setError(null); };

  if (audit.status === "closed") {
    return (
      <section aria-label="Audit cycle closed" className="rounded-xl border border-amber-300 bg-amber-50 p-4 mb-6 max-w-3xl">
        <p className="text-sm font-semibold text-amber-900">This audit cycle is closed.</p>
        <p className="text-sm text-amber-900 mt-0.5">
          {audit.closedAt ? `Closed on ${day(audit.closedAt)}${audit.closedBy ? ` by ${audit.closedBy}` : ""}. ` : ""}
          Nothing in it can be changed: no uploads, reviews, comments or assignments. You can still look at everything.
        </p>
        {canManage && step !== "reopen" && (
          <button type="button" onClick={() => setStep("reopen")} className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900">Reopen audit cycle</button>
        )}
        {canManage && step === "reopen" && (
          <form className="mt-3" onSubmit={(e) => { e.preventDefault(); void run(() => api.reopenAudit(audit.id, reason.trim())); }}>
            <label htmlFor="reopen-reason" className="block text-xs font-semibold text-amber-900 mb-1">Reason for reopening</label>
            <textarea id="reopen-reason" value={reason} maxLength={1000} rows={2} onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm" />
            <p className="text-xs text-amber-800 mt-1">The reason is written to the audit log, together with your name.</p>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
            <div className="mt-3 flex gap-2">
              <button type="submit" disabled={busy || reason.trim().length < MIN_REASON} className="rounded-lg bg-amber-700 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
                {busy ? "Reopening…" : "Confirm reopen"}
              </button>
              <button type="button" disabled={busy} onClick={cancel} className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Cancel</button>
            </div>
          </form>
        )}
      </section>
    );
  }

  if (!canManage) return null;

  return (
    <section aria-label="Close this audit cycle" className="mb-6 max-w-3xl">
      {step !== "confirm-close" && (
        <button type="button" onClick={() => setStep("confirm-close")} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold">Close audit cycle</button>
      )}
      {step === "confirm-close" && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold mb-1">Close “{audit.name}”?</h2>
          <p className="text-xs text-gray-600">
            Closing makes this cycle read-only. Nobody can upload evidence, review, comment, assign controls or change anything in it,
            and everything stays visible. Use it once the audit is signed off. It is written to the audit log, and a lead auditor or
            organisation admin can reopen it later (with a reason).
          </p>
          {notAccepted > 0 && (
            <p className="mt-2 text-xs font-semibold text-amber-800">
              {notAccepted} applicable control{notAccepted === 1 ? " is" : "s are"} not accepted yet. {notAccepted === 1 ? "It" : "They"} will stay as {notAccepted === 1 ? "it is" : "they are"}.
            </p>
          )}
          {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => api.closeAudit(audit.id))} className="rounded-lg bg-slate-800 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
              {busy ? "Closing…" : "Yes, close it"}
            </button>
            <button type="button" disabled={busy} onClick={cancel} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
