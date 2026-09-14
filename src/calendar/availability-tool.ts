import { formatTimeInZone, isIsoDate, weekdayInTimeZone, zonedDateTime } from "../time.js";
import {
  createTokenProvider,
  loadCredentials,
  type AccessTokenProvider,
  type GoogleOAuthCredentials,
} from "./auth.js";
import { queryBusyIntervals } from "./client.js";
import {
  MAX_HORIZON_MS,
  MIN_NOTICE_MS,
  SCHEDULING_TIMEZONE,
  computeAvailableStarts,
  type AvailableStart,
} from "./policy.js";
import { loadSelection, requiredCalendarIds, type CalendarSelection } from "./selection.js";

export interface OfferedAvailabilitySlot extends AvailableStart {
  readonly requestedStartTime?: string;
  readonly requestedEndTime?: string;
  readonly requestedTimezone?: string;
}

export type AvailabilityFailureReason =
  | "date_required"
  | "invalid_date"
  | "invalid_timezone"
  | "weekend_not_permitted"
  | "notice_insufficient"
  | "beyond_horizon"
  | "no_slots_available"
  | "calendars_not_selected"
  | "calendar_unavailable";

export interface CalendarAvailabilityResult {
  readonly status: "available" | "unavailable";
  readonly isSynthetic: false;
  readonly timezone: typeof SCHEDULING_TIMEZONE;
  readonly slots: readonly OfferedAvailabilitySlot[];
  readonly reason?: AvailabilityFailureReason;
  readonly message: string;
}

export interface CalendarAvailabilityTool {
  definition(): {
    readonly type: "function";
    readonly name: "check_availability";
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Record<string, unknown>;
      readonly required: readonly string[];
    };
  };
  execute(
    args: { date?: string; timezone?: string },
    options?: { referenceTime?: Date },
  ): Promise<CalendarAvailabilityResult>;
}

export interface CalendarToolOptions {
  readonly fetchFn?: typeof fetch;
  readonly credentials?: GoogleOAuthCredentials | null;
  readonly tokenProvider?: AccessTokenProvider;
  readonly selection?: CalendarSelection | null;
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly maxOptions?: number;
}

const DEFAULT_MAX_OPTIONS = 4;

function unavailable(
  reason: AvailabilityFailureReason,
  message: string,
): CalendarAvailabilityResult {
  return {
    status: "unavailable",
    isSynthetic: false,
    timezone: SCHEDULING_TIMEZONE,
    slots: [],
    reason,
    message,
  };
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function createCalendarAvailabilityTool(
  options: CalendarToolOptions = {},
): CalendarAvailabilityTool {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const maxOptions = options.maxOptions ?? DEFAULT_MAX_OPTIONS;
  const explicitCredentials =
    options.credentials === undefined
      ? loadCredentials({ env: options.env, dataDir: options.dataDir })
      : (options.credentials ?? undefined);
  const explicitSelection =
    options.selection === undefined
      ? loadSelection({ env: options.env, dataDir: options.dataDir })
      : (options.selection ?? undefined);
  const tokenProvider =
    options.tokenProvider ??
    (explicitCredentials ? createTokenProvider(explicitCredentials, fetchFn) : undefined);

  return {
    definition() {
      return {
        type: "function",
        name: "check_availability",
        description:
          "Check Jacob's real appointment availability for a date. Returns permitted 30-minute starts on that date in America/New_York; pass timezone to also show those starts in the caller's timezone. Offer only the returned times, name the timezone, and never describe Jacob's existing events.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "The date to check in YYYY-MM-DD format.",
            },
            timezone: {
              type: "string",
              description:
                "Optional IANA timezone the caller asked about, for example America/Chicago.",
            },
          },
          required: ["date"],
        },
      };
    },

    async execute(args, execOptions): Promise<CalendarAvailabilityResult> {
      const referenceTime = execOptions?.referenceTime ?? now();
      if (!args.date) {
        return unavailable(
          "date_required",
          "Please ask the caller which date they would like, and check that exact date.",
        );
      }
      if (!isIsoDate(args.date) || !zonedDateTime(args.date, "12:00", SCHEDULING_TIMEZONE)) {
        return unavailable(
          "invalid_date",
          `I could not understand '${args.date}' as a date. Please clarify the exact date with the caller and check again.`,
        );
      }
      const requestedTimezone = args.timezone?.trim() || undefined;
      if (requestedTimezone && !isValidTimezone(requestedTimezone)) {
        return unavailable(
          "invalid_timezone",
          `I could not understand '${args.timezone}' as a timezone. Please confirm the caller's timezone and check again.`,
        );
      }

      const weekday = weekdayInTimeZone(args.date, SCHEDULING_TIMEZONE);
      if (weekday === "Sat" || weekday === "Sun") {
        return unavailable(
          "weekend_not_permitted",
          "Appointments are only available Monday through Friday, 10:00 AM to 5:00 PM Eastern. Please ask the caller for a weekday date.",
        );
      }

      const earliestPermitted = referenceTime.getTime() + MIN_NOTICE_MS;
      const latestPermitted = referenceTime.getTime() + MAX_HORIZON_MS;
      const firstStart = zonedDateTime(args.date, "10:00", SCHEDULING_TIMEZONE);
      const lastStart = zonedDateTime(args.date, "16:30", SCHEDULING_TIMEZONE);
      if (!firstStart || !lastStart) {
        return unavailable("invalid_date", "Please clarify the exact date with the caller.");
      }
      if (lastStart.getTime() < earliestPermitted) {
        return unavailable(
          "notice_insufficient",
          "Appointments require at least 72 hours advance notice. Please ask the caller for a later date.",
        );
      }
      if (firstStart.getTime() > latestPermitted) {
        return unavailable(
          "beyond_horizon",
          "Appointments can only be scheduled up to 14 days in advance. Please ask the caller for an earlier date.",
        );
      }

      if (!explicitSelection) {
        return unavailable(
          "calendars_not_selected",
          "Jacob's scheduling calendars have not been selected yet. Calendar data is unavailable.",
        );
      }
      if (!tokenProvider) {
        return unavailable(
          "calendar_unavailable",
          "Jacob's calendar is not connected right now. Please invite the caller to try again later.",
        );
      }

      const dayStart = zonedDateTime(args.date, "00:00", SCHEDULING_TIMEZONE);
      const dayEnd = zonedDateTime(args.date, "23:59", SCHEDULING_TIMEZONE);
      let starts: AvailableStart[];
      try {
        const accessToken = await tokenProvider.getAccessToken();
        const busy = await queryBusyIntervals(fetchFn, accessToken, {
          calendarIds: requiredCalendarIds(explicitSelection),
          timeMin: dayStart ?? firstStart,
          timeMax: dayEnd ?? lastStart,
        });
        starts = computeAvailableStarts({ date: args.date, now: referenceTime, busy });
      } catch {
        return unavailable(
          "calendar_unavailable",
          "Jacob's calendar cannot be reached right now. Please invite the caller to try again later.",
        );
      }

      if (starts.length === 0) {
        return unavailable(
          "no_slots_available",
          `There is no availability on ${args.date} within the permitted weekday hours. Please offer another date.`,
        );
      }

      const offered = starts.slice(0, maxOptions).map((slot): OfferedAvailabilitySlot => {
        if (!requestedTimezone || requestedTimezone === SCHEDULING_TIMEZONE) {
          return slot;
        }
        const instant = zonedDateTime(slot.date, slot.startTime, SCHEDULING_TIMEZONE);
        const endInstant = instant
          ? new Date(instant.getTime() + slot.durationMinutes * 60_000)
          : undefined;
        const requestedStartTime = instant
          ? formatTimeInZone(instant, requestedTimezone)
          : undefined;
        const requestedEndTime = endInstant
          ? formatTimeInZone(endInstant, requestedTimezone)
          : undefined;
        if (!requestedStartTime || !requestedEndTime) {
          return slot;
        }
        return { ...slot, requestedStartTime, requestedEndTime, requestedTimezone };
      });

      const times = offered.map((slot) => slot.startTime).join(", ");
      const conversion =
        requestedTimezone && requestedTimezone !== SCHEDULING_TIMEZONE
          ? ` That is ${offered.map((slot) => slot.requestedStartTime).join(", ")} in ${requestedTimezone}.`
          : "";
      const more =
        starts.length > offered.length
          ? ` These are the earliest ${offered.length} of ${starts.length} available starts that day.`
          : "";
      return {
        status: "available",
        isSynthetic: false,
        timezone: SCHEDULING_TIMEZONE,
        slots: offered,
        message: `Available on ${args.date}: ${times} Eastern Time (${SCHEDULING_TIMEZONE}).${conversion}${more} Offer a few of these times by name.`,
      };
    },
  };
}
