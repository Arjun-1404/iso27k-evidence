import { useEffect, useState } from "react";
import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { StatusBadge } from "./StatusBadge";
import type { ControlSummary } from "../api/types";
import { ControlAssignment } from "./ControlAssignment";
import { ApiError } from "../api/client";
import { saveBlob } from "./saveBlob";
import { ApplicabilityControl } from "./ApplicabilityControl";
import { useAccess } from "../api/AccessProvider";

const SCAN_LABEL: Record<string, string> = { pending: "Scanning…", clean: "Scan: clean", infected: "Scan: infected", unscannable: "Scan: needs review", skipped: "Scan: skipped" };

export function ControlDetailDrawer({ control, canReview, canSetApplicability = false, canSetDueDate = false, readOnly = false, assignTenantId, onClose, onChanged }: {
  control: ControlSummary;
  canReview: boolean;
  /** May say whether this control applies to the client (and why not). */
  canSetApplicability?: boolean;
  /** May set or clear the control's due date. */
  canSetDueDate?: boolean;
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
  const { can } = useAccess();
  const canComment = can("comment");
  const [showClose, setShowClose] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [due, setDue] = useState(control.dueDate ?? "");
  const [dueNote, setDueNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setDue(control.dueDate ?? ""); }, [control.dueDate]);

  async function saveDue(value: string | null) {
    setBusy(true); setDueNote(null);
    try {
      await api.setDueDate(control.id, value);
      setDueNote({ ok: true, text: value ? `Due date set to ${value}.` : "Due date cleared." });
      onChanged();
    } catch (e) {
      setDueNote({ ok: false, text: e instanceof ApiError ? e.message : "The due date could not be saved. Please try again." });
    } finally { setBusy(false); }
  }

  async function closeWithoutEvidence() {
    setBusy(true); setError(null);
    try {
      await api.review(control.id, "close", closeReason.trim());
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not close this control. Please try again.");
    } finally { setBusy(false); }
  }

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
  // The firm can close a control the client never submitted evidence for (not started, waiting, rejected, or put back under
  // review with no file): for something seen on site, or something that needs nothing from the client.
  const canClose = canReview && !readOnly && control.applicable
    && (control.status === "not_started" || control.status === "awaiting_evidence" || control.status === "rejected" || (control.status === "under_review" && control.fileCount === 0));
  const closedByFirm = control.applicable && control.status === "accepted" && control.fileCount === 0;

  return (
    <div className="fixed inset-0 bg-slate-900/30 z-40" onClick={onClose}>
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-lg p-6 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-base font-semibold">{control.controlRef} {control.title}</h2>
          <StatusBadge status={control.status} na={!control.applicable} />
        </div>
        <p className="text-xs text-gray-500 mb-4">{control.effectiveEvidence}</p>
        {closedByFirm && <p className="text-xs text-teal-800 mb-4">Closed by the audit firm without evidence from the client. The reason is in the comments.</p>}

        {(canSetApplicability || !control.applicable) && control.kind === "annex" && (
          <section aria-label="Applicability" className="mb-4">
            <h3 className="text-xs font-semibold text-gray-500 mb-1">Applies to this client</h3>
            <ApplicabilityControl control={control} editable={canSetApplicability && !readOnly} onChanged={onChanged} />
            {!control.applicable && !canSetApplicability && !control.naJustification && <p className="text-xs text-gray-500">Marked not applicable.</p>}
          </section>
        )}

        {control.applicable && (canSetDueDate && !readOnly ? (
          <section aria-label="Due date" className="mb-4">
            <label htmlFor={`due-${control.id}`} className="block text-xs font-semibold text-gray-500 mb-1">Due date</label>
            <div className="flex flex-wrap items-center gap-2">
              <input id={`due-${control.id}`} type="date" value={due} onChange={(e) => { setDue(e.target.value); setDueNote(null); }} className="rounded-lg border border-gray-300 px-2 py-1 text-sm" />
              <button type="button" onClick={() => void saveDue(due || null)} disabled={busy || due === (control.dueDate ?? "")} className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-semibold disabled:opacity-50">Save</button>
              {control.dueDate && <button type="button" onClick={() => void saveDue(null)} disabled={busy} className="text-xs text-gray-500">Clear</button>}
            </div>
            {dueNote && <p role={dueNote.ok ? "status" : "alert"} className={`text-xs mt-1 ${dueNote.ok ? "text-green-700" : "text-red-600"}`}>{dueNote.text}</p>}
          </section>
        ) : control.dueDate ? (
          <p className="text-xs text-amber-700 mb-4">Due {control.dueDate}</p>
        ) : null)}

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
        ) : !canComment ? (
          <p className="text-xs text-gray-400 mb-4">Your role doesn't include adding comments.</p>
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

        {canClose && (
          <section aria-label="Close without client evidence" className="border-t border-gray-200 pt-4 mt-4">
            {error && !canDecide && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
            {showClose ? (
              <div>
                <p className="text-xs text-gray-500 mb-2">
                  This accepts the control without any file from the client, for example because you saw it on site or it needs nothing from them. Your reason is kept and shown to the client in the comments.
                </p>
                <label htmlFor={`close-${control.id}`} className="sr-only">Reason for closing</label>
                <textarea id={`close-${control.id}`} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="Reason for closing" rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void closeWithoutEvidence()} disabled={busy || closeReason.trim().length < 3} className="rounded-lg bg-teal-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">Confirm close</button>
                  <button type="button" onClick={() => { setShowClose(false); setCloseReason(""); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <button type="button" onClick={() => setShowClose(true)} className="rounded-lg border border-teal-600 text-teal-800 px-4 py-1.5 text-sm font-semibold">Close without client evidence</button>
                <p className="text-xs text-gray-400 mt-1">For controls the client doesn't need to upload evidence for.</p>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
