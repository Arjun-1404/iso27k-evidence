import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";

export function ResetPasswordPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Taken from the link once, then removed from the address bar (below) so the secret doesn't sit in the
  // browser history or in a screenshot of the window.
  const [token] = useState(() => params.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [linkProblem, setLinkProblem] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (params.has("token")) navigate("/reset-password", { replace: true });
  }, [params, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("Those passwords don't match."); return; }
    if (password.length < 12) { setError("Password must be at least 12 characters."); return; }
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      navigate("/login?reset=1");
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_RESET") setLinkProblem(true);
      else setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // No secret to work with: the page was opened directly, or the link was cut off, or it was already used and
  // the address bar was cleaned. Either way the only way forward is a fresh email.
  if (!token || linkProblem) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
          <h1 className="text-xl font-semibold mb-1">This reset link can't be used</h1>
          <p className="text-sm text-gray-600 mt-3 mb-4" role="alert">
            {linkProblem
              ? "It has expired or was already used. Reset links work once and last 1 hour."
              : "Open the link from your reset email, or request a new one."}
          </p>
          <Link to="/forgot-password" className="text-sm text-teal-700">Request a new link</Link>
          <p className="text-xs text-gray-400 mt-4"><Link to="/login" className="text-teal-700">Back to sign in</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
        <h1 className="text-xl font-semibold mb-1">Choose a new password</h1>
        <p className="text-sm text-gray-500 mb-6">You'll be signed out everywhere else once this is saved.</p>
        <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          required
          autoFocus
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="confirm">Confirm password</label>
        <input
          id="confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        <p className="text-xs text-gray-400 mb-2">At least 12 characters.</p>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password || !confirm}
          className="w-full rounded-lg bg-teal-600 text-white text-sm font-semibold py-2 mt-2 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save new password"}
        </button>
      </form>
    </div>
  );
}
