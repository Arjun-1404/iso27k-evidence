import type { OrgUser } from "../api/types";

/** People of the client organisation who can be given a control: those who do the work, not read-only viewers. */
const ASSIGNABLE_ROLES = new Set(["contributor", "tenant_lead"]);
/** Someone who has been invited but hasn't signed in yet can be lined up for a control; someone switched off cannot. */
export const canBeAssigned = (u: OrgUser) => ASSIGNABLE_ROLES.has(u.role) && u.status !== "disabled";
export const personLabel = (u: { fullName: string | null; email: string }) => (u.fullName ? `${u.fullName} (${u.email})` : u.email);
