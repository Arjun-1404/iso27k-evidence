import { describe, it, expect } from "vitest";
import { describeConnectError } from "./integrationMessages";

describe("describeConnectError", () => {
  it("explains each code the server can send, in plain language", () => {
    for (const code of ["access_denied", "invalid_or_expired_state", "not_configured", "OAUTH_NOT_CONFIGURED", "missing_code_or_state", "invalid_request", "OAUTH_PROVIDER_UNAVAILABLE", "OAUTH_INVALID_REQUEST"]) {
      const text = describeConnectError(code);
      expect(text, code).toMatch(/Google/);
      expect(text, code).not.toContain(code); // a person shouldn't have to read a machine code
      expect(text.endsWith("."), code).toBe(true);
    }
  });

  it("tells the person what to do when they declined access", () => {
    expect(describeConnectError("access_denied")).toMatch(/allow access/i);
  });

  it("falls back to a generic message that still includes the code, so it can be reported", () => {
    expect(describeConnectError("SOMETHING_NEW")).toContain("SOMETHING_NEW");
  });

  it("doesn't treat inherited object keys as codes", () => {
    expect(describeConnectError("toString")).toContain("toString");
    expect(describeConnectError("constructor")).toContain("constructor");
  });
});
