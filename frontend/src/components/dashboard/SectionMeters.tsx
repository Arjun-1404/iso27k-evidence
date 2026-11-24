import type { DashboardBySection } from "../../api/types";
import { METER_FILL, METER_TRACK } from "./statusStyle";
import { CheckCircleIcon } from "./icons";

/** One row per section: its name, a meter of how much of it is accepted, and the figures. Bars line up down the page. */
export function SectionMeters({ sections }: { sections: DashboardBySection[] }) {
  return (
    <ul className="space-y-3 text-sm">
      {sections.map((s) => {
        const pct = s.applicable ? (100 * s.accepted) / s.applicable : 0;
        const complete = s.applicable > 0 && s.accepted >= s.applicable;
        return (
          <li key={s.section} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[14rem_minmax(0,1fr)_7rem]">
            <span className="min-w-0 truncate" title={s.section}>{s.section}</span>
            <span className="flex items-center justify-end gap-1.5 text-gray-600 sm:order-3">
              {complete && <CheckCircleIcon className="text-teal-700" />}
              <span><span className="font-semibold text-gray-900">{s.accepted}</span> of {s.applicable}</span>
            </span>
            <div
              role="meter" aria-label={`${s.section}: ${s.accepted} of ${s.applicable} accepted`} aria-valuemin={0} aria-valuemax={s.applicable} aria-valuenow={s.accepted}
              className="col-span-2 h-2 overflow-hidden rounded-full sm:order-2 sm:col-span-1" style={{ background: METER_TRACK }}
            >
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: METER_FILL }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
