import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { AesSecretStore } from "../src/auth/secretStore.ts";

const KEY = randomBytes(32).toString("hex");

describe("AesSecretStore", () => {
  it("round-trips a secret", () => {
    const store = new AesSecretStore(KEY);
    const ref = store.encrypt("1//0g-real-looking-refresh-token-value");
    expect(ref).not.toContain("1//0g-real-looking-refresh-token-value");
    expect(store.decrypt(ref)).toBe("1//0g-real-looking-refresh-token-value");
  });

  it("produces a different ciphertext each time (random IV), even for the same plaintext", () => {
    const store = new AesSecretStore(KEY);
    const a = store.encrypt("same-secret");
    const b = store.encrypt("same-secret");
    expect(a).not.toBe(b);
    expect(store.decrypt(a)).toBe("same-secret");
    expect(store.decrypt(b)).toBe("same-secret");
  });

  it("rejects a key of the wrong length, with a clear message", () => {
    expect(() => new AesSecretStore("too-short")).toThrow(/32 bytes/);
    expect(() => new AesSecretStore(randomBytes(16).toString("hex"))).toThrow(/32 bytes/);
  });

  it("refuses to decrypt with the wrong key (authentication tag check fails)", () => {
    const store = new AesSecretStore(KEY);
    const ref = store.encrypt("secret-value");
    const otherStore = new AesSecretStore(randomBytes(32).toString("hex"));
    expect(() => otherStore.decrypt(ref)).toThrow();
  });

  it("refuses to decrypt a tampered ciphertext, authentication tag or IV — wherever the change is", () => {
    const store = new AesSecretStore(KEY);
    // Run it many times: every encryption uses a fresh random IV, so each ciphertext differs. (An earlier
    // version overwrote the last two hex digits with "00", which changed nothing about 1 time in 256 — when
    // they were already "00" — and so failed at random.)
    for (let i = 0; i < 50; i++) {
      const ref = store.encrypt("secret-value");
      const parts = ref.split(".");
      for (const which of [0, 1, 2]) {
        const bad = [...parts];
        const last = bad[which].at(-1)!;
        bad[which] = bad[which].slice(0, -1) + (last === "0" ? "1" : "0"); // guaranteed to differ from the original
        const tampered = bad.join(".");
        expect(tampered).not.toBe(ref);
        expect(() => store.decrypt(tampered), `part ${which} altered`).toThrow();
      }
    }
  });

  it("rejects a malformed reference", () => {
    const store = new AesSecretStore(KEY);
    expect(() => store.decrypt("not-the-right-shape")).toThrow(/Malformed/);
  });
});
