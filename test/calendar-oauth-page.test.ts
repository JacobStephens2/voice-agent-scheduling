import { describe, expect, it } from "vitest";
import { createOAuthRouter, type OAuthPageResponse } from "../src/calendar/oauth-routes.js";

const OPERATOR_TOKEN = "test-operator-token";
const BASE_URL = "https://scheduler.example";
const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };

function tokenFetch(refreshToken = "test-refresh-token"): typeof fetch {
  return (async (url: unknown) => {
    expect(String(url)).toContain("oauth2.googleapis.com/token");
    return Response.json({ access_token: "test-access", expires_in: 3600, refresh_token: refreshToken });
  }) as typeof fetch;
}

function createRouter(overrides: Record<string, unknown> = {}) {
  const saved: Array<{ client: typeof CLIENT; refreshToken: string }> = [];
  const router = createOAuthRouter({
    operatorToken: OPERATOR_TOKEN,
    baseUrl: BASE_URL,
    client: CLIENT,
    fetchFn: tokenFetch(),
    loadStatus: () => ({ authorized: false }),
    onTokensSaved: (client, refreshToken) => {
      saved.push({ client, refreshToken });
    },
    ...overrides,
  } as Parameters<typeof createOAuthRouter>[0]);
  return { router, saved };
}

function cookieFrom(response: OAuthPageResponse): string {
  const setCookie = response.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  expect(setCookie!).toContain("HttpOnly");
  expect(setCookie!).toContain("Secure");
  expect(setCookie!).toContain("SameSite=Lax");
  return setCookie!.split(";")[0]!;
}

async function establishSession(
  router: ReturnType<typeof createOAuthRouter>,
): Promise<string> {
  const redirect = await router.handle(
    "GET",
    new URL("/calendar/auth/start?token=test-operator-token", BASE_URL),
    {},
  );
  expect(redirect.statusCode).toBe(302);
  expect(redirect.headers.location).toBe("/calendar/auth/start");
  expect(redirect.headers.location).not.toContain("test-operator-token");
  return cookieFrom(redirect);
}

describe("OAuth consent pages", () => {
  it("rejects visitors without the operator token", async () => {
    const { router } = createRouter();
    const anonymous = await router.handle("GET", new URL("/calendar/auth/start", BASE_URL), {});
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["set-cookie"]).toBeUndefined();

    const wrong = await router.handle(
      "GET",
      new URL("/calendar/auth/start?token=wrong", BASE_URL),
      {},
    );
    expect(wrong.statusCode).toBe(401);

    const google = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {});
    expect(google.statusCode).toBe(401);
  });

  it("rejects an operator token whose UTF-8 byte length differs from the configured token", async () => {
    // "é" is one UTF-16 code unit and two UTF-8 bytes, so this query value
    // matches the configured token's string length and not its byte length.
    const presented = `é${"x".repeat(OPERATOR_TOKEN.length - 1)}`;
    const { router } = createRouter();
    const response = await router.handle(
      "GET",
      new URL(`/calendar/auth/start?token=${encodeURIComponent(presented)}`, BASE_URL),
      {},
    );
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("establishes a short-lived session, then shows the setup page", async () => {
    const { router } = createRouter();
    const cookie = await establishSession(router);

    const page = await router.handle("GET", new URL("/calendar/auth/start", BASE_URL), {
      cookie,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/calendar/auth/google");
    expect(page.body).toContain("calendar.freebusy");
    expect(page.body).not.toContain(OPERATOR_TOKEN);
    expect(page.body).not.toContain("test-client-secret");
  });

  it("redirects an authorized session to Google with offline access and state", async () => {
    const { router } = createRouter();
    const cookie = await establishSession(router);

    const redirect = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {
      cookie,
    });
    expect(redirect.statusCode).toBe(302);
    const target = new URL(redirect.headers.location!);
    expect(target.hostname).toBe("accounts.google.com");
    expect(target.searchParams.get("access_type")).toBe("offline");
    expect(target.searchParams.get("prompt")).toBe("consent");
    expect(target.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/calendar/auth/callback`);
    expect(target.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(redirect.headers.location).not.toContain("test-client-secret");
  });

  it("exchanges a verified callback for stored tokens without rendering secrets", async () => {
    const { router, saved } = createRouter();
    const cookie = await establishSession(router);
    const google = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {
      cookie,
    });
    const state = new URL(google.headers.location!).searchParams.get("state")!;

    const done = await router.handle(
      "GET",
      new URL(`/calendar/auth/callback?code=auth-code&state=${state}`, BASE_URL),
      { cookie },
    );
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("Calendar connected");
    expect(done.body).not.toContain("auth-code");
    expect(done.body).not.toContain("test-refresh-token");
    expect(done.body).not.toContain("test-client-secret");
    expect(saved).toEqual([{ client: CLIENT, refreshToken: "test-refresh-token" }]);

    const replay = await router.handle(
      "GET",
      new URL(`/calendar/auth/callback?code=auth-code&state=${state}`, BASE_URL),
      { cookie },
    );
    expect(replay.statusCode).toBe(401);
    expect(saved).toHaveLength(1);
  });

  it("rejects callbacks with forged state or missing codes", async () => {
    const { router, saved } = createRouter();
    const cookie = await establishSession(router);

    const forged = await router.handle(
      "GET",
      new URL("/calendar/auth/callback?code=auth-code&state=forged", BASE_URL),
      { cookie },
    );
    expect(forged.statusCode).toBe(401);

    const google = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {
      cookie,
    });
    const state = new URL(google.headers.location!).searchParams.get("state")!;
    const noCode = await router.handle(
      "GET",
      new URL(`/calendar/auth/callback?state=${state}`, BASE_URL),
      { cookie },
    );
    expect(noCode.statusCode).toBe(400);
    expect(saved).toEqual([]);
  });

  it("reports a bounded failure when Google rejects the exchange", async () => {
    const failingFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    const { router, saved } = createRouter({ fetchFn: failingFetch });
    const cookie = await establishSession(router);
    const google = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {
      cookie,
    });
    const state = new URL(google.headers.location!).searchParams.get("state")!;

    const done = await router.handle(
      "GET",
      new URL(`/calendar/auth/callback?code=stale&state=${state}`, BASE_URL),
      { cookie },
    );
    expect(done.statusCode).toBe(502);
    expect(done.body).not.toContain("stale");
    expect(saved).toEqual([]);
  });

  it("reports missing OAuth client configuration instead of linking", async () => {
    const { router } = createRouter({ client: undefined });
    const cookie = await establishSession(router);
    const google = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {
      cookie,
    });
    expect(google.statusCode).toBe(503);
  });

  it("rejects non-GET requests", async () => {
    const { router } = createRouter();
    const response = await router.handle("POST", new URL("/calendar/auth/start", BASE_URL), {});
    expect(response.statusCode).toBe(405);
  });
});
