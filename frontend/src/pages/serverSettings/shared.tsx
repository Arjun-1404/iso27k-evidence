import { useState, type ReactNode } from "react";
import type { SettingsGroupView } from "../../api/types";
import { field, secondary } from "../security/styles";
import { errorText } from "./helpers";

/** Where a group's values come from, in words. */
export function StatusPill({ group }: { group: SettingsGroupView }) {
  const [text, tone] =
    group.source === "environment" ? ["Set by the server's configuration (locked)", "bg-slate-100 text-slate-700"]
    : group.source === "panel" ? ["Set up here", "bg-green-50 text-green-800"]
    : group.problem ? ["Saved settings can't be used", "bg-red-50 text-red-700"]
    : ["Not set up", "bg-amber-50 text-amber-800"];
  return <span data-testid={`status-${group.group}`} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{text}</span>;
}


export function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-xs font-semibold text-gray-500 mb-1">{children}</label>;
}

/** The password (and code, for an owner who uses two-step sign-in) that saving or removing asks for again. */
export function ConfirmYou({ idPrefix, needsCode, password, setPassword, code, setCode }: {
  idPrefix: string; needsCode: boolean; password: string; setPassword: (v: string) => void; code: string; setCode: (v: string) => void;
}) {
  return (
    <fieldset className="rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-3">
      <legend className="px-1 text-xs font-semibold text-gray-600">Confirm it's you</legend>
      <div>
        <Label htmlFor={`${idPrefix}-password`}>Your password</Label>
        <input id={`${idPrefix}-password`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${field} max-w-xs`} />
      </div>
      {needsCode && (
        <div>
          <Label htmlFor={`${idPrefix}-code`}>Code to confirm: from your authenticator app, or a recovery code</Label>
          <input id={`${idPrefix}-code`} autoComplete="one-time-code" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} className={`${field} font-mono tracking-wider max-w-xs`} />
        </div>
      )}
    </fieldset>
  );
}

/** What the server's own configuration provides: shown, but not editable here. */
export function LockedValues({ group, labels }: { group: SettingsGroupView; labels: Record<string, string> }) {
  return (
    <div>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm mb-3">
        {Object.entries(labels).map(([key, label]) => (
          <div key={key} className="contents">
            <dt className="text-gray-500">{label}</dt>
            <dd className="break-all">{group.values?.[key] ?? "—"}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-gray-500">
        These come from the server's configuration file (.env), which takes priority. To change them, edit that file and restart the server — or remove them from the file to manage them here.
      </p>
    </div>
  );
}

/** A "check it works" button and its result, for the mail server and the scanner. */
export function CheckButton({ label, busyLabel, run }: { label: string; busyLabel: string; run: () => Promise<string> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  async function click() {
    setBusy(true); setResult(null);
    try { setResult({ ok: true, text: await run() }); } catch (e) { setResult({ ok: false, text: errorText(e, "The check didn't finish. Please try again.") }); } finally { setBusy(false); }
  }
  return (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <button type="button" onClick={click} disabled={busy} className={secondary}>{busy ? busyLabel : label}</button>
      {result && <p role={result.ok ? "status" : "alert"} className={`mt-2 text-sm ${result.ok ? "text-green-700" : "text-red-600"}`}>{result.text}</p>}
    </div>
  );
}

