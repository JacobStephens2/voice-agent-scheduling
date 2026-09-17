import { zonedDateTime } from "../time.js";
import { endTimeOf, SCHEDULING_TIMEZONE, type BusyInterval } from "./policy.js";
import { CalendarAuthError } from "./auth.js";

type FetchFn = typeof fetch;

export interface CalendarValidation {
  readonly id: string;
  readonly reachable: boolean;
  readonly error?: string;
}

export class CalendarQueryError extends Error {
  readonly kind: "auth" | "required_calendar" | "transport" | "not_found";
  constructor(kind: CalendarQueryError["kind"], message: string) {
    super(message);
    this.name = "CalendarQueryError";
    this.kind = kind;
  }
}

const UNAVAILABLE_MESSAGE = "Could not reach Google Calendar. Calendar data is unavailable.";
const AUTH_MESSAGE =
  "Google Calendar authorization failed. Calendar data is unavailable.";

function throwForHttpStatus(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new CalendarQueryError("auth", AUTH_MESSAGE);
  }
  if (!response.ok) {
    throw new CalendarQueryError("transport", UNAVAILABLE_MESSAGE);
  }
}

async function readJsonBody(response: Response): Promise<{ [key: string]: unknown }> {
  try {
    return (await response.json()) as { [key: string]: unknown };
  } catch {
    throw new CalendarQueryError("transport", UNAVAILABLE_MESSAGE);
  }
}

function toAuthOrTransport(error: unknown): CalendarQueryError {
  if (error instanceof CalendarAuthError) {
    return new CalendarQueryError(
      "auth",
      "Google Calendar authorization failed. Calendar data is unavailable.",
    );
  }
  if (error instanceof CalendarQueryError) {
    return error;
  }
  return new CalendarQueryError(
    "transport",
    "Could not reach Google Calendar. Calendar data is unavailable.",
  );
}

function firstErrorReason(entry: { errors?: unknown }): string {
  if (Array.isArray(entry.errors)) {
    const first = entry.errors[0] as { reason?: unknown } | undefined;
    if (first && typeof first.reason === "string" && first.reason) {
      return first.reason;
    }
  }
  return "unknown";
}

/**
 * Validate candidate calendar IDs so Jacob can select the destination and
 * every conflict calendar. Uses freeBusy, which the minimal Calendar scopes
 * authorize: calendarList would need a broader read scope, so browsing by
 * name is unavailable. Reports per-calendar reachability only; no event
 * content is read.
 */
export async function validateCalendars(
  fetchFn: FetchFn,
  accessToken: string,
  calendarIds: readonly string[],
): Promise<CalendarValidation[]> {
  const timeMin = new Date();
  const timeMax = new Date(timeMin.getTime() + 24 * 60 * 60 * 1000);
  let response: Response;
  try {
    response = await fetchFn("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: SCHEDULING_TIMEZONE,
        items: calendarIds.map((id) => ({ id })),
      }),
    });
  } catch (error) {
    throw toAuthOrTransport(error);
  }
  throwForHttpStatus(response);
  const payload = await readJsonBody(response);
  if (typeof payload.calendars !== "object" || payload.calendars === null) {
    throw new CalendarQueryError("transport", UNAVAILABLE_MESSAGE);
  }
  const calendars = payload.calendars as Record<string, unknown>;
  return calendarIds.map((id) => {
    const entry = calendars[id] as { errors?: unknown } | undefined;
    if (!entry || entry.errors !== undefined) {
      return { id, reachable: false, error: firstErrorReason(entry ?? {}) };
    }
    return { id, reachable: true };
  });
}

interface FreeBusyEntry {
  readonly start?: unknown;
  readonly end?: unknown;
  readonly transparency?: unknown;
}

/** Resolve a free/busy bound; date-only edges expand to midnight Eastern. */
function resolveBound(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) {
    return zonedDateTime(dateOnly[1]!, "00:00", SCHEDULING_TIMEZONE);
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

function toBusyIntervals(entries: readonly FreeBusyEntry[]): BusyInterval[] {
  const intervals: BusyInterval[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    if (entry.transparency === "transparent") {
      continue;
    }
    const start = resolveBound(entry.start);
    const end = resolveBound(entry.end);
    if (start && end && start < end) {
      intervals.push({ start, end, transparency: "opaque" });
    }
  }
  return intervals;
}

/**
 * Read busy intervals for every required calendar. Free/busy omits events
 * marked free, so those never block. Any per-calendar error fails the whole
 * query: partial data must never be presented as an empty schedule.
 */
export async function queryBusyIntervals(
  fetchFn: FetchFn,
  accessToken: string,
  options: {
    readonly calendarIds: readonly string[];
    readonly timeMin: Date;
    readonly timeMax: Date;
  },
): Promise<BusyInterval[]> {
  let response: Response;
  try {
    response = await fetchFn("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: options.timeMin.toISOString(),
        timeMax: options.timeMax.toISOString(),
        timeZone: SCHEDULING_TIMEZONE,
        items: options.calendarIds.map((id) => ({ id })),
      }),
    });
  } catch (error) {
    throw toAuthOrTransport(error);
  }
  throwForHttpStatus(response);
  const payload = await readJsonBody(response);
  if (typeof payload.calendars !== "object" || payload.calendars === null) {
    throw new CalendarQueryError("transport", UNAVAILABLE_MESSAGE);
  }
  const calendars = payload.calendars as Record<string, unknown>;
  const merged: BusyInterval[] = [];
  for (const id of options.calendarIds) {
    const entry = calendars[id] as { errors?: unknown; busy?: unknown } | undefined;
    if (!entry || entry.errors !== undefined) {
      throw new CalendarQueryError(
        "required_calendar",
        "One of Jacob's required calendars could not be read. Calendar data is unavailable.",
      );
    }
    if (Array.isArray(entry.busy)) {
      merged.push(...toBusyIntervals(entry.busy as FreeBusyEntry[]));
    }
  }
  return merged;
}

export interface StoredCalendarEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly start?: { dateTime?: string; timeZone?: string };
  readonly end?: { dateTime?: string; timeZone?: string };
  readonly transparency?: string;
  readonly attendees: readonly unknown[];
  readonly hangoutLink?: string;
  readonly conferenceData?: unknown;
  readonly reminders?: {
    readonly useDefault?: boolean;
    readonly overrides?: readonly { readonly method?: string; readonly minutes?: number }[];
  };
}

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

function appointmentDescription(callbackNumber: string, purpose?: string): string {
  if (purpose && purpose.trim()) {
    return `Callback number: ${callbackNumber}\nPurpose: ${purpose.trim()}`;
  }
  return `Callback number: ${callbackNumber}`;
}

/** Account-level notification fields from GET, not from the insert request. */
export function appointmentNotificationProof(event: StoredCalendarEvent): {
  readonly hasAttendees: boolean;
  readonly hasHangoutLink: boolean;
  readonly hasConferenceData: boolean;
  readonly hasEmailReminder: boolean;
  readonly popupReminderMinutes: readonly number[];
  readonly matchesApprovedShape: boolean;
} {
  const overrides = event.reminders?.overrides ?? [];
  const hasEmailReminder = overrides.some((item) => item.method === "email");
  const popupReminderMinutes = overrides
    .filter((item) => item.method === "popup")
    .map((item) => item.minutes ?? 0);
  const hasAttendees = event.attendees.length > 0;
  const hasHangoutLink = Boolean(event.hangoutLink);
  const hasConferenceData = event.conferenceData !== undefined && event.conferenceData !== null;
  return {
    hasAttendees,
    hasHangoutLink,
    hasConferenceData,
    hasEmailReminder,
    popupReminderMinutes,
    matchesApprovedShape:
      !hasAttendees &&
      !hasHangoutLink &&
      !hasConferenceData &&
      !hasEmailReminder &&
      event.reminders?.useDefault === false &&
      overrides.length === 1 &&
      popupReminderMinutes.length === 1 &&
      popupReminderMinutes[0] === 10 &&
      (!event.transparency || event.transparency === "opaque") &&
      Boolean(event.summary?.startsWith("Appointment with ")),
  };
}

function storedAppointmentMatchesPolicy(event: StoredCalendarEvent): boolean {
  return appointmentNotificationProof(event).matchesApprovedShape;
}

function asStoredEvent(payload: { [key: string]: unknown }): StoredCalendarEvent {
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const reminders =
    payload.reminders && typeof payload.reminders === "object"
      ? (payload.reminders as StoredCalendarEvent["reminders"])
      : undefined;
  return {
    id: typeof payload.id === "string" ? payload.id : "",
    status: typeof payload.status === "string" ? payload.status : undefined,
    summary: typeof payload.summary === "string" ? payload.summary : undefined,
    description: typeof payload.description === "string" ? payload.description : undefined,
    start:
      payload.start && typeof payload.start === "object"
        ? (payload.start as StoredCalendarEvent["start"])
        : undefined,
    end:
      payload.end && typeof payload.end === "object"
        ? (payload.end as StoredCalendarEvent["end"])
        : undefined,
    transparency: typeof payload.transparency === "string" ? payload.transparency : undefined,
    attendees,
    hangoutLink: typeof payload.hangoutLink === "string" ? payload.hangoutLink : undefined,
    conferenceData: payload.conferenceData,
    reminders,
  };
}

/**
 * Read one event as stored on the account. Used after insert so callers
 * observe account-level fields (attendees, Meet, reminders), not the
 * insert request parameters.
 */
export async function getAppointmentEvent(
  fetchFn: FetchFn,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<StoredCalendarEvent> {
  let response: Response;
  try {
    response = await fetchFn(eventsUrl(calendarId, eventId), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    throw toAuthOrTransport(error);
  }
  // A missing event is a reconciled absence, not an unreachable Calendar:
  // callers distinguish "no event under this identity" from transport/auth
  // failures so an uncertain write is never reported as a false success.
  if (response.status === 404 || response.status === 410) {
    throw new CalendarQueryError("not_found", "The calendar event was not found.");
  }
  throwForHttpStatus(response);
  const payload = await readJsonBody(response);
  const stored = asStoredEvent(payload);
  if (!stored.id) {
    throw new CalendarQueryError("transport", UNAVAILABLE_MESSAGE);
  }
  return stored;
}

/**
 * Insert a 30-minute busy appointment with the approved notification
 * shape, then GET it. Success is the stored event, not the insert body.
 */
export async function createAppointmentEvent(
  fetchFn: FetchFn,
  accessToken: string,
  options: {
    readonly calendarId: string;
    readonly eventId: string;
    readonly callerName: string;
    readonly callbackNumber: string;
    readonly purpose?: string;
    readonly date: string;
    readonly startTime: string;
  },
): Promise<StoredCalendarEvent> {
  const endTime = endTimeOf(options.startTime);
  const body = {
    id: options.eventId,
    summary: `Appointment with ${options.callerName}`,
    description: appointmentDescription(options.callbackNumber, options.purpose),
    start: {
      dateTime: `${options.date}T${options.startTime}:00`,
      timeZone: SCHEDULING_TIMEZONE,
    },
    end: {
      dateTime: `${options.date}T${endTime}:00`,
      timeZone: SCHEDULING_TIMEZONE,
    },
    transparency: "opaque",
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    },
  };
  let response: Response;
  try {
    response = await fetchFn(`${eventsUrl(options.calendarId)}?sendUpdates=none`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw toAuthOrTransport(error);
  }
  if (response.status === 409) {
    return readMatchingAppointment(
      fetchFn,
      accessToken,
      options.calendarId,
      options.eventId,
    );
  }
  throwForHttpStatus(response);
  return readMatchingAppointment(fetchFn, accessToken, options.calendarId, options.eventId);
}

async function readMatchingAppointment(
  fetchFn: FetchFn,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<StoredCalendarEvent> {
  const stored = await getAppointmentEvent(fetchFn, accessToken, calendarId, eventId);
  if (!storedAppointmentMatchesPolicy(stored)) {
    throw new CalendarQueryError(
      "transport",
      "The stored calendar event does not match the approved appointment shape.",
    );
  }
  return stored;
}

export async function deleteAppointmentEvent(
  fetchFn: FetchFn,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(`${eventsUrl(calendarId, eventId)}?sendUpdates=none`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    throw toAuthOrTransport(error);
  }
  if (response.status === 404 || response.status === 410) {
    return;
  }
  throwForHttpStatus(response);
}
