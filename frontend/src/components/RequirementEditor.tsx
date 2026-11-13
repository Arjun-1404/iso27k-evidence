import { useState } from "react";
import type { ControlSummary, FileCategory } from "../api/types";

const CATEGORIES: FileCategory[] = ["document", "image", "spreadsheet", "any"];

export function RequirementEditor({
  control, onClose, onSave, onResetToDefault,
}: {
  control: ControlSummary;
  onClose: () => void;
  onSave: (text: string, category: FileCategory, maxFiles: number) => Promise<void>;
  onResetToDefault: () => Promise<void>;
}) {
  const [text, setText] = useState(control.effectiveEvidence);
  const [category, setCategory] = useState<FileCategory>(control.effectiveFileSpec.types?.[0] ?? "any");
  const [maxFiles, setMaxFiles] = useState(control.effectiveFileSpec.maxFiles ?? 4);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(text, category, maxFiles);
      onClose();
    } catch {
      setError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" role="dialog" aria-label={`Evidence required · ${control.controlRef}`}>
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold mb-1">Evidence required · {control.controlRef} {control.title}</h2>
        <p className="text-xs text-gray-500 mb-4">Changes apply to this tenant only. The default text stays available for others.</p>
        <label htmlFor="evidence-text" className="block text-xs font-semibold text-gray-500 mb-1">What the tenant should provide</label>
        <textarea
          id="evidence-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-4 focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none"
        />
        <div className="flex gap-4 mb-4">
          <div>
            <label htmlFor="file-category" className="block text-xs font-semibold text-gray-500 mb-1">Expected files</label>
            <select id="file-category" value={category} onChange={(e) => setCategory(e.target.value as FileCategory)} className="rounded-lg border border-gray-300 text-sm px-2 py-1.5">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="max-files" className="block text-xs font-semibold text-gray-500 mb-1">Max files</label>
            <input
              id="max-files"
              type="number"
              min={1}
              max={100}
              value={maxFiles}
              onChange={(e) => setMaxFiles(Number(e.target.value))}
              className="w-20 rounded-lg border border-gray-300 text-sm px-2 py-1.5"
            />
          </div>
        </div>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex items-center justify-between">
          <button onClick={onResetToDefault} className="text-sm text-gray-500 hover:text-gray-800">Reset to default</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">Cancel</button>
            <button onClick={save} disabled={saving || !text.trim()} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
