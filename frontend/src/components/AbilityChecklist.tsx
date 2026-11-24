import type { BaseRole, Permission, RoleCatalog } from "../api/types";

/**
 * The abilities of a built-in role as tick boxes: ticked means the role keeps it, unticked means it is taken away. Only
 * abilities the built-in role has to begin with are listed, because nothing else could be taken away.
 */
export function AbilityChecklist({ catalog, base, kept, onChange, disabled, idPrefix }: {
  catalog: RoleCatalog;
  base: BaseRole;
  kept: Set<Permission>;
  onChange?: (kept: Set<Permission>) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const allowed = catalog.baseRoles.find((b) => b.role === base)?.allowed ?? [];
  const rows = catalog.permissions.filter((p) => allowed.includes(p.key));
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="sr-only">What this role can do</legend>
      {rows.map((p) => (
        <div key={p.key} className="flex items-start gap-2">
          <input type="checkbox" id={`${idPrefix}-${p.key}`} checked={kept.has(p.key)} disabled={disabled}
            onChange={(e) => { const next = new Set(kept); if (e.target.checked) next.add(p.key); else next.delete(p.key); onChange?.(next); }}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-teal-600" />
          <label htmlFor={`${idPrefix}-${p.key}`} className="text-sm">
            <span className={kept.has(p.key) ? "" : "text-gray-400 line-through"}>{p.label}</span>
            <span className="block text-xs text-gray-500">{p.hint}</span>
          </label>
        </div>
      ))}
    </fieldset>
  );
}

/** The set of abilities kept, from the list taken away. */
export function keptFrom(catalog: RoleCatalog, base: BaseRole, denied: Permission[]): Set<Permission> {
  const allowed = catalog.baseRoles.find((b) => b.role === base)?.allowed ?? [];
  return new Set(allowed.filter((p) => !denied.includes(p)));
}

/** The abilities taken away, from the set kept. */
export function deniedFrom(catalog: RoleCatalog, base: BaseRole, kept: Set<Permission>): Permission[] {
  const allowed = catalog.baseRoles.find((b) => b.role === base)?.allowed ?? [];
  return allowed.filter((p) => !kept.has(p));
}
