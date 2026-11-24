import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ControlStatus, ControlSummary } from "../../api/types";
import { NA_HATCH, NA_LOOK, STATUS_LABEL, STATUS_LOOK, STATUS_ORDER } from "./statusStyle";

/** What the legend can narrow the grid to: one status, or the controls marked not applicable. */
type Focus = ControlStatus | "na" | null;

const NA_LABEL = "Not applicable";

interface Group { section: string; controls: ControlSummary[] }

function groupBySection(controls: ControlSummary[]): Group[] {
  const groups: Group[] = [];
  const byName = new Map<string, Group>();
  for (const c of controls) {
    let g = byName.get(c.section);
    if (!g) { g = { section: c.section, controls: [] }; byName.set(c.section, g); groups.push(g); }
    g.controls.push(c);
  }
  return groups;
}

const keyOf = (c: ControlSummary): ControlStatus | "na" => (c.applicable ? c.status : "na");

function describe(c: ControlSummary): string {
  const bits = [c.controlRef, c.title, c.applicable ? STATUS_LABEL[c.status] : NA_LABEL];
  if (c.applicable) bits.push(c.fileCount === 1 ? "1 file" : `${c.fileCount} files`);
  if (c.applicable && c.dueDate) bits.push(`due ${c.dueDate}`);
  return bits.join(" · ");
}

function Tile({ control, dim, href, onActive }: { control: ControlSummary; dim: boolean; href: string | null; onActive: (c: ControlSummary | null) => void }) {
  const na = !control.applicable;
  const look = STATUS_LOOK[control.status];
  const base = "inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded px-1.5 text-[11px] font-semibold leading-none transition-opacity";
  const style = na ? { backgroundImage: NA_HATCH, borderColor: NA_LOOK.edge, color: NA_LOOK.ink } : { background: look.fill, color: look.ink };
  const skin = na ? "border" : "";
  const cls = `${base} ${skin} ${dim ? "opacity-20" : ""}`;
  const label = describe(control);
  const text = na ? `⊘ ${control.controlRef}` : control.status === "rejected" ? `✕ ${control.controlRef}` : control.controlRef;
  const common = { "data-status": na ? "na" : control.status, style, className: cls, onMouseEnter: () => onActive(control), onMouseLeave: () => onActive(null) };
  if (!href) return <span {...common} role="img" aria-label={label}>{text}</span>;
  return (
    <Link {...common} to={href} aria-label={label} onFocus={() => onActive(control)} onBlur={() => onActive(null)}
      className={`${cls} hover:ring-2 hover:ring-gray-900/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-900`}>
      {text}
    </Link>
  );
}

/**
 * Every control as a small tile, grouped by clause or Annex A theme and filled by status: the audit at a glance. The legend
 * narrows the grid to one status; hovering or focusing a tile names the control underneath; a tile opens the control; and
 * "View as table" gives the same counts as plain rows, so nothing depends on colour or on a pointer.
 */
export function ControlHeatmap({ controls, hrefFor, visibleOfTotal }: {
  controls: ControlSummary[];
  /** Where a tile goes when pressed, or null for a tile that opens nothing for this person. */
  hrefFor: (c: ControlSummary) => string | null;
  /** When this person can see fewer controls than the audit has (a contributor sees only theirs), the total. */
  visibleOfTotal?: number;
}) {
  const [focus, setFocus] = useState<Focus>(null);
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<ControlSummary | null>(null);
  const groups = useMemo(() => groupBySection(controls), [controls]);
  const counts = useMemo(() => {
    const m = new Map<Focus, number>();
    for (const c of controls) m.set(keyOf(c), (m.get(keyOf(c)) ?? 0) + 1);
    return m;
  }, [controls]);

  if (controls.length === 0) return null;
  const legend: { key: Exclude<Focus, null>; label: string; swatch: string; hollow?: boolean }[] = [
    ...STATUS_ORDER.map((s) => ({ key: s, label: STATUS_LABEL[s], swatch: STATUS_LOOK[s].fill })),
    { key: "na", label: NA_LABEL, swatch: NA_HATCH, hollow: true },
  ];

  return (
    <section aria-label="Controls at a glance" className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Controls at a glance</h2>
        <button type="button" onClick={() => setTable((t) => !t)} aria-pressed={table} className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold hover:bg-gray-50">
          {table ? "View as tiles" : "View as table"}
        </button>
      </div>

      <ul className="mb-4 flex flex-wrap gap-x-1 gap-y-1" aria-label="Filter by status">
        {legend.filter((l) => (counts.get(l.key) ?? 0) > 0).map((l) => (
          <li key={l.key}>
            <button
              type="button" aria-pressed={focus === l.key} onClick={() => setFocus(focus === l.key ? null : l.key)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-gray-100 ${focus === l.key ? "bg-gray-100 font-semibold" : ""}`}
            >
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px]" style={l.hollow ? { backgroundImage: l.swatch, border: `1px solid ${NA_LOOK.edge}` } : { background: l.swatch }} />
              {l.label} <span className="text-gray-500">{counts.get(l.key)}</span>
            </button>
          </li>
        ))}
      </ul>

      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Controls by section and status</caption>
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th scope="col" className="py-1.5 pr-3 font-semibold">Section</th>
                {legend.map((l) => <th key={l.key} scope="col" className="px-2 py-1.5 text-right font-semibold">{l.label}</th>)}
                <th scope="col" className="pl-2 py-1.5 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.section} className="border-b border-gray-100">
                  <th scope="row" className="py-1.5 pr-3 font-normal">{g.section}</th>
                  {legend.map((l) => {
                    const n = g.controls.filter((c) => keyOf(c) === l.key).length;
                    return <td key={l.key} className={`px-2 py-1.5 text-right ${n === 0 ? "text-gray-300" : ""}`}>{n}</td>;
                  })}
                  <td className="pl-2 py-1.5 text-right font-semibold">{g.controls.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const accepted = g.controls.filter((c) => c.applicable && c.status === "accepted").length;
            const applicable = g.controls.filter((c) => c.applicable).length;
            return (
              <div key={g.section}>
                <h3 className="mb-1.5 flex items-baseline justify-between gap-3 text-xs font-semibold text-gray-700">
                  <span className="truncate">{g.section}</span>
                  <span className="shrink-0 font-normal text-gray-500">{accepted} of {applicable} accepted</span>
                </h3>
                <div className="flex flex-wrap gap-0.5">
                  {g.controls.map((c) => <Tile key={c.id} control={c} dim={focus !== null && keyOf(c) !== focus} href={hrefFor(c)} onActive={setActive} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!table && (
        <p aria-live="polite" className="mt-4 min-h-[1.25rem] text-xs text-gray-600">
          {active ? describe(active) : "Hover or focus a tile to see which control it is. Press it to open it."}
        </p>
      )}
      {visibleOfTotal !== undefined && controls.length < visibleOfTotal && (
        <p className="mt-2 text-xs text-gray-500">{controls.length === 1 ? "Showing the 1 control you can see." : `Showing the ${controls.length} controls you can see.`}</p>
      )}
    </section>
  );
}
