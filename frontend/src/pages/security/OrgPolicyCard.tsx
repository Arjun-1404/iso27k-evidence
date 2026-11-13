import { useState } from "react";
import { useApi } from "../../api/ApiProvider";
import { ApiError } from "../../api/client";
import { useApiQuery } from "../../api/useApiQuery";
import type { MfaPolicy, MfaPolicyCounts, OrgMfaPolicy } from "../../api/types";
import { primary } from "./styles";

const OPTIONS: { value: MfaPolicy; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Two-step sign-in is optional for everyone." },
  { value: "staff", label: "Staff only", help: "Everyone in your organisation must use it. Your clients' people are not required to." },
  { value: "everyone", label: "Everyone", help: "Staff and your clients' people must use it." },
];

const progress = (c: MfaPolicyCounts) => `${c.enrolled} of ${c.total} ${c.total === 1 ? "person has" : "people have"} set it up`;

/**
 * Organisation admins decide who must use two-step sign-in. Anyone the rule covers who hasn't set it up is shown the
 * Security page and nothing else until they do; the people it covers can't turn it off. Accounts that sign in through
 * an organisation's single sign-on are never covered (their provider handles it), so the counts leave them out.
 */
export function OrgPolicyCard({ adminHasTwoStep }: { adminHasTwoStep: boolean }) {
  const api = useApi();
  const { data: loaded, loading, error: loadError } = useApiQuery((signal) => api.getMfaPolicy(signal), []);
  const [updated, setUpdated] = useState<OrgMfaPolicy | null>(null); // the server's answer after a save, newer than what was loaded
  const [picked, setPicked] = useState<MfaPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = updated ?? loaded;
  const saved = data?.policy ?? null;
  const chosen = picked ?? saved;
  const counts = data ? { staff: data.staff, everyone: data.everyone } : null;

  // "Off" is always allowed. Anything else needs the server to be able to do it, and the admin to have it on first
  // (so switching it on can never lock out the person who did). The server enforces both; this just says so up front.
  const blockedReason = !data ? null
    : !data.available ? "This server can't do two-step sign-in yet (SECRET_ENCRYPTION_KEY isn't set), so it can't be required."
    : !adminHasTwoStep ? "Turn on two-step sign-in for your own account first, above, so you can't lock yourself out."
    : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.setMfaPolicy(chosen);
      setUpdated(next);
      setPicked(null);
      setNotice(next.policy === "off" ? "Two-step sign-in is no longer required." : "Policy saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the policy. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6" aria-labelledby="org-policy-heading">
      <h2 id="org-policy-heading" className="text-lg font-semibold mb-1">Organisation policy</h2>
      <p className="text-sm text-gray-600 mb-4">Require two-step sign-in for the people in your organisation.</p>

      {loading && !data && <p className="text-sm text-gray-500">Loading…</p>}
      {loadError && <p role="alert" className="text-sm text-red-600">{loadError}</p>}

      {data && counts && chosen && (
        <form onSubmit={save} className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="sr-only">Who must use two-step sign-in</legend>
            {OPTIONS.map((o) => {
              const disabled = o.value !== "off" && blockedReason !== null && o.value !== saved;
              return (
                <label key={o.value} className={`flex items-start gap-3 rounded-lg border p-3 ${chosen === o.value ? "border-teal-600 bg-teal-50" : "border-gray-200"} ${disabled ? "opacity-60" : ""}`}>
                  <input type="radio" name="mfa-policy" value={o.value} checked={chosen === o.value} disabled={disabled} onChange={() => { setPicked(o.value); setNotice(null); }} className="mt-1" />
                  <span>
                    <span className="block text-sm font-semibold">{o.label}</span>
                    <span className="block text-sm text-gray-600">{o.help}</span>
                    {o.value === "staff" && <span className="block text-xs text-gray-500 mt-1">{progress(counts.staff)}</span>}
                    {o.value === "everyone" && <span className="block text-xs text-gray-500 mt-1">{progress(counts.everyone)}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {blockedReason && <p role="status" className="text-sm text-amber-700">{blockedReason}</p>}
          {chosen !== "off" && chosen !== saved && (
            <p className="text-sm text-gray-600">
              People who haven't set it up yet will be asked to the next time they use the portal, and can't do anything else until they have.
              Keep at least two organisation admins, so a lost phone never leaves nobody able to reset it.
            </p>
          )}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
          <button type="submit" disabled={busy || chosen === saved} className={primary}>{busy ? "Saving…" : "Save policy"}</button>
        </form>
      )}
    </section>
  );
}
