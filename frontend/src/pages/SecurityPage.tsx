import { useEffect, useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import { AppShell } from "../components/AppShell";
import { QrCode } from "../components/QrCode";
import { useAuth } from "../auth/AuthProvider";
import type { MfaEnrollment } from "../api/types";
import { field, primary, secondary } from "./security/styles";
import { ChangePasswordCard } from "./security/ChangePasswordCard";
import { OrgPolicyCard } from "./security/OrgPolicyCard";

type Mode = "idle" | "enroll-password" | "enroll-scan" | "recovery-codes" | "disable" | "regenerate";

/** Shown when the number of unused recovery codes is this low or lower. */
const LOW_RECOVERY_CODES = 3;

/** The secret in groups of four, easier to read off a screen and type into an app. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

function downloadCodes(codes: string[]) {
  const blob = new Blob([`Evidence Portal recovery codes\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "evidence-portal-recovery-codes.txt";
  a.click();
  URL.revokeObjectURL(url);
}

/** Each person's own security settings: two-step sign-in (turn it on, see how many recovery codes are left, get new
 *  ones, turn it off), their password, and — for organisation admins — the organisation's two-step policy. Everything
 *  that changes anything asks for the password again (and a code to take protection away).
 *
 *  If the organisation requires two-step sign-in and this person hasn't set it up, this is the one page they can use:
 *  the server refuses everything else, and the rest of the app sends them here until it is on. */
export function SecurityPage() {
  const api = useApi();
  const { user, setMfaSetupRequired } = useAuth();
  const { data: status, loading, error: loadError, refetch } = useApiQuery((signal) => api.getMfaStatus(signal), []);
  const mustSetUp = !!status && status.required && !status.enabled;
  const isAdmin = user?.role === "org_admin";

  // Keep the app-wide "must set this up first" state in line with what the server just said (it may have been
  // switched on, or off, since this person last looked).
  useEffect(() => { if (status) setMfaSetupRequired(status.required && !status.enabled); }, [status, setMfaSetupRequired]);

  const [mode, setMode] = useState<Mode>("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function go(next: Mode) {
    setMode(next);
    setPassword("");
    setCode("");
    setError(null);
  }

  /** One place for "do the request, show the server's own message if it fails". */
  async function attempt(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const startEnrollment = (e: React.FormEvent) => {
    e.preventDefault();
    return attempt(async () => {
      setEnrollment(await api.startMfaEnrollment(password));
      setNotice(null);
      go("enroll-scan");
    }, "Could not start setting up two-step sign-in. Please try again.");
  };

  const confirmEnrollment = (e: React.FormEvent) => {
    e.preventDefault();
    return attempt(async () => {
      const done = await api.confirmMfaEnrollment(code.trim());
      setMfaSetupRequired(false); // the server stops refusing everything else from this moment
      setRecoveryCodes(done.recoveryCodes);
      setEnrollment(null); // the secret has done its job; don't keep it in the page
      setSaved(false);
      go("recovery-codes");
    }, "Could not turn on two-step sign-in. Please try again.");
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    return attempt(async () => {
      await api.disableMfa(password, code.trim());
      setNotice("Two-step sign-in is off.");
      go("idle");
      refetch();
    }, "Could not turn off two-step sign-in. Please try again.");
  };

  const regenerate = (e: React.FormEvent) => {
    e.preventDefault();
    return attempt(async () => {
      const done = await api.regenerateRecoveryCodes(password, code.trim());
      setRecoveryCodes(done.recoveryCodes);
      setSaved(false);
      setNotice(null);
      go("recovery-codes");
    }, "Could not make new recovery codes. Please try again.");
  };

  function finishRecoveryCodes() {
    setRecoveryCodes(null); // shown once: once the person says they have them, they are gone from the page
    setNotice("Two-step sign-in is on.");
    go("idle");
    refetch();
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText((recoveryCodes ?? []).join("\n"));
      setNotice("Recovery codes copied.");
    } catch {
      setNotice("Could not copy automatically — select the codes and copy them by hand.");
    }
  }

  return (
    <AppShell>
      <div className="p-8 max-w-2xl space-y-6">
        <h1 className="text-xl font-semibold">Security</h1>
        {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}

        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold mb-1">Two-step sign-in</h2>

          {loading && !status && <p className="text-sm text-gray-500">Loading…</p>}
          {loadError && <p role="alert" className="text-sm text-red-600">{loadError}</p>}

          {mustSetUp && (
            <p role="alert" className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3 my-3">
              <strong>Your organisation requires two-step sign-in.</strong> Set it up below to carry on. Nothing else in the portal is open to you until you do.
            </p>
          )}

          {status && !status.available && (
            <p role="status" className="text-sm text-amber-700 mt-2">
              {status.enabled
                ? "Two-step sign-in is on for your account, but this server can't check authenticator codes right now. Use a recovery code to sign in, and ask your administrator to set SECRET_ENCRYPTION_KEY."
                : "Two-step sign-in isn't available on this server yet. Ask your administrator to set SECRET_ENCRYPTION_KEY (see the README)."}
            </p>
          )}

          {status && mode === "idle" && !status.enabled && status.available && (
            <>
              <p className="text-sm text-gray-600 mb-4">
                Add a second step to signing in: a 6-digit code from an app on your phone (Google Authenticator, Microsoft Authenticator,
                1Password and others). Even if someone learns your password, they can't sign in without your phone.
              </p>
              <button type="button" className={primary} onClick={() => go("enroll-password")}>Set up two-step sign-in</button>
            </>
          )}

          {status && mode === "idle" && status.enabled && (
            <>
              <p className="text-sm mb-1">
                <span className="inline-block rounded-full bg-green-100 text-green-800 text-xs font-semibold px-2 py-0.5">On</span>
                {status.required && <span className="ml-2 text-xs text-gray-500">Required by your organisation</span>}
              </p>
              <p className="text-sm text-gray-600 mb-1">
                Recovery codes left: <strong>{status.recoveryRemaining}</strong>
              </p>
              {status.recoveryRemaining <= LOW_RECOVERY_CODES && (
                <p role="status" className="text-sm text-amber-700 mb-3">
                  {status.recoveryRemaining === 0
                    ? "You have no recovery codes left. If you lose your phone you won't be able to sign in. Get new codes now."
                    : "You're running low on recovery codes. Get a new set so you're not locked out if you lose your phone."}
                </p>
              )}
              <div className="flex gap-2 mt-3">
                <button type="button" className={secondary} onClick={() => go("regenerate")}>Get new recovery codes</button>
                {!status.required && <button type="button" className={secondary} onClick={() => go("disable")}>Turn off two-step sign-in</button>}
              </div>
              {status.required && (
                <p className="text-xs text-gray-500 mt-2">Your organisation requires it, so it can't be turned off. If you lose your phone, an organisation admin can reset it.</p>
              )}
            </>
          )}

          {mode === "enroll-password" && (
            <form onSubmit={startEnrollment} className="mt-3 space-y-3">
              <p className="text-sm text-gray-600">First, confirm it's you.</p>
              <div>
                <label htmlFor="mfa-password" className="block text-xs font-semibold text-gray-500 mb-1">Password</label>
                <input id="mfa-password" type="password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
              </div>
              {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={busy || !password} className={primary}>{busy ? "Checking…" : "Continue"}</button>
                <button type="button" className={secondary} onClick={() => go("idle")}>Cancel</button>
              </div>
            </form>
          )}

          {mode === "enroll-scan" && enrollment && (
            <form onSubmit={confirmEnrollment} className="mt-3 space-y-4">
              <div>
                <p className="text-sm font-semibold mb-2">1. Scan this QR code with your authenticator app</p>
                <QrCode value={enrollment.otpauthUri} label="QR code for your authenticator app" className="h-48 w-48 border border-gray-200 rounded-lg" />
                <p className="text-xs text-gray-500 mt-2">Can't scan it? Choose "enter a setup key" in the app and type this key:</p>
                <p className="mt-1"><code data-testid="setup-key" className="rounded bg-gray-100 px-2 py-1 text-sm font-mono tracking-wide select-all">{grouped(enrollment.secret)}</code></p>
              </div>
              <div>
                <label htmlFor="mfa-code" className="block text-sm font-semibold mb-2">2. Enter the 6-digit code the app shows</label>
                <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} required autoFocus value={code}
                  onChange={(e) => setCode(e.target.value)} placeholder="123456" className={`${field} max-w-[10rem] font-mono tracking-wider`} />
              </div>
              {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={busy || !code.trim()} className={primary}>{busy ? "Checking…" : "Turn on"}</button>
                <button type="button" className={secondary} onClick={() => { setEnrollment(null); go("idle"); }}>Cancel</button>
              </div>
            </form>
          )}

          {mode === "recovery-codes" && recoveryCodes && (
            <div className="mt-3 space-y-4">
              <p className="text-sm text-gray-600">
                <strong>Save your recovery codes.</strong> If you lose your phone, each of these lets you sign in once. They are shown
                only now — keep them somewhere safe, such as a password manager.
              </p>
              <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-lg bg-gray-50 border border-gray-200 p-4">
                {recoveryCodes.map((c) => <li key={c} className="font-mono text-sm tracking-wide select-all">{c}</li>)}
              </ul>
              <div className="flex gap-2">
                <button type="button" className={secondary} onClick={copyCodes}>Copy codes</button>
                <button type="button" className={secondary} onClick={() => downloadCodes(recoveryCodes)}>Download</button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                I've saved these codes somewhere safe
              </label>
              <button type="button" className={primary} disabled={!saved} onClick={finishRecoveryCodes}>Done</button>
            </div>
          )}

          {(mode === "disable" || mode === "regenerate") && (
            <form onSubmit={mode === "disable" ? disable : regenerate} className="mt-3 space-y-3">
              <p className="text-sm text-gray-600">
                {mode === "disable"
                  ? "To turn off two-step sign-in, confirm your password and enter a code."
                  : "New recovery codes replace the old ones — the old codes stop working. Confirm your password and enter a code."}
              </p>
              <div>
                <label htmlFor="mfa-password" className="block text-xs font-semibold text-gray-500 mb-1">Password</label>
                <input id="mfa-password" type="password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
              </div>
              <div>
                <label htmlFor="mfa-code" className="block text-xs font-semibold text-gray-500 mb-1">Authenticator or recovery code</label>
                <input id="mfa-code" autoComplete="one-time-code" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)}
                  className={`${field} font-mono tracking-wider`} />
              </div>
              {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={busy || !password || !code.trim()} className={primary}>
                  {busy ? "Checking…" : mode === "disable" ? "Turn off" : "Get new codes"}
                </button>
                <button type="button" className={secondary} onClick={() => go("idle")}>Cancel</button>
              </div>
            </form>
          )}
        </section>

        {status && !mustSetUp && <ChangePasswordCard twoStepOn={status.enabled} />}
        {status && !mustSetUp && isAdmin && <OrgPolicyCard adminHasTwoStep={status.enabled} />}
      </div>
    </AppShell>
  );
}
