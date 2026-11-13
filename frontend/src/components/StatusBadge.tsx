import type { ControlStatus } from "../api/types";

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
  if (na) return <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-gray-100 text-gray-500">N/A</span>;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  );
}
