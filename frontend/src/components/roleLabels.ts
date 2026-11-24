import type { BaseRole, Permission, Role } from "../api/types";

/** The plain names of the built-in roles, as people say them. */
export const ROLE_LABEL: Record<Role, string> = {
  org_admin: "Organisation admin",
  lead_auditor: "Lead auditor",
  auditor: "Auditor",
  read_only: "Read-only reviewer",
  dashboard_only: "Dashboard only",
  tenant_lead: "Client lead",
  contributor: "Contributor",
  viewer: "Viewer",
  tenant_dashboard: "Client dashboard",
};
export const roleLabel = (role: string): string => ROLE_LABEL[role as Role] ?? role;

/** What each built-in role is for, in a line (shown beside the choice, so nobody has to guess what "viewer" means). */
export const ROLE_HINT: Record<Role, string> = {
  org_admin: "Runs the whole organisation: sees every client, manages staff, roles and settings.",
  lead_auditor: "Runs the audits of the clients they're assigned to: applicability, due dates, requirements, people, and closing cycles.",
  auditor: "Reviews evidence and sends reminders for the clients they're assigned to.",
  read_only: "Can look at the clients they're assigned to, and change nothing.",
  dashboard_only: "Sees only the dashboard numbers of the clients they're assigned to.",
  tenant_lead: "The client's own lead: sees every control, uploads evidence, decides who does what.",
  contributor: "Uploads evidence for the controls they've been given.",
  viewer: "Can look at the client's controls, and change nothing.",
  tenant_dashboard: "Sees only the dashboard numbers.",
};

/** The roles each kind of person can be given. */
export const FIRM_ROLES: Role[] = ["org_admin", "lead_auditor", "auditor", "read_only", "dashboard_only"];
export const CLIENT_ROLES: Role[] = ["tenant_lead", "contributor", "viewer", "tenant_dashboard"];

export const isFirmBase = (b: BaseRole) => b === "lead_auditor" || b === "auditor";

/** Plain names of the abilities, for a message that has only the key. */
export const PERMISSION_LABEL: Record<Permission, string> = {
  review: "Review controls",
  remind: "Send reminders",
  applicability: "Set applicable / not applicable",
  due_dates: "Set due dates",
  requirements: "Change evidence requirements",
  assign_controls: "Assign controls",
  manage_people: "Invite and manage people",
  comment: "Comment",
  close_cycle: "Close and reopen audit cycles",
  upload: "Upload and submit evidence",
};
