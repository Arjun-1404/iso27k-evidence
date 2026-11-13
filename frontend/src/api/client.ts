import type {
  AuditLogEntry, AuditSummary, Comment, CommentType, ControlSummary, Dashboard, EvidenceFile, FileSpec,
  ControlAssignee, OrgUser, Role, MfaStatus, MfaEnrollment, MfaPolicy, OrgMfaPolicy, PlatformSettingsView, SessionResult, SettingsGroup, StorageConnection, StorageOptions, ChoosableStorage, S3Form, Tenant, TemplateSummary, UploadSessionResponse, ApiErrorBody,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the current bearer token, or null if signed out. Called fresh on every request, so a
   *  token refreshed by the auth layer is always picked up without the client needing to know how. */
  getToken: () => Promise<string | null>;
  /** Called when the server rejects a request that carried a session token with 401 — the session has
   *  expired, or was ended on the server (the password was reset, the account disabled). The app signs
   *  the person out so they land on the sign-in page instead of a page full of errors. Not called for a
   *  request that carried no token (a wrong password at sign-in is not a "session ended"). */
  onUnauthorized?: () => void;
  /** Called when the server answers 403 MFA_SETUP_REQUIRED: the organisation requires two-step sign-in and this
   *  person hasn't set it up, so the server is refusing everything else. The app sends them to Security settings. */
  onMfaSetupRequired?: () => void;
}

/**
 * A thin, typed wrapper around fetch for the Evidence Portal API. Deliberately framework-free: nothing
 * here imports React, so this same client works from a test, a script, or a different UI layer later.
 */
export class ApiClient {
  private readonly opts: ApiClientOptions;
  constructor(opts: ApiClientOptions) {
    this.opts = opts;
  }

  /** The address of the API, e.g. to show the Google redirect address this server expects. */
  get baseUrl(): string { return this.opts.baseUrl; }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = await this.opts.getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.opts.baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && token) this.opts.onUnauthorized?.();
      if (res.status === 403 && (data as ApiErrorBody | null)?.error?.code === "MFA_SETUP_REQUIRED") this.opts.onMfaSetupRequired?.();
      const err = data as ApiErrorBody | null;
      throw new ApiError(err?.error?.message ?? `Request failed (${res.status})`, res.status, err?.error?.code ?? "UNKNOWN");
    }
    return data as T;
  }

  // ---- controls -----------------------------------------------------------------------------
  listTemplates(signal?: AbortSignal) { return this.request<TemplateSummary[]>("GET", "/templates", undefined, signal); }
  listTenantAudits(tenantId: string, signal?: AbortSignal) { return this.request<AuditSummary[]>("GET", `/tenants/${tenantId}/audits`, undefined, signal); }
  createAudit(tenantId: string, templateId: string, name: string) { return this.request<AuditSummary>("POST", `/tenants/${tenantId}/audits`, { templateId, name }); }
  /** Makes a cycle read-only. Lead auditors and organisation admins only. */
  closeAudit(auditId: string) { return this.request<AuditSummary>("POST", `/audits/${auditId}/close`); }
  /** Opens a closed cycle again; the reason is written to the audit log. */
  reopenAudit(auditId: string, reason: string) { return this.request<AuditSummary>("POST", `/audits/${auditId}/reopen`, { reason }); }
  getAudit(auditId: string, signal?: AbortSignal) { return this.request<AuditSummary>("GET", `/audits/${auditId}`, undefined, signal); }
  listControls(auditId: string, signal?: AbortSignal) { return this.request<ControlSummary[]>("GET", `/audits/${auditId}/controls`, undefined, signal); }
  getDashboard(auditId: string, signal?: AbortSignal) { return this.request<Dashboard>("GET", `/audits/${auditId}/dashboard`, undefined, signal); }
  checkIntegrity(auditId: string) { return this.request<{ evidenceFileId: string; changed: boolean }[]>("POST", `/audits/${auditId}/integrity-check`); }

  updateRequirement(controlId: string, body: { evidenceText?: string; fileSpec?: FileSpec; resetToDefault?: boolean }) {
    return this.request<{ id: string }>("PATCH", `/controls/${controlId}/requirement`, body);
  }
  setApplicability(controlId: string, applicable: boolean, naJustification?: string) {
    return this.request<{ id: string }>("PATCH", `/controls/${controlId}/applicability`, { applicable, naJustification });
  }
  setDueDate(controlId: string, dueDate: string | null) {
    return this.request<{ id: string }>("PATCH", `/controls/${controlId}/due-date`, { dueDate });
  }

  requestUploadSession(controlId: string, file: { fileName: string; mimeType: string; sizeBytes: number }) {
    return this.request<UploadSessionResponse>("POST", `/controls/${controlId}/upload-session`, file);
  }
  confirmUpload(controlId: string, providerFileId: string) {
    return this.request<{ id: string; fileName: string; scanStatus: string }>("POST", `/controls/${controlId}/uploads/confirm`, { providerFileId });
  }
  listFiles(controlId: string, signal?: AbortSignal) { return this.request<EvidenceFile[]>("GET", `/controls/${controlId}/files`, undefined, signal); }
  submitControl(controlId: string) { return this.request<{ id: string; status: string }>("POST", `/controls/${controlId}/submit`); }
  remind(controlId: string) { return this.request<{ remindedCount: number }>("POST", `/controls/${controlId}/remind`); }
  review(controlId: string, decision: "accept" | "reject", reason?: string) {
    return this.request<{ id: string; status: string }>("POST", `/controls/${controlId}/reviews`, { decision, reason });
  }
  addComment(controlId: string, type: CommentType, body: string) {
    return this.request<Comment>("POST", `/controls/${controlId}/comments`, { type, body });
  }
  listComments(controlId: string, signal?: AbortSignal) { return this.request<Comment[]>("GET", `/controls/${controlId}/comments`, undefined, signal); }
  assignControl(controlId: string, userId: string) { return this.request<{ controlId: string }>("POST", `/controls/${controlId}/assignments`, { userId }); }
  /** Who a control is assigned to. (A contributor is only told about themselves.) */
  listControlAssignees(controlId: string, signal?: AbortSignal) { return this.request<ControlAssignee[]>("GET", `/controls/${controlId}/assignments`, undefined, signal); }
  /** Assigns one person to several controls of an audit at once. `assigned` counts the ones that were not already assigned. */
  assignControlsBulk(auditId: string, userId: string, controlIds: string[]) {
    return this.request<{ assigned: number }>("POST", `/audits/${auditId}/assignments`, { userId, controlIds });
  }
  unassignControl(controlId: string, userId: string) { return this.request<{ removed: boolean }>("DELETE", `/controls/${controlId}/assignments/${userId}`); }

  // ---- tenants and org ------------------------------------------------------------------------
  listTenants(signal?: AbortSignal) { return this.request<Tenant[]>("GET", "/tenants", undefined, signal); }
  createTenant(name: string, allowedDomains: string[]) { return this.request<Tenant>("POST", "/tenants", { name, allowedDomains }); }
  archiveTenant(tenantId: string) { return this.request<Tenant>("POST", `/tenants/${tenantId}/archive`); }
  reactivateTenant(tenantId: string) { return this.request<Tenant>("POST", `/tenants/${tenantId}/reactivate`); }
  setTenantStorageRoot(tenantId: string, storageRootId: string) { return this.request<Tenant>("PATCH", `/tenants/${tenantId}/storage-root`, { storageRootId }); }
  /** Creates the tenant's evidence folder in the org's connected storage (org admin only). */
  createTenantStorageRoot(tenantId: string) { return this.request<{ id: string; storageRootId: string }>("POST", `/tenants/${tenantId}/storage-root/create`); }

  updateOrgSettings(body: { name?: string; storageProvider?: "google_drive" | "sharepoint" | "local" | "s3" }) { return this.request("PATCH", "/org", body); }
  listStorageConnections(signal?: AbortSignal) { return this.request<StorageConnection[]>("GET", "/org/storage-connections", undefined, signal); }
  /** Step 1 of "Connect Google Drive": returns the Google consent-screen URL to send the browser to. The
   *  rest happens on Google's side and the server's callback, which redirects back to the Integrations page. */
  startGoogleConnect() { return this.request<{ url: string }>("POST", "/org/storage-connections/google/start"); }
  connectStorage(body: { provider: "google_drive" | "sharepoint"; tokenRef: string; accountLabel?: string }) {
    return this.request<StorageConnection>("PUT", "/org/storage-connections", body);
  }

  // ---- where evidence is kept (org admin only) -----------------------------------------------------------
  /** What this server offers, which of it the organisation has connected, which one is in use, and whether the choice is locked. */
  getStorageOptions(signal?: AbortSignal) { return this.request<StorageOptions>("GET", "/org/storage-options", undefined, signal); }
  /** Starts keeping evidence in the folder the server owner set aside on the server's own disk. */
  connectLocalStorage() { return this.request<{ id: string; provider: "local"; folder: string }>("POST", "/org/storage-connections/local"); }
  /** Checks the entered S3 details against the real service. Saves nothing. */
  testS3Storage(form: S3Form) { return this.request<{ ok: true }>("POST", "/org/storage-connections/s3/test", form); }
  /** Checks, then saves (the secret key encrypted) and starts using the bucket. */
  connectS3Storage(form: S3Form) { return this.request<{ id: string; provider: "s3"; label: string }>("PUT", "/org/storage-connections/s3", form); }
  /** Switches to a storage that is already connected. Refused once evidence has been recorded. */
  chooseStorageProvider(provider: ChoosableStorage) { return this.request<{ provider: ChoosableStorage }>("PUT", "/org/storage-provider", { provider }); }

  /**
   * Fetches an evidence file's content with the person's session (a plain link could not carry it) and
   * returns it as a Blob for the caller to save. The server always sends it as a download, never as a page.
   */
  async downloadEvidence(fileId: string): Promise<Blob> {
    const token = await this.opts.getToken();
    const res = await fetch(`${this.opts.baseUrl}/evidence/${fileId}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      if (res.status === 401 && token) this.opts.onUnauthorized?.();
      const data = (await res.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(data?.error?.message ?? `The download failed (${res.status}).`, res.status, data?.error?.code ?? "UNKNOWN");
    }
    return res.blob();
  }

  // ---- users -----------------------------------------------------------------------------------
  listOrgUsers(signal?: AbortSignal) { return this.request<OrgUser[]>("GET", "/users", undefined, signal); }
  inviteAuditorUser(email: string, role: Role) { return this.request<OrgUser>("POST", "/users", { email, role }); }
  resendInvite(userId: string) { return this.request<{ id: string }>("POST", `/users/${userId}/resend-invite`); }

  /** Completes an invite link (sets a first password). Public — no session exists at this point, but
   *  this still goes through the shared ApiClient (unlike login; see BuiltInAuthClient's own comment
   *  for why login is different) since nothing here needs to update "the current session" — the
   *  caller is expected to send the person to sign in afterward, not be auto-authenticated by this. */
  acceptInvite(token: string, password: string) { return this.request<{ token: string; userId: string }>("POST", "/auth/accept-invite", { token, password }); }

  /** Asks for a password-reset email. The server answers the same way whether or not the address has an
   *  account (so this cannot be used to find out who does) — a resolved promise means "asked", nothing more. */
  requestPasswordReset(email: string) { return this.request<{ message: string }>("POST", "/auth/forgot-password", { email }); }
  /** Sets a new password using the secret from the emailed link. Does not sign anyone in. */
  resetPassword(token: string, password: string) { return this.request<{ ok: true }>("POST", "/auth/reset-password", { token, password }); }

  // ---- two-step sign-in (the signed-in person's own settings) --------------------------------------
  getMfaStatus(signal?: AbortSignal) { return this.request<MfaStatus>("GET", "/auth/mfa", undefined, signal); }
  /** Starts turning it on: re-checks the password and returns a new secret (pending until the first code is confirmed). */
  startMfaEnrollment(password: string) { return this.request<MfaEnrollment>("POST", "/auth/mfa/enroll", { password }); }
  /** Finishes turning it on with the first code from the authenticator app. Returns the recovery codes — shown once. */
  confirmMfaEnrollment(code: string) { return this.request<{ recoveryCodes: string[] }>("POST", "/auth/mfa/enroll/confirm", { code }); }
  /** Turning it off needs the password and a current code (or a recovery code). */
  disableMfa(password: string, code: string) { return this.request<{ ok: true }>("POST", "/auth/mfa/disable", { password, code }); }
  /** A fresh set of recovery codes; the old ones stop working. Needs the password and a current code. */
  regenerateRecoveryCodes(password: string, code: string) { return this.request<{ recoveryCodes: string[] }>("POST", "/auth/mfa/recovery-codes", { password, code }); }
  /** Organisation admins only: switches off someone else's two-step sign-in (lost phone) and signs them out everywhere. */
  resetUserMfa(userId: string) { return this.request<{ reset: boolean }>("POST", `/users/${userId}/reset-mfa`); }

  // ---- password and the organisation's two-step policy -----------------------------------------------
  /** Changes the signed-in person's own password. Needs the current password and, if two-step sign-in is on, a code.
   *  Every OTHER session of theirs is ended; the one returned replaces the current one (see AuthClient.replaceSession). */
  changePassword(currentPassword: string, newPassword: string, code?: string) {
    return this.request<SessionResult>("POST", "/auth/change-password", code ? { currentPassword, newPassword, code } : { currentPassword, newPassword });
  }
  /** Organisation admins only: the policy and how many people have set two-step sign-in up. */
  getMfaPolicy(signal?: AbortSignal) { return this.request<OrgMfaPolicy>("GET", "/org/mfa-policy", undefined, signal); }
  /** Organisation admins only: who must use two-step sign-in. Returns the new state. */
  setMfaPolicy(policy: MfaPolicy) { return this.request<OrgMfaPolicy>("PUT", "/org/mfa-policy", { policy }); }

  // ---- server settings (installation owner only) --------------------------------------------------------
  /** Whether the signed-in person is the owner of this installation (any signed-in person may ask about themselves). */
  getPlatformOwner(signal?: AbortSignal) { return this.request<{ owner: boolean }>("GET", "/platform/owner", undefined, signal); }
  getPlatformSettings(signal?: AbortSignal) { return this.request<PlatformSettingsView>("GET", "/platform/settings", undefined, signal); }
  /** Saves one group. Re-checks the password (and a two-step code if the owner uses one). Returns the new state of everything. */
  savePlatformGroup(group: SettingsGroup, settings: Record<string, unknown>, password: string, code?: string) {
    return this.request<PlatformSettingsView>("PUT", `/platform/settings/${group}`, code ? { settings, password, code } : { settings, password });
  }
  clearPlatformGroup(group: SettingsGroup, password: string, code?: string) {
    return this.request<PlatformSettingsView>("POST", `/platform/settings/${group}/clear`, code ? { password, code } : { password });
  }
  /** Sends a test message to the owner's own address through the mail server in force. */
  sendTestEmail() { return this.request<{ ok: true; sentTo: string }>("POST", "/platform/settings/email/test"); }
  /** Checks the malware scanner answers and flags the standard antivirus test file. */
  checkScanner() { return this.request<{ ok: true }>("POST", "/platform/settings/scanner/test"); }

  disableUser(userId: string) { return this.request<OrgUser>("POST", `/users/${userId}/disable`); }
  reactivateUser(userId: string) { return this.request<OrgUser>("POST", `/users/${userId}/reactivate`); }
  listTenantUsers(tenantId: string, signal?: AbortSignal) { return this.request<OrgUser[]>("GET", `/tenants/${tenantId}/users`, undefined, signal); }
  inviteTenantUser(tenantId: string, email: string, role: Role) { return this.request<OrgUser>("POST", `/tenants/${tenantId}/users`, { email, role }); }
  assignAuditor(tenantId: string, userId: string) { return this.request("PUT", `/tenants/${tenantId}/auditors/${userId}`); }
  unassignAuditor(tenantId: string, userId: string) { return this.request<{ removed: boolean }>("DELETE", `/tenants/${tenantId}/auditors/${userId}`); }

  listAuditLog(signal?: AbortSignal) { return this.request<AuditLogEntry[]>("GET", "/audit-log", undefined, signal); }
}

/**
 * Performs the browser's direct upload to storage using the session from requestUploadSession, then
 * confirms it. Kept separate from ApiClient because this step talks to the storage provider, not our
 * API — ApiClient's requestUploadSession/confirmUpload bracket it.
 */
export async function uploadFile(api: ApiClient, controlId: string, file: File): Promise<{ id: string; fileName: string; scanStatus: string }> {
  const session = await api.requestUploadSession(controlId, { fileName: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size });
  // The in-memory dev/test backend issues sessions that aren't real network destinations — nothing to
  // PUT to. A real deployment uploads the bytes to session.uploadUrl: straight to Google Drive, or, for
  // storage kept on this server's disk or in S3, to the portal itself — which answers with an address
  // relative to the API (/uploads/…), so it is resolved against the API's own address.
  if (!session.uploadUrl.startsWith("memory://")) {
    const putRes = await fetch(resolveUploadUrl(api.baseUrl, session.uploadUrl), { method: session.method, headers: session.headers, body: file });
    if (!putRes.ok) throw await uploadFailure(putRes);
  }
  return api.confirmUpload(controlId, session.providerFileId);
}

/** An address starting with "/" belongs to the portal's API; a full address (Google's) is used as it is. */
export function resolveUploadUrl(apiBaseUrl: string, uploadUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uploadUrl)) return uploadUrl;
  const base = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  // Joined by hand: new URL("/uploads/x", "https://host/api") would drop the "/api" the rest of the API lives under.
  return `${base.replace(/\/+$/, "")}/${uploadUrl.replace(/^\/+/, "")}`;
}

/** The portal says why an upload to it failed (too large, link expired, folder full...). Google's answers aren't ours to read. */
async function uploadFailure(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as ApiErrorBody | null;
  const message = data?.error?.message;
  return new ApiError(message ?? "The upload to storage failed. Please try again.", res.status, data?.error?.code ?? "STORAGE_UPLOAD_FAILED");
}
