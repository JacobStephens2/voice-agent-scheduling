import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  CALENDAR_SCOPES,
  buildConsentUrl,
  exchangeAuthCode,
  type GoogleOAuthClient,
} from "./auth.js";
import type { CalendarSelection } from "./selection.js";

export interface OAuthPageResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface CalendarSetupStatus {
  readonly authorized: boolean;
  readonly selection?: CalendarSelection;
}

export interface OAuthRouterOptions {
  readonly operatorToken: string;
  readonly baseUrl: string;
  readonly client: GoogleOAuthClient | undefined;
  readonly fetchFn?: typeof fetch;
  readonly nowMs?: () => number;
  readonly onTokensSaved?: (client: GoogleOAuthClient, refreshToken: string) => void;
  readonly loadStatus?: () => CalendarSetupStatus;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE = "sched_oauth";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function html(statusCode: number, title: string, body: string): OAuthPageResponse {
  return {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: page(title, body),
  };
}

function redirect(location: string, setCookie?: string): OAuthPageResponse {
  const headers: Record<string, string> = { location };
  if (setCookie) {
    headers["set-cookie"] = setCookie;
  }
  return { statusCode: 302, headers, body: "" };
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function tokensMatch(expected: string, presented: string | undefined): boolean {
  if (!presented) {
    return false;
  }
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  return (
    presentedBuf.length === expectedBuf.length &&
    timingSafeEqual(presentedBuf, expectedBuf)
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in cookies)) {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * Operator-only Google consent pages. Every step requires proof the visitor
 * is the operator: the long-lived operator token once (query), then a
 * short-lived session cookie, plus a single-use OAuth state on the way back.
 * Callback codes are exchanged server-side; tokens and codes never render.
 */
export function createOAuthRouter(options: OAuthRouterOptions): {
  handle(method: string, url: URL, headers: Record<string, string | undefined>): Promise<OAuthPageResponse>;
} {
  const fetchFn = options.fetchFn ?? fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  const sessions = new Map<string, number>();
  const states = new Map<string, number>();
  const callbackUrl = `${options.baseUrl.replace(/\/$/, "")}/calendar/auth/callback`;

  const prune = (store: Map<string, number>) => {
    const now = nowMs();
    for (const [token, expiresAt] of store) {
      if (expiresAt <= now) {
        store.delete(token);
      }
    }
  };

  const sessionCookie = (session: string): string =>
    `${SESSION_COOKIE}=${session}; Path=/calendar/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;

  const validSession = (headers: Record<string, string | undefined>): boolean => {
    prune(sessions);
    const presented = parseCookies(headers.cookie)[SESSION_COOKIE];
    if (!presented || !sessions.has(presented)) {
      return false;
    }
    return true;
  };

  const statusLines = (): string => {
    const status = options.loadStatus?.() ?? { authorized: false };
    const authLine = status.authorized
      ? "<p>Calendar authorization: connected.</p>"
      : "<p>Calendar authorization: not connected yet.</p>";
    const selectionLine = status.selection
      ? `<p>Selected primary calendar: <code>${escapeHtml(status.selection.primaryCalendarId)}</code> with ${status.selection.conflictCalendarIds.length} conflict calendar(s).</p>`
      : "<p>No scheduling calendars selected yet.</p>";
    return `${authLine}\n${selectionLine}`;
  };

  return {
    async handle(
      method: string,
      url: URL,
      headers: Record<string, string | undefined>,
    ): Promise<OAuthPageResponse> {
      if (method !== "GET") {
        return html(405, "Method not allowed", "<p>Use the link provided on the setup page.</p>");
      }

      if (url.pathname === "/calendar/auth/start") {
        const token = url.searchParams.get("token") ?? undefined;
        if (token !== undefined) {
          if (!tokensMatch(options.operatorToken, token)) {
            return html(401, "Not authorized", "<p>This setup page is operator-only.</p>");
          }
          const session = newToken();
          sessions.set(session, nowMs() + SESSION_TTL_MS);
          return redirect("/calendar/auth/start", sessionCookie(session));
        }
        if (!validSession(headers)) {
          return html(401, "Not authorized", "<p>This setup page is operator-only.</p>");
        }
        return html(
          200,
          "Connect Google Calendar",
          [
            statusLines(),
            "<p>Connect Jacob's Google Calendar so the scheduling agent can read real availability. This slice only reads; no calendar event is created.</p>",
            `<p>Google will ask for: <code>${CALENDAR_SCOPES.map(escapeHtml).join("</code>, <code>")}</code>.</p>`,
            '<p><a href="/calendar/auth/google">Connect Google Calendar</a></p>',
          ].join("\n"),
        );
      }

      if (url.pathname === "/calendar/auth/google") {
        if (!validSession(headers)) {
          return html(401, "Not authorized", "<p>This setup page is operator-only.</p>");
        }
        if (!options.client) {
          return html(
            503,
            "OAuth client not configured",
            "<p>Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET, then restart the service.</p>",
          );
        }
        prune(states);
        const state = newToken();
        states.set(state, nowMs() + STATE_TTL_MS);
        const consent = new URL(buildConsentUrl({ clientId: options.client.clientId, redirectUri: callbackUrl }));
        consent.searchParams.set("state", state);
        return redirect(consent.toString());
      }

      if (url.pathname === "/calendar/auth/callback") {
        if (!options.client) {
          return html(
            503,
            "OAuth client not configured",
            "<p>Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET, then restart the service.</p>",
          );
        }
        const state = url.searchParams.get("state") ?? undefined;
        const code = url.searchParams.get("code") ?? undefined;
        prune(states);
        const stateOk = state !== undefined && states.has(state);
        if (state) {
          states.delete(state);
        }
        if (!stateOk || !validSession(headers)) {
          return html(
            401,
            "Authorization failed",
            "<p>The sign-in attempt could not be verified. Please start again from the setup page.</p>",
          );
        }
        if (!code) {
          return html(
            400,
            "Authorization cancelled",
            "<p>Google did not return an authorization code. Please try again from the setup page.</p>",
          );
        }
        try {
          const { refreshToken } = await exchangeAuthCode(
            fetchFn,
            options.client,
            code,
            callbackUrl,
          );
          options.onTokensSaved?.(options.client, refreshToken);
        } catch {
          return html(
            502,
            "Authorization failed",
            "<p>Google Calendar authorization failed. Calendar data is unavailable; please try again.</p>",
          );
        }
        sessions.delete(parseCookies(headers.cookie)[SESSION_COOKIE] ?? "");
        return html(
          200,
          "Calendar connected",
          [
            "<p>Google Calendar authorization is stored. The scheduling agent can now read real availability.</p>",
            statusLines(),
            "<p>Next: select the primary destination and every conflict calendar, then place a controlled test call.</p>",
          ].join("\n"),
        );
      }

      return html(404, "Not found", "<p>No setup page here.</p>");
    },
  };
}
