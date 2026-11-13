import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";

export function AcceptInvitePage() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    setSubmitting(true);
    try {
      await api.acceptInvite(token.trim(), password);
      navigate("/login?accepted=1");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
        <h1 className="text-xl font-semibold mb-1">Set your password</h1>
        <p className="text-sm text-gray-500 mb-6">Use the link from your invite email, or paste your invite code below.</p>

        <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="token">Invite code</label>
        <input
          id="token"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3 font-mono text-xs focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          required
          autoFocus={!!token}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        <label className="block text-xs font-semibold text-gray-500 mb-1" htmlFor="confirm">Confirm password</label>
        <input
          id="confirm"
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        <p className="text-xs text-gray-400 mb-2">At least 12 characters.</p>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !token || !password || !confirm}
          className="w-full rounded-lg bg-teal-600 text-white text-sm font-semibold py-2 mt-2 disabled:opacity-50"
        >
          {submitting ? "Setting password…" : "Set password"}
        </button>
      </form>
    </div>
  );
}
