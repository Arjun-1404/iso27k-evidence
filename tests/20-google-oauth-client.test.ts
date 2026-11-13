import { describe, it, expect } from "vitest";
import { GoogleOAuthClient } from "../src/storage/googleOAuth.ts";
import { FakeGoogleOAuthApi } from "../src/storage/fakeGoogleOAuthApi.ts";
import { StorageError } from "../src/storage/types.ts";

const CONFIG = { clientId: "test-client-id", clientSecret: "test-client-secret", redirectUri: "https://portal.example/oauth/google/callback" };
function setup() {
  const api = new FakeGoogleOAuthApi();
  const client = new GoogleOAuthClient(CONFIG, api.fetcher);
  return { api, client };
}

describe("GoogleOAuthClient: building the authorization URL", () => {
  it("includes the client id, redirect URI, drive.file scope, and the caller's state unchanged", () => {
    const { client } = setup();
    const url = new URL(client.buildAuthUrl("my-csrf-state-value"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("state")).toBe("my-csrf-state-value");
  });

  it("requests offline access and forces consent, so a refresh token always comes back", () => {
    const { client } = setup();
    const url = new URL(client.buildAuthUrl("x"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("never leaks the client secret into the authorization URL", () => {
    const { client } = setup();
    const url = client.buildAuthUrl("x");
    expect(url).not.toContain("test-client-secret");
  });
});

describe("GoogleOAuthClient: exchanging the code", () => {
  it("exchanges a valid code for a refresh token, access token, and expiry", async () => {
    const { api, client } = setup();
    api.seedCode("good-code", { refreshToken: "1//0g-refresh-value", accessToken: "ya29.access-value", expiresIn: 3599 });
    const tokens = await client.exchangeCode("good-code");
    expect(tokens).toEqual({ refreshToken: "1//0g-refresh-value", accessToken: "ya29.access-value", expiresInSeconds: 3599 });
  });

  it("sends the client secret and redirect URI in the token request body, not the URL", async () => {
    const { api, client } = setup();
    api.seedCode("good-code");
    await client.exchangeCode("good-code");
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).not.toContain("test-client-secret");
    const params = new URLSearchParams(api.calls[0].body);
    expect(params.get("client_secret")).toBe("test-client-secret");
    expect(params.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(params.get("grant_type")).toBe("authorization_code");
  });

  it("rejects an invalid or already-used code with a clean, non-retryable StorageError", async () => {
    const { client } = setup();
    await expect(client.exchangeCode("never-seeded")).rejects.toMatchObject({ name: "StorageError", code: "INVALID_REQUEST", retryable: false });
  });

  it("treats a missing refresh token as a retryable error, not a silent partial success", async () => {
    const { api, client } = setup();
    api.seedCode("already-granted");
    api.omitRefreshToken("already-granted");
    await expect(client.exchangeCode("already-granted")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("StorageError from a failed exchange is a real Error instance", async () => {
    const { client } = setup();
    try {
      await client.exchangeCode("bad-code");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});
