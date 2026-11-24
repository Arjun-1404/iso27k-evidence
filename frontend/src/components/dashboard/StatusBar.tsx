import type { DashboardByStatus } from "../../api/types";
import { NA_HATCH, NA_LOOK, STATUS_LABEL, STATUS_LOOK, STATUS_ORDER } from "./statusStyle";

/**
 * Where the applicable controls stand: one thin bar split into the six states, and under it the same figures as a list (the
 * list is also the table form of the bar, so nothing is readable only from colour). Segments are separated by a 2px gap of
 * page colour, a state with none draws nothing, and the bar's own name lists every part with its count and share.
 */
export function StatusBar({ byStatus, notApplicable = 0 }: { byStatus: DashboardByStatus[]; /** Controls marked not applicable: not part of the bar (it is about the applicable ones), but listed under it. */ notApplicable?: number }) {
  const counts = new Map(byStatus.map((s) => [s.status, s.count]));
  const rows = STATUS_ORDER.map((status) => ({ status, count: counts.get(status) ?? 0 }));
  // A status the server sends that this screen does not know is still counted, after the known ones.
  for (const s of byStatus) if (!STATUS_ORDER.includes(s.status)) rows.push({ status: s.status, count: s.count });
  const total = rows.reduce((n, r) => n + r.count, 0);
  const share = (n: number) => (total > 0 ? Math.round((100 * n) / total) : 0);
  const label = (s: string) => STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s;

  return (
    <div>
      <div
        role="img"
        aria-label={total === 0 ? "No applicable controls yet" : `Status of ${total} applicable controls: ${rows.filter((r) => r.count > 0).map((r) => `${label(r.status)} ${r.count} (${share(r.count)}%)`).join(", ")}`}
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
      >
        {rows.filter((r) => r.count > 0).map((r) => (
          <div key={r.status} style={{ flexGrow: r.count, flexBasis: 0, background: (STATUS_LOOK[r.status as keyof typeof STATUS_LOOK] ?? STATUS_LOOK.not_started).fill }} />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.status} className={`flex items-center gap-2 ${r.count === 0 ? "text-gray-400" : ""}`}>
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: (STATUS_LOOK[r.status as keyof typeof STATUS_LOOK] ?? STATUS_LOOK.not_started).fill }} />
            <span className="flex-1">{label(r.status)}</span>
            <span className="font-semibold">{r.count}</span>
            <span className="w-10 text-right text-xs text-gray-500">{r.count > 0 ? `${share(r.count)}%` : ""}</span>
          </li>
        ))}
      </ul>
      {notApplicable > 0 && (
        <p className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 text-sm">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundImage: NA_HATCH, border: `1px solid ${NA_LOOK.edge}` }} />
          <span className="flex-1">Not applicable <span className="text-xs text-gray-500">(not counted above)</span></span>
          <span className="font-semibold">{notApplicable}</span>
        </p>
      )}
    </div>
  );
}
