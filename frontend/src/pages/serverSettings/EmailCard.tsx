import { useState } from "react";
import { useApi } from "../../api/ApiProvider";
import type { SettingsGroupView } from "../../api/types";
import { field, primary, secondary } from "../security/styles";
import { CheckButton, ConfirmYou, Label, LockedValues, StatusPill } from "./shared";
import { cardClass, useGroupActions, type OnSaved } from "./helpers";

const LABELS = { host: "Mail server", port: "Port", security: "Encryption", user: "Username", from: "From address" };

/** The mail server that invitation, reset and reminder emails are sent through. */
export function EmailCard({ group, needsCode, canStoreSecrets, onSaved, notice }: {
  group: SettingsGroupView; needsCode: boolean; canStoreSecrets: boolean; onSaved: OnSaved, notice?: string;
}) {
  const api = useApi();
  const v = group.values;
  const [host, setHost] = useState(String(v?.host ?? ""));
  const [port, setPort] = useState(v?.port != null ? String(v.port) : "");
  const [security, setSecurity] = useState(String(v?.security ?? "starttls"));
  const [user, setUser] = useState(String(v?.user ?? ""));
  const [password, setPasswordValue] = useState("");
  const [from, setFrom] = useState(String(v?.from ?? ""));
  const a = useGroupActions("email", needsCode, (view, message) => { setPasswordValue(""); onSaved(view, message); });
  const passwordSaved = group.secretsSet.includes("password");
  const complete = host.trim() !== "" && from.trim() !== "";
  const canRemove = group.source === "panel" || (group.problem !== null && !group.locked);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    a.save({
      host: host.trim(), security, from: from.trim(),
      ...(port.trim() !== "" ? { port: port.trim() } : {}),
      ...(user.trim() !== "" ? { user: user.trim() } : {}),
      ...(password !== "" ? { password } : {}),
    });
  }

  return (
    <section aria-labelledby="email-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 id="email-heading" className="text-lg font-semibold">Email</h2>
        <StatusPill group={group} />
      </div>
      <p className="text-sm text-gray-600 mb-4">
        The mail server used to send invitations, password-reset links and reminders. Sign-in links travel in these emails, so use an encrypted connection.
      </p>
      {group.problem && <p role="alert" className="rounded-lg bg-red-50 text-red-700 text-sm px-3 py-2 mb-4">{group.problem}</p>}

      {group.locked ? <LockedValues group={group} labels={LABELS} /> : (
        <form onSubmit={submit} aria-label="Email settings" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem_10rem]">
            <div>
              <Label htmlFor="email-host">Mail server</Label>
              <input id="email-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" spellCheck={false} className={field} />
            </div>
            <div>
              <Label htmlFor="email-port">Port</Label>
              <input id="email-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder={security === "tls" ? "465" : security === "none" ? "25" : "587"} className={field} />
            </div>
            <div>
              <Label htmlFor="email-security">Encryption</Label>
              <select id="email-security" value={security} onChange={(e) => setSecurity(e.target.value)} className={field}>
                <option value="starttls">STARTTLS (usual)</option>
                <option value="tls">TLS</option>
                <option value="none">None</option>
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="email-user">Username (leave empty if the server needs no login)</Label>
              <input id="email-user" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} className={field} />
            </div>
            <div>
              <Label htmlFor="email-mail-password">Password</Label>
              <input id="email-mail-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPasswordValue(e.target.value)}
                placeholder={passwordSaved ? "Saved — leave empty to keep it" : ""} className={field} />
            </div>
          </div>
          <div>
            <Label htmlFor="email-from">From address</Label>
            <input id="email-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Evidence Portal <noreply@yourfirm.example>" spellCheck={false} className={field} />
          </div>
          {!canStoreSecrets && (
            <p role="note" className="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
              This server has no encryption key, so the mail settings can't be saved here. Add one to the server's .env file (the setup script does this) and restart.
            </p>
          )}
          <ConfirmYou idPrefix="email" needsCode={needsCode} password={a.password} setPassword={a.setPassword} code={a.code} setCode={a.setCode} />
          {a.error && <p role="alert" className="text-sm text-red-600">{a.error}</p>}
          {!a.error && notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={a.busy || !complete || !a.confirmed || !canStoreSecrets} className={primary}>{a.busy ? "Saving…" : "Save email settings"}</button>
            {canRemove && <button type="button" onClick={a.remove} disabled={a.busy || !a.confirmed} className={secondary}>Remove saved email settings</button>}
          </div>
        </form>
      )}

      {group.source !== "none" && (
        <CheckButton label="Send me a test email" busyLabel="Sending…"
          run={async () => `Sent a test message to ${(await api.sendTestEmail()).sentTo}. Check that inbox.`} />
      )}
    </section>
  );
}
