import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import type { ControlSummary } from "../api/types";
import { NotApplicableDialog } from "./NotApplicableDialog";

/**
 * Whether a control applies to the client: a Yes / No choice.
 *
 * Choosing No asks for the reason first and changes nothing until it is given. The mandatory clauses (4 to 10) always
 * apply, so they get no choice. People who may not change this see the answer as text. `onChanged` is called after a
 * successful change so the page can reload its list.
 */
export function ApplicabilityControl({ control, editable, onChanged, compact = false }: {
  control: ControlSummary;
  editable: boolean;
  onChanged: () => void;
  /** In a table cell: no label, and the reason is not repeated under the choice. */
  compact?: boolean;
}) {
  const api = useApi();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const yes = control.applicable;

  async function save(applicable: boolean, reason?: string) {
    setBusy(true); setError(null);
    try {
      await api.setApplicability(control.id, applicable, reason);
      onChanged();
    } finally { setBusy(false); }
  }

  if (control.kind === "clause") {
    return <span className="text-xs font-semibold text-green-700" title="Clauses 4 to 10 are mandatory, so they always apply.">Yes</span>;
  }
  if (!editable) {
    return (
      <span>
        <span className={`text-xs font-semibold ${yes ? "text-green-700" : "text-violet-800"}`}>{yes ? "Yes" : "No"}</span>
        {!yes && !compact && control.naJustification && <span className="block text-xs text-gray-500 mt-0.5">{control.naJustification}</span>}
      </span>
    );
  }
  return (
    <span className="inline-block">
      <label htmlFor={`applicable-${control.id}`} className="sr-only">Applicable: {control.controlRef}</label>
      <select
        id={`applicable-${control.id}`}
        value={yes ? "yes" : "no"}
        disabled={busy}
        onChange={(e) => {
          if (e.target.value === "no") setAsking(true);
          else void save(true).catch((err) => setError(err instanceof ApiError ? err.message : "That didn't work. Please try again."));
        }}
        className={`rounded-lg border px-2 py-1 text-xs font-semibold ${yes ? "border-gray-300 text-green-700" : "border-violet-400 text-violet-800"}`}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      {!yes && !compact && control.naJustification && <span className="block text-xs text-gray-500 mt-1">{control.naJustification}</span>}
      {!yes && (
        <button type="button" onClick={() => setAsking(true)} aria-label={`Change the reason for ${control.controlRef}`} className="ml-1 text-xs text-teal-700 hover:text-teal-900">Reason</button>
      )}
      {error && <span role="alert" className="block text-xs text-red-600 mt-1">{error}</span>}
      {asking && (
        <NotApplicableDialog
          control={control}
          initialReason={control.naJustification ?? ""}
          onCancel={() => setAsking(false)}
          onConfirm={async (reason) => { await save(false, reason); setAsking(false); }}
        />
      )}
    </span>
  );
}
