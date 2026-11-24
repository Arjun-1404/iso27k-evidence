import type { ControlStatus } from "../api/types";
import { NA_HATCH, NA_LOOK } from "./dashboard/statusStyle";

const STYLES: Record<ControlStatus, string> = {
  not_started: "bg-gray-100 text-gray-600",
  awaiting_evidence: "bg-amber-100 text-amber-800",
  submitted: "bg-blue-100 text-blue-700",
  under_review: "bg-violet-100 text-violet-700",
  accepted: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

const LABELS: Record<ControlStatus, string> = {
  not_started: "Not started",
  awaiting_evidence: "Awaiting evidence",
  submitted: "Submitted",
  under_review: "Under review",
  accepted: "Accepted",
  rejected: "Rejected",
};

export function StatusBadge({ status, na }: { status: ControlStatus; na?: boolean }) {
  // Striped and edged in the violet used for "not applicable" on the dashboard, so it reads the same everywhere.
  if (na) return <span style={{ backgroundImage: NA_HATCH, borderColor: NA_LOOK.edge, color: NA_LOOK.ink }} className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold">N/A</span>;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  );
}
