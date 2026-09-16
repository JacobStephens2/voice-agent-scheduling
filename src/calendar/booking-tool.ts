import { randomBytes } from "node:crypto";
import { extractE164 } from "../admission.js";
import { zonedDateTime } from "../time.js";
import {
  createTokenProvider,
  loadCredentials,
  type AccessTokenProvider,
  type GoogleOAuthCredentials,
} from "./auth.js";
import {
  appendBookingRecord,
  latestForProposal,
  loadBookingRecords,
  type BookingRecord,
} from "./booking-store.js";
import { createAppointmentEvent, queryBusyIntervals } from "./client.js";
import { computeAvailableStarts, SCHEDULING_TIMEZONE } from "./policy.js";
import { loadSelection, requiredCalendarIds, type CalendarSelection } from "./selection.js";

export interface BookingIds {
  readonly operationId: string;
  readonly eventId: string;
}

export interface AppointmentProposal {
  readonly proposalId: string;
  readonly callId: string;
  readonly callerName: string;
  readonly callbackNumber: string;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: typeof SCHEDULING_TIMEZONE;
  readonly purpose?: string;
}

export interface ProposeResult {
  readonly status: "proposed" | "invalid";
  readonly proposalId?: string;
  readonly readback?: {
    readonly callerName: string;
    readonly callbackNumber: string;
    readonly date: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly timezone: typeof SCHEDULING_TIMEZONE;
    readonly purpose?: string;
  };
  readonly message: string;
}

export interface ConfirmResult {
  readonly status: "booked" | "not_confirmed" | "no_proposal" | "unavailable" | "failed";
  readonly operationId?: string;
  readonly eventId?: string;
  readonly eventExists?: boolean;
  readonly message: string;
}

export type BookingToolResult = ProposeResult | ConfirmResult;

export interface AppointmentBooking {
  definitions(): Array<{
    readonly type: "function";
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Record<string, unknown>;
      readonly required: readonly string[];
    };
  }>;
  execute(
    name: string,
    args: Record<string, unknown>,
    options: { callId: string; referenceTime?: Date },
  ): Promise<BookingToolResult>;
  release(callId: string): void;
}

export interface BookingToolOptions {
  readonly fetchFn?: typeof fetch;
  readonly credentials?: GoogleOAuthCredentials | null;
  readonly tokenProvider?: AccessTokenProvider;
  readonly selection?: CalendarSelection | null;
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly createIds?: () => BookingIds;
}

const E164 = /^\+\d{8,15}$/;

function newHexId(): string {
  return randomBytes(16).toString("hex");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function invalid(message: string): ProposeResult {
  return { status: "invalid", message };
}

export function createAppointmentBooking(
  options: BookingToolOptions = {},
): AppointmentBooking {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const createIds = options.createIds ?? (() => ({ operationId: newHexId(), eventId: newHexId() }));
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
  const proposals = new Map<string, AppointmentProposal>();
  const records: BookingRecord[] = options.dataDir ? loadBookingRecords(options.dataDir) : [];
  let queue: Promise<unknown> = Promise.resolve();

  const persist = (record: BookingRecord): void => {
    records.push(record);
    if (options.dataDir) {
      appendBookingRecord(options.dataDir, record);
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    definitions() {
      return [
        {
          type: "function",
          name: "propose_appointment",
          description:
            "Record the caller's chosen 30-minute appointment for readback. Call this after collecting their name, a callback number they have confirmed (which may differ from the number that placed this call), the chosen date and Eastern start time, and an optional purpose. Do not request an email address. This does not create the calendar event. A new proposal replaces any earlier one for this call.",
          parameters: {
            type: "object",
            properties: {
              callerName: {
                type: "string",
                description: "The caller's name as they gave it.",
              },
              callbackNumber: {
                type: "string",
                description:
                  "The phone number the caller spoke and confirmed for Jacob to call.",
              },
              callbackConfirmed: {
                type: "boolean",
                description: "True only after the caller confirmed the callback number aloud.",
              },
              date: {
                type: "string",
                description: "Appointment date in YYYY-MM-DD.",
              },
              startTime: {
                type: "string",
                description: "Eastern start time in HH:MM, on the hour or half-hour.",
              },
              purpose: {
                type: "string",
                description: "Optional short purpose for the appointment.",
              },
            },
            required: ["callerName", "callbackNumber", "callbackConfirmed", "date", "startTime"],
          },
        },
        {
          type: "function",
          name: "confirm_appointment",
          description:
            "Create the current proposed appointment after you have finished the complete readback and the caller has explicitly agreed. Do not call this for unclear assent, background speech, an interrupted readback, or a refusal. Success means the calendar event exists; then tell the caller Jacob will call the confirmed callback number.",
          parameters: {
            type: "object",
            properties: {
              confirmed: {
                type: "boolean",
                description:
                  "True only when the caller explicitly agreed to the current readback.",
              },
            },
            required: ["confirmed"],
          },
        },
      ];
    },

    async execute(name, args, execOptions): Promise<BookingToolResult> {
      if (name === "propose_appointment") {
        return propose(args, execOptions, { now, proposals });
      }
      if (name === "confirm_appointment") {
        return enqueue(() =>
          confirm(args, execOptions, {
            proposals,
            persist,
            records,
            fetchFn,
            now,
            createIds,
            tokenProvider,
            selection: explicitSelection,
          }),
        );
      }
      return {
        status: "failed",
        message: "Unknown booking tool.",
      };
    },

    release(callId) {
      proposals.delete(callId);
    },
  };
}

function propose(
  args: Record<string, unknown>,
  execOptions: { callId: string; referenceTime?: Date },
  ctx: {
    now: () => Date;
    proposals: Map<string, AppointmentProposal>;
  },
): ProposeResult {
  const callerName = asString(args.callerName);
  if (!callerName) {
    return invalid("Please ask the caller for their name before proposing an appointment.");
  }
  if (args.callbackConfirmed !== true) {
    return invalid(
      "Ask the caller to confirm the callback number aloud before proposing the appointment.",
    );
  }
  const rawNumber = asString(args.callbackNumber);
  const callbackNumber = rawNumber ? extractE164(rawNumber) : "";
  if (!E164.test(callbackNumber)) {
    return invalid(
      "I could not understand that callback number. Ask the caller to repeat it, including the area code.",
    );
  }
  const date = asString(args.date);
  const startTime = asString(args.startTime);
  if (!date || !startTime) {
    return invalid("Please include the chosen date and Eastern start time.");
  }
  const referenceTime = execOptions.referenceTime ?? ctx.now();
  const permitted = computeAvailableStarts({ date, now: referenceTime, busy: [] });
  const slot = permitted.find((entry) => entry.startTime === startTime);
  if (!slot) {
    return invalid(
      "That time is not a permitted 30-minute weekday start in Eastern Time. Check availability and propose an offered time.",
    );
  }
  const purpose = asString(args.purpose);
  const proposal: AppointmentProposal = {
    proposalId: newHexId(),
    callId: execOptions.callId,
    callerName,
    callbackNumber,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone: SCHEDULING_TIMEZONE,
    ...(purpose ? { purpose } : {}),
  };
  ctx.proposals.set(execOptions.callId, proposal);
  const purposeLine = purpose ? ` Purpose: ${purpose}.` : "";
  return {
    status: "proposed",
    proposalId: proposal.proposalId,
    readback: {
      callerName,
      callbackNumber,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      timezone: SCHEDULING_TIMEZONE,
      ...(purpose ? { purpose } : {}),
    },
    message: `Please read back: ${callerName}, callback ${callbackNumber}, ${slot.date} ${slot.startTime}–${slot.endTime} ${SCHEDULING_TIMEZONE}.${purposeLine} Wait for explicit agreement before confirming.`,
  };
}

function bookedResult(record: BookingRecord, callbackNumber: string): ConfirmResult {
  return {
    status: "booked",
    operationId: record.operationId,
    eventId: record.eventId,
    eventExists: true,
    message: `The appointment is booked. Jacob will call ${callbackNumber} at the agreed time. Do not send any automated callback, message, or email.`,
  };
}

async function confirm(
  args: Record<string, unknown>,
  execOptions: { callId: string; referenceTime?: Date },
  ctx: {
    proposals: Map<string, AppointmentProposal>;
    persist: (record: BookingRecord) => void;
    records: BookingRecord[];
    fetchFn: typeof fetch;
    now: () => Date;
    createIds: () => BookingIds;
    tokenProvider: AccessTokenProvider | undefined;
    selection: CalendarSelection | undefined;
  },
): Promise<ConfirmResult> {
  const proposal = ctx.proposals.get(execOptions.callId);
  if (!proposal) {
    return {
      status: "no_proposal",
      message: "There is no current appointment proposal on this call to confirm.",
    };
  }
  if (args.confirmed !== true) {
    return {
      status: "not_confirmed",
      message:
        "Do not create the appointment. Finish the full readback and wait for the caller's explicit agreement.",
    };
  }

  const existing = latestForProposal(ctx.records, proposal.proposalId);
  if (existing?.status === "booked") {
    return bookedResult(existing, proposal.callbackNumber);
  }

  if (!ctx.selection) {
    return {
      status: "failed",
      message: "Jacob's scheduling calendars have not been selected yet. Do not claim the appointment is booked.",
    };
  }
  if (!ctx.tokenProvider) {
    return {
      status: "failed",
      message: "Jacob's calendar is not connected right now. Do not claim the appointment is booked.",
    };
  }

  const referenceTime = execOptions.referenceTime ?? ctx.now();
  const dayStart = zonedDateTime(proposal.date, "00:00", SCHEDULING_TIMEZONE);
  const dayEnd = zonedDateTime(proposal.date, "23:59", SCHEDULING_TIMEZONE);
  const start = zonedDateTime(proposal.date, proposal.startTime, SCHEDULING_TIMEZONE);
  if (!dayStart || !dayEnd || !start) {
    return {
      status: "failed",
      message: "The proposed appointment time could not be understood. Do not claim it is booked.",
    };
  }

  const generated = existing
    ? { operationId: existing.operationId, eventId: existing.eventId }
    : ctx.createIds();
  const calendarId = ctx.selection.primaryCalendarId;

  const record = (status: BookingRecord["status"]): BookingRecord => ({
    operationId: generated.operationId,
    eventId: generated.eventId,
    callId: proposal.callId,
    proposalId: proposal.proposalId,
    calendarId,
    startUtc: start.toISOString(),
    status,
    recordedAt: new Date().toISOString(),
  });

  if (!existing) {
    ctx.persist(record("pending"));
  }

  try {
    const accessToken = await ctx.tokenProvider.getAccessToken();
    const busy = await queryBusyIntervals(ctx.fetchFn, accessToken, {
      calendarIds: requiredCalendarIds(ctx.selection),
      timeMin: dayStart,
      timeMax: dayEnd,
    });
    const stillOpen = computeAvailableStarts({
      date: proposal.date,
      now: referenceTime,
      busy,
    }).some((slot) => slot.startTime === proposal.startTime);
    if (!stillOpen) {
      ctx.persist(record("unavailable"));
      ctx.proposals.delete(execOptions.callId);
      return {
        status: "unavailable",
        operationId: generated.operationId,
        eventId: generated.eventId,
        eventExists: false,
        message:
          "That time is no longer available. Offer fresh alternatives from check_availability. Do not claim the appointment is booked.",
      };
    }

    const stored = await createAppointmentEvent(ctx.fetchFn, accessToken, {
      calendarId,
      eventId: generated.eventId,
      callerName: proposal.callerName,
      callbackNumber: proposal.callbackNumber,
      purpose: proposal.purpose,
      date: proposal.date,
      startTime: proposal.startTime,
    });
    if (!stored.id) {
      throw new Error("missing stored event");
    }
    const booked = record("booked");
    ctx.persist(booked);
    return bookedResult(booked, proposal.callbackNumber);
  } catch {
    ctx.persist(record("failed"));
    return {
      status: "failed",
      operationId: generated.operationId,
      eventId: generated.eventId,
      eventExists: false,
      message:
        "The calendar event could not be confirmed. Do not tell the caller the appointment is booked.",
    };
  }
}
