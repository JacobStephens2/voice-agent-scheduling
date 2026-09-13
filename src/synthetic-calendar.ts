import { isIsoDate, weekdayInTimeZone, zonedDateTime } from "./time.js";

export interface SyntheticAvailabilitySlot {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly durationMinutes: number;
  readonly isSynthetic: true;
}

export interface SyntheticAvailabilityResult {
  readonly status: "available" | "unavailable";
  readonly isSynthetic: true;
  readonly timezone: string;
  readonly slots: readonly SyntheticAvailabilitySlot[];
  readonly reason?: string;
  readonly message: string;
}

export interface ToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
}

export interface ExecuteOptions {
  readonly referenceTime?: Date;
}

export interface SyntheticAvailabilityTool {
  definition(): ToolDefinition;
  execute(
    args: { date?: string },
    options?: ExecuteOptions,
  ): SyntheticAvailabilityResult;
}

const DEFAULT_TIMEZONE = "America/New_York";
const MIN_NOTICE_MS = 72 * 60 * 60 * 1000;
const MAX_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const SYNTHETIC_TIMES = [
  { startTime: "10:00", endTime: "10:30" },
  { startTime: "11:30", endTime: "12:00" },
  { startTime: "14:00", endTime: "14:30" },
  { startTime: "15:30", endTime: "16:00" },
] as const;

function unavailable(
  timezone: string,
  reason: string,
  message: string,
): SyntheticAvailabilityResult {
  return {
    status: "unavailable",
    isSynthetic: true,
    timezone,
    slots: [],
    reason,
    message,
  };
}

export function createSyntheticAvailabilityTool(
  options: { defaultTimezone?: string } = {},
): SyntheticAvailabilityTool {
  const timezone = options.defaultTimezone ?? DEFAULT_TIMEZONE;

  return {
    definition(): ToolDefinition {
      return {
        type: "function",
        name: "check_availability",
        description:
          "Check Jacob's appointment availability for a date in Eastern time. Currently in synthetic test mode; returned slots are synthetic and do not represent a real appointment.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "The date to check in YYYY-MM-DD format.",
            },
          },
          required: ["date"],
        },
      };
    },

    execute(args, execOptions): SyntheticAvailabilityResult {
      const now = execOptions?.referenceTime ?? new Date();
      if (!args.date) {
        return unavailable(timezone, "date_required", "Please specify a date to check availability.");
      }
      if (!isIsoDate(args.date) || !zonedDateTime(args.date, "12:00", timezone)) {
        return unavailable(
          timezone,
          "invalid_date",
          `Invalid date '${args.date}'. Please provide YYYY-MM-DD.`,
        );
      }

      const weekday = weekdayInTimeZone(args.date, timezone);
      if (weekday === "Sat" || weekday === "Sun") {
        return unavailable(
          timezone,
          "weekend_not_permitted",
          "Appointments are only available Monday through Friday, 10:00 AM to 5:00 PM Eastern.",
        );
      }

      const earliestPermitted = now.getTime() + MIN_NOTICE_MS;
      const latestPermitted = now.getTime() + MAX_HORIZON_MS;
      const lastStart = zonedDateTime(args.date, "16:30", timezone);
      const firstStart = zonedDateTime(args.date, "10:00", timezone);
      if (!lastStart || !firstStart) {
        return unavailable(timezone, "invalid_date", `Invalid date '${args.date}'.`);
      }

      if (lastStart.getTime() < earliestPermitted) {
        return unavailable(
          timezone,
          "notice_insufficient",
          "Appointments require at least 72 hours advance notice. Please select a date further in the future.",
        );
      }
      if (firstStart.getTime() > latestPermitted) {
        return unavailable(
          timezone,
          "beyond_horizon",
          "Appointments can only be scheduled up to 14 days in advance.",
        );
      }

      const slots: SyntheticAvailabilitySlot[] = [];
      for (const time of SYNTHETIC_TIMES) {
        const start = zonedDateTime(args.date, time.startTime, timezone);
        if (!start) {
          continue;
        }
        if (start.getTime() < earliestPermitted || start.getTime() > latestPermitted) {
          continue;
        }
        slots.push({
          date: args.date,
          startTime: time.startTime,
          endTime: time.endTime,
          timezone,
          durationMinutes: 30,
          isSynthetic: true,
        });
      }

      if (slots.length === 0) {
        return unavailable(
          timezone,
          "no_slots_available",
          `No synthetic availability on ${args.date} that meets the 72-hour advance notice requirement.`,
        );
      }

      return {
        status: "available",
        isSynthetic: true,
        timezone,
        slots,
        message: `Synthetic availability for ${args.date}: ${slots.map((slot) => slot.startTime).join(", ")} Eastern Time. Synthetic test mode — no actual appointment is booked.`,
      };
    },
  };
}
