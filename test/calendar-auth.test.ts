import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_SCOPES,
  CalendarAuthError,
  buildConsentUrl,
  createTokenProvider,
  exchangeAuthCode,
  loadCredentials,
  saveClientConfig,
  saveRefreshToken,
} from "../src/calendar/auth.js";

const CREDS = { clientId: "test-client-id", clientSecret: "test-client-secret", refreshToken: "test-refresh" };

function tokenFetch(payload: unknown, status = 200): typeof fetch {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  (fn as unknown as { calls: () => number }).calls = () => calls;
  return fn;
}

const callCount = (fn: typeof fetch): number =>
  (fn as unknown as { calls: () => number }).calls();

describe("calendar OAuth", () => {
  it("refreshes an access token and reuses the cached token", async () => {
    const fetchFn = tokenFetch({ access_token: "access-1", expires_in: 3600 });
    const provider = createTokenProvider(CREDS, fetchFn);

    expect(await provider.getAccessToken()).toBe("access-1");
    expect(await provider.getAccessToken()).toBe("access-1");
    expect(callCount(fetchFn)).toBe(1);
  });

  it("maps revoked authorization to an error that carries no secrets", async () => {
    const fetchFn = tokenFetch({ error: "invalid_grant" }, 400);
    const provider = createTokenProvider(CREDS, fetchFn);

    const error = await provider.getAccessToken().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CalendarAuthError);
    const message = (error as Error).message;
    expect(message).toMatch(/revoked|expired/i);
    expect(message).not.toContain("test-client-secret");
    expect(message).not.toContain("test-refresh");
  });

  it("maps a network failure to an unavailable error without secrets", async () => {
    const fetchFn = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const provider = createTokenProvider(CREDS, fetchFn);

    const error = await provider.getAccessToken().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).not.toContain("test-client-secret");
  });

  it("exchanges an authorization code for access and refresh tokens", async () => {
    let requestBody = "";
    const fetchFn = (async (_url: unknown, init?: unknown) => {
      requestBody = String((init as RequestInit)?.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "access-1", expires_in: 3600, refresh_token: "refresh-1" }),
      );
    }) as typeof fetch;

    const result = await exchangeAuthCode(
      fetchFn,
      { clientId: "id", clientSecret: "secret" },
      "auth-code",
      "http://localhost:1/callback",
    );

    expect(result).toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(requestBody).toContain("grant_type=authorization_code");
    expect(requestBody).toContain("code=auth-code");
    expect(requestBody).not.toContain("refresh-1");
  });

  it("loads credentials from the environment", () => {
    expect(
      loadCredentials({
        env: {
          GOOGLE_CALENDAR_CLIENT_ID: "id",
          GOOGLE_CALENDAR_CLIENT_SECRET: "secret",
          GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
  });

  it("returns undefined until authorization is complete", () => {
    expect(loadCredentials({ env: {} as NodeJS.ProcessEnv })).toBeUndefined();
    expect(
      loadCredentials({
        env: { GOOGLE_CALENDAR_CLIENT_ID: "id" } as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });

  it("round-trips client config and refresh tokens through the data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-auth-"));
    saveClientConfig(dataDir, { clientId: "id", clientSecret: "secret" });
    saveRefreshToken(dataDir, "refresh");

    expect(loadCredentials({ env: {} as NodeJS.ProcessEnv, dataDir })).toEqual({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
  });

  it("builds a consent URL with offline access and only the needed scopes", () => {
    const url = new URL(
      buildConsentUrl({ clientId: "test-client-id", redirectUri: "http://localhost:1/cb" }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(CALENDAR_SCOPES.join(" "));
    expect(CALENDAR_SCOPES).toHaveLength(2);
    expect(url.toString()).not.toContain("test-client-secret");
  });
});
