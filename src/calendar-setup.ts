/**
 * Operator setup for Google Calendar authorization and selection.
 *
 * Human steps (also see docs/deployment/calendar-setup.md):
 *   1. Create a Desktop-app OAuth client for jacob@stephens.page.
 *   2. GOOGLE_CALENDAR_CLIENT_ID=... npm run calendars:auth-url
 *      -> open the printed URL, authorize, copy the code.
 *   3. GOOGLE_CALENDAR_CLIENT_ID=... GOOGLE_CALENDAR_CLIENT_SECRET=... \
 *        npm run calendars:auth -- --code <code>
 *      -> exchanges the code and stores the refresh token (0600) in the data dir.
 *   4. npm run calendars:list -- --calendars <id,...>
 *      -> validate Jacob's candidate calendar IDs through freeBusy
 *         (the minimal scopes cannot browse by name) and report reachability.
 *   5. npm run calendars:select -- --primary <id> --conflicts <id,...>
 *      -> persist Jacob's explicit selection.
 *
 * Refresh credentials never print to stdout and stay out of source control.
 */

import {
  buildConsentUrl,
  createTokenProvider,
  exchangeAuthCode,
  loadCredentials,
  saveClientConfig,
  saveRefreshToken,
} from "./calendar/auth.js";
import { validateCalendars } from "./calendar/client.js";
import { saveSelection } from "./calendar/selection.js";

const DEFAULT_REDIRECT_URI = "http://localhost:1/callback";

function dataDir(): string {
  return process.env.SCHEDULING_DATA_DIR?.trim() || ".scratch/scheduling-data";
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || !value || value.startsWith("--")) {
    return undefined;
  }
  return value;
}

function clientIdOrThrow(): string {
  const fromEnv = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const loaded = loadCredentials({ dataDir: dataDir() });
  if (loaded) {
    return loaded.clientId;
  }
  throw new Error("Set GOOGLE_CALENDAR_CLIENT_ID to the Desktop-app OAuth client ID.");
}

async function authUrl(): Promise<void> {
  const redirectUri = flagValue("--redirect-uri") ?? DEFAULT_REDIRECT_URI;
  const url = buildConsentUrl({ clientId: clientIdOrThrow(), redirectUri });
  process.stdout.write(
    [
      "Open this URL as jacob@stephens.page, authorize Calendar access, and copy the code.",
      "",
      url,
      "",
      `Redirect URI (must be registered on the OAuth client): ${redirectUri}`,
      "",
    ].join("\n"),
  );
}

async function auth(): Promise<void> {
  const code = flagValue("--code");
  if (!code) {
    throw new Error("Pass the consent code: npm run calendars:auth -- --code <code>");
  }
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET to exchange the code.",
    );
  }
  const redirectUri = flagValue("--redirect-uri") ?? DEFAULT_REDIRECT_URI;
  const { refreshToken } = await exchangeAuthCode(
    fetch,
    { clientId, clientSecret },
    code,
    redirectUri,
  );
  saveClientConfig(dataDir(), { clientId, clientSecret });
  saveRefreshToken(dataDir(), refreshToken);
  process.stdout.write(
    `Stored the refresh token in ${dataDir()} with owner-only permissions.\n`,
  );
}

async function list(): Promise<void> {
  const credentials = loadCredentials({ dataDir: dataDir() });
  if (!credentials) {
    throw new Error("Calendar authorization is incomplete. Run calendars:auth first.");
  }
  const extra = (flagValue("--calendars") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const candidates = [...new Set(["primary", ...extra])];
  const token = await createTokenProvider(credentials, fetch).getAccessToken();
  const validated = await validateCalendars(fetch, token, candidates);
  for (const calendar of validated) {
    process.stdout.write(
      calendar.reachable
        ? `ok ${calendar.id}\n`
        : `UNREACHABLE ${calendar.id} (${calendar.error ?? "unknown"})\n`,
    );
  }
  process.stdout.write(
    `\nChecked ${validated.length} candidate(s) through freeBusy; no event content was read. ` +
      `Copy IDs from Google Calendar Settings > Integrate calendar, then persist the choice:\n` +
      `npm run calendars:select -- --primary <id> --conflicts <id,...>\n`,
  );
}

async function select(): Promise<void> {
  const primary = flagValue("--primary");
  if (!primary) {
    throw new Error("Pass a primary calendar: npm run calendars:select -- --primary <id>");
  }
  const conflicts = (flagValue("--conflicts") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  saveSelection(dataDir(), {
    primaryCalendarId: primary,
    conflictCalendarIds: conflicts,
    updatedAt: new Date().toISOString(),
  });
  process.stdout.write(
    `Selected primary ${primary} with ${conflicts.length} conflict calendar(s).\n`,
  );
}

const command = process.argv[2];
try {
  if (command === "auth-url") {
    await authUrl();
  } else if (command === "auth") {
    await auth();
  } else if (command === "list") {
    await list();
  } else if (command === "select") {
    await select();
  } else {
    process.stderr.write("Usage: calendar-setup.ts <auth-url|auth|list|select>\n");
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(
    `calendar-setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
