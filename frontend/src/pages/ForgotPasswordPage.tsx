import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";

export function ForgotPasswordPage() {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const address = email.trim();
    try {
      await api.requestPasswordReset(address);
      setAsked(address);
    } catch (e) {
      // The server answers identically for every address, so the only errors here are "that doesn't look like
      // an email address", "too many requests" and "couldn't reach the server" — all safe to show as they are.
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
        <h1 className="text-xl font-semibold mb-1">Reset your password</h1>
        {asked ? (
          <>
            <p className="text-sm text-gray-600 mt-3 mb-3" role="status">
              If an account exists for <span className="font-medium">{asked}</span>, we've emailed a link to reset the password.
              It works once and expires in 1 hour.
            </p>
            <p className="text-xs text-gray-500 mb-4">
              Nothing arrived after a few minutes? Check your spam folder. If you were invited but never set a password,
              ask your administrator to resend your invite instead.
            </p>
            <Link to="/login" className="text-sm text-teal-700">Back to sign in</Link>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <p className="text-sm text-gray-500 mb-6">Enter your work email and we'll send you a link to choose a new password.</p>
            <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
              placeholder="you@company.com"
            />
            {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="w-full rounded-lg bg-teal-600 text-white text-sm font-semibold py-2 mt-2 disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Send reset link"}
            </button>
            <p className="text-xs text-gray-400 mt-4"><Link to="/login" className="text-teal-700">Back to sign in</Link></p>
          </form>
        )}
      </div>
    </div>
  );
}
