import { randomBytes } from "node:crypto";
import { extractE164, isE164 } from "../phone.js";
import { computeAvailableStarts, SCHEDULING_TIMEZONE } from "./policy.js";

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

export interface ProposalStore {
  save(proposal: AppointmentProposal): void;
  current(callId: string): AppointmentProposal | undefined;
  drop(callId: string): void;
  markReadbackFinished(callId: string): void;
  readbackFinished(callId: string): boolean;
}

export function createProposalStore(): ProposalStore {
  const proposals = new Map<string, AppointmentProposal>();
  const finishedReadbacks = new Set<string>();
  return {
    save(proposal) {
      proposals.set(proposal.callId, proposal);
      finishedReadbacks.delete(proposal.callId);
    },
    current(callId) {
      return proposals.get(callId);
    },
    drop(callId) {
      proposals.delete(callId);
      finishedReadbacks.delete(callId);
    },
    markReadbackFinished(callId) {
      if (proposals.has(callId)) {
        finishedReadbacks.add(callId);
      }
    },
    readbackFinished(callId) {
      return finishedReadbacks.has(callId);
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function invalid(message: string): ProposeResult {
  return { status: "invalid", message };
}

/** Record a call-scoped proposal for readback. A new proposal replaces any earlier one. */
export function proposeAppointment(
  args: Record<string, unknown>,
  options: {
    readonly callId: string;
    readonly referenceTime?: Date;
    readonly now: () => Date;
    readonly proposals: ProposalStore;
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
  if (!isE164(callbackNumber)) {
    return invalid(
      "I could not understand that callback number. Ask the caller to repeat it, including the area code.",
    );
  }
  const date = asString(args.date);
  const startTime = asString(args.startTime);
  if (!date || !startTime) {
    return invalid("Please include the chosen date and Eastern start time.");
  }
  const referenceTime = options.referenceTime ?? options.now();
  const permitted = computeAvailableStarts({ date, now: referenceTime, busy: [] });
  const slot = permitted.find((entry) => entry.startTime === startTime);
  if (!slot) {
    return invalid(
      "That time is not a permitted 30-minute weekday start in Eastern Time. Check availability and propose an offered time.",
    );
  }
  const purpose = asString(args.purpose);
  const proposal: AppointmentProposal = {
    proposalId: randomBytes(16).toString("hex"),
    callId: options.callId,
    callerName,
    callbackNumber,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone: SCHEDULING_TIMEZONE,
    ...(purpose ? { purpose } : {}),
  };
  options.proposals.save(proposal);
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

/**
 * The assistant output transcript covers the proposal when it contains each
 * returned readback field. Purpose is required only when the proposal has one.
 * The transcript itself is not retained.
 */
export function transcriptCoversReadback(proposal: AppointmentProposal, transcript: string): boolean {
  const fields = [
    proposal.callerName,
    proposal.callbackNumber,
    proposal.date,
    proposal.startTime,
    proposal.endTime,
    proposal.timezone,
  ];
  if (proposal.purpose) {
    fields.push(proposal.purpose);
  }
  return fields.every((field) => field.length > 0 && transcript.includes(field));
}
