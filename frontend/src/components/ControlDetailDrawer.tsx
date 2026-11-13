import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { StatusBadge } from "./StatusBadge";
import type { ControlSummary } from "../api/types";
import { ControlAssignment } from "./ControlAssignment";
import { ApiError } from "../api/client";
import { saveBlob } from "./saveBlob";

const SCAN_LABEL: Record<string, string> = { pending: "Scanning…", clean: "Scan: clean", infected: "Scan: infected", unscannable: "Scan: needs review", skipped: "Scan: skipped" };

export function ControlDetailDrawer({ control, canReview, readOnly = false, assignTenantId, onClose, onChanged }: {
  control: ControlSummary;
  canReview: boolean;
  /** A closed audit cycle: everything is shown, but no comment can be added and no decision made. */
  readOnly?: boolean;
  /** Set (to the client's id) for people who may assign the control to someone: it adds the "Assigned to" section. */
  assignTenantId?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const { data: files } = useApiQuery((signal) => api.listFiles(control.id, signal), [control.id]);
  const { data: comments, refetch: refetchComments } = useApiQuery((signal) => api.listComments(control.id, signal), [control.id]);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ fileId: string; text: string } | null>(null);

  async function download(fileId: string, fileName: string) {
    setDownloading(fileId);
    setDownloadError(null);
    try {
      saveBlob(await api.downloadEvidence(fileId), fileName);
    } catch (e) {
      setDownloadError({ fileId, text: e instanceof ApiError ? e.message : "The download failed. Please try again." });
    } finally {
      setDownloading(null);
    }
  }

  async function post() {
    if (!comment.trim()) return;
    setBusy(true);
    setCommentError(null);
    try {
      await api.addComment(control.id, "comment", comment.trim());
      setComment("");
      refetchComments();
    } catch (e) {
      setCommentError(e instanceof ApiError ? e.message : "The comment could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "accept" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api.review(control.id, decision, decision === "reject" ? reason.trim() : undefined);
      onChanged();
      onClose();
    } catch (e) {
      // A cycle closed while this page was open gets the server's plain explanation instead of a guess.
      if (e instanceof ApiError && e.code === "AUDIT_CLOSED") setError(e.message);
      else setError(decision === "reject" ? "A reason is required to reject." : "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const canDecide = canReview && !readOnly && (control.status === "submitted" || control.status === "under_review");

  return (
    <div className="fixed inset-0 bg-slate-900/30 z-40" onClick={onClose}>
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-lg p-6 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-base font-semibold">{control.controlRef} {control.title}</h2>
          <StatusBadge status={control.status} na={!control.applicable} />
        </div>
        <p className="text-xs text-gray-500 mb-4">{control.effectiveEvidence}</p>

        {assignTenantId && <ControlAssignment control={control} tenantId={assignTenantId} readOnly={readOnly} />}

        <h3 className="text-xs font-semibold text-gray-500 mb-2">Files in the storage folder</h3>
        <ul className="space-y-2 mb-4">
          {(files ?? []).map((f) => (
            <li key={f.id} className="rounded-lg border border-gray-200 p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium break-words">{f.fileName}</div>
                  <div className="text-xs text-gray-500">{(f.sizeBytes / 1024).toFixed(0)} KB · {SCAN_LABEL[f.scanStatus]}</div>
                </div>
                <button
                  onClick={() => void download(f.id, f.fileName)}
                  disabled={downloading !== null}
                  aria-label={`Download ${f.fileName}`}
                  className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
                >
                  {downloading === f.id ? "Downloading…" : "Download"}
                </button>
              </div>
              {f.integrityStatus === "modified" && <div className="text-xs text-red-600 font-semibold mt-1">Changed in storage since acceptance</div>}
              {downloadError?.fileId === f.id && <p role="alert" className="text-xs text-red-600 mt-1">{downloadError.text}</p>}
            </li>
          ))}
          {files && files.length === 0 && <li className="text-sm text-gray-400">No files yet.</li>}
        </ul>

        <h3 className="text-xs font-semibold text-gray-500 mb-2">Comments</h3>
        <ul className="space-y-2 mb-3">
          {(comments ?? []).map((c) => (
            <li key={c.id} className="text-sm">
              {c.type !== "comment" && <span className="mr-1 text-[10px] font-semibold uppercase text-violet-600">{c.type}</span>}
              {c.body}
            </li>
          ))}
        </ul>
        {readOnly ? (
          <p className="text-xs text-gray-400 mb-4">This audit cycle is closed, so comments can't be added.</p>
        ) : (
          <>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment"
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2"
            />
            {commentError && <p role="alert" className="text-sm text-red-600 mb-2">{commentError}</p>}
            <button onClick={post} disabled={busy || !comment.trim()} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm mb-4 disabled:opacity-50">
              Add comment
            </button>
          </>
        )}

        {canDecide && (
          <div className="border-t border-gray-200 pt-4">
            {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
            {showReject ? (
              <div>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejecting" rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2" />
                <div className="flex gap-2">
                  <button onClick={() => decide("reject")} disabled={busy || !reason.trim()} className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">Confirm reject</button>
                  <button onClick={() => setShowReject(false)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => decide("accept")} disabled={busy} className="rounded-lg bg-green-700 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Accept</button>
                <button onClick={() => setShowReject(true)} disabled={busy} className="rounded-lg border border-red-300 text-red-700 px-4 py-1.5 text-sm font-semibold">Reject</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
