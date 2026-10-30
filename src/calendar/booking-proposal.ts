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
 * A join where one transcript source appended a fragment it already contained.
 * `index` is the UTF-16 offset of that fragment. `additionLength` is its length.
 */
export interface RepeatedFragmentJoin {
  readonly index: number;
  readonly additionLength: number;
}

interface TranscriptWitness {
  readonly text: string;
  readonly repeatedJoins: readonly RepeatedFragmentJoin[];
}

/**
 * The assistant output covers the proposal when one transcript source
 * contains every returned readback field as its own contiguous value.
 * Each source is checked on its own. A field in one source does not
 * supply a field missing from another, and sources are not concatenated.
 * A source already contained in another is not a separate witness, so its
 * cut cannot open a field inside a longer word or number. A repeated
 * fragment can extend a field that already ends at its join. A field that
 * appears only across that join does not count unless the fragment is one
 * code point that finishes the field, and a field opened only at the
 * fragment's leading edge does not count. A field inside a longer word or
 * number does not count. A Unicode format character continues a field, so
 * it does not end one. Purpose is required only when the proposal has one.
 * The transcript itself is not retained.
 */
export function transcriptCoversReadback(
  proposal: AppointmentProposal,
  sources: readonly string[],
  repeatedJoins: readonly (readonly RepeatedFragmentJoin[])[] = [],
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
  const witnesses = uncontainedSources(
    sources.map((text, index) => ({
      text,
      repeatedJoins: repeatedJoins[index] ?? [],
    })),
  );
  return witnesses.some((source) =>
    fields.every((field) => containsField(source.text, field, source.repeatedJoins)),
  );
}

/**
 * A source already contained in another is the same text with a cut at its
 * edge. That cut is not a field boundary. Near-copies where neither string
 * contains the other stay separate and are not concatenated.
 */
function uncontainedSources(sources: readonly TranscriptWitness[]): TranscriptWitness[] {
  let kept: TranscriptWitness[] = [];
  for (const source of sources) {
    if (source.text.length === 0) {
      continue;
    }
    if (kept.some((existing) => existing.text.includes(source.text))) {
      continue;
    }
    kept = kept.filter((existing) => !source.text.includes(existing.text));
    kept.push(source);
  }
  return kept;
}

function containsField(
  transcript: string,
  field: string,
  repeatedJoins: readonly RepeatedFragmentJoin[],
): boolean {
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
    if (
      !isFieldCharacter(before) &&
      !isFieldCharacter(after) &&
      !repeatedJoinBlocksMatch(transcript, at, field.length, repeatedJoins)
    ) {
      return true;
    }
    from = at + 1;
  }
  return false;
}

/**
 * A copied fragment must not mint a field. A match that starts on its leading
 * edge is the cut of the copy. A match that crosses the join counts only when
 * the copy is one code point and that code point finishes the field.
 */
function repeatedJoinBlocksMatch(
  transcript: string,
  at: number,
  fieldLength: number,
  joins: readonly RepeatedFragmentJoin[],
): boolean {
  const end = at + fieldLength;
  for (const join of joins) {
    if (join.additionLength <= 0 || join.index < 0 || join.index > transcript.length) {
      continue;
    }
    if (at === join.index) {
      return true;
    }
    if (at < join.index && end > join.index) {
      const additionEnd = join.index + join.additionLength;
      const addition = transcript.slice(join.index, additionEnd);
      if (!(isSingleCodePoint(addition) && end === additionEnd)) {
        return true;
      }
    }
  }
  return false;
}

function isSingleCodePoint(text: string): boolean {
  if (text.length === 0 || text.length > 2) {
    return false;
  }
  const point = text.codePointAt(0);
  if (point === undefined || (point >= 0xd800 && point <= 0xdfff)) {
    return false;
  }
  return String.fromCodePoint(point) === text;
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
