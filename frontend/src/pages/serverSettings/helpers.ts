import { useState } from "react";
import { useApi } from "../../api/ApiProvider";
import { ApiError } from "../../api/client";
import type { PlatformSettingsView, SettingsGroup } from "../../api/types";

export const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
export const cardClass = "rounded-xl border border-gray-200 bg-white p-6";

/** Saving and removing one group: the shared password/code state, busy flag, and messages. */
export type OnSaved = (view: PlatformSettingsView, message: string) => void;

export function useGroupActions(group: SettingsGroup, needsCode: boolean, onSaved: OnSaved) {
  const api = useApi();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = password !== "" && (!needsCode || code.trim() !== "");

  async function run(action: () => Promise<PlatformSettingsView>, done: string) {
    setBusy(true); setError(null);
    try {
      const view = await action();
      setPassword(""); setCode("");
      onSaved(view, done);
    } catch (e) {
      setError(errorText(e, "That didn't work. Please try again."));
    } finally {
      setBusy(false);
    }
  }
  return {
    password, setPassword, code, setCode, busy, error, confirmed,
    save: (settings: Record<string, unknown>) =>
      run(() => api.savePlatformGroup(group, settings, password, needsCode ? code.trim() : undefined), "Saved. The server is using these settings now — no restart needed."),
    remove: () =>
      run(() => api.clearPlatformGroup(group, password, needsCode ? code.trim() : undefined), "Removed."),
  };
}
