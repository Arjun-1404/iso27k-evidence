import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h, parse, pid, storageFor } from "./shared.ts";
import * as controls from "../../services/controls.ts";
import * as evidence from "../../services/evidence.ts";
import { pipeline } from "node:stream/promises";
import { attachmentHeader } from "../contentDisposition.ts";
import * as review from "../../services/review.ts";
import * as dashboard from "../../services/dashboard.ts";
import * as users from "../../services/users.ts";
import * as audits from "../../services/audits.ts";

const fileSpecSchema = z.object({ types: z.array(z.enum(["document", "image", "spreadsheet", "any"])).optional(), maxFiles: z.number().int().positive().max(100).optional() });
const uploadRequestSchema = z.object({ fileName: z.string().min(1).max(255), mimeType: z.string().min(1), sizeBytes: z.number().int().positive() });
const confirmSchema = z.object({ providerFileId: z.string().min(1) });
const requirementSchema = z.object({ evidenceText: z.string().min(1).max(4000).optional(), fileSpec: fileSpecSchema.optional(), resetToDefault: z.boolean().optional() });
const applicabilitySchema = z.object({ applicable: z.boolean(), naJustification: z.string().min(3).max(1000).optional() });
const dueDateSchema = z.object({ dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() });
const reviewSchema = z.object({ decision: z.enum(["accept", "reject"]), reason: z.string().min(3).max(1000).optional() });
const commentSchema = z.object({ type: z.enum(["comment", "major", "minor", "ofi", "observation"]).default("comment"), body: z.string().min(1).max(4000) });
const assignSchema = z.object({ userId: z.string().uuid() });
const bulkAssignSchema = z.object({ userId: z.string().uuid(), controlIds: z.array(z.string().uuid()).min(1).max(users.MAX_BULK_ASSIGN) });
const newAuditSchema = z.object({ templateId: z.string().uuid(), name: z.string().min(1).max(200) });
// The database checks the length that matters (3 to 1000 once trimmed) and explains it in plain words; this only bounds the request.
const reopenSchema = z.object({ reason: z.string().max(5000).default("") });

/** The address of the web page making a request, but only if it is one of this portal's own (never a stranger's page). */
function pageOrigin(deps: AppDeps, header: string | undefined): string | undefined {
  if (!header) return undefined;
  const own = new Set<string>();
  for (const o of [deps.appBaseUrl, ...(deps.corsAllowedOrigins ?? [])]) { try { own.add(new URL(o).origin); } catch { /* ignore */ } }
  return own.has(header) ? header : undefined;
}

export function controlsRouter(deps: AppDeps): Router {
  const r = Router();

  r.get("/templates", h(async (req, res) => {
    res.json(await audits.listTemplates(deps.pool, req.userId!));
  }));

  r.get("/tenants/:id/audits", h(async (req, res) => {
    res.json(await audits.listAudits(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/tenants/:id/audits", h(async (req, res) => {
    const b = parse(newAuditSchema, req.body);
    res.status(201).json(await audits.createAudit(deps.pool, req.userId!, pid(req, "id"), b.templateId, b.name));
  }));

  r.get("/audits/:auditId", h(async (req, res) => {
    res.json(await audits.getAudit(deps.pool, req.userId!, pid(req, "auditId")));
  }));

  r.post("/audits/:auditId/close", h(async (req, res) => {
    res.json(await audits.closeAudit(deps.pool, req.userId!, pid(req, "auditId")));
  }));

  r.post("/audits/:auditId/reopen", h(async (req, res) => {
    const b = parse(reopenSchema, req.body ?? {});
    res.json(await audits.reopenAudit(deps.pool, req.userId!, pid(req, "auditId"), b.reason));
  }));

  r.get("/audits/:auditId/controls", h(async (req, res) => {
    res.json(await controls.listControls(deps.pool, req.userId!, pid(req, "auditId")));
  }));

  r.get("/audits/:auditId/dashboard", h(async (req, res) => {
    res.json(await dashboard.getDashboard(deps.pool, req.userId!, pid(req, "auditId")));
  }));

  r.get("/audit-log", h(async (req, res) => {
    res.json(await dashboard.listAuditLog(deps.pool, req.userId!));
  }));

  r.post("/audits/:auditId/integrity-check", h(async (req, res) => {
    res.json(await evidence.checkIntegrity(deps.pool, req.userId!, storageFor(deps, req.userId!), pid(req, "auditId")));
  }));

  r.patch("/controls/:id/requirement", h(async (req, res) => {
    res.json(await controls.updateRequirement(deps.pool, req.userId!, pid(req, "id"), parse(requirementSchema, req.body)));
  }));

  r.patch("/controls/:id/applicability", h(async (req, res) => {
    const b = parse(applicabilitySchema, req.body);
    res.json(await controls.setApplicability(deps.pool, req.userId!, pid(req, "id"), b.applicable, b.naJustification));
  }));

  r.patch("/controls/:id/due-date", h(async (req, res) => {
    const b = parse(dueDateSchema, req.body);
    res.json(await controls.setDueDate(deps.pool, req.userId!, pid(req, "id"), b.dueDate));
  }));

  r.post("/controls/:id/upload-session", h(async (req, res) => {
    res.json(await evidence.requestUploadSession(deps.pool, req.userId!, storageFor(deps, req.userId!), pid(req, "id"), parse(uploadRequestSchema, req.body), pageOrigin(deps, req.headers.origin)));
  }));

  r.post("/controls/:id/uploads/confirm", h(async (req, res) => {
    const b = parse(confirmSchema, req.body);
    res.status(201).json(await evidence.confirmUpload(deps.pool, req.userId!, storageFor(deps, req.userId!), deps.scanner, pid(req, "id"), b.providerFileId));
  }));

  r.get("/controls/:id/files", h(async (req, res) => {
    res.json(await evidence.listEvidenceFiles(deps.pool, req.userId!, pid(req, "id")));
  }));

  // Hands over a recorded file's content. Always sent as a download of unknown type, never as something the browser may
  // display or run: evidence is whatever people uploaded.
  r.get("/evidence/:fileId/download", h(async (req, res) => {
    const f = await evidence.openEvidenceDownload(deps.pool, req.userId!, storageFor(deps, req.userId!), pid(req, "fileId"));
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", attachmentHeader(f.fileName));
    res.setHeader("Content-Length", String(f.sizeBytes));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    try { await pipeline(f.stream, res); }
    catch { res.destroy(); } // the answer has begun: all that is left is to cut the connection so the browser sees an incomplete download
  }));

  r.post("/controls/:id/submit", h(async (req, res) => {
    res.json(await evidence.submitControl(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/controls/:id/remind", h(async (req, res) => {
    res.json(await review.remindForControl(deps.pool, req.userId!, deps.email, pid(req, "id")));
  }));

  r.post("/controls/:id/reviews", h(async (req, res) => {
    const b = parse(reviewSchema, req.body);
    res.status(201).json(await review.reviewControl(deps.pool, req.userId!, pid(req, "id"), b.decision, b.reason));
  }));

  r.post("/controls/:id/comments", h(async (req, res) => {
    const b = parse(commentSchema, req.body);
    res.status(201).json(await review.addComment(deps.pool, req.userId!, pid(req, "id"), b.type, b.body));
  }));

  r.get("/controls/:id/comments", h(async (req, res) => {
    res.json(await review.listComments(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/controls/:id/assignments", h(async (req, res) => {
    const b = parse(assignSchema, req.body);
    res.status(201).json(await users.assignControlToUser(deps.pool, req.userId!, pid(req, "id"), b.userId));
  }));

  r.get("/controls/:id/assignments", h(async (req, res) => {
    res.json(await users.listControlAssignees(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/audits/:auditId/assignments", h(async (req, res) => {
    const b = parse(bulkAssignSchema, req.body);
    res.status(201).json(await users.assignControlsToUser(deps.pool, req.userId!, pid(req, "auditId"), b.userId, b.controlIds));
  }));

  r.delete("/controls/:id/assignments/:userId", h(async (req, res) => {
    res.json(await users.unassignControlFromUser(deps.pool, req.userId!, pid(req, "id"), pid(req, "userId")));
  }));

  return r;
}
