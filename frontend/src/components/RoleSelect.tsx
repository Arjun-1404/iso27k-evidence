import type { CustomRole, OrgUser, Permission, Role } from "../api/types";
import { PERMISSION_LABEL, ROLE_HINT, roleLabel } from "./roleLabels";

/** A choice is "role:<built-in role>" or "custom:<custom role id>". */
export const builtInValue = (role: Role) => `role:${role}`;
export const customValue = (id: string) => `custom:${id}`;
export const valueOfUser = (u: Pick<OrgUser, "role" | "customRoleId">) => (u.customRoleId ? customValue(u.customRoleId) : builtInValue(u.role));

export function parseRoleValue(v: string): { role?: Role; customRoleId?: string } {
  if (v.startsWith("custom:")) return { customRoleId: v.slice("custom:".length) };
  return { role: v.slice("role:".length) as Role };
}

/** What a person with this choice can't do, in words. */
export function describeChoice(value: string, custom: CustomRole[]): string {
  const { role, customRoleId } = parseRoleValue(value);
  if (customRoleId) {
    const c = custom.find((r) => r.id === customRoleId);
    if (!c) return "";
    const no = c.denied.map((p: Permission) => PERMISSION_LABEL[p].toLowerCase());
    return `Like a ${roleLabel(c.baseRole).toLowerCase()}${no.length ? `, but can't: ${no.join(", ")}` : ", with nothing taken away"}.`;
  }
  return role ? ROLE_HINT[role] : "";
}

/**
 * A role choice with the built-in roles and, below them, the firm's custom roles. Choosing a custom role means "this
 * built-in role, with these abilities taken away"; the line under the choice says which.
 */
export function RoleSelect({ label, value, onChange, builtIn, custom, disabled, id }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  builtIn: Role[];
  custom: CustomRole[];
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="min-w-0">
      <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm max-w-full">
        <optgroup label="Built-in roles">
          {builtIn.map((r) => <option key={r} value={builtInValue(r)}>{roleLabel(r)}</option>)}
        </optgroup>
        {custom.length > 0 && (
          <optgroup label="Custom roles">
            {custom.map((c) => <option key={c.id} value={customValue(c.id)}>{c.name} ({roleLabel(c.baseRole).toLowerCase()})</option>)}
          </optgroup>
        )}
      </select>
      <p className="text-xs text-gray-500 mt-1">{describeChoice(value, custom)}</p>
    </div>
  );
}
