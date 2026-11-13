import { describe, it, expect, vi, afterEach } from "vitest";
import { saveBlob } from "./saveBlob";

describe("saveBlob", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete (URL as unknown as Record<string, unknown>).createObjectURL; delete (URL as unknown as Record<string, unknown>).revokeObjectURL; });

  it("clicks a hidden link carrying the file's name, removes it again, and releases the object address later", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:http://portal.test/abc");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const blob = new Blob(["abc"]);
    saveBlob(blob, "Q3 access review (final).pdf");

    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    const clicked = click.mock.contexts[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("Q3 access review (final).pdf");
    expect(clicked.getAttribute("href")).toBe("blob:http://portal.test/abc");
    expect(document.body.contains(clicked)).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith("blob:http://portal.test/abc");
  });
});
