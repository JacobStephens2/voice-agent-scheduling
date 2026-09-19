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
  unresolvedOperations,
  type BookingRecord,
} from "./booking-store.js";
import {
  createCallbackNumberHasher,
  evaluateCallbackLimit,
  normalizeCallbackNumber,
  type CallbackNumberHasher,
} from "./callback-limit.js";
import {
  appointmentNotificationProof,
  CalendarQueryError,
  createAppointmentEvent,
  getAppointmentEvent,
  queryBusyIntervals,
  type StoredCalendarEvent,
} from "./client.js";
import {
  computeAvailableStarts,
  SCHEDULING_TIMEZONE,
  type BusyInterval,
} from "./policy.js";
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
    | "inconclusive"
    | "failed";
  readonly operationId?: string;
  readonly eventId?: string;
  readonly eventExists?: boolean;
  readonly message: string;
}

/**
 * Bounded outcome for one durable operation after restart recovery.
 * "booked" means the matching event is known to exist; "inconclusive"
 * means no matching event could be established without inventing one;
 * "unresolved" means Calendar could not be reached to decide.
 */
export interface ReconcileResult {
  readonly operationId: string;
  readonly eventId: string;
  readonly status: "booked" | "inconclusive" | "unresolved";
  readonly eventExists: boolean;
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
  /**
   * Reconcile every pending/inconclusive durable operation against its
   * stored event identity. Establishes a single matching event or a
   * bounded unresolved outcome from durable storage alone; never
   * re-inserts, never mints a replacement identity, and never claims
   * success for an event that could not be read back.
   */
  reconcileUnresolvedOperations(): Promise<readonly ReconcileResult[]>;
  reloadDurableRecords(): void;
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
  const callbackHasher = createCallbackNumberHasher(options.dataDir);
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
            "Create the current proposed appointment after you have finished speaking the complete readback and the caller has explicitly agreed. Pass the proposalId from that proposal. Do not call this for unclear assent, background speech, an interrupted readback, or a refusal. Only one upcoming appointment is allowed per confirmed callback number; when that number already holds one, the confirmation is refused and the caller is directed to Jacob. Success means the calendar event exists; then tell the caller Jacob will call the confirmed callback number.",
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
            callbackHasher,
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

    reconcileUnresolvedOperations() {
      return enqueue(() =>
        reconcileUnresolved({
          persist,
          records,
          fetchFn,
          tokenProvider,
          selection: explicitSelection,
        }),
      );
    },

    reloadDurableRecords() {
      if (!options.dataDir) {
        return;
      }
      const loaded = loadBookingRecords(options.dataDir);
      records.splice(0, records.length, ...loaded);
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
    callbackHasher: CallbackNumberHasher;
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

  const normalizedCallback = normalizeCallbackNumber(proposal.callbackNumber);
  if (!normalizedCallback) {
    return {
      status: "failed",
      message:
        "The callback number could not be understood. Do not claim the appointment is booked.",
    };
  }
  const numberHash = ctx.callbackHasher(normalizedCallback);

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
    numberHash,
  };

  let accessToken: string;
  try {
    accessToken = await ctx.tokenProvider.getAccessToken();
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

  // Evaluate the per-number limit before presenting a booking as
  // confirmed. A repeat caller keeps no new appointment: they hear that
  // changes go through Jacob directly, without any existing details.
  const limit = await evaluateCallbackLimit({
    fetchFn: ctx.fetchFn,
    accessToken,
    records: ctx.records,
    numberHash,
    now: referenceTime,
    excludeOperationId: generated.operationId,
  });
  if (limit !== "clear") {
    ctx.persist(bookingRecord({ ...identities, status: "failed" }));
    return limitRefusal(limit);
  }

  if (!existing) {
    ctx.persist(bookingRecord({ ...identities, status: "pending" }));
  }

  // Recheck policy and availability inside the serialized operation, so a
  // slot taken after the proposal is never knowingly written.
  let busy: BusyInterval[];
  try {
    busy = await queryBusyIntervals(ctx.fetchFn, accessToken, {
      calendarIds: requiredCalendarIds(ctx.selection),
      timeMin: dayStart,
      timeMax: dayEnd,
    });
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
  const stillOpen = computeAvailableStarts({
    date: proposal.date,
    now: referenceTime,
    busy,
  }).some((slot) => slot.startTime === proposal.startTime);
  if (!stillOpen) {
    // The slot can read busy because this operation's own uncertain write
    // already landed. Reconcile against the original event identity before
    // reporting the time as taken by someone else.
    const own = await readOwnEvent(ctx.fetchFn, accessToken, calendarId, generated.eventId);
    if (own) {
      const booked = bookingRecord({ ...identities, status: "booked" });
      ctx.persist(booked);
      return bookedResult(booked, proposal.callbackNumber);
    }
    if (own === undefined) {
      return persistInconclusive(ctx, identities);
    }
    ctx.persist(bookingRecord({ ...identities, status: "unavailable" }));
    ctx.proposals.drop(execOptions.callId);
    return {
      status: "unavailable",
      operationId: generated.operationId,
      eventId: generated.eventId,
      eventExists: false,
      message:
        "That time is no longer available. Offer fresh alternatives from check_availability and require confirmation of any replacement. Do not claim the appointment is booked.",
    };
  }

  // Evaluate the limit again within the committing operation, after the
  // availability recheck: a repeated attempt under fresh identities must
  // not slip between the first evaluation and the insert.
  const finalLimit = await evaluateCallbackLimit({
    fetchFn: ctx.fetchFn,
    accessToken,
    records: ctx.records,
    numberHash,
    now: referenceTime,
    excludeOperationId: generated.operationId,
  });
  if (finalLimit !== "clear") {
    ctx.persist(bookingRecord({ ...identities, status: "failed" }));
    return limitRefusal(finalLimit);
  }

  try {
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
    // A timeout can fire after Google accepted the insertion. Reconcile
    // against the original operation/event identity instead of minting a
    // replacement: a retry of this same proposal reuses these identities,
    // and a duplicate delivery finds the booked outcome below.
    const own = await readOwnEvent(ctx.fetchFn, accessToken, calendarId, generated.eventId);
    if (own) {
      const booked = bookingRecord({ ...identities, status: "booked" });
      ctx.persist(booked);
      return bookedResult(booked, proposal.callbackNumber);
    }
    return persistInconclusive(ctx, identities);
  }
}

const CALLBACK_LIMIT_MESSAGE =
  "That callback number already has an upcoming appointment. " +
  "The scheduling agent cannot change, cancel, or reschedule appointments. " +
  "Please contact Jacob directly about any changes. No new appointment was created.";

const CALLBACK_LIMIT_UNKNOWN_MESSAGE =
  "Existing appointments for that callback number could not be verified right now. " +
  "Do not tell the caller the appointment is booked. " +
  "The caller may try again later or contact Jacob directly.";

function limitRefusal(outcome: "blocked" | "unknown"): ConfirmResult {
  return {
    status: "unavailable",
    eventExists: false,
    message: outcome === "blocked" ? CALLBACK_LIMIT_MESSAGE : CALLBACK_LIMIT_UNKNOWN_MESSAGE,
  };
}

const INCONCLUSIVE_MESSAGE =
  "The appointment could not be confirmed because the calendar write was interrupted. " +
  "Do not tell the caller the appointment is booked. " +
  "The caller may confirm the same proposal again or choose another time.";

function persistInconclusive(
  ctx: {
    persist: (record: BookingRecord) => void;
  },
  identities: {
    operationId: string;
    eventId: string;
    callId: string;
    proposalId: string;
    calendarId: string;
    startUtc: string;
    numberHash: string;
  },
): ConfirmResult {
  ctx.persist(bookingRecord({ ...identities, status: "inconclusive" }));
  return {
    status: "inconclusive",
    operationId: identities.operationId,
    eventId: identities.eventId,
    eventExists: false,
    message: INCONCLUSIVE_MESSAGE,
  };
}

/**
 * Read back this operation's own event by its stored identity.
 * Returns the stored event only when a policy-matching event exists;
 * anything else readable under the identity (absent, or an event that
 * does not match the approved shape) is not this operation's booked
 * appointment, so success is never claimed for it. Returns undefined
 * when the read itself failed and nothing can be established.
 */
async function readOwnEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<StoredCalendarEvent | null | undefined> {
  let stored: StoredCalendarEvent;
  try {
    stored = await getAppointmentEvent(fetchFn, accessToken, calendarId, eventId);
  } catch (error) {
    if (error instanceof CalendarQueryError && error.kind === "not_found") {
      return null;
    }
    return undefined;
  }
  return appointmentNotificationProof(stored).matchesApprovedShape ? stored : null;
}

/**
 * Reconcile durable pending/inconclusive operations after a restart, using
 * only the stored operation/event identities. No transcript or proposal is
 * needed: a matching stored event becomes booked, an absent event stays a
 * bounded inconclusive outcome, and an unreachable Calendar stays
 * unresolved. Nothing is re-inserted and no identity is replaced.
 */
async function reconcileUnresolved(ctx: {
  persist: (record: BookingRecord) => void;
  records: BookingRecord[];
  fetchFn: typeof fetch;
  tokenProvider: AccessTokenProvider | undefined;
  selection: CalendarSelection | undefined;
}): Promise<readonly ReconcileResult[]> {
  const outcomes: ReconcileResult[] = [];
  for (const latest of unresolvedOperations(ctx.records)) {
    const identity = {
      operationId: latest.operationId,
      eventId: latest.eventId,
    };
    if (!ctx.tokenProvider || !ctx.selection) {
      outcomes.push({ ...identity, status: "unresolved", eventExists: false });
      continue;
    }
    let accessToken: string;
    try {
      accessToken = await ctx.tokenProvider.getAccessToken();
    } catch {
      outcomes.push({ ...identity, status: "unresolved", eventExists: false });
      continue;
    }
    const own = await readOwnEvent(
      ctx.fetchFn,
      accessToken,
      latest.calendarId,
      latest.eventId,
    );
    if (own) {
      const booked = bookingRecord({
        operationId: latest.operationId,
        eventId: latest.eventId,
        callId: latest.callId,
        proposalId: latest.proposalId,
        calendarId: latest.calendarId,
        startUtc: latest.startUtc,
        status: "booked",
        numberHash: latest.numberHash,
      });
      ctx.persist(booked);
      outcomes.push({ ...identity, status: "booked", eventExists: true });
      continue;
    }
    if (own === undefined) {
      outcomes.push({ ...identity, status: "unresolved", eventExists: false });
      continue;
    }
    if (latest.status === "pending") {
      ctx.persist(
        bookingRecord({
          operationId: latest.operationId,
          eventId: latest.eventId,
          callId: latest.callId,
          proposalId: latest.proposalId,
          calendarId: latest.calendarId,
          startUtc: latest.startUtc,
          status: "inconclusive",
          numberHash: latest.numberHash,
        }),
      );
    }
    outcomes.push({ ...identity, status: "inconclusive", eventExists: false });
  }
  return outcomes;
}
