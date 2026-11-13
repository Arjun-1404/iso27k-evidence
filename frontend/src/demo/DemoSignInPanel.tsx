import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import { DEMO_PASSWORD, SIGN_IN_ACCOUNTS } from "./accounts";

/** One-click sign-in as each of the made-up people, so nobody has to know an address or a password to look around. */
export function DemoSignInPanel() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signInAs(email: string) {
    setBusy(email);
    setError(null);
    try {
      const outcome = await login(email, DEMO_PASSWORD);
      if (outcome === "signed-in") navigate("/");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign in failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Try the demo" className="w-full max-w-sm bg-white rounded-xl border border-teal-200 p-6 shadow-sm">
      <h2 className="text-sm font-semibold mb-1">Try it: sign in as…</h2>
      <p className="text-xs text-gray-500 mb-3">Each person sees and can do something different. Start with the lead auditor to see evidence waiting for review.</p>
      <ul className="space-y-2">
        {SIGN_IN_ACCOUNTS.map((a) => (
          <li key={a.email}>
            <button
              type="button"
              onClick={() => void signInAs(a.email)}
              disabled={busy !== null}
              className="w-full text-left rounded-lg border border-gray-200 px-3 py-2 hover:border-teal-500 hover:bg-teal-50 disabled:opacity-60"
            >
              <span className="block text-sm font-semibold">{a.label} <span className="font-normal text-gray-500">· {a.fullName}</span></span>
              <span className="block text-xs text-gray-500">{a.blurb}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-red-600 mt-3">{error}</p>}
    </section>
  );
}
