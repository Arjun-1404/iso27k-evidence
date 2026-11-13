import { useState } from "react";
import { useApi } from "../../api/ApiProvider";
import type { SettingsGroupView } from "../../api/types";
import { field, primary, secondary } from "../security/styles";
import { CheckButton, ConfirmYou, Label, LockedValues, StatusPill } from "./shared";
import { cardClass, useGroupActions, type OnSaved } from "./helpers";

const LABELS = { host: "Scanner host", port: "Port", timeoutSeconds: "Time limit (seconds)", maxFileMb: "Largest file (MB)" };

/** The ClamAV virus scanner that every uploaded file is checked by. */
export function ScannerCard({ group, needsCode, onSaved, notice }: { group: SettingsGroupView; needsCode: boolean; onSaved: OnSaved, notice?: string }) {
  const api = useApi();
  const v = group.values;
  const [host, setHost] = useState(String(v?.host ?? ""));
  const [port, setPort] = useState(v?.port != null ? String(v.port) : "");
  const [timeout, setTimeoutValue] = useState(v?.timeoutSeconds != null ? String(v.timeoutSeconds) : "");
  const [maxMb, setMaxMb] = useState(v?.maxFileMb != null ? String(v.maxFileMb) : "");
  const a = useGroupActions("scanner", needsCode, onSaved);
  const canRemove = group.source === "panel" || (group.problem !== null && !group.locked);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    a.save({
      host: host.trim(),
      ...(port.trim() !== "" ? { port: port.trim() } : {}),
      ...(timeout.trim() !== "" ? { timeoutSeconds: timeout.trim() } : {}),
      ...(maxMb.trim() !== "" ? { maxFileMb: maxMb.trim() } : {}),
    });
  }

  return (
    <section aria-labelledby="scanner-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 id="scanner-heading" className="text-lg font-semibold">Malware scanning</h2>
        <StatusPill group={group} />
      </div>
      <p className="text-sm text-gray-600 mb-4">
        Uploaded evidence is checked by a ClamAV scanner. Without one, files are recorded as <em>skipped</em> (never as clean), and reviewers are told they weren't checked.
      </p>
      {group.problem && <p role="alert" className="rounded-lg bg-red-50 text-red-700 text-sm px-3 py-2 mb-4">{group.problem}</p>}

      {group.locked ? <LockedValues group={group} labels={LABELS} /> : (
        <form onSubmit={submit} aria-label="Scanner settings" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <div>
              <Label htmlFor="scanner-host">Scanner host</Label>
              <input id="scanner-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="clamav" spellCheck={false} className={field} />
            </div>
            <div>
              <Label htmlFor="scanner-port">Port</Label>
              <input id="scanner-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3310" className={field} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="scanner-timeout">Time limit per file (seconds)</Label>
              <input id="scanner-timeout" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} placeholder="60" className={field} />
            </div>
            <div>
              <Label htmlFor="scanner-max">Largest file to scan (MB)</Label>
              <input id="scanner-max" inputMode="numeric" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} placeholder="25" className={field} />
            </div>
          </div>
          <ConfirmYou idPrefix="scanner" needsCode={needsCode} password={a.password} setPassword={a.setPassword} code={a.code} setCode={a.setCode} />
          {a.error && <p role="alert" className="text-sm text-red-600">{a.error}</p>}
          {!a.error && notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={a.busy || host.trim() === "" || !a.confirmed} className={primary}>{a.busy ? "Saving…" : "Save scanner settings"}</button>
            {canRemove && <button type="button" onClick={a.remove} disabled={a.busy || !a.confirmed} className={secondary}>Remove saved scanner settings</button>}
          </div>
        </form>
      )}

      {group.source !== "none" && (
        <CheckButton label="Check the scanner" busyLabel="Checking…"
          run={async () => { await api.checkScanner(); return "The scanner answered and caught the standard antivirus test file. It is working."; }} />
      )}
    </section>
  );
}
