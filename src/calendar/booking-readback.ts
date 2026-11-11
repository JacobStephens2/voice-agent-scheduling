import type { AppointmentProposal } from "./booking-proposal.js";

/** Call-scoped observation; closing releases speech without revoking confirmation. */
export interface ReadbackHandle {
  observe(event: Readonly<Record<string, unknown>>): void;
  close(): void;
}

/** All transcript state and provenance live only for this verifier's lifetime. */
export function createBookingReadback(): {
  observe(
    event: Readonly<Record<string, unknown>>,
    currentProposal: AppointmentProposal | undefined,
  ): boolean;
  close(): void;
} {
  const transcripts = new Map<string, TranscriptAssembly>();
  let closed = false;
  return {
    observe(event, currentProposal) {
      if (closed) {
        return false;
      }
      if (
        typeof event.type === "string" &&
        event.type.startsWith("response.output_audio_transcript")
      ) {
        rememberOutputTranscript(transcripts, event);
        return false;
      }
      if (event.type !== "response.done") {
        return false;
      }
      const response =
        event.response && typeof event.response === "object"
          ? (event.response as { status?: unknown; id?: unknown })
          : undefined;
      const responseId = stringField(response?.id);
      const streamed = responseId
        ? (transcripts.get(responseId) ?? transcriptPiece(""))
        : transcriptPiece("");
      if (responseId) {
        transcripts.delete(responseId);
      }
      if (response?.status !== "completed" || !currentProposal) {
        return false;
      }
      const payload = completedPayloadTranscript(response);
      // Stream and payload are separate witnesses, never a concatenated utterance.
      return transcriptCoversReadback(currentProposal, [streamed, payload]);
    },
    close() {
      closed = true;
      transcripts.clear();
    },
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface TranscriptAssembly {
  readonly text: string;
  readonly repeatedJoins: readonly RepeatedFragmentJoin[];
  /**
   * When `text` ends with a done transcript that already contains the
   * streamed prefix, later fragments are compared to this suffix. The
   * doubled text must not become the containment key.
   */
  readonly containmentSuffix?: string;
}

/**
 * Join two fragments of one assistant transcript source. Append the later
 * fragment unless it already contains the text held for that source, in
 * which case keep the fragment. A fragment already contained in the held
 * text is still appended, and that join is recorded so a copied fragment
 * cannot mint a readback field. A done transcript that is a small edit of
 * the streamed deltas is appended even when one string contains the other,
 * and that join is recorded too. When that appended copy contains the
 * streamed text, a later fragment that contains the copy replaces it
 * instead of joining onto the doubled text. A done transcript that
 * continues the deltas, and distinct delta fragments, stay ordinary joins.
 * The streamed output-audio transcript and the completed response payload
 * are separate sources and must not be passed here together.
 */
function mergeTranscript(
  current: TranscriptAssembly,
  addition: TranscriptAssembly,
  options?: { readonly doneTranscript?: boolean },
): TranscriptAssembly {
  if (!addition.text) {
    return current;
  }
  const containedCopy = containedDoneSuffix(current);
  if (
    containedCopy &&
    addition.text.includes(containedCopy) &&
    !addition.text.includes(current.text)
  ) {
    return replaceContainedDoneSuffix(current, addition, containedCopy);
  }
  if (
    current.text &&
    options?.doneTranscript === true &&
    isSmallEdit(current.text, addition.text)
  ) {
    const appended = appendTranscript(current, addition, true);
    if (addition.text.includes(current.text)) {
      return { ...appended, containmentSuffix: addition.text };
    }
    return appended;
  }
  if (addition.text.includes(current.text)) {
    if (!current.text) {
      return addition;
    }
    const offset = addition.text.indexOf(current.text);
    return {
      text: addition.text,
      repeatedJoins: [
        ...addition.repeatedJoins,
        ...current.repeatedJoins.map((join) => ({
          index: join.index + offset,
          additionLength: join.additionLength,
        })),
      ],
    };
  }
  return appendTranscript(current, addition, current.text.includes(addition.text));
}

function appendTranscript(
  current: TranscriptAssembly,
  addition: TranscriptAssembly,
  repeated: boolean,
): TranscriptAssembly {
  const shift = current.text.length;
  const shifted = addition.repeatedJoins.map((join) => ({
    index: join.index + shift,
    additionLength: join.additionLength,
  }));
  return {
    text: current.text + addition.text,
    repeatedJoins: repeated
      ? [
          ...current.repeatedJoins,
          { index: shift, additionLength: addition.text.length },
          ...shifted,
        ]
      : [...current.repeatedJoins, ...shifted],
  };
}

/**
 * The doubled text ends with the done transcript. Return that copy only
 * while it is still the suffix the next fragment would join onto.
 */
function containedDoneSuffix(current: TranscriptAssembly): string | undefined {
  const suffix = current.containmentSuffix;
  if (!suffix || !current.text.endsWith(suffix)) {
    return undefined;
  }
  return suffix;
}

/**
 * Drop the appended done transcript and keep the streamed prefix beside
 * the later fragment. The boundary stays a repeated-fragment join, so the
 * copy seam cannot mint a field, and a field that was valid only on the
 * streamed prefix still has its original boundary.
 */
function replaceContainedDoneSuffix(
  current: TranscriptAssembly,
  addition: TranscriptAssembly,
  suffix: string,
): TranscriptAssembly {
  const prefixLength = current.text.length - suffix.length;
  if (prefixLength <= 0) {
    return addition;
  }
  const prefixJoins = current.repeatedJoins.filter(
    (join) =>
      join.index >= 0 &&
      join.additionLength > 0 &&
      join.index + join.additionLength <= prefixLength,
  );
  const appended = appendTranscript(
    { text: current.text.slice(0, prefixLength), repeatedJoins: prefixJoins },
    addition,
    true,
  );
  return { ...appended, containmentSuffix: addition.text };
}

/**
 * A done transcript is a small edit of the streamed deltas when the
 * code-point edits that turn one into the other are at most one eighth of
 * the shorter text. A longer continuation is not a small edit.
 */
function isSmallEdit(left: string, right: string): boolean {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shorter = Math.min(leftPoints.length, rightPoints.length);
  const longer = Math.max(leftPoints.length, rightPoints.length);
  const budget = Math.floor(shorter / 8);
  if (budget < 1 || longer - shorter > budget) {
    return false;
  }
  return editDistanceAtMost(leftPoints, rightPoints, budget);
}

function editDistanceAtMost(
  left: readonly string[],
  right: readonly string[],
  budget: number,
): boolean {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current: number[] = [row];
    let rowBest = row;
    const leftPoint = left[row - 1];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = leftPoint === right[column - 1] ? 0 : 1;
      const value = Math.min(
        (current[column - 1] ?? budget + 1) + 1,
        (previous[column] ?? budget + 1) + 1,
        (previous[column - 1] ?? budget + 1) + substitution,
      );
      current.push(value);
      if (value < rowBest) {
        rowBest = value;
      }
    }
    if (rowBest > budget) {
      return false;
    }
    previous = current;
  }
  return (previous[right.length] ?? budget + 1) <= budget;
}

function transcriptPiece(text: string): TranscriptAssembly {
  return { text, repeatedJoins: [] };
}

function rememberOutputTranscript(
  transcripts: Map<string, TranscriptAssembly>,
  event: { readonly [key: string]: unknown },
): void {
  const responseId = stringField(event.response_id);
  if (!responseId) {
    return;
  }
  const delta = stringField(event.delta);
  const doneTranscript = stringField(event.transcript);
  if (!delta && !doneTranscript) {
    return;
  }
  let held = transcripts.get(responseId) ?? transcriptPiece("");
  if (delta) {
    held = mergeTranscript(held, transcriptPiece(delta));
  }
  if (doneTranscript) {
    held = mergeTranscript(held, transcriptPiece(doneTranscript), {
      doneTranscript: event.type === "response.output_audio_transcript.done",
    });
  }
  if (!held.text) {
    return;
  }
  transcripts.set(responseId, held);
}

function completedPayloadTranscript(response: unknown): TranscriptAssembly {
  if (!response || typeof response !== "object") {
    return transcriptPiece("");
  }
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return transcriptPiece("");
  }
  let text = transcriptPiece("");
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const partTranscript = stringField((part as { transcript?: unknown }).transcript);
      text = mergeTranscript(text, transcriptPiece(partTranscript));
    }
  }
  return text;
}

/**
 * A join where one transcript source appended a fragment it already contained.
 * `index` is the UTF-16 offset of that fragment. `additionLength` is its length.
 */
interface RepeatedFragmentJoin {
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
 * number does not count. A Unicode format character, variation selector,
 * default-ignorable mark, or unassigned default-ignorable code point
 * continues a field, so it does not end one. Purpose is required only when
 * the proposal has one.
 * The transcript itself is not retained.
 */
function transcriptCoversReadback(
  proposal: AppointmentProposal,
  sources: readonly TranscriptWitness[],
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
  const witnesses = uncontainedSources(sources);
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

/** Letters, numbers, underscore, Unicode format characters, variation selectors, default-ignorable marks, and unassigned default-ignorable code points continue a field. `Ada` does not match inside `Adam`. */
function isFieldCharacter(char: string): boolean {
  if (char === "") {
    return false;
  }
  if (/^[\p{L}\p{N}\p{Cf}\p{Variation_Selector}_]$/u.test(char)) {
    return true;
  }
  if (/^\p{M}$/u.test(char) && /^\p{Default_Ignorable_Code_Point}$/u.test(char)) {
    return true;
  }
  return /^\p{Cn}$/u.test(char) && /^\p{Default_Ignorable_Code_Point}$/u.test(char);
}
