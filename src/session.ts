import type { RepeatedFragmentJoin } from "./calendar/booking-proposal.js";
import { SCHEDULING_TIMEZONE } from "./calendar/policy.js";

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

export interface AvailabilityTool {
  definition(): ToolDefinition;
  execute(
    args: { date?: string; timezone?: string },
    options?: { referenceTime?: Date },
  ): unknown | Promise<unknown>;
}

export interface BookingReconciliation {
  readonly operationId: string;
  readonly eventId: string;
  readonly status: string;
  readonly eventExists: boolean;
}

export interface BookingTool {
  definitions(): readonly ToolDefinition[];
  execute(
    name: string,
    args: Record<string, unknown>,
    options: { callId: string; referenceTime?: Date },
  ): unknown | Promise<unknown>;
  /**
   * Mark the current readback finished when this assistant response
   * completed and one of its transcript sources contains every returned
   * field. The transcript is not stored or logged.
   */
  finishReadbackIfCovered?(
    callId: string,
    response: {
      readonly status: string;
      readonly sources: readonly string[];
      readonly repeatedJoins?: readonly (readonly RepeatedFragmentJoin[])[];
    },
  ): void;
  reconcileUnresolvedOperations?(): Promise<readonly BookingReconciliation[]>;
}

export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
}

export type ConnectWebSocket = (
  url: string,
  headers: Record<string, string>,
) => RealtimeSocket;

export interface SessionOutcome {
  readonly callId: string;
  readonly status: "completed" | "failed";
  readonly modelVerified?: string;
  readonly reasoningVerified?: string;
  readonly toolRoundTrips: number;
  readonly durationMs: number;
  readonly durationWarningSent: boolean;
  readonly error?: string;
}

export const REQUIRED_MODEL = "grok-voice-think-fast-2.0";
export const REQUIRED_REASONING_EFFORT = "high";

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "grok-voice-latest": REQUIRED_MODEL,
  [REQUIRED_MODEL]: REQUIRED_MODEL,
};

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_WARNING_LEAD_MS = 60 * 1000;

export const DURATION_CUTOFF_STATUS = "duration_cutoff";

function callLimitLabel(maxDurationMs: number): string {
  return `${Math.max(1, Math.round(maxDurationMs / 60_000))}-minute`;
}

function durationLimitInstructions(maxDurationMs: number): string {
  return (
    `Scheduling calls end after ${callLimitLabel(maxDurationMs)}. Give the caller a brief warning ` +
    "shortly beforehand, wrap up the current point, and do not start a new booking confirmation after the cutoff."
  );
}

const AVAILABILITY_INSTRUCTIONS = [
  "You are Jacob's scheduling assistant.",
  "You help callers learn Jacob's availability and arrange 30-minute phone appointments.",
  "Identify yourself as Jacob's scheduling assistant.",
  "When the caller asks about availability, use the check_availability tool with the exact date in YYYY-MM-DD format.",
  "Offer a few of the returned times by name and always state the timezone (Eastern Time, America/New_York).",
  "If the caller asks about another timezone, call the tool again with that timezone and share the converted times.",
  "If a date is ambiguous, ask the caller to clarify it instead of guessing.",
  "If the caller corrects a date or timezone, check the corrected details and offer the new options.",
  "Never describe Jacob's existing events; only share the available times the tool returns.",
  "If the tool reports no availability or that the calendar cannot be reached, say so honestly and invite the caller to try another date or try again later.",
].join(" ");

const BOOKING_INSTRUCTIONS = [
  "Collect the caller's name and a callback number they speak and confirm. The callback number may differ from the number that placed this call. Purpose is optional. Do not request an email address.",
  "After the caller chooses an offered time and has confirmed their callback number, call propose_appointment with their name, confirmed callback number, date, Eastern start time, and optional purpose.",
  "Read back every field the proposal returns, using the exact returned values: name, callback number, date, start and end times, timezone, and purpose when the proposal includes one. Do not call confirm_appointment until you have finished speaking that entire readback.",
  "A material correction of name, callback number, date, time, timezone, or purpose requires a new propose_appointment and a fresh complete readback. Do not reuse an earlier proposalId.",
  "Call confirm_appointment only after you finished the full readback and the caller explicitly agrees. Pass that proposal's proposalId and confirmed true.",
  "Do not call confirm_appointment for unclear assent, background speech, an interrupted readback, a refusal, or if the caller has not clearly agreed. Interrupted readback requires a fresh complete readback first.",
  "If confirm_appointment returns that the time is unavailable because the time was taken, offer fresh alternatives from check_availability. Do not claim the appointment was booked.",
  "If confirm_appointment returns that the callback number already has an upcoming appointment, relay that changes go through Jacob directly and do not offer a new booking or fresh alternatives.",
  "If confirm_appointment reports the result is inconclusive, say honestly that the booking could not be confirmed and offer to try the same time again or pick another time. Never say an inconclusive appointment is booked.",
  "If confirm_appointment reports the appointment is booked, tell the caller it is booked and that Jacob will call the confirmed callback number at the agreed time. Do not send or promise any automated callback, message, or email.",
  "Never say the appointment is booked unless confirm_appointment reported that the calendar event exists.",
].join(" ");

const easternDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULING_TIMEZONE,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/**
 * Anchor relative days ("this coming Monday", "tomorrow") to the call's
 * date. Without this the model must produce YYYY-MM-DD tool dates with no
 * knowledge of today, so it cannot resolve them.
 */
function dateAnchorInstructions(now: Date): string {
  return (
    `Today is ${easternDateFormat.format(now)} in Eastern Time (America/New_York). ` +
    `When the caller names a relative day such as "this coming Monday", "next Friday", or "tomorrow", ` +
    `resolve it against today's date and call the tools with the resulting YYYY-MM-DD date. ` +
    `If their words could mean two different dates, ask them to confirm the exact date instead of guessing.`
  );
}

function sessionInstructions(
  booking: BookingTool | undefined,
  maxDurationMs: number,
  now: Date,
): string {
  const durationInstructions = durationLimitInstructions(maxDurationMs);
  const dateAnchor = dateAnchorInstructions(now);
  if (!booking) {
    return `${AVAILABILITY_INSTRUCTIONS} ${dateAnchor} ${durationInstructions} Do not claim that an appointment has been booked or written to a calendar.`;
  }
  return `${AVAILABILITY_INSTRUCTIONS} ${BOOKING_INSTRUCTIONS} ${dateAnchor} ${durationInstructions}`;
}

export function resolveVoiceModel(reported: unknown): string | undefined {
  if (typeof reported !== "string") {
    return undefined;
  }
  return MODEL_ALIASES[reported];
}

export function sipRealtimeUrl(callId: string): string {
  const url = new URL("wss://api.x.ai/v1/realtime");
  url.searchParams.set("call_id", callId);
  url.searchParams.set("reasoning.effort", REQUIRED_REASONING_EFFORT);
  return url.toString();
}

function unexpectedModelError(reported: unknown): string {
  return `Expected model ${REQUIRED_MODEL}, but provider returned ${String(reported)}`;
}

function sessionUpdatePayload(
  availabilityTool: AvailabilityTool,
  booking: BookingTool | undefined,
  maxDurationMs: number,
  now: Date,
): string {
  return JSON.stringify({
    type: "session.update",
    session: {
      voice: "ara",
      reasoning: { effort: REQUIRED_REASONING_EFFORT },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 200,
      },
      // Omit audio.input.transcription. xAI emits live input transcripts
      // only when audio.input.transcription.model is set; this service
      // never stores speech, transcripts, or recordings.
      instructions: sessionInstructions(booking, maxDurationMs, now),
      tools: [availabilityTool.definition(), ...(booking?.definitions() ?? [])],
    },
  });
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The model sometimes emits invalid JSON; treat that as empty args.
  }
  return {};
}

function functionOutputMessages(toolCallId: string, result: unknown): string[] {
  return [
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(result),
      },
    }),
    JSON.stringify({ type: "response.create" }),
  ];
}

async function toolOutputMessages(
  event: { name?: unknown; call_id?: unknown; arguments?: unknown },
  options: {
    availabilityTool: AvailabilityTool;
    booking?: BookingTool;
    callId: string;
    referenceTime: Date | undefined;
    isCutoffReached: () => boolean;
    callLimitLabel: string;
  },
): Promise<string[] | undefined> {
  if (typeof event.call_id !== "string" || typeof event.name !== "string") {
    return undefined;
  }
  if (options.isCutoffReached() && event.name === "confirm_appointment") {
    return functionOutputMessages(event.call_id, {
      status: DURATION_CUTOFF_STATUS,
      message: `The ${options.callLimitLabel} scheduling-call limit was reached. Do not create the appointment and do not claim it is booked. Invite the caller to call again.`,
    });
  }
  const args = parseToolArgs(event.arguments);
  if (event.name === "check_availability") {
    const result = await options.availabilityTool.execute(
      { date: asOptionalString(args.date), timezone: asOptionalString(args.timezone) },
      { referenceTime: options.referenceTime },
    );
    return functionOutputMessages(event.call_id, result);
  }
  const bookingNames = new Set(options.booking?.definitions().map((tool) => tool.name) ?? []);
  if (options.booking && bookingNames.has(event.name)) {
    const result = await options.booking.execute(event.name, args, {
      callId: options.callId,
      referenceTime: options.referenceTime,
    });
    return functionOutputMessages(event.call_id, result);
  }
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringField(value: unknown): string {
  return asOptionalString(value) ?? "";
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

function eventText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (typeof data === "object" && data && "data" in data) {
    return eventText((data as { data: unknown }).data);
  }
  return undefined;
}

function durationNoticePayload(text: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text }],
    },
  });
}

export function createTelephoneSession(options: {
  callId: string;
  apiKey: string;
  availabilityTool: AvailabilityTool;
  booking?: BookingTool;
  connectWebSocket: ConnectWebSocket;
  hangupCall?: (callId: string) => Promise<void>;
  referenceTime?: Date;
  maxDurationMs?: number;
  warningLeadMs?: number;
}): { start(): Promise<SessionOutcome> } {
  let socket: RealtimeSocket | undefined;

  return {
    start(): Promise<SessionOutcome> {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        let modelVerified: string | undefined;
        let reasoningVerified: string | undefined;
        let toolRoundTrips = 0;
        let finished = false;
        let warningSent = false;
        let cutoffReached = false;
        let timeout: NodeJS.Timeout | undefined;
        let warningTimeout: NodeJS.Timeout | undefined;
        const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
        const warningLeadMs = options.warningLeadMs ?? DEFAULT_WARNING_LEAD_MS;

        const finish = (status: "completed" | "failed", error?: string) => {
          if (finished) {
            return;
          }
          finished = true;
          if (timeout) {
            clearTimeout(timeout);
          }
          if (warningTimeout) {
            clearTimeout(warningTimeout);
          }
          void options.hangupCall?.(options.callId);
          try {
            socket?.close();
          } catch {
            // The provider socket may already be closed.
          }
          resolve({
            callId: options.callId,
            status,
            modelVerified,
            reasoningVerified,
            toolRoundTrips,
            durationMs: Date.now() - startedAt,
            durationWarningSent: warningSent,
            error,
          });
        };

        const limitLabel = callLimitLabel(maxDurationMs);
        const assistantTranscripts = new Map<string, TranscriptAssembly>();

        warningTimeout = setTimeout(() => {
          if (finished) {
            return;
          }
          warningSent = true;
          socket?.send(
            durationNoticePayload(
              `The ${limitLabel} scheduling-call limit approaches. Briefly warn the caller, wrap up the current point, and do not start a new booking confirmation.`,
            ),
          );
          socket?.send(JSON.stringify({ type: "response.create" }));
        }, Math.max(0, maxDurationMs - warningLeadMs));

        timeout = setTimeout(() => {
          if (finished) {
            return;
          }
          cutoffReached = true;
          socket?.send(
            durationNoticePayload(
              `The ${limitLabel} scheduling-call limit is reached. Do not accept a new booking confirmation; politely close the scheduling call.`,
            ),
          );
          finish("completed", "duration_limit_reached");
        }, maxDurationMs);

        try {
          socket = options.connectWebSocket(sipRealtimeUrl(options.callId), {
            Authorization: `Bearer ${options.apiKey}`,
          });
        } catch (error) {
          finish(
            "failed",
            `Failed to connect websocket: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }

        const handleMessage = (raw: unknown) => {
          const text = eventText(raw);
          if (!text) {
            return;
          }
          let event: { type?: string; [key: string]: unknown };
          try {
            event = JSON.parse(text) as { type?: string };
          } catch {
            return;
          }
          if (!event.type) {
            return;
          }

          if (event.type.startsWith("response.output_audio_transcript")) {
            rememberOutputTranscript(assistantTranscripts, event);
            return;
          }

          switch (event.type) {
            case "session.created": {
              const session = event.session as { model?: unknown } | undefined;
              if (session?.model !== undefined) {
                const resolved = resolveVoiceModel(session.model);
                if (!resolved) {
                  finish("failed", unexpectedModelError(session.model));
                  return;
                }
                modelVerified = resolved;
              }
              socket?.send(
                sessionUpdatePayload(
                  options.availabilityTool,
                  options.booking,
                  maxDurationMs,
                  options.referenceTime ?? new Date(),
                ),
              );
              break;
            }
            case "session.updated": {
              const session = event.session as
                | { model?: unknown; reasoning?: { effort?: unknown } }
                | undefined;
              if (session?.model !== undefined) {
                const resolved = resolveVoiceModel(session.model);
                if (!resolved) {
                  finish("failed", unexpectedModelError(session.model));
                  return;
                }
                modelVerified = resolved;
              }
              if (session?.reasoning?.effort === REQUIRED_REASONING_EFFORT) {
                reasoningVerified = REQUIRED_REASONING_EFFORT;
              }
              if (!modelVerified) {
                finish(
                  "failed",
                  `Expected model ${REQUIRED_MODEL}, but provider did not report a model on session.created or session.updated`,
                );
                return;
              }
              socket?.send(JSON.stringify({ type: "response.create" }));
              break;
            }
            case "response.done": {
              const response =
                event.response && typeof event.response === "object"
                  ? (event.response as { status?: unknown; id?: unknown })
                  : undefined;
              const status = stringField(response?.status);
              const responseId = stringField(response?.id);
              const streamed = responseId
                ? (assistantTranscripts.get(responseId) ?? transcriptPiece(""))
                : transcriptPiece("");
              const payload = completedPayloadTranscript(response);
              // Two copies of this response. Check each on its own. Do not
              // concatenate them: a near-copy join can mint a field that
              // neither copy contains. Do not take a field from one copy
              // to fill the other.
              const sources = [streamed.text, payload.text];
              const repeatedJoins = [streamed.repeatedJoins, payload.repeatedJoins];
              if (responseId) {
                assistantTranscripts.delete(responseId);
              }
              options.booking?.finishReadbackIfCovered?.(options.callId, {
                status,
                sources,
                repeatedJoins,
              });
              break;
            }
            case "response.function_call_arguments.done": {
              const toolCallId = event.call_id;
              void toolOutputMessages(
                {
                  name: event.name,
                  call_id: toolCallId,
                  arguments: event.arguments,
                },
                {
                  availabilityTool: options.availabilityTool,
                  booking: options.booking,
                  callId: options.callId,
                  referenceTime: options.referenceTime,
                  isCutoffReached: () => cutoffReached,
                  callLimitLabel: limitLabel,
                },
              )
                .then((messages) => {
                  if (!messages) {
                    return;
                  }
                  toolRoundTrips += 1;
                  for (const message of messages) {
                    socket?.send(message);
                  }
                })
                .catch(() => {
                  finish("failed", "Scheduling tool failed");
                });
              break;
            }
            case "error": {
              const details = event.error;
              finish(
                "failed",
                `Provider error: ${typeof details === "object" ? JSON.stringify(details) : String(details)}`,
              );
              break;
            }
          }
        };

        socket.on("message", handleMessage);
        socket.on("close", () => {
          finish("completed");
        });
        socket.on("error", (error) => {
          finish(
            "failed",
            `WebSocket error: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
    },
  };
}
