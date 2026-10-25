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
  transcriptCoversReadback,
  type ProposeResult,
  type ProposalStore,
} from "./booking-proposal.js";
import {
  createAppointmentLedger,
  isUnresolvedBookingStatus,
  type AppointmentLedger,
  type BookingRecord,
  type BookingRecordFields,
} from "./appointment-ledger.js";
import {
  commitStoredCalendarEvent,
  queryBusyIntervals,
  readStoredCalendarEvent,
} from "./client.js";
import {
  project,
  type Confirmation,
  type LedgerCommit,
} from "./stored-event-projection.js";
import {
  appointmentEndMs,
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
 * "booked" means the matching event is known to exist. "inconclusive"
 * means no matching event could be established without inventing one.
 * eventExists is true when an event is stored under this identity, including
 * one that does not match the approved shape and one that is cancelled; a
 * missing event is inconclusive with eventExists false. "unresolved" means
 * Calendar could not be reached to decide. A cancelled event is not booked,
 * so admissions are not left paused on it.
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
  finishReadbackIfCovered(
    callId: string,
    response: { readonly status: string; readonly transcript: string },
  ): void;
  /**
   * Reconcile every pending/inconclusive durable operation against its
   * stored event identity. Establishes a single matching event or a
   * bounded unresolved outcome from durable storage alone; never
   * re-inserts, never mints a replacement identity, and never claims
   * success for an event that could not be read back.
   */
  reconcileUnresolvedOperations(): Promise<readonly ReconcileResult[]>;
}

export interface BookingToolOptions {
  readonly fetchFn?: typeof fetch;
  readonly credentials?: GoogleOAuthCredentials | null;
  readonly tokenProvider?: AccessTokenProvider;
  readonly selection?: CalendarSelection | null;
  readonly dataDir?: string;
  /**
   * The process's shared appointment ledger. Built from `dataDir` when
   * absent, for callers that construct the booking tool on its own.
   */
  readonly ledger?: AppointmentLedger;
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
  const ledger = options.ledger ?? createAppointmentLedger({ dataDir: options.dataDir });
  let queue: Promise<unknown> = Promise.resolve();

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
            ledger,
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

    finishReadbackIfCovered(callId, response) {
      if (response.status !== "completed") {
        return;
      }
      const proposal = proposals.current(callId);
      if (!proposal || !transcriptCoversReadback(proposal, response.transcript)) {
        return;
      }
      proposals.markReadbackFinished(callId);
    },

    reconcileUnresolvedOperations() {
      return enqueue(() =>
        reconcileUnresolved({
          ledger,
          fetchFn,
          tokenProvider,
          selection: explicitSelection,
        }),
      );
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
    ledger: AppointmentLedger;
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
      status: "readback_incomplete",
      message: "There is no current appointment proposal on this call to confirm.",
    };
  }
  if (args.confirmed !== true) {
    return {
      status: "readback_incomplete",
      message:
        "Do not create the appointment. Unclear assent, background speech, or a refusal is not confirmation.",
    };
  }
  if (typeof args.proposalId !== "string" || args.proposalId !== proposal.proposalId) {
    return {
      status: "readback_incomplete",
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

  const existing = ctx.ledger.latestForProposal(proposal.proposalId);
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

  const numberHash = ctx.ledger.hashCallbackNumber(proposal.callbackNumber);
  if (!numberHash) {
    return {
      status: "failed",
      message:
        "The callback number could not be understood. Do not claim the appointment is booked.",
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
    numberHash,
  };

  let accessToken: string;
  try {
    accessToken = await ctx.tokenProvider.getAccessToken();
  } catch {
    // A retry has not proved the earlier write is gone. Leave that
    // unresolved row in place instead of hiding it behind failed.
    return failUnlessUnresolved(ctx.ledger, existing, identities);
  }

  // Evaluate the per-number limit before presenting a booking as
  // confirmed. A repeat caller keeps no new appointment: they hear that
  // changes go through Jacob directly, without any existing details.
  const limit = await evaluateCallbackLimit({
    fetchFn: ctx.fetchFn,
    accessToken,
    ledger: ctx.ledger,
    numberHash,
    now: referenceTime,
    excludeOperationId: generated.operationId,
  });
  if (limit !== "clear") {
    recordFailedUnlessUnresolved(ctx.ledger, existing, identities);
    return limitRefusal(limit);
  }

  ctx.ledger.recordPending(identities);

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
    // Free/busy failed before this attempt could prove the event absent.
    // A retry keeps the unresolved row that already blocks the callback number.
    return failUnlessUnresolved(ctx.ledger, existing, identities);
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
    const own = await readStoredCalendarEvent(
      ctx.fetchFn,
      accessToken,
      calendarId,
      generated.eventId,
    );
    // The projection decides a closed start. Missing is unavailable: no
    // commit, drop the proposal, and say the time was taken. Every other
    // kind appends the same commit confirm would, and the proposal stays.
    const closed = project(own.kind).confirmClosedStart();
    if (closed.outcome === "unavailable") {
      ctx.ledger.record({ ...identities, status: "unavailable" });
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
    return applyConfirmation(
      ctx.ledger,
      identities,
      proposal.callbackNumber,
      closed.confirmation,
    );
  }

  // Evaluate the limit again within the committing operation, after the
  // availability recheck: a repeated attempt under fresh identities must
  // not slip between the first evaluation and the insert.
  const finalLimit = await evaluateCallbackLimit({
    fetchFn: ctx.fetchFn,
    accessToken,
    ledger: ctx.ledger,
    numberHash,
    now: referenceTime,
    excludeOperationId: generated.operationId,
  });
  if (finalLimit !== "clear") {
    recordFailedUnlessUnresolved(ctx.ledger, existing, identities);
    return limitRefusal(finalLimit);
  }

  // Commit already read the stored event once, including when the insert
  // timed out or conflicted. Confirmation does not read it again.
  const committed = await commitStoredCalendarEvent(ctx.fetchFn, accessToken, {
    calendarId,
    eventId: generated.eventId,
    callerName: proposal.callerName,
    callbackNumber: proposal.callbackNumber,
    purpose: proposal.purpose,
    date: proposal.date,
    startTime: proposal.startTime,
  });
  return applyConfirmation(
    ctx.ledger,
    identities,
    proposal.callbackNumber,
    project(committed.kind).confirm(),
  );
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

const MISMATCHED_SHAPE_MESSAGE =
  "A calendar event for this appointment is stored but does not match the approved shape. " +
  "Do not tell the caller the appointment is booked. " +
  "This is not a missing event. The caller may confirm the same proposal again.";

type OperationIdentities = BookingRecordFields & { readonly numberHash: string };

const UNCONFIRMED_MESSAGE =
  "The calendar event could not be confirmed. Do not tell the caller the appointment is booked.";

/** Return the prior unresolved outcome without appending a new row. */
function heldUnresolved(beforeAttempt: BookingRecord | undefined): ConfirmResult | undefined {
  if (!beforeAttempt || !isUnresolvedBookingStatus(beforeAttempt.status)) {
    return undefined;
  }
  return inconclusiveResult(
    beforeAttempt,
    beforeAttempt.storedShape === "mismatched" ? MISMATCHED_SHAPE_MESSAGE : INCONCLUSIVE_MESSAGE,
  );
}

function inconclusiveResult(
  identities: { operationId: string; eventId: string },
  message: string,
): ConfirmResult {
  return {
    status: "inconclusive",
    operationId: identities.operationId,
    eventId: identities.eventId,
    // False so confirmation is not announced as booked. The message, and
    // storedShape on the row, separate a mismatched event from a missing one.
    eventExists: false,
    message,
  };
}

/**
 * Append the projection's commit from the operation identity alone.
 * A commit that omits `storedShape` does not copy a previous mark forward.
 */
function recordCommit(
  ledger: AppointmentLedger,
  identity: Pick<
    BookingRecord,
    | "operationId"
    | "eventId"
    | "callId"
    | "proposalId"
    | "calendarId"
    | "startUtc"
    | "numberHash"
  >,
  commit: LedgerCommit,
): BookingRecord {
  return ledger.record({
    operationId: identity.operationId,
    eventId: identity.eventId,
    callId: identity.callId,
    proposalId: identity.proposalId,
    calendarId: identity.calendarId,
    startUtc: identity.startUtc,
    status: commit.status,
    ...(identity.numberHash === undefined ? {} : { numberHash: identity.numberHash }),
    ...(commit.storedShape === undefined ? {} : { storedShape: commit.storedShape }),
  });
}

/**
 * Close this attempt as failed unless it began from an unresolved record.
 * beforeAttempt is the proposal's latest record from before this attempt,
 * not the ledger's live latest: once recordPending has run, the live latest
 * is this attempt's own pending, which a failure before the insert must
 * still close.
 */
function recordFailedUnlessUnresolved(
  ledger: AppointmentLedger,
  beforeAttempt: BookingRecord | undefined,
  identities: OperationIdentities,
): void {
  if (beforeAttempt && isUnresolvedBookingStatus(beforeAttempt.status)) {
    return;
  }
  ledger.record({ ...identities, status: "failed" });
}

function failUnlessUnresolved(
  ledger: AppointmentLedger,
  beforeAttempt: BookingRecord | undefined,
  identities: OperationIdentities,
): ConfirmResult {
  const held = heldUnresolved(beforeAttempt);
  if (held) {
    return held;
  }
  recordFailedUnlessUnresolved(ledger, beforeAttempt, identities);
  return {
    status: "failed",
    operationId: identities.operationId,
    eventId: identities.eventId,
    eventExists: false,
    message: UNCONFIRMED_MESSAGE,
  };
}

/**
 * Append the confirmation's commit. The speech key selects the sentence.
 * The event-exists flag is the tell-the-caller flag, true only when the
 * caller may be told the appointment is booked. Confirmation always
 * appends and does not recover.
 */
function applyConfirmation(
  ledger: AppointmentLedger,
  identities: OperationIdentities,
  callbackNumber: string,
  confirmation: Confirmation,
): ConfirmResult {
  const recorded = recordCommit(ledger, identities, confirmation.commit);
  if (confirmation.speechKey === "booked") {
    return { ...bookedResult(recorded, callbackNumber), eventExists: confirmation.tellCaller };
  }
  return {
    ...inconclusiveResult(
      identities,
      confirmation.speechKey === "mismatched" ? MISMATCHED_SHAPE_MESSAGE : INCONCLUSIVE_MESSAGE,
    ),
    eventExists: confirmation.tellCaller,
  };
}

/**
 * Whether another operation already holds an upcoming appointment for this
 * callback number. The upcoming window, the excluded operation, and an
 * unparseable start stay here. The stored event's hold comes from the
 * projection: held blocks, not held does not, and unknown stops the scan.
 */
async function evaluateCallbackLimit(options: {
  readonly fetchFn: typeof fetch;
  readonly accessToken: string;
  readonly ledger: AppointmentLedger;
  readonly numberHash: string;
  readonly now: Date;
  /**
   * The committing operation's own identity. Its records describe this
   * attempt's uncertain write, reconciled separately against the same
   * identity; only other operations can hold a competing appointment.
   */
  readonly excludeOperationId?: string;
}): Promise<"clear" | "blocked" | "unknown"> {
  const candidates = options.ledger.operationsHoldingAppointment(
    options.numberHash,
    options.excludeOperationId,
  );
  for (const record of candidates) {
    const endMs = appointmentEndMs(record.startUtc);
    if (Number.isNaN(endMs)) {
      return "unknown";
    }
    if (endMs <= options.now.getTime()) {
      continue;
    }
    const reading = await readStoredCalendarEvent(
      options.fetchFn,
      options.accessToken,
      record.calendarId,
      record.eventId,
    );
    const hold = project(reading.kind).hold();
    if (hold === "not_held") {
      continue;
    }
    if (hold === "unknown") {
      return "unknown";
    }
    return "blocked";
  }
  return "clear";
}

/**
 * Reconcile durable pending/inconclusive operations after a restart, using
 * only the stored operation/event identities. No transcript or proposal is
 * needed, and nothing is re-inserted. The projection says what the stored
 * event means. The event-exists flag is whether a stored event was read,
 * not the tell-the-caller flag.
 */
async function reconcileUnresolved(ctx: {
  ledger: AppointmentLedger;
  fetchFn: typeof fetch;
  tokenProvider: AccessTokenProvider | undefined;
  selection: CalendarSelection | undefined;
}): Promise<readonly ReconcileResult[]> {
  const outcomes: ReconcileResult[] = [];
  for (const latest of ctx.ledger.unresolvedOperations()) {
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
    const own = await readStoredCalendarEvent(
      ctx.fetchFn,
      accessToken,
      latest.calendarId,
      latest.eventId,
    );
    const settlement = project(own.kind).recover({
      status: latest.status,
      ...(latest.storedShape === undefined ? {} : { storedShape: latest.storedShape }),
    });
    if (settlement.append) {
      recordCommit(ctx.ledger, latest, settlement.append);
    }
    outcomes.push({
      ...identity,
      status: settlement.status,
      eventExists: settlement.eventStored,
    });
  }
  return outcomes;
}
