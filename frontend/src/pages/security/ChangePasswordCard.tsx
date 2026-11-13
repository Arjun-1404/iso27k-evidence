import { useState } from "react";
import { useApi } from "../../api/ApiProvider";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { field, primary } from "./styles";

const MIN_LENGTH = 12;

/**
 * Changing your own password while signed in. Asks for the current password (a borrowed session can't supply it) and,
 * if two-step sign-in is on, a code. On success every OTHER session of the person's is ended by the server, and the
 * fresh session it returns replaces this one, so they carry on without noticing anything but the message.
 */
export function ChangePasswordCard({ twoStepOn }: { twoStepOn: boolean }) {
  const api = useApi();
  const { replaceSession } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const ready = !!current && !!next && !!again && (!twoStepOn || !!code.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setDone(false);
    if (next.length < MIN_LENGTH) { setError(`The new password must be at least ${MIN_LENGTH} characters.`); return; }
    if (next !== again) { setError("The two new passwords don't match."); return; }
    setBusy(true);
    setError(null);
    try {
      replaceSession(await api.changePassword(current, next, twoStepOn ? code.trim() : undefined));
      setCurrent(""); setNext(""); setAgain(""); setCode("");
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change your password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold mb-1">Password</h2>
      <p className="text-sm text-gray-600 mb-4">Changing it signs you out on every other device.</p>
      {done && <p role="status" className="text-sm text-green-700 mb-3">Password changed. Any other devices have been signed out.</p>}
      <form onSubmit={submit} className="space-y-3" aria-label="Change password">
        <div>
          <label htmlFor="pw-current" className="block text-xs font-semibold text-gray-500 mb-1">Current password</label>
          <input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="pw-new" className="block text-xs font-semibold text-gray-500 mb-1">New password</label>
          <input id="pw-new" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} className={field} />
          <p className="text-xs text-gray-400 mt-1">At least {MIN_LENGTH} characters.</p>
        </div>
        <div>
          <label htmlFor="pw-again" className="block text-xs font-semibold text-gray-500 mb-1">New password again</label>
          <input id="pw-again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} className={field} />
        </div>
        {twoStepOn && (
          <div>
            <label htmlFor="pw-code" className="block text-xs font-semibold text-gray-500 mb-1">Code to confirm: from your authenticator app, or a recovery code</label>
            <input id="pw-code" autoComplete="one-time-code" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)} className={`${field} font-mono tracking-wider max-w-xs`} />
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy || !ready} className={primary}>{busy ? "Changing…" : "Change password"}</button>
      </form>
    </section>
  );
}
