import { describe, it, expect } from "vitest";
import { camelizeDeep } from "../src/http/middleware/camelCase.ts";

describe("camelizeDeep", () => {
  it("converts snake_case keys to camelCase, recursively, including inside arrays", () => {
    const input = { full_name: "Sam", scan_status: "clean", nested: { account_label: "x", items: [{ due_date: "2026-01-01" }] } };
    expect(camelizeDeep(input)).toEqual({ fullName: "Sam", scanStatus: "clean", nested: { accountLabel: "x", items: [{ dueDate: "2026-01-01" }] } });
  });

  it("leaves already-camelCase keys, null, and primitives alone", () => {
    expect(camelizeDeep({ id: "1", isOverridden: true, note: null })).toEqual({ id: "1", isOverridden: true, note: null });
    expect(camelizeDeep(null)).toBeNull();
    expect(camelizeDeep(42)).toBe(42);
    expect(camelizeDeep("plain string")).toBe("plain string");
  });

  it("does not reach into Date objects or mangle them", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(camelizeDeep({ created_at: d })).toEqual({ createdAt: d });
    expect((camelizeDeep({ created_at: d }) as { createdAt: Date }).createdAt).toBeInstanceOf(Date);
  });

  it("handles a bare array at the top level", () => {
    expect(camelizeDeep([{ is_overridden: false }, { is_overridden: true }])).toEqual([{ isOverridden: false }, { isOverridden: true }]);
  });
});
