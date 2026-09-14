import { zonedDateTime } from "../time.js";
import { SCHEDULING_TIMEZONE, type BusyInterval } from "./policy.js";
import { CalendarAuthError } from "./auth.js";

type FetchFn = typeof fetch;

export interface CalendarMetadata {
  readonly id: string;
  readonly summary: string;
  readonly primary: boolean;
  readonly accessRole: string;
}

export class CalendarQueryError extends Error {
  readonly kind: "auth" | "required_calendar" | "transport";
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

/**
 * Present calendar metadata so Jacob can select the destination and every
 * conflict calendar. Returns summaries and roles only; no event content.
 */
export async function listCalendars(
  fetchFn: FetchFn,
  accessToken: string,
): Promise<CalendarMetadata[]> {
  let response: Response;
  try {
    response = await fetchFn("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new CalendarQueryError("transport", UNAVAILABLE_MESSAGE);
  }
  throwForHttpStatus(response);
  const payload = await readJsonBody(response);
  if (!Array.isArray(payload.items)) {
    return [];
  }
  const calendars: CalendarMetadata[] = [];
  for (const item of payload.items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as { id?: unknown; summary?: unknown; primary?: unknown; accessRole?: unknown };
    if (typeof entry.id !== "string" || !entry.id) {
      continue;
    }
    calendars.push({
      id: entry.id,
      summary: typeof entry.summary === "string" ? entry.summary : entry.id,
      primary: entry.primary === true,
      accessRole: typeof entry.accessRole === "string" ? entry.accessRole : "unknown",
    });
  }
  return calendars;
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
