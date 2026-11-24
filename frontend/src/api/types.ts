// These types describe the wire contract of the Evidence Portal API (see ../../../src/http/routes in
// the backend). Kept as plain types with no import from the backend package on purpose: the frontend
// should only ever depend on the JSON contract, never on the backend's internal module layout.

export type FileCategory = "document" | "image" | "spreadsheet" | "any";
export interface FileSpec {
  types?: FileCategory[];
  maxFiles?: number;
}

export type ControlStatus = "not_started" | "awaiting_evidence" | "submitted" | "under_review" | "accepted" | "rejected";
export type ControlKind = "clause" | "annex";

export interface ControlSummary {
  id: string;
  kind: ControlKind;
  section: string;
  controlRef: string;
  title: string;
  effectiveEvidence: string;
  effectiveFileSpec: FileSpec;
  isOverridden: boolean;
  applicable: boolean;
  naJustification: string | null;
  status: ControlStatus;
  dueDate: string | null;
  requirementChangedAt: string | null;
  fileCount: number;
}

export interface UploadSessionResponse {
  uploadUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  providerFileId: string;
  expiresAt: string;
}

export type ScanStatus = "pending" | "clean" | "infected" | "unscannable" | "skipped";
export type IntegrityStatus = "unchecked" | "verified" | "modified" | "missing";

export interface EvidenceFile {
  id: string;
  fileName: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  integrityStatus: IntegrityStatus;
  uploadedAt: string;
  providerFileId: string;
}

export type CommentType = "comment" | "major" | "minor" | "ofi" | "observation";
export interface Comment {
  id: string;
  type: CommentType;
  body: string;
  authorId?: string;
  createdAt: string;
}

export interface DashboardByStatus {
  status: ControlStatus;
  count: number;
}
export interface DashboardBySection {
  section: string;
  applicable: number;
  accepted: number;
}
export interface Dashboard {
  total: number;
  applicable: number;
  notApplicable: number;
  accepted: number;
  overdue: number;
  completionPct: number;
  byStatus: DashboardByStatus[];
  bySection: DashboardBySection[];
}

export type OrgRole = "org_admin" | "lead_auditor" | "auditor" | "read_only" | "dashboard_only";
export type TenantRole = "tenant_lead" | "contributor" | "viewer" | "tenant_dashboard";
export type Role = OrgRole | TenantRole;

export interface Tenant {
  id: string;
  name: string;
  status: "active" | "archived";
  storageRootId: string | null;
}

export interface OrgUser {
  id: string;
  email: string;
  fullName: string | null;
  role: Role;
  /** The firm's custom role this person has (a built-in role with some abilities taken away), if any. */
  customRoleId?: string | null;
  /** Its name. Only the firm's staff are told it; the client's own people see just that a restriction exists. */
  customRoleName?: string | null;
  status: "invited" | "active" | "disabled";
  /** Only present on the response to an invite: false means the invite was saved but the email did not go out. */
  emailSent?: boolean;
  /** Whether the person has two-step sign-in on. Only present when the caller is an organisation admin. */
  mfaEnabled?: boolean;
}

/** Someone a control is assigned to. */
export interface ControlAssignee {
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
}

export interface MfaStatus {
  enabled: boolean;
  /** Unused recovery codes left (0 when two-step sign-in is off). */
  recoveryRemaining: number;
  /** False when this server can't do two-step sign-in at all (no SECRET_ENCRYPTION_KEY). */
  available: boolean;
  /** True when the organisation's policy covers this person: they can't turn it off, and until it is on the
   *  rest of the portal is closed to them. */
  required: boolean;
}

/** Who the organisation requires to use two-step sign-in. */
export type MfaPolicy = "off" | "staff" | "everyone";

export interface MfaPolicyCounts { total: number; enrolled: number }

/** The organisation's two-step policy and how far along people are (numbers only). Organisation admins only. */
export interface OrgMfaPolicy {
  policy: MfaPolicy;
  /** False when this server can't do two-step sign-in at all, so the policy can't be switched on. */
  available: boolean;
  staff: MfaPolicyCounts;
  everyone: MfaPolicyCounts;
}

/** What a successful password change hands back: the one fresh session the person carries on with. */
export interface SessionResult { token: string; userId: string; role: string; tenantId?: string | null }

export interface MfaEnrollment {
  /** The authenticator secret, to type in by hand if the QR code can't be scanned. */
  secret: string;
  /** The otpauth:// address the QR code encodes. */
  otpauthUri: string;
}

/** Where an organisation can keep its evidence. SharePoint is listed by the server but not usable yet. */
export type StorageProviderName = "google_drive" | "local" | "s3" | "sharepoint";
/** The ones an administrator can choose today. */
export type ChoosableStorage = "google_drive" | "local" | "s3";

export interface StorageConnection {
  id: string;
  provider: StorageProviderName;
  accountLabel: string | null;
  status: "active" | "revoked" | "error";
}

export interface StorageOption {
  provider: StorageProviderName;
  /** Can this installation use it at all? When not, `unavailableReason` says what its owner has to do. */
  available: boolean;
  unavailableReason?: string;
  /** Has this organisation connected it? */
  connected: boolean;
  status?: string;
  /** Which account / bucket / folder it is. */
  label?: string;
}

export interface StorageOptions {
  /** The storage the organisation is using now. */
  current: StorageProviderName;
  /** True once the first evidence file has been recorded: the choice can no longer be changed. */
  locked: boolean;
  options: StorageOption[];
}

/** What an administrator enters to connect an S3-compatible service. */
export interface S3Form {
  /** Blank for Amazon S3 itself; the service's address for MinIO, Wasabi, Backblaze B2, Cloudflare R2 and the like. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** An optional folder inside the bucket. */
  prefix: string;
}

export interface AuditSummary {
  id: string;
  name: string;
  status: "in_progress" | "closed";
  templateVersion: string;
  createdAt: string;
  /** When the cycle was closed (made read-only); null while it is open. */
  closedAt: string | null;
  /** Who closed it; null while open, or when the viewer can't see staff (people on the client's side). */
  closedBy: string | null;
}

export interface TemplateSummary {
  id: string;
  framework: string;
  version: string;
  name: string;
  isPlatformDefault: boolean;
}

export interface AuditLogEntry {
  seq: string;
  tenantId: string | null;
  actorId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  change: unknown;
  createdAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---- server settings (the installation owner's page) ----------------------------------------------------------------

export type SettingsGroup = "email" | "scanner" | "google";

export interface SettingsGroupView {
  group: SettingsGroup;
  /** "environment" = set in the server's own configuration file, so it is shown here but can't be changed. */
  source: "environment" | "panel" | "none";
  locked: boolean;
  /** The non-secret values in force, or null when not set up. Secrets are never sent to the browser. */
  values: Record<string, string | number | null> | null;
  /** Which secret fields have a value stored (their values are never sent). */
  secretsSet: string[];
  updatedAt: string | null;
  updatedBy: string | null;
  /** Why saved settings are being ignored, if they are. */
  problem: string | null;
}

export interface PlatformSettingsView {
  /** False when the server has no encryption key, so a mail password or Google secret can't be stored. */
  canStoreSecrets: boolean;
  /** True when the owner uses two-step sign-in, so saving also needs a code. */
  needsCode: boolean;
  groups: SettingsGroupView[];
}

// ---- custom roles ------------------------------------------------------------------------------------------------

/** What a role can be stopped from doing. A custom role is a built-in role with some of these taken away. */
export type Permission =
  | "review" | "remind" | "applicability" | "due_dates" | "requirements"
  | "assign_controls" | "manage_people" | "comment" | "close_cycle" | "upload";
/** The built-in roles a custom role can be based on. */
export type BaseRole = "lead_auditor" | "auditor" | "tenant_lead" | "contributor";

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  baseRole: BaseRole;
  /** What is taken away from the base role. */
  denied: Permission[];
  /** How many people have this role. */
  memberCount: number;
}

export interface RoleCatalog {
  permissions: Array<{ key: Permission; label: string; hint: string }>;
  /** What each base role can do before anything is taken away. */
  baseRoles: Array<{ role: BaseRole; side: "firm" | "client"; allowed: Permission[] }>;
}

export interface RoleList { custom: CustomRole[]; catalog: RoleCatalog }

/** What the signed-in person's custom role takes away from them (the server enforces it; this lets the page hide the buttons). */
export interface Access {
  role: Role;
  customRole: { id: string; name: string } | null;
  denied: Permission[];
}
