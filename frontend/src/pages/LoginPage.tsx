import { useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import { useDemoMode } from "../demoContext";

export function LoginPage() {
  const { login, completeMfa, cancelMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const demo = useDemoMode(); // only in the live demo: one-click sign-in as each made-up person
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Two steps for an account with two-step sign-in on: the password, then a code.
  const [step, setStep] = useState<"password" | "code">("password");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  const query = new URLSearchParams(location.search);
  const justAcceptedInvite = query.get("accepted") === "1";
  const justResetPassword = query.get("reset") === "1";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await login(email.trim(), password);
      if (outcome === "mfa-required") {
        setPassword(""); // not needed again, and not worth keeping around in the page
        setCode("");
        setUseRecovery(false);
        setStep("code");
      } else {
        navigate("/");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign in failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await completeMfa(code.trim());
      navigate("/");
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_MFA_TOKEN") {
        // The half-finished sign-in is gone (it only lasts a few minutes): back to the password.
        setStep("password");
        setError(e.message);
      } else {
        setError(e instanceof ApiError ? e.message : "Sign in failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function backToPassword() {
    cancelMfa();
    setCode("");
    setError(null);
    setStep("password");
  }

  if (step === "code") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <form onSubmit={onSubmitCode} className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
          <div className="h-10 w-10 rounded-lg bg-teal-600 text-white flex items-center justify-center font-semibold mb-4">✓</div>
          <h1 className="text-xl font-semibold mb-1">Two-step sign-in</h1>
          <p className="text-sm text-gray-500 mb-6">
            {useRecovery
              ? "Enter one of your recovery codes. Each one works only once."
              : "Open your authenticator app and enter the 6-digit code for Evidence Portal."}
          </p>
          <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="code">{useRecovery ? "Recovery code" : "Authentication code"}</label>
          <input
            id="code"
            key={useRecovery ? "recovery" : "totp"}
            type="text"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode={useRecovery ? "text" : "numeric"}
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 font-mono tracking-wider focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
            placeholder={useRecovery ? "XXXX-XXXX-XXXX-XXXX" : "123456"}
          />
          {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
          <button type="submit" disabled={submitting || !code.trim()} className="w-full rounded-lg bg-teal-600 text-white text-sm font-semibold py-2 mt-2 disabled:opacity-50">
            {submitting ? "Checking…" : "Verify"}
          </button>
          <div className="flex justify-between mt-4 text-xs">
            <button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }} className="text-teal-700">
              {useRecovery ? "Use my authenticator app instead" : "Use a recovery code instead"}
            </button>
            <button type="button" onClick={backToPassword} className="text-gray-500">Back</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 py-8">
      {demo?.signInPanel /* the live demo only: one-click sign-in comes first, so nobody has to scroll for it */}
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
        <div className="h-10 w-10 rounded-lg bg-teal-600 text-white flex items-center justify-center font-semibold mb-4">✓</div>
        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-gray-500 mb-6">Use the email and password from your invite.</p>
        {justAcceptedInvite && <p className="text-sm text-green-700 mb-4">Password set. Sign in below.</p>}
        {justResetPassword && <p className="text-sm text-green-700 mb-4">Password changed. Sign in with your new password.</p>}
        <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
          placeholder="you@company.com"
        />
        <div className="flex items-baseline justify-between mb-1">
          <label className="block text-xs font-semibold text-gray-500" htmlFor="password">Password</label>
          <Link to="/forgot-password" className="text-xs text-teal-700">Forgot password?</Link>
        </div>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !email || !password}
          className="w-full rounded-lg bg-teal-600 text-white text-sm font-semibold py-2 mt-2 disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-gray-400 mt-4">
          Haven't set a password yet? Use the link from your invite email, or <Link to="/accept-invite" className="text-teal-700">enter your invite code</Link>.
        </p>
      </form>
    </div>
  );
}
