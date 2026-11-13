// Audit cycles, controls, evidence, reviews, comments and assignments (the real server's routes/controls.ts and the
// services behind it). The order of the checks in each handler follows the order the real server's database applies them,
// because that order decides which message a person sees when two things are wrong at once.

import type { Comment, FileSpec } from "../api/types";
import type { Route } from "./backend";
import { asObject, boolField, enumField, fail, FORBIDDEN, intField, textField } from "./http";
import { placeholderFile } from "./placeholder";
import { dashboardSummary, isAuditorSide, validateFile } from "./rules";
import { controlsFromTemplate } from "./seed";
import type { DemoControl, DemoFile } from "./state";

const ASSIGNERS = ["org_admin", "lead_auditor", "tenant_lead"];
const REVIEWERS = ["org_admin", "lead_auditor", "auditor"];
const COMMENTERS = ["org_admin", "lead_auditor", "auditor", "tenant_lead", "contributor"];
const UPLOADERS = ["org_admin", "lead_auditor", "tenant_lead", "contributor"];
const CYCLE_MANAGERS = ["org_admin", "lead_auditor"];
const COMMENT_TYPES = ["comment", "major", "minor", "ofi", "observation"] as const;
const FILE_CATEGORIES = ["document", "image", "spreadsheet", "any"] as const;
const UPLOAD_LINK_LIFETIME_MS = 15 * 60 * 1000;
const MAX_BULK_ASSIGN = 200;

const AUDIT_NOT_FOUND = "Audit not found or not visible to you.";

function fileSpecField(body: Record<string, unknown>): FileSpec | undefined {
  if (body.fileSpec === undefined) return undefined;
  const spec = asObject(body.fileSpec);
  const out: FileSpec = {};
  if (spec.types !== undefined) {
    if (!Array.isArray(spec.types)) fail(400, "VALIDATION", "fileSpec.types: Invalid input: expected array");
    out.types = (spec.types as unknown[]).map((t, i) => enumField({ [`${i}`]: t }, `${i}`, FILE_CATEGORIES));
  }
  if (spec.maxFiles !== undefined) out.maxFiles = intField(spec, "maxFiles", { min: 1, max: 100 });
  return out;
}

export function controlRoutes(): Route[] {
  return [
    // ---- audit cycles ------------------------------------------------------------------------------------------------
    {
      method: "GET", path: "/templates",
      handle: ({ api, user }) => ({ json: isAuditorSide(user.role) ? api.state.templates : [] }),
    },
    {
      method: "GET", path: "/tenants/:id/audits",
      handle: ({ api, user, params }) => ({
        json: api.state.audits
          .filter((a) => a.tenantId === params.id && api.canReadAudit(user, a))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          .map((a) => api.toAuditSummary(user, a)),
      }),
    },
    {
      method: "POST", path: "/tenants/:id/audits",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const templateId = textField(b, "templateId", { max: 100 });
        const name = textField(b, "name", { max: 200 });
        if (!CYCLE_MANAGERS.includes(user.role) || !api.tenantActive(user, params.id)) FORBIDDEN();
        const template = api.state.templates.find((t) => t.id === templateId);
        if (!template) fail(404, "TEMPLATE_NOT_FOUND", "That audit template does not exist.");
        const audit = { id: api.newId(), tenantId: params.id, name, status: "in_progress" as const, templateVersion: template!.version, createdAt: api.iso(), closedAt: null, closedBy: null };
        api.state.audits.push(audit);
        api.state.controls.push(...controlsFromTemplate(params.id, audit.id, api.newId));
        api.log(user, "audit.created", params.id, "audit", audit.id, { name });
        return { status: 201, json: api.toAuditSummary(user, audit) };
      },
    },
    {
      method: "GET", path: "/audits/:auditId",
      handle: ({ api, user, params }) => {
        const a = api.audit(params.auditId);
        if (!a || !api.canReadAudit(user, a)) fail(404, "NOT_FOUND", AUDIT_NOT_FOUND);
        return { json: api.toAuditSummary(user, a!) };
      },
    },
    {
      method: "POST", path: "/audits/:auditId/close",
      handle: ({ api, user, params }) => {
        const a = api.audit(params.auditId);
        if (!a || !api.canReadAudit(user, a)) fail(404, "NOT_FOUND", AUDIT_NOT_FOUND);
        if (!CYCLE_MANAGERS.includes(user.role)) fail(403, "FORBIDDEN_ROLE", "Only a lead auditor or an organisation admin can close or reopen an audit cycle.");
        if (!api.tenantActive(user, a!.tenantId)) fail(409, "TENANT_INACTIVE", "This client is archived, so its audits can't be changed. Restore the client first.");
        if (a!.status === "closed") fail(409, "AUDIT_ALREADY_CLOSED", "This audit cycle is already closed.");
        const mine = api.state.controls.filter((c) => c.auditId === a!.id && c.applicable);
        a!.status = "closed";
        a!.closedAt = api.iso();
        a!.closedBy = user.id;
        api.log(user, "audit.closed", a!.tenantId, "audit", a!.id, { name: a!.name, applicableControls: mine.length, acceptedControls: mine.filter((c) => c.status === "accepted").length });
        return { json: api.toAuditSummary(user, a!) };
      },
    },
    {
      method: "POST", path: "/audits/:auditId/reopen",
      handle: ({ api, user, params, req }) => {
        const reason = textField(asObject(req.body), "reason", { min: 0, max: 5000, optional: true }) ?? "";
        const a = api.audit(params.auditId);
        if (!a || !api.canReadAudit(user, a)) fail(404, "NOT_FOUND", AUDIT_NOT_FOUND);
        if (!CYCLE_MANAGERS.includes(user.role)) fail(403, "FORBIDDEN_ROLE", "Only a lead auditor or an organisation admin can close or reopen an audit cycle.");
        if (!api.tenantActive(user, a!.tenantId)) fail(409, "TENANT_INACTIVE", "This client is archived, so its audits can't be changed. Restore the client first.");
        if (a!.status !== "closed") fail(409, "AUDIT_NOT_CLOSED", "This audit cycle isn't closed.");
        const why = reason.trim();
        if (why.length < 3 || why.length > 1000) fail(400, "VALIDATION", "Say why you are reopening this audit cycle (3 to 1000 characters). It is written to the audit log.");
        const { closedAt, closedBy } = a!;
        a!.status = "in_progress";
        a!.closedAt = null;
        a!.closedBy = null;
        api.log(user, "audit.reopened", a!.tenantId, "audit", a!.id, { name: a!.name, reason: why, closedAt, closedBy });
        return { json: api.toAuditSummary(user, a!) };
      },
    },
    {
      method: "GET", path: "/audits/:auditId/controls",
      handle: ({ api, user, params }) => ({
        json: api.state.controls
          .filter((c) => c.auditId === params.auditId && api.canReadControl(user, c))
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((c) => api.toControlSummary(c)),
      }),
    },
    {
      // Numbers only: anyone who can see the client may read these, including dashboard-only roles.
      method: "GET", path: "/audits/:auditId/dashboard",
      handle: ({ api, user, params }) => {
        const a = api.audit(params.auditId);
        if (!a || !api.canSeeTenant(user, a.tenantId)) fail(404, "NOT_FOUND", AUDIT_NOT_FOUND);
        const rows = api.state.controls.filter((c) => c.auditId === a!.id);
        return { json: dashboardSummary(rows, api.today()) };
      },
    },
    {
      method: "GET", path: "/audit-log",
      handle: ({ api, user }) => {
        if (!CYCLE_MANAGERS.includes(user.role)) return { json: [] }; // everyone else is simply shown nothing
        return {
          json: [...api.state.log].reverse().slice(0, 200).map((e) => ({
            seq: String(e.seq), tenantId: e.tenantId, actorId: e.actorId, action: e.action, entity: e.entity, entityId: e.entityId, change: e.change, createdAt: e.createdAt,
          })),
        };
      },
    },
    {
      // Nothing in the demo's pretend storage ever changes behind its back, so there is never anything to flag.
      method: "POST", path: "/audits/:auditId/integrity-check",
      handle: ({ api, user, params }) => {
        const accepted = api.state.controls.filter((c) => c.auditId === params.auditId && c.status === "accepted" && api.canReadControl(user, c));
        const ids = new Set(accepted.map((c) => c.id));
        return { json: api.state.files.filter((f) => ids.has(f.controlId)).map((f) => ({ evidenceFileId: f.id, changed: false })) };
      },
    },

    // ---- what a control asks for -----------------------------------------------------------------------------------------
    {
      method: "PATCH", path: "/controls/:id/requirement",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const evidenceText = textField(b, "evidenceText", { max: 4000, optional: true });
        const fileSpec = fileSpecField(b);
        const reset = b.resetToDefault === undefined ? false : boolField(b, "resetToDefault");
        // As the real server does: a requirement saved without a file rule clears any earlier file rule.
        const patch: Partial<DemoControl> = reset ? { evidenceOverride: null, fileSpecOverride: null } : { evidenceOverride: evidenceText ?? null, fileSpecOverride: fileSpec ?? null };
        return { json: api.updateControl(user, params.id, patch, "control.requirement_changed", { evidence_override: patch.evidenceOverride, file_spec_override: patch.fileSpecOverride }) };
      },
    },
    {
      method: "PATCH", path: "/controls/:id/applicability",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const applicable = boolField(b, "applicable");
        const why = textField(b, "naJustification", { min: 3, max: 1000, optional: true });
        const patch: Partial<DemoControl> = { applicable, naJustification: applicable ? null : why ?? null };
        return { json: api.updateControl(user, params.id, patch, "control.applicability_changed", { applicable, na_justification: patch.naJustification }) };
      },
    },
    {
      method: "PATCH", path: "/controls/:id/due-date",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const v = b.dueDate;
        if (v !== null && (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))) fail(400, "VALIDATION", "dueDate: Invalid input");
        return { json: api.updateControl(user, params.id, { dueDate: v as string | null }, "control.due_date_changed", { due_date: v }) };
      },
    },

    // ---- evidence files ------------------------------------------------------------------------------------------------------
    {
      method: "POST", path: "/controls/:id/upload-session",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const file = { fileName: textField(b, "fileName", { max: 255 }), mimeType: textField(b, "mimeType", { max: 255 }), sizeBytes: intField(b, "sizeBytes", { min: 1 }) };
        const c = api.requireControl(user, params.id, "Control not found.");
        // Before anything is created in the storage: a closed cycle takes no more evidence.
        if (api.isClosed(c.auditId)) fail(409, "AUDIT_CLOSED", "This audit cycle is closed, so no more evidence can be added to it. A lead auditor or an organisation admin can reopen it.");
        if (!c.applicable) fail(409, "NOT_APPLICABLE", "This control is not applicable.");
        if (!api.tenant(c.tenantId)!.storageRootId) fail(409, "STORAGE_NOT_CONNECTED", "Storage is not connected for this tenant yet.");
        const existing = api.state.files.filter((f) => f.controlId === c.id).length;
        const check = validateFile(file, c.fileSpecOverride ?? c.baseFileSpec, existing);
        if (!check.ok) fail(422, "INVALID_FILE", check.reason);
        c.folderId = c.folderId ?? `demo-disk:${c.controlRef.toLowerCase()}-${c.id.slice(0, 8)}`;

        const token = `up-${api.newId()}`;
        const providerFileId = `demo-disk:${api.newId()}`;
        const expiresAt = api.now() + UPLOAD_LINK_LIFETIME_MS;
        api.pendingUploads.set(token, { controlId: c.id, userId: user.id, ...file, providerFileId, expiresAt, received: false });
        // Same shape as this server's own disk storage: the browser PUTs the file to a signed address on the portal itself.
        return { json: { uploadUrl: `/uploads/${token}`, method: "PUT", headers: {}, providerFileId, expiresAt: new Date(expiresAt).toISOString() } };
      },
    },
    {
      // The signed upload link: needs no session, only the link itself, as on the real server.
      method: "PUT", path: "/uploads/:token", open: true,
      handle: ({ api, params, req }) => {
        const p = api.pendingUploads.get(params.token);
        if (!p || p.expiresAt < api.now()) fail(403, "UPLOAD_LINK_INVALID", "This upload link has expired or isn't valid. Choose the file again.");
        const bytes = req.upload;
        if (!bytes) fail(411, "LENGTH_REQUIRED", "The upload must say how large the file is.");
        if (bytes!.size !== p!.sizeBytes) fail(400, "UPLOAD_SIZE_MISMATCH", "The file is not the size that was announced for this upload.");
        api.blobs.set(p!.providerFileId, bytes!);
        p!.received = true;
        return undefined;
      },
    },
    {
      method: "POST", path: "/controls/:id/uploads/confirm",
      handle: ({ api, user, params, req }) => {
        const providerFileId = textField(asObject(req.body), "providerFileId", { max: 1000 });
        const c = api.requireControl(user, params.id, "Control not found.");
        if (api.isClosed(c.auditId)) {
          fail(409, "AUDIT_CLOSED", "This audit cycle is closed, so no more evidence can be added to it. The file you sent has not been recorded; it is still in your storage folder. A lead auditor or an organisation admin can reopen it.");
        }
        if (!c.folderId) fail(409, "UPLOAD_NOT_STARTED", "No upload has been started for this control yet. Choose the file again.");
        // The file id comes from the browser, so it is only believed if it is one this control was given an upload link for.
        const pending = [...api.pendingUploads.entries()].find(([, p]) => p.providerFileId === providerFileId && p.controlId === c.id);
        if (!pending) fail(422, "FILE_NOT_IN_FOLDER", "That file isn't in this control's evidence folder, so it was not recorded.");
        const [token, p] = pending!;
        if (!p.received) fail(409, "UPLOAD_INCOMPLETE", "The file has not finished uploading. Choose it again.");
        if (!UPLOADERS.includes(user.role) || !api.tenantActive(user, c.tenantId)) FORBIDDEN();

        const file: DemoFile = {
          id: api.newId(), controlId: c.id, tenantId: c.tenantId, providerFileId, fileName: p.fileName, sizeBytes: p.sizeBytes, mimeType: p.mimeType,
          scanStatus: "skipped", integrityStatus: "unchecked", uploadedAt: api.iso(), uploadedBy: user.id, // the demo has no malware scanner, and says so
        };
        api.state.files.push(file);
        api.pendingUploads.delete(token);
        api.log(user, "evidence.uploaded", c.tenantId, "audit_control", c.id, { fileName: file.fileName, scanStatus: file.scanStatus });
        return { status: 201, json: { id: file.id, fileName: file.fileName, scanStatus: file.scanStatus } };
      },
    },
    {
      method: "GET", path: "/controls/:id/files",
      handle: ({ api, user, params }) => {
        const c = api.readableControl(user, params.id);
        if (!c) return { json: [] };
        return {
          json: api.state.files.filter((f) => f.controlId === c.id).sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : a.uploadedAt > b.uploadedAt ? 1 : 0))
            .map((f) => ({ id: f.id, fileName: f.fileName, sizeBytes: f.sizeBytes, scanStatus: f.scanStatus, integrityStatus: f.integrityStatus, uploadedAt: f.uploadedAt, providerFileId: f.providerFileId })),
        };
      },
    },
    {
      // Always a download of unknown type, never something the browser may display; and written to the audit log.
      method: "GET", path: "/evidence/:fileId/download",
      handle: ({ api, user, params }) => {
        const f = api.state.files.find((x) => x.id === params.fileId);
        const c = f ? api.readableControl(user, f.controlId) : undefined;
        if (!f || !c) fail(404, "NOT_FOUND", "File not found.");
        api.log(user, "evidence.downloaded", f!.tenantId, "evidence_file", f!.id, { fileName: f!.fileName });
        const blob = api.blobs.get(f!.providerFileId) ?? placeholderFile(f!.fileName, `${c!.controlRef} ${c!.title}`);
        return { blob, headers: { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } };
      },
    },

    // ---- moving a control along ---------------------------------------------------------------------------------------------------
    {
      method: "POST", path: "/controls/:id/submit",
      handle: ({ api, user, params }) => {
        const { id } = api.updateControl(user, params.id, { status: "submitted" }, "control.submitted", undefined);
        return { json: { id, status: "submitted" } };
      },
    },
    {
      method: "POST", path: "/controls/:id/remind",
      handle: ({ api, user, params }) => {
        // A marker that always differs from what is stored; the real time is stamped once the rules have passed.
        api.updateControl(user, params.id, { lastRemindedAt: "reminder requested" }, "control.reminder_sent", { last_reminded_at: api.iso() });
        const c = api.control(params.id)!;
        const assigned = api.state.assignments.filter((a) => a.controlId === c.id).map((a) => api.user(a.userId)!.email);
        // Told to whoever is assigned; if nobody is, to the client's leads. (A demo has no mail server: nothing is actually sent.)
        const recipients = new Set(assigned.length > 0 ? assigned : api.state.users.filter((u) => u.tenantId === c.tenantId && u.role === "tenant_lead").map((u) => u.email));
        return { json: { remindedCount: recipients.size } };
      },
    },
    {
      method: "POST", path: "/controls/:id/reviews",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const decision = enumField(b, "decision", ["accept", "reject"] as const);
        const reason = textField(b, "reason", { min: 3, max: 1000, optional: true });
        const c = api.requireControl(user, params.id);
        api.refuseIfClosed(c.auditId);
        if (!REVIEWERS.includes(user.role) || !api.tenantActive(user, c.tenantId)) FORBIDDEN();
        if (decision === "reject" && (reason ?? "").trim().length < 3) fail(400, "reject_needs_reason", "A reason is required when rejecting evidence.");
        const status = decision === "accept" ? "accepted" : "rejected";
        // The decision and the status change are one step: if the status can't move, no decision is recorded.
        api.updateControl(user, c.id, { status }, `control.${decision}`, { status, reason: reason ?? null });
        api.state.reviews.push({ id: api.newId(), controlId: c.id, tenantId: c.tenantId, reviewerId: user.id, decision, reason: reason ?? null, createdAt: api.iso() });
        return { status: 201, json: { id: c.id, status } };
      },
    },

    // ---- comments ------------------------------------------------------------------------------------------------------------------
    {
      method: "POST", path: "/controls/:id/comments",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const type = enumField(b, "type", COMMENT_TYPES, "comment");
        const body = textField(b, "body", { max: 4000 });
        const c = api.requireControl(user, params.id);
        api.refuseIfClosed(c.auditId);
        if (!COMMENTERS.includes(user.role) || !api.tenantActive(user, c.tenantId) || (type !== "comment" && !isAuditorSide(user.role))) FORBIDDEN();
        const row = { id: api.newId(), controlId: c.id, tenantId: c.tenantId, authorId: user.id, type, body, createdAt: api.iso() };
        api.state.comments.push(row);
        api.log(user, "control.comment", c.tenantId, "audit_control", c.id, { type });
        return { status: 201, json: { id: row.id, type, body, createdAt: row.createdAt } };
      },
    },
    {
      method: "GET", path: "/controls/:id/comments",
      handle: ({ api, user, params }): { json: Comment[] } => {
        const c = api.readableControl(user, params.id);
        if (!c) return { json: [] };
        return {
          json: api.state.comments.filter((x) => x.controlId === c.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
            .map((x) => ({ id: x.id, type: x.type, body: x.body, authorId: x.authorId, createdAt: x.createdAt })),
        };
      },
    },

    // ---- who a control is given to --------------------------------------------------------------------------------------------------
    {
      method: "POST", path: "/controls/:id/assignments",
      handle: ({ api, user, params, req }) => {
        const targetId = textField(asObject(req.body), "userId", { max: 100 });
        const c = api.requireControl(user, params.id);
        api.requireAssignable(user, targetId, c.tenantId);
        api.refuseIfClosed(c.auditId);
        if (!ASSIGNERS.includes(user.role) || !api.tenantActive(user, c.tenantId)) FORBIDDEN();
        if (!api.state.assignments.some((a) => a.controlId === c.id && a.userId === targetId)) {
          api.state.assignments.push({ controlId: c.id, userId: targetId });
          api.log(user, "control.assigned", c.tenantId, "audit_control", c.id, { userId: targetId });
        }
        return { status: 201, json: { controlId: c.id, targetUserId: targetId } };
      },
    },
    {
      method: "GET", path: "/controls/:id/assignments",
      handle: ({ api, user, params }) => {
        const c = api.requireControl(user, params.id);
        const rows = api.state.assignments.filter((a) => a.controlId === c.id && (user.role !== "contributor" || a.userId === user.id));
        return {
          json: rows.map((a) => api.user(a.userId)!).sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()))
            .map((u) => ({ userId: u.id, email: u.email, fullName: u.fullName, role: u.role })),
        };
      },
    },
    {
      method: "POST", path: "/audits/:auditId/assignments",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const targetId = textField(b, "userId", { max: 100 });
        if (!Array.isArray(b.controlIds)) fail(400, "VALIDATION", "controlIds: Invalid input: expected array");
        const ids = [...new Set(b.controlIds as unknown[])];
        if (ids.length < 1) fail(400, "VALIDATION", "controlIds: Too small: expected array to have >=1 items");
        if (ids.length > MAX_BULK_ASSIGN) fail(400, "VALIDATION", `controlIds: Too big: expected array to have <=${MAX_BULK_ASSIGN} items`);
        const found = api.state.controls.filter((c) => c.auditId === params.auditId && ids.includes(c.id) && api.canReadControl(user, c));
        if (found.length !== ids.length) fail(404, "NOT_FOUND", "Some of those controls were not found in this audit.");
        const tenantId = found[0].tenantId; // an audit belongs to one client, so they all share it
        api.requireAssignable(user, targetId, tenantId);
        api.refuseIfClosed(params.auditId);
        if (!ASSIGNERS.includes(user.role) || !api.tenantActive(user, tenantId)) FORBIDDEN();
        let assigned = 0;
        for (const c of found) {
          if (api.state.assignments.some((a) => a.controlId === c.id && a.userId === targetId)) continue;
          api.state.assignments.push({ controlId: c.id, userId: targetId });
          api.log(user, "control.assigned", c.tenantId, "audit_control", c.id, { userId: targetId });
          assigned += 1;
        }
        return { status: 201, json: { assigned } };
      },
    },
    {
      method: "DELETE", path: "/controls/:id/assignments/:userId",
      handle: ({ api, user, params }) => {
        const row = api.state.assignments.find((a) => a.controlId === params.id && a.userId === params.userId);
        const c = api.control(params.id);
        // Someone who may not remove it simply finds nothing to remove.
        if (!row || !c || !api.canSeeTenant(user, c.tenantId) || !ASSIGNERS.includes(user.role) || !api.tenantActive(user, c.tenantId)) return { json: { removed: false } };
        api.refuseIfClosed(c.auditId);
        api.state.assignments.splice(api.state.assignments.indexOf(row), 1);
        api.log(user, "control.unassigned", c.tenantId, "audit_control", c.id, { userId: params.userId });
        return { json: { removed: true } };
      },
    },
  ];
}
