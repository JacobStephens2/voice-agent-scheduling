import { randomBytes } from "node:crypto";
import { zonedDateTime } from "../time.js";
import {
  createTokenProvider,
  loadCredentials,
  type AccessTokenProvider,
  type GoogleOAuthCredentials,
} from "./auth.js";
import {
  createProposalStore,
  proposeAppointment,
  type ProposeResult,
  type ProposalStore,
} from "./booking-proposal.js";
import {
  appendBookingRecord,
  bookingRecord,
  latestForProposal,
  loadBookingRecords,
  type BookingRecord,
} from "./booking-store.js";
import { createAppointmentEvent, queryBusyIntervals } from "./client.js";
import { computeAvailableStarts, SCHEDULING_TIMEZONE } from "./policy.js";
import { loadSelection, requiredCalendarIds, type CalendarSelection } from "./selection.js";

export type { AppointmentProposal, ProposeResult } from "./booking-proposal.js";

export interface BookingIds {
  readonly operationId: string;
  readonly eventId: string;
}

export interface ConfirmResult {
  readonly status:
    | "booked"
    | "not_confirmed"
    | "no_proposal"
    | "readback_incomplete"
    | "unavailable"
    | "failed";
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
  markReadbackFinished(callId: string): void;
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
  readonly allowWrites?: boolean;
}

function newHexId(): string {
  return randomBytes(16).toString("hex");
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
  const proposals = createProposalStore();
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
            "Create the current proposed appointment after you have finished speaking the complete readback and the caller has explicitly agreed. Pass the proposalId from that proposal. Do not call this for unclear assent, background speech, an interrupted readback, or a refusal. Success means the calendar event exists; then tell the caller Jacob will call the confirmed callback number.",
          parameters: {
            type: "object",
            properties: {
              confirmed: {
                type: "boolean",
                description:
                  "True only when the caller explicitly agreed to the current readback.",
              },
              proposalId: {
                type: "string",
                description: "The proposalId returned by the current propose_appointment result.",
              },
            },
            required: ["confirmed", "proposalId"],
          },
        },
      ];
    },

    async execute(name, args, execOptions): Promise<BookingToolResult> {
      if (name === "propose_appointment") {
        return proposeAppointment(args, {
          callId: execOptions.callId,
          referenceTime: execOptions.referenceTime,
          now,
          proposals,
        });
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
            allowWrites: options.allowWrites === true,
          }),
        );
      }
      return {
        status: "failed",
        message: "Unknown booking tool.",
      };
    },

    markReadbackFinished(callId) {
      proposals.markReadbackFinished(callId);
    },
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
    proposals: ProposalStore;
    persist: (record: BookingRecord) => void;
    records: BookingRecord[];
    fetchFn: typeof fetch;
    now: () => Date;
    createIds: () => BookingIds;
    tokenProvider: AccessTokenProvider | undefined;
    selection: CalendarSelection | undefined;
    allowWrites: boolean;
  },
): Promise<ConfirmResult> {
  const proposal = ctx.proposals.current(execOptions.callId);
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
        "Do not create the appointment. Unclear assent, background speech, or a refusal is not confirmation.",
    };
  }
  if (typeof args.proposalId !== "string" || args.proposalId !== proposal.proposalId) {
    return {
      status: "no_proposal",
      message:
        "That confirmation does not match the current proposal on this call. Finish a fresh complete readback first.",
    };
  }
  if (!ctx.proposals.readbackFinished(execOptions.callId)) {
    return {
      status: "readback_incomplete",
      message:
        "The readback is not finished. Complete the full readback without interruption before confirming. Do not create the appointment.",
    };
  }

  const existing = latestForProposal(ctx.records, proposal.proposalId);
  if (existing?.status === "booked") {
    return bookedResult(existing, proposal.callbackNumber);
  }

  if (!ctx.allowWrites) {
    return {
      status: "failed",
      message:
        "Calendar writes are not enabled on this deployment. Do not claim the appointment is booked.",
    };
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
  const identities = {
    operationId: generated.operationId,
    eventId: generated.eventId,
    callId: proposal.callId,
    proposalId: proposal.proposalId,
    calendarId,
    startUtc: start.toISOString(),
  };

  if (!existing) {
    ctx.persist(bookingRecord({ ...identities, status: "pending" }));
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
      ctx.persist(bookingRecord({ ...identities, status: "unavailable" }));
      ctx.proposals.drop(execOptions.callId);
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
    const booked = bookingRecord({ ...identities, status: "booked" });
    ctx.persist(booked);
    return bookedResult(booked, proposal.callbackNumber);
  } catch {
    ctx.persist(bookingRecord({ ...identities, status: "failed" }));
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
