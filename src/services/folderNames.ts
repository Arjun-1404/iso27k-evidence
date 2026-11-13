/**
 * Where an audit cycle's evidence goes in the firm's storage: the client's root folder holds one folder per audit
 * cycle, and each of those holds one folder per control.
 *
 *   <client folder> / <audit name> [1a2b3c4d] / A.8.5 / the files
 *
 * The short code from the audit's id is what keeps two cycles apart even when they share a name ("Surveillance
 * audit" in two different years), so a second cycle's evidence can never land among the first one's. The name part
 * is only there so a person browsing the folders can tell them apart; characters that Google Drive, SharePoint or
 * Windows won't accept in a folder name are replaced.
 */
export function auditFolderName(auditName: string, auditId: string): string {
  const cleaned = auditName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, ""); // SharePoint and Windows refuse names that end in a dot or a space
  const code = auditId.slice(0, 8); // the first group of the id: 8 characters
  return `${cleaned || "Audit"} [${code}]`;
}
