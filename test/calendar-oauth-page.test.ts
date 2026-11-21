import { describe, expect, it } from "vitest";
import {
  OPERATOR_TOKEN_BODY_CEILING_BYTES,
  createOAuthRouter,
  type OAuthPageResponse,
} from "../src/calendar/oauth-routes.js";
import { OPERATOR_EMAIL, TEST_JWKS, operatorIdToken } from "./google-id-token.js";

const OPERATOR_TOKEN = "test-operator-token";
const BASE_URL = "https://scheduler.example";
const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

function tokenFetch(refreshToken = "test-refresh-token", idToken = operatorIdToken()): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: "test-access",
        expires_in: 3600,
        refresh_token: refreshToken,
        id_token: idToken,
      });
    }
    if (href.includes("/oauth2/v3/certs")) {
      return Response.json(TEST_JWKS);
    }
    throw new Error(`unexpected fetch ${href}`);
  }) as typeof fetch;
}

function createRouter(overrides: Record<string, unknown> = {}) {
  const saved: Array<{ client: typeof CLIENT; refreshToken: string }> = [];
  const router = createOAuthRouter({
    operatorToken: OPERATOR_TOKEN,
    operatorEmail: OPERATOR_EMAIL,
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
    "POST",
    new URL("/calendar/auth/start", BASE_URL),
    FORM_HEADERS,
    `token=${OPERATOR_TOKEN}`,
  );
  expect(redirect.statusCode).toBe(303);
  expect(redirect.headers.location).toBe("/calendar/auth/start");
  expect(redirect.headers.location).not.toContain(OPERATOR_TOKEN);
  return cookieFrom(redirect);
}

describe("OAuth consent pages", () => {
  it("shows a form when the setup page has no session", async () => {
    const { router } = createRouter();
    const anonymous = await router.handle("GET", new URL("/calendar/auth/start", BASE_URL), {});
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.headers["set-cookie"]).toBeUndefined();
    expect(anonymous.body).toContain('<form method="post" action="/calendar/auth/start">');
    expect(anonymous.body).toContain('name="token"');
    expect(anonymous.body).not.toContain(OPERATOR_TOKEN);

    const google = await router.handle("GET", new URL("/calendar/auth/google", BASE_URL), {});
    expect(google.statusCode).toBe(401);
  });

  it("refuses an operator token in the query", async () => {
    const { router } = createRouter();
    const matched = await router.handle(
      "GET",
      new URL("/calendar/auth/start?token=test-operator-token", BASE_URL),
      {},
    );
    expect(matched.statusCode).toBe(401);
    expect(matched.headers["set-cookie"]).toBeUndefined();
    expect(matched.body).not.toContain(OPERATOR_TOKEN);

    const postedWithQuery = await router.handle(
      "POST",
      new URL("/calendar/auth/start?token=test-operator-token", BASE_URL),
      FORM_HEADERS,
      `token=${OPERATOR_TOKEN}`,
    );
    expect(postedWithQuery.statusCode).toBe(401);
    expect(postedWithQuery.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a posted operator token that does not match", async () => {
    const { router } = createRouter();
    const wrong = await router.handle(
      "POST",
      new URL("/calendar/auth/start", BASE_URL),
      FORM_HEADERS,
      "token=wrong",
    );
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses an operator token that is not posted as a form", async () => {
    const { router } = createRouter();
    const response = await router.handle(
      "POST",
      new URL("/calendar/auth/start", BASE_URL),
      { "content-type": "application/json" },
      JSON.stringify({ token: OPERATOR_TOKEN }),
    );
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses an operator token form larger than the body ceiling", async () => {
    const { router } = createRouter();
    const body = `token=${OPERATOR_TOKEN}&pad=${"a".repeat(OPERATOR_TOKEN_BODY_CEILING_BYTES)}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(OPERATOR_TOKEN_BODY_CEILING_BYTES);
    const response = await router.handle(
      "POST",
      new URL("/calendar/auth/start", BASE_URL),
      FORM_HEADERS,
      body,
    );
    expect(response.statusCode).toBe(413);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an operator token whose UTF-8 byte length differs from the configured token", async () => {
    // "é" is one UTF-16 code unit and two UTF-8 bytes, so this form value
    // matches the configured token's string length and not its byte length.
    const presented = `é${"x".repeat(OPERATOR_TOKEN.length - 1)}`;
    const { router } = createRouter();
    const response = await router.handle(
      "POST",
      new URL("/calendar/auth/start", BASE_URL),
      FORM_HEADERS,
      `token=${encodeURIComponent(presented)}`,
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
    expect(page.body).toContain("openid");
    expect(page.body).toContain("email");
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
    expect(target.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
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

  it("does not store a refresh token when the verified email does not match", async () => {
    const { router, saved } = createRouter({
      fetchFn: tokenFetch("test-refresh-token", operatorIdToken("other@example.com")),
    });
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
    expect(done.statusCode).toBe(403);
    expect(done.body).toContain("refresh token was not stored");
    expect(done.body).not.toContain("other@example.com");
    expect(done.body).not.toContain("test-refresh-token");
    expect(done.body).not.toContain("auth-code");
    expect(saved).toEqual([]);
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

  it("rejects methods other than the setup form post", async () => {
    const { router } = createRouter();
    const response = await router.handle("POST", new URL("/calendar/auth/google", BASE_URL), {});
    expect(response.statusCode).toBe(405);
    const put = await router.handle("PUT", new URL("/calendar/auth/start", BASE_URL), {});
    expect(put.statusCode).toBe(405);
  });
});
