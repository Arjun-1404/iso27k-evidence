import type { ReactNode } from "react";
import type { Dashboard } from "../../api/types";
import { CheckCircleIcon, ClockIcon, InboxIcon, UploadIcon, XCircleIcon } from "./icons";

interface Item { key: string; icon: ReactNode; count: number; text: string; clear: string; tone: string }

const countOf = (d: Dashboard, ...statuses: string[]) => d.byStatus.filter((s) => statuses.includes(s.status)).reduce((n, s) => n + s.count, 0);

/**
 * What a person looking at this dashboard would act on first. The audit firm's side sees what is waiting for them to review;
 * the client's side sees what still needs evidence. Each line has an icon and words, so it never relies on colour, and a line
 * with nothing in it says so in a calm tone instead of vanishing.
 */
export function NeedsAttention({ dashboard, auditorSide }: { dashboard: Dashboard; auditorSide: boolean }) {
  const overdue = dashboard.overdue;
  const rejected = countOf(dashboard, "rejected");
  const items: Item[] = [
    {
      key: "overdue", icon: <ClockIcon />, count: overdue, tone: "text-red-700",
      text: `${overdue} overdue`, clear: "Nothing is overdue",
    },
    {
      key: "rejected", icon: <XCircleIcon />, count: rejected, tone: "text-red-700",
      text: auditorSide ? `${rejected} rejected, back with the client` : `${rejected} rejected, needs a new upload`, clear: "Nothing has been rejected",
    },
    auditorSide
      ? { key: "review", icon: <InboxIcon />, count: countOf(dashboard, "submitted", "under_review"), tone: "text-teal-800", text: `${countOf(dashboard, "submitted", "under_review")} waiting for review`, clear: "Nothing is waiting for review" }
      : { key: "evidence", icon: <UploadIcon />, count: countOf(dashboard, "awaiting_evidence"), tone: "text-teal-800", text: `${countOf(dashboard, "awaiting_evidence")} still need evidence`, clear: "No evidence is outstanding" },
  ];
  const allClear = items.every((i) => i.count === 0);

  return (
    <ul className="space-y-3 text-sm">
      {items.map((i) => (
        <li key={i.key} className={`flex items-center gap-2.5 ${i.count > 0 ? `${i.tone} font-semibold` : "text-gray-500"}`}>
          {i.count > 0 ? i.icon : <CheckCircleIcon className="text-teal-700" />}
          <span>{i.count > 0 ? i.text : i.clear}</span>
        </li>
      ))}
      {allClear && <li className="pt-1 text-xs text-gray-500">All clear for now.</li>}
    </ul>
  );
}
