import { createPublicKey, createVerify, timingSafeEqual, type JsonWebKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;

/** OpenID scopes required so the ID token carries a verified email. */
export const CONSENT_SCOPES = ["openid", "email", ...CALENDAR_SCOPES] as const;

export const DEFAULT_OPERATOR_EMAIL = "jacob@stephens.page";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarAuthError";
  }
}

const SIGN_IN_UNVERIFIED =
  "The Google sign-in could not be verified. The refresh token was not stored.";

export class OperatorEmailMismatchError extends CalendarAuthError {
  constructor() {
    super(
      "The Google account's verified email does not match the configured operator address. The refresh token was not stored.",
    );
    this.name = "OperatorEmailMismatchError";
  }
}

export function configuredOperatorEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPERATOR_EMAIL?.trim() || DEFAULT_OPERATOR_EMAIL;
}

function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load persistent user-OAuth credentials. Environment takes precedence;
 * otherwise client and refresh material is read from files in the service
 * data directory. Returns undefined when authorization was never completed.
 * Refresh credentials are never logged or included in error messages.
 */
export function loadCredentials(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
}): GoogleOAuthCredentials | undefined {
  const env = options.env ?? process.env;
  const client = loadClientConfig(options);
  if (!client) {
    return undefined;
  }
  const refreshToken =
    env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim() ||
    (options.dataDir ? readFileIfPresent(join(options.dataDir, "google-refresh")) : undefined);
  if (!refreshToken) {
    return undefined;
  }
  return { ...client, refreshToken };
}

export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Load the OAuth client without requiring a stored refresh token. */
export function loadClientConfig(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
}): GoogleOAuthClient | undefined {
  const env = options.env ?? process.env;
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || undefined;
  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }
  if (!options.dataDir) {
    return undefined;
  }
  try {
    const raw = readFileIfPresent(join(options.dataDir, "google-client.json"));
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { clientId?: unknown; clientSecret?: unknown };
    if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string") {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Persist OAuth client material with owner-only permissions. */
export function saveClientConfig(
  dataDir: string,
  config: { clientId: string; clientSecret: string },
): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "google-client.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
}

/** Persist a refresh token with owner-only permissions. */
export function saveRefreshToken(dataDir: string, refreshToken: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "google-refresh"), `${refreshToken.trim()}\n`, {
    mode: 0o600,
  });
}

export function buildConsentUrl(options: {
  readonly clientId: string;
  readonly redirectUri: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", CONSENT_SCOPES.join(" "));
  return url.toString();
}

export interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
}

type FetchFn = typeof fetch;

async function postTokenRequest(
  fetchFn: FetchFn,
  params: Record<string, string>,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new CalendarAuthError(
      "Could not reach Google authorization servers. Calendar data is unavailable.",
    );
  }
  let payload: {
    error?: unknown;
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (!response.ok || typeof payload.access_token !== "string") {
    if (payload.error === "invalid_grant") {
      throw new CalendarAuthError(
        "Google Calendar authorization was revoked or expired. Calendar data is unavailable until Jacob re-authorizes.",
      );
    }
    throw new CalendarAuthError(
      "Google Calendar authorization failed. Calendar data is unavailable.",
    );
  }
  return {
    access_token: payload.access_token,
    expires_in:
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600,
    ...(typeof payload.refresh_token === "string" ? { refresh_token: payload.refresh_token } : {}),
    ...(typeof payload.id_token === "string" ? { id_token: payload.id_token } : {}),
  };
}

export async function exchangeAuthCode(
  fetchFn: FetchFn,
  credentials: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
  expectedEmail: string,
  nowMs?: () => number,
): Promise<{ accessToken: string; refreshToken: string }> {
  const payload = await postTokenRequest(fetchFn, {
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const full = payload as TokenResponse & { refresh_token?: unknown };
  if (typeof full.refresh_token !== "string" || !full.refresh_token) {
    throw new CalendarAuthError(
      "Google did not return a refresh token. Calendar data is unavailable.",
    );
  }
  if (typeof payload.id_token !== "string" || !payload.id_token) {
    throw new CalendarAuthError(SIGN_IN_UNVERIFIED);
  }
  const verifiedAtMs = nowMs?.() ?? Date.now();
  const email = await verifiedEmailFromIdToken(
    fetchFn,
    payload.id_token,
    credentials.clientId,
    verifiedAtMs,
  );
  if (!emailsMatch(expectedEmail, email)) {
    throw new OperatorEmailMismatchError();
  }
  return { accessToken: payload.access_token, refreshToken: full.refresh_token };
}

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

interface GoogleJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface IdTokenHeader {
  alg?: unknown;
  kid?: unknown;
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

function unverified(): CalendarAuthError {
  return new CalendarAuthError(SIGN_IN_UNVERIFIED);
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw unverified();
  }
  return Buffer.from(segment, "base64url");
}

function emailsMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected.trim().toLowerCase());
  const actualBuf = Buffer.from(actual.trim().toLowerCase());
  return (
    expectedBuf.length > 0 &&
    expectedBuf.length === actualBuf.length &&
    timingSafeEqual(expectedBuf, actualBuf)
  );
}

function audienceMatches(claims: IdTokenClaims, clientId: string): boolean {
  if (typeof claims.aud === "string") {
    return claims.aud === clientId;
  }
  if (
    Array.isArray(claims.aud) &&
    claims.aud.length > 0 &&
    claims.aud.every((item) => typeof item === "string") &&
    claims.aud.includes(clientId)
  ) {
    return claims.azp === clientId;
  }
  return false;
}

async function verifiedEmailFromIdToken(
  fetchFn: FetchFn,
  idToken: string,
  clientId: string,
  nowMs: number,
): Promise<string> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw unverified();
  }
  const encodedHeader = parts[0]!;
  const encodedPayload = parts[1]!;
  const encodedSignature = parts[2]!;
  let header: IdTokenHeader;
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(decodeSegment(encodedHeader).toString("utf8")) as IdTokenHeader;
    claims = JSON.parse(decodeSegment(encodedPayload).toString("utf8")) as IdTokenClaims;
  } catch (error) {
    if (error instanceof CalendarAuthError) {
      throw error;
    }
    throw unverified();
  }
  if (
    typeof header !== "object" ||
    header === null ||
    typeof claims !== "object" ||
    claims === null ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid.length === 0
  ) {
    throw unverified();
  }
  const key = await googleSigningKey(fetchFn, header.kid);
  let signatureOk = false;
  try {
    const publicKey = createPublicKey({ key, format: "jwk" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    signatureOk = verifier.verify(publicKey, decodeSegment(encodedSignature));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw unverified();
  }
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
    throw unverified();
  }
  if (!audienceMatches(claims, clientId)) {
    throw unverified();
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= nowMs) {
    throw unverified();
  }
  if (claims.email_verified !== true || typeof claims.email !== "string" || claims.email.trim() === "") {
    throw unverified();
  }
  return claims.email;
}

async function googleSigningKey(fetchFn: FetchFn, kid: string): Promise<GoogleJwk> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_JWKS_URL);
  } catch {
    throw unverified();
  }
  if (!response.ok) {
    throw unverified();
  }
  let payload: { keys?: unknown };
  try {
    payload = (await response.json()) as { keys?: unknown };
  } catch {
    throw unverified();
  }
  if (!Array.isArray(payload.keys)) {
    throw unverified();
  }
  const key = payload.keys.find((candidate): candidate is GoogleJwk => {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const parsed = candidate as GoogleJwk;
    return (
      parsed.kid === kid &&
      parsed.kty === "RSA" &&
      (parsed.alg === undefined || parsed.alg === "RS256") &&
      (parsed.use === undefined || parsed.use === "sig")
    );
  });
  if (!key) {
    throw unverified();
  }
  return key;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

/** Refreshing provider with a short-lived in-memory access-token cache. */
export function createTokenProvider(
  credentials: GoogleOAuthCredentials,
  fetchFn: FetchFn = fetch,
): AccessTokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  return {
    async getAccessToken(): Promise<string> {
      if (cached && Date.now() < cached.expiresAt) {
        return cached.token;
      }
      const payload = await postTokenRequest(fetchFn, {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      });
      cached = {
        token: payload.access_token,
        expiresAt: Date.now() + Math.max(0, payload.expires_in - 60) * 1000,
      };
      return cached.token;
    },
  };
}
