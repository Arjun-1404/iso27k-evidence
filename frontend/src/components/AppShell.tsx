import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { usePlatformOwner } from "../api/PlatformOwnerProvider";

interface NavItem { to: string; label: string; /** If set, only these roles see the link. */ roles?: string[]; /** Only the owner of this installation sees the link. */ ownerOnly?: boolean }

const AUDITOR_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/tenants", label: "Tenants" },
  { to: "/controls", label: "Controls" },
  { to: "/audit-log", label: "Audit log" },
  { to: "/users", label: "Users" },
  { to: "/settings/integrations", label: "Integrations", roles: ["org_admin"] },
  { to: "/settings/server", label: "Server settings", ownerOnly: true },
  { to: "/settings/security", label: "Security" },
];
const TENANT_NAV: NavItem[] = [
  { to: "/my-controls", label: "My controls" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/settings/security", label: "Security" },
];
const AUDITOR_ROLES = new Set(["org_admin", "lead_auditor", "auditor", "read_only", "dashboard_only"]);

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout, mfaSetupRequired } = useAuth();
  const isOwner = usePlatformOwner() === true;
  const isAuditorSide = user ? AUDITOR_ROLES.has(user.role) : true;
  // While the organisation's two-step requirement is unmet, every other page would only send the person back here.
  const nav = (isAuditorSide ? AUDITOR_NAV : TENANT_NAV)
    .filter((item) => !item.roles || (user && item.roles.includes(user.role)))
    .filter((item) => !item.ownerOnly || isOwner)
    .filter((item) => !mfaSetupRequired || item.to === "/settings/security");

  // On a phone-sized screen the menu is hidden behind a button and slides over the page; from "md" up it is the usual side panel.
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="md:flex min-h-screen bg-gray-50">
      <header className="md:hidden flex items-center justify-between bg-slate-900 text-white px-4 py-3">
        <span className="flex items-center gap-2 font-semibold">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-teal-600">✓</span>
          Evidence Portal
        </span>
        <button type="button" aria-label="Open menu" aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(true)} className="rounded-lg border border-slate-600 px-3 py-1 text-sm">
          Menu
        </button>
      </header>
      {menuOpen && <div className="fixed inset-0 z-40 bg-slate-900/50 md:hidden" onClick={closeMenu} aria-hidden="true" />}
      <aside
        id="app-sidebar"
        className={`${menuOpen ? "fixed inset-y-0 left-0 z-50 flex" : "hidden"} md:static md:z-auto md:flex w-56 shrink-0 bg-slate-900 text-white flex-col`}
      >
        <div className="flex items-center justify-between gap-2 px-5 py-5 font-semibold">
          <span className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-teal-600">✓</span>
            Evidence Portal
          </span>
          <button type="button" aria-label="Close menu" onClick={closeMenu} className="md:hidden text-slate-400 hover:text-white text-lg leading-none">×</button>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={closeMenu}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm ${isActive ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        {user && (
          <div className="px-4 py-4 border-t border-slate-800 text-sm">
            <div className="truncate">{user.name}</div>
            <div className="truncate text-slate-400 text-xs mb-2">{user.email}</div>
            <button onClick={logout} className="text-slate-400 hover:text-white text-xs">Sign out</button>
          </div>
        )}
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
