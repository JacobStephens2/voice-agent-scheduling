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
 *   6. npm run calendars:verify-booking -- --calendar <test-id>
 *      -> insert, GET notification fields, delete. Refuses `primary`
 *         unless --allow-primary.
 *
 * Refresh credentials never print to stdout and stay out of source control.
 */

import { randomBytes } from "node:crypto";
import {
  buildConsentUrl,
  createTokenProvider,
  exchangeAuthCode,
  loadCredentials,
  saveClientConfig,
  saveRefreshToken,
} from "./calendar/auth.js";
import {
  appointmentNotificationProof,
  commitStoredCalendarEvent,
  deleteAppointmentEvent,
  validateCalendars,
} from "./calendar/client.js";
import { computeAvailableStarts, SCHEDULING_TIMEZONE } from "./calendar/policy.js";
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

function easternDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function firstPermittedSlot(now: Date): { date: string; startTime: string } {
  for (let offset = 3; offset <= 14; offset += 1) {
    const date = easternDate(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000));
    const slot = computeAvailableStarts({ date, now, busy: [] })[0];
    if (slot) {
      return { date: slot.date, startTime: slot.startTime };
    }
  }
  throw new Error("No permitted weekday slot in the booking window.");
}

async function verifyBooking(): Promise<void> {
  const calendarId = flagValue("--calendar");
  if (!calendarId) {
    throw new Error(
      "Pass a test calendar: npm run calendars:verify-booking -- --calendar <id>",
    );
  }
  if (calendarId === "primary" && process.argv.includes("--allow-primary") === false) {
    throw new Error(
      "Refusing to write the Google primary calendar. Pass a test calendar id, or --allow-primary.",
    );
  }
  const credentials = loadCredentials({ dataDir: dataDir() });
  if (!credentials) {
    throw new Error("Calendar authorization is incomplete. Run calendars:auth first.");
  }
  const slot = firstPermittedSlot(new Date());
  const eventId = randomBytes(16).toString("hex");
  const token = await createTokenProvider(credentials, fetch).getAccessToken();
  const reading = await commitStoredCalendarEvent(fetch, token, {
    calendarId,
    eventId,
    callerName: "Live verification",
    callbackNumber: "+15555550100",
    purpose: "Notification proof",
    date: slot.date,
    startTime: slot.startTime,
  });
  const stored = reading.event;
  if (stored) {
    const proof = appointmentNotificationProof(stored);
    process.stdout.write(
      [
        `GET stored event ${stored.id} on ${calendarId}`,
        `summary starts Appointment with: ${stored.summary?.startsWith("Appointment with ") ? "yes" : "no"}`,
        `attendees: ${proof.hasAttendees ? "present" : "none"}`,
        `hangoutLink: ${proof.hasHangoutLink ? "present" : "none"}`,
        `conferenceData: ${proof.hasConferenceData ? "present" : "none"}`,
        `emailReminder: ${proof.hasEmailReminder ? "present" : "none"}`,
        `popupMinutes: ${proof.popupReminderMinutes.join(",") || "none"}`,
        "",
      ].join("\n"),
    );
  }
  if (reading.kind === "mismatched") {
    try {
      await deleteAppointmentEvent(fetch, token, calendarId, eventId);
      process.stdout.write("Deleted the verification event (sendUpdates=none).\n");
    } catch {
      // The shape failure is the result. Cleanup is best-effort.
    }
    throw new Error(
      "Stored event did not match the approved notification shape (no attendees, Meet, or email reminder; popup 10 only).",
    );
  }
  if (reading.kind !== "matching" || !stored) {
    try {
      await deleteAppointmentEvent(fetch, token, calendarId, eventId);
    } catch {
      // Best-effort cleanup when the stored event could not be classified.
    }
    throw new Error("The stored verification event could not be read from the authorized account.");
  }
  await deleteAppointmentEvent(fetch, token, calendarId, eventId);
  process.stdout.write("Deleted the verification event (sendUpdates=none).\n");
  process.stdout.write("Notification proof passed on the authorized account.\n");
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
  } else if (command === "verify-booking") {
    await verifyBooking();
  } else {
    process.stderr.write(
      "Usage: calendar-setup.ts <auth-url|auth|list|select|verify-booking>\n",
    );
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(
    `calendar-setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
