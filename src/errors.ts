/** A typed, intentional error with an HTTP status attached — safe to show its message to the caller. */
export class AppError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "AppError";
  }
}

interface PgErrorLike { code?: string; message: string; constraint?: string }

const RAISE_CODE_TO_STATUS: Record<string, number> = {
  DOMAIN_NOT_ALLOWED: 422,
  INVALID_EMAIL: 422,
  IMMUTABLE_COLUMN: 400,
  FORBIDDEN_COLUMN: 403,
  FORBIDDEN_ROLE: 403,
  NOT_APPLICABLE: 409,
  INVALID_TRANSITION: 409,
  EVIDENCE_REQUIRED: 409,
  REMINDER_NOT_ALLOWED: 409,
  REMINDER_RATE_LIMIT: 429,
  TEMPLATE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  AUDIT_CLOSED: 409,
  STORAGE_PROVIDER_LOCKED: 409,
  AUDIT_ALREADY_CLOSED: 409,
  AUDIT_NOT_CLOSED: 409,
  TENANT_INACTIVE: 409,
  AUDIT_LOG_IMMUTABLE: 500,
  MFA_ALREADY_ENABLED: 409,
  MFA_NEEDS_RECOVERY_CODES: 400,
  MFA_REQUIRED_BY_POLICY: 403,
  MFA_ADMIN_NEEDS_MFA: 409,
};

const CONSTRAINT_TO_MESSAGE: Record<string, string> = {
  na_needs_justification: "A justification is required when marking a control not applicable.",
  reject_needs_reason: "A reason is required when rejecting evidence.",
  clauses_always_applicable: "Clauses 4 to 10 are mandatory and cannot be marked not applicable.",
  comments_body_check: "The comment must be between 1 and 4000 characters.",
  users_scope: "Tenant users must have a tenant-side role, and auditor-side staff must not belong to a tenant.",
  users_role_check: "That role is not valid.",
  orgs_name_check: "The organisation name must be between 1 and 200 characters.",
  orgs_mfa_policy_check: "The two-step sign-in policy must be off, staff or everyone.",
  tenants_name_check: "The tenant name must be between 1 and 200 characters.",
};

/**
 * Turns a raw Postgres error (from `pg`) into a clean AppError with an HTTP status. This is the one
 * place that understands our database's error conventions (the RAISE codes used throughout the
 * migration, Postgres's own SQLSTATEs) so every caller — HTTP routes today, a worker or CLI later —
 * gets the same, safe translation instead of leaking raw SQL text.
 */
export function mapDbError(e: unknown): AppError {
  const err = e as PgErrorLike;
  if (!err || typeof err.message !== "string") return new AppError("Unexpected error.", 500, "INTERNAL");

  // RAISE EXCEPTION 'CODE: details' (SQLSTATE P0001) — our own application-level rules.
  const raised = err.message.match(/^([A-Z_]+):\s*(.*)$/s);
  if (err.code === "P0001" && raised) {
    const [, code, detail] = raised;
    return new AppError(detail || code, RAISE_CODE_TO_STATUS[code] ?? 400, code);
  }

  switch (err.code) {
    case "42501": // insufficient_privilege — includes RLS policy violations
      return new AppError("You don't have access to do that.", 403, "FORBIDDEN");
    case "22P02": // invalid_text_representation — e.g. something that isn't an id where an id belongs
      return new AppError("That identifier is not valid.", 400, "INVALID_ID");
    case "23505": // unique_violation
      return new AppError("That value is already in use.", 409, "DUPLICATE");
    case "23503": // foreign_key_violation
      return new AppError("That reference does not exist.", 400, "INVALID_REFERENCE");
    case "23514": { // check_violation
      const msg = err.constraint ? CONSTRAINT_TO_MESSAGE[err.constraint] : undefined;
      return new AppError(msg ?? "That value is not allowed.", 400, err.constraint ?? "CHECK_VIOLATION");
    }
    default:
      return new AppError("Unexpected error.", 500, "INTERNAL");
  }
}
