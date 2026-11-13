import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { AppShell } from "../components/AppShell";

export function AuditLogPage() {
  const api = useApi();
  const { data: entries, loading, error } = useApiQuery((signal) => api.listAuditLog(signal), []);

  return (
    <AppShell>
      <div className="p-8 max-w-3xl">
        <h1 className="text-xl font-semibold mb-1">Audit log</h1>
        <p className="text-sm text-gray-500 mb-6">Every action taken in the portal, in order.</p>
        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {entries && entries.length === 0 && <p className="text-sm text-gray-500">Nothing logged yet, or you don't have access to view the log.</p>}
        <ul className="space-y-1">
          {(entries ?? []).map((e) => (
            <li key={e.seq} className="rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm flex items-center justify-between">
              <span>{e.action}{e.entityId ? ` · ${e.entityId.slice(0, 8)}` : ""}</span>
              <span className="text-xs text-gray-400">{new Date(e.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
