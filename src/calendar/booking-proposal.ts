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
 * The assistant output covers the proposal when each returned readback field
 * appears as its own value in one transcript source. Sources are not
 * concatenated. A field inside a longer word or number does not count. A
 * Unicode format character continues a field, so it does not end one.
 * Purpose is required only when the proposal has one. The transcript itself
 * is not retained.
 */
export function transcriptCoversReadback(
  proposal: AppointmentProposal,
  sources: readonly string[],
): boolean {
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
  return fields.every((field) => sources.some((source) => containsField(source, field)));
}

function containsField(transcript: string, field: string): boolean {
  if (field.length === 0) {
    return false;
  }
  let from = 0;
  while (from <= transcript.length - field.length) {
    const at = transcript.indexOf(field, from);
    if (at < 0) {
      return false;
    }
    const before = codePointEndingAt(transcript, at);
    const after = codePointStartingAt(transcript, at + field.length);
    if (!isFieldCharacter(before) && !isFieldCharacter(after)) {
      return true;
    }
    from = at + 1;
  }
  return false;
}

/**
 * The code point ending at this UTF-16 index. A supplementary format
 * character is two units; reading one unit would end the field early.
 */
function codePointEndingAt(text: string, index: number): string {
  if (index <= 0) {
    return "";
  }
  const tail = index - 1;
  const unit = text.charCodeAt(tail);
  const lead = tail > 0 ? text.charCodeAt(tail - 1) : 0;
  if (unit >= 0xdc00 && unit <= 0xdfff && lead >= 0xd800 && lead <= 0xdbff) {
    return text.slice(tail - 1, index);
  }
  return text[tail] ?? "";
}

/** The code point starting at this UTF-16 index, or "" at the end. */
function codePointStartingAt(text: string, index: number): string {
  if (index < 0 || index >= text.length) {
    return "";
  }
  const point = text.codePointAt(index);
  if (point === undefined) {
    return "";
  }
  return String.fromCodePoint(point);
}

/** Letters, numbers, underscore, and Unicode format characters continue a field. `Ada` does not match inside `Adam`. */
function isFieldCharacter(char: string): boolean {
  return char !== "" && /^[\p{L}\p{N}\p{Cf}_]$/u.test(char);
}
