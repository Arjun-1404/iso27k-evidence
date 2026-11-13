import { useState } from "react";
import { useApi } from "../../api/ApiProvider";
import type { SettingsGroupView } from "../../api/types";
import { field, primary, secondary } from "../security/styles";
import { ConfirmYou, Label, LockedValues, StatusPill } from "./shared";
import { cardClass, useGroupActions, type OnSaved } from "./helpers";

const LABELS = { clientId: "Client ID", redirectUri: "Redirect address" };

/** The Google Cloud app that "Connect Google Drive" signs people in through (one app for the whole installation). */
export function GoogleCard({ group, needsCode, canStoreSecrets, onSaved, notice }: {
  group: SettingsGroupView; needsCode: boolean; canStoreSecrets: boolean; onSaved: OnSaved, notice?: string;
}) {
  const api = useApi();
  const suggested = `${api.baseUrl.replace(/\/+$/, "")}/oauth/google/callback`;
  const v = group.values;
  const [clientId, setClientId] = useState(String(v?.clientId ?? ""));
  const [secret, setSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(String(v?.redirectUri ?? ""));
  const a = useGroupActions("google", needsCode, (view, message) => { setSecret(""); onSaved(view, message); });
  const secretSaved = group.secretsSet.includes("clientSecret");
  const complete = clientId.trim() !== "" && redirectUri.trim() !== "" && (secret.trim() !== "" || secretSaved);
  const canRemove = group.source === "panel" || (group.problem !== null && !group.locked);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    a.save({ clientId: clientId.trim(), redirectUri: redirectUri.trim(), ...(secret.trim() !== "" ? { clientSecret: secret.trim() } : {}) });
  }

  return (
    <section aria-labelledby="google-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 id="google-heading" className="text-lg font-semibold">Google Drive app</h2>
        <StatusPill group={group} />
      </div>
      <p className="text-sm text-gray-600 mb-3">
        Lets each audit firm connect its own Google Drive. In Google Cloud Console, open <strong>APIs &amp; Services → Credentials</strong>, create an <strong>OAuth client ID</strong> of type
        <em> Web application</em>, add the redirect address below to it, and paste the client ID and secret here. Evidence files stay in each firm's own Drive.
      </p>
      {group.problem && <p role="alert" className="rounded-lg bg-red-50 text-red-700 text-sm px-3 py-2 mb-4">{group.problem}</p>}

      {group.locked ? <LockedValues group={group} labels={LABELS} /> : (
        <form onSubmit={submit} aria-label="Google Drive app settings" className="space-y-3">
          <div>
            <Label htmlFor="google-client-id">Client ID</Label>
            <input id="google-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789-abc.apps.googleusercontent.com" spellCheck={false} className={field} />
          </div>
          <div>
            <Label htmlFor="google-client-secret">Client secret</Label>
            <input id="google-client-secret" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder={secretSaved ? "Saved — leave empty to keep it" : ""} className={field} />
          </div>
          <div>
            <Label htmlFor="google-redirect">Redirect address</Label>
            <input id="google-redirect" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} spellCheck={false} className={field} />
            <p className="text-xs text-gray-500 mt-1">
              Must match what you added in Google Cloud Console exactly. If this portal's API is at {api.baseUrl}, that is <code className="break-all">{suggested}</code>{" "}
              {redirectUri.trim() !== suggested && <button type="button" onClick={() => setRedirectUri(suggested)} className="underline text-teal-700">Use this</button>}
            </p>
          </div>
          {!canStoreSecrets && (
            <p role="note" className="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
              This server has no encryption key, so the client secret can't be saved here. Add one to the server's .env file (the setup script does this) and restart.
            </p>
          )}
          <ConfirmYou idPrefix="google" needsCode={needsCode} password={a.password} setPassword={a.setPassword} code={a.code} setCode={a.setCode} />
          {a.error && <p role="alert" className="text-sm text-red-600">{a.error}</p>}
          {!a.error && notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={a.busy || !complete || !a.confirmed || !canStoreSecrets} className={primary}>{a.busy ? "Saving…" : "Save Google app settings"}</button>
            {canRemove && <button type="button" onClick={a.remove} disabled={a.busy || !a.confirmed} className={secondary}>Remove saved Google app settings</button>}
          </div>
        </form>
      )}
    </section>
  );
}
