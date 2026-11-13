// Database
export { createAppPool, withUser, withoutUser } from "./db/pool.ts";
export { migrate, ensureAppRole } from "./db/migrate.ts";
export { seedPlatformTemplate } from "./db/seed.ts";

// Cross-cutting types
export { AppError, mapDbError } from "./errors.ts";

// Storage: the interface plus every implementation. Swapping providers (Drive today, SharePoint
// later, or a fake for tests) never requires changing anything that imports from here.
export type { StorageProvider, FolderRef, UploadSession, FileMeta } from "./storage/types.ts";
export { StorageError } from "./storage/types.ts";
export { GoogleDriveProvider } from "./storage/googleDrive.ts";
export { InMemoryStorageProvider } from "./storage/inMemoryProvider.ts";
export { FakeDriveApi } from "./storage/fakeDriveApi.ts";

// Email
export type { EmailSender, EmailMessage, EmailFailureKind } from "./email/types.ts";
export { FakeEmailSender, EmailDeliveryError } from "./email/types.ts";
export { SmtpEmailSender } from "./email/smtp.ts";
export type { SmtpSettings, SmtpSecurity } from "./email/smtp.ts";
export { ConsoleEmailSender } from "./email/console.ts";

// Malware scanning
export type { Scanner, ScanResult } from "./scan/types.ts";
export { FakeScanner, NoScanner, ScannerUnavailableError } from "./scan/types.ts";
export { ClamAvScanner } from "./scan/clamav.ts";
export type { ClamAvSettings } from "./scan/clamav.ts";
export { FakeClamd } from "./scan/fakeClamd.ts";

// Auth
export type { Session, TokenVerifier } from "./auth/types.ts";
export { FakeTokenVerifier } from "./auth/types.ts";
export { JwtTokenVerifier, signSessionToken } from "./auth/jwt.ts";
export { hashPassword, verifyPassword, checkPasswordStrength } from "./auth/password.ts";
export { generateInviteToken, hashInviteToken } from "./auth/inviteToken.ts";
export * as authService from "./services/auth.ts";

// Services — the reusable business logic, independent of HTTP. A worker or CLI can import these
// directly instead of going through the Express app.
export * as controlsService from "./services/controls.ts";
export * as evidenceService from "./services/evidence.ts";
export * as reviewService from "./services/review.ts";
export * as dashboardService from "./services/dashboard.ts";
export * as auditsService from "./services/audits.ts";
export { validateFile, MAX_UPLOAD_BYTES, DEFAULT_MAX_FILES_PER_CONTROL } from "./services/fileSpec.ts";
export type { FileSpec, FileCategory } from "./services/fileSpec.ts";

// HTTP
export { createApp } from "./http/app.ts";
export type { AppDeps } from "./http/app.ts";
export { camelizeDeep, camelCaseJson } from "./http/middleware/camelCase.ts";
