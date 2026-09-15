import { isValidCalendarDate, weekdayInTimeZone, zonedDateTime } from "../time.js";

export const SCHEDULING_TIMEZONE = "America/New_York";
export const APPOINTMENT_MINUTES = 30;
export const MIN_NOTICE_MS = 72 * 60 * 60 * 1000;
export const MAX_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const FIRST_START = "10:00";
const LAST_START = "16:30";

export interface BusyInterval {
  readonly start: Date;
  readonly end: Date;
  /** Free/busy busy blocks are opaque; events marked free arrive as transparent and never block. */
  readonly transparency?: "opaque" | "transparent";
}

export interface AvailableStart {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: typeof SCHEDULING_TIMEZONE;
  readonly durationMinutes: typeof APPOINTMENT_MINUTES;
  readonly startUtc: string;
  readonly isSynthetic: false;
}

function endTimeOf(startTime: string): string {
  const hour = Number(startTime.slice(0, 2));
  const minute = Number(startTime.slice(3));
  if (minute === 0) {
    return `${String(hour).padStart(2, "0")}:30`;
  }
  return `${String(hour + 1).padStart(2, "0")}:00`;
}

export function computeAvailableStarts(options: {
  readonly date: string;
  readonly now: Date;
  readonly busy: readonly BusyInterval[];
}): AvailableStart[] {
  if (!isValidCalendarDate(options.date)) {
    return [];
  }
  const weekday = weekdayInTimeZone(options.date, SCHEDULING_TIMEZONE);
  if (weekday === undefined || weekday === "Sat" || weekday === "Sun") {
    return [];
  }

  const earliestPermitted = options.now.getTime() + MIN_NOTICE_MS;
  const latestPermitted = options.now.getTime() + MAX_HORIZON_MS;
  const blocking = options.busy.filter((interval) => interval.transparency !== "transparent");

  const slots: AvailableStart[] = [];
  let cursor = FIRST_START;
  while (cursor <= LAST_START) {
    const start = zonedDateTime(options.date, cursor, SCHEDULING_TIMEZONE);
    if (start) {
      const end = new Date(start.getTime() + APPOINTMENT_MINUTES * 60_000);
      const inWindow =
        start.getTime() >= earliestPermitted && start.getTime() <= latestPermitted;
      const overlaps = blocking.some(
        (interval) => start < interval.end && interval.start < end,
      );
      if (inWindow && !overlaps) {
        slots.push({
          date: options.date,
          startTime: cursor,
          endTime: endTimeOf(cursor),
          timezone: SCHEDULING_TIMEZONE,
          durationMinutes: APPOINTMENT_MINUTES,
          startUtc: start.toISOString(),
          isSynthetic: false,
        });
      }
    }
    cursor = endTimeOf(cursor);
  }
  return slots;
}
