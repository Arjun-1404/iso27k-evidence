import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { usePlatformOwner } from "../api/PlatformOwnerProvider";
import type { PlatformSettingsView, SettingsGroup } from "../api/types";
import { AppShell } from "../components/AppShell";
import { EmailCard } from "./serverSettings/EmailCard";
import { ScannerCard } from "./serverSettings/ScannerCard";
import { GoogleCard } from "./serverSettings/GoogleCard";

/**
 * Mail server, malware scanner and Google Drive app: set up here instead of in the server's configuration file.
 * One set for the whole installation, so only its owner sees this page (the server enforces that too).
 */
export function ServerSettingsPage() {
  const owner = usePlatformOwner();
  return (
    <AppShell>
      <div className="p-8 max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold mb-1">Server settings</h1>
          <p className="text-sm text-gray-500">
            These apply to this whole installation, for every organisation that uses it. Changes take effect immediately — no restart.
          </p>
        </header>
        {owner === null && <p className="text-sm text-gray-500">Checking…</p>}
        {owner === false && (
          <p className="text-sm text-gray-600">
            Only the owner of this installation can see or change these. That is the first administrator who was set up on the server; they can be changed by whoever runs it.
            {" "}<Link to="/dashboard" className="underline text-teal-700">Back to the dashboard</Link>
          </p>
        )}
        {owner === true && <SettingsContent />}
      </div>
    </AppShell>
  );
}

function SettingsContent() {
  const api = useApi();
  const query = useApiQuery((signal) => api.getPlatformSettings(signal), []);
  const [latest, setLatest] = useState<PlatformSettingsView | null>(null);
  const [saved, setSaved] = useState<{ group: SettingsGroup; message: string } | null>(null);
  const view = latest ?? query.data;
  const onSaved = (g: SettingsGroup) => (v: PlatformSettingsView, message: string) => { setLatest(v); setSaved({ group: g, message }); };
  const noticeFor = (g: SettingsGroup) => (saved?.group === g ? saved.message : undefined);

  if (query.error && !view) return <p role="alert" className="text-sm text-red-600">{query.error}</p>;
  if (!view) return <p className="text-sm text-gray-500">Loading settings…</p>;

  const group = (name: SettingsGroup) => view.groups.find((g) => g.group === name)!;
  // The key makes a card start from what was just saved, rather than from what it was showing before.
  const stamp = (name: SettingsGroup) => `${name}:${group(name).source}:${group(name).updatedAt ?? ""}`;

  return (
    <>
      {!view.canStoreSecrets && (
        <p role="alert" className="rounded-lg bg-amber-50 text-amber-900 text-sm px-4 py-3">
          <strong>This server has no encryption key.</strong> Passwords and secrets can't be stored here until one is set (SECRET_ENCRYPTION_KEY in the server's .env file; the setup script creates it). The scanner can still be set up.
        </p>
      )}
      <EmailCard key={stamp("email")} group={group("email")} needsCode={view.needsCode} canStoreSecrets={view.canStoreSecrets} onSaved={onSaved("email")} notice={noticeFor("email")} />
      <ScannerCard key={stamp("scanner")} group={group("scanner")} needsCode={view.needsCode} onSaved={onSaved("scanner")} notice={noticeFor("scanner")} />
      <GoogleCard key={stamp("google")} group={group("google")} needsCode={view.needsCode} canStoreSecrets={view.canStoreSecrets} onSaved={onSaved("google")} notice={noticeFor("google")} />
    </>
  );
}
