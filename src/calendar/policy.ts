import { isValidCalendarDate, weekdayInTimeZone, zonedDateTime } from "../time.js";

export const SCHEDULING_TIMEZONE = "America/New_York";
export const APPOINTMENT_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_NOTICE_MS = 72 * 60 * 60 * 1000;
const MAX_HORIZON_MS = 14 * DAY_MS;
const FIRST_START = "10:00";
const LAST_START = "16:30";

export interface BusyInterval {
  readonly start: Date;
  readonly end: Date;
  /** Free/busy busy blocks are opaque; events marked free arrive as transparent and never block. */
  readonly transparency?: "opaque" | "transparent";
}

export interface AppointmentStart {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: typeof SCHEDULING_TIMEZONE;
  readonly durationMinutes: typeof APPOINTMENT_MINUTES;
  readonly startUtc: string;
  readonly isSynthetic: false;
}

interface PreparedBookingDay {
  readonly window: "open" | "weekend_not_permitted" | "notice_insufficient" | "beyond_horizon";
  readonly freeBusyBounds: { readonly timeMin: Date; readonly timeMax: Date };
  nominalStart(startTime: string): AppointmentStart | undefined;
  eligibleStarts(busy?: readonly BusyInterval[]): readonly AppointmentStart[];
}

export function endTimeOf(startTime: string): string {
  const hour = Number(startTime.slice(0, 2));
  const minute = Number(startTime.slice(3));
  if (minute === 0) {
    return `${String(hour).padStart(2, "0")}:30`;
  }
  return `${String(hour + 1).padStart(2, "0")}:00`;
}

/** End of an Appointment in epoch milliseconds, or NaN for an unparseable start. */
export function appointmentEndMs(startUtc: string): number {
  return Date.parse(startUtc) + APPOINTMENT_MINUTES * 60_000;
}

export function prepareBookingDay(
  date: string,
  referenceTime: Date,
): PreparedBookingDay | { readonly window: "invalid_date" } {
  if (!isValidCalendarDate(date)) {
    return { window: "invalid_date" };
  }
  const weekday = weekdayInTimeZone(date, SCHEDULING_TIMEZONE);
  const timeMin = zonedDateTime(date, "00:00", SCHEDULING_TIMEZONE);
  const timeMax = zonedDateTime(date, "23:59", SCHEDULING_TIMEZONE);
  if (!weekday || !timeMin || !timeMax) {
    return { window: "invalid_date" };
  }

  const nominalStarts: AppointmentStart[] = [];
  if (weekday !== "Sat" && weekday !== "Sun") {
    for (let startTime = FIRST_START; startTime <= LAST_START; startTime = endTimeOf(startTime)) {
      const instant = zonedDateTime(date, startTime, SCHEDULING_TIMEZONE);
      if (!instant) {
        return { window: "invalid_date" };
      }
      nominalStarts.push({
        date,
        startTime,
        endTime: endTimeOf(startTime),
        timezone: SCHEDULING_TIMEZONE,
        durationMinutes: APPOINTMENT_MINUTES,
        startUtc: instant.toISOString(),
        isSynthetic: false,
      });
    }
  }

  const referenceMs = referenceTime.getTime();
  const earliestPermitted = referenceMs + MIN_NOTICE_MS;
  const latestPermitted = referenceMs + MAX_HORIZON_MS;
  const first = nominalStarts[0];
  const last = nominalStarts.at(-1);
  let window: PreparedBookingDay["window"] = "open";
  if (!first || !last) {
    window = "weekend_not_permitted";
  } else if (Date.parse(last.startUtc) < earliestPermitted) {
    window = "notice_insufficient";
  } else if (Date.parse(first.startUtc) > latestPermitted) {
    window = "beyond_horizon";
  }

  const eligible = nominalStarts.filter(({ startUtc }) => {
    const startMs = Date.parse(startUtc);
    return startMs >= earliestPermitted && startMs <= latestPermitted;
  });

  return {
    window,
    freeBusyBounds: { timeMin, timeMax },
    nominalStart(startTime) {
      return nominalStarts.find((slot) => slot.startTime === startTime);
    },
    eligibleStarts(busy = []) {
      const blocking = busy.filter((interval) => interval.transparency !== "transparent");
      return eligible.filter(({ startUtc }) => {
        const startMs = Date.parse(startUtc);
        const endMs = appointmentEndMs(startUtc);
        return !blocking.some(
          (interval) => startMs < interval.end.getTime() && interval.start.getTime() < endMs,
        );
      });
    },
  };
}

/** Select the first eligible start for verification, before applying Calendar busy intervals. */
export function firstVerificationStart(referenceTime: Date): AppointmentStart {
  const easternDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const referenceMs = referenceTime.getTime();
  for (let offset = MIN_NOTICE_MS; offset <= MAX_HORIZON_MS; offset += DAY_MS) {
    const date = easternDate.format(new Date(referenceMs + offset));
    const day = prepareBookingDay(date, referenceTime);
    const start = day.window === "open" ? day.eligibleStarts()[0] : undefined;
    if (start) {
      return start;
    }
  }
  throw new Error("No permitted weekday slot in the booking window.");
}
