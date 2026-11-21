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
import { OPERATOR_EMAIL, TEST_JWKS, operatorIdToken } from "./google-id-token.js";

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
    const fetchFn = (async (url: unknown, init?: unknown) => {
      const href = String(url);
      if (href.includes("/oauth2/v3/certs")) {
        return Response.json(TEST_JWKS);
      }
      requestBody = String((init as RequestInit)?.body ?? "");
      return Response.json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        id_token: operatorIdToken(),
      });
    }) as typeof fetch;

    const result = await exchangeAuthCode(
      fetchFn,
      { clientId: "test-client-id", clientSecret: "secret" },
      "auth-code",
      "http://localhost:1/callback",
      { email: OPERATOR_EMAIL },
    );

    expect(result).toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(requestBody).toContain("grant_type=authorization_code");
    expect(requestBody).toContain("code=auth-code");
    expect(requestBody).not.toContain("refresh-1");
  });

  it("does not return a refresh token when the verified email does not match", async () => {
    const fetchFn = (async (url: unknown) => {
      const href = String(url);
      if (href.includes("/oauth2/v3/certs")) {
        return Response.json(TEST_JWKS);
      }
      return Response.json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        id_token: operatorIdToken("other@example.com"),
      });
    }) as typeof fetch;

    const error = await exchangeAuthCode(
      fetchFn,
      { clientId: "test-client-id", clientSecret: "secret" },
      "auth-code",
      "http://localhost:1/callback",
      { email: OPERATOR_EMAIL },
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CalendarAuthError);
    const message = (error as Error).message;
    expect(message).toMatch(/not stored/i);
    expect(message).not.toContain("refresh-1");
    expect(message).not.toContain("other@example.com");
    expect(message).not.toContain("secret");
  });

  it("does not return a refresh token when the ID token email is not verified", async () => {
    const fetchFn = (async (url: unknown) => {
      const href = String(url);
      if (href.includes("/oauth2/v3/certs")) {
        return Response.json(TEST_JWKS);
      }
      return Response.json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        id_token: operatorIdToken(OPERATOR_EMAIL, { email_verified: false }),
      });
    }) as typeof fetch;

    const error = await exchangeAuthCode(
      fetchFn,
      { clientId: "test-client-id", clientSecret: "secret" },
      "auth-code",
      "http://localhost:1/callback",
      { email: OPERATOR_EMAIL },
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).not.toContain("refresh-1");
  });

  it("does not return a refresh token when the ID token signature does not verify", async () => {
    const signed = operatorIdToken();
    const parts = signed.split(".");
    const forged = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}aa`;
    const fetchFn = (async (url: unknown) => {
      const href = String(url);
      if (href.includes("/oauth2/v3/certs")) {
        return Response.json(TEST_JWKS);
      }
      return Response.json({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        id_token: forged,
      });
    }) as typeof fetch;

    const error = await exchangeAuthCode(
      fetchFn,
      { clientId: "test-client-id", clientSecret: "secret" },
      "auth-code",
      "http://localhost:1/callback",
      { email: OPERATOR_EMAIL },
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).not.toContain("refresh-1");
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
    expect(url.searchParams.get("scope")).toBe(
      ["openid", "email", ...CALENDAR_SCOPES].join(" "),
    );
    expect(CALENDAR_SCOPES).toHaveLength(2);
    expect(url.toString()).not.toContain("test-client-secret");
  });
});
