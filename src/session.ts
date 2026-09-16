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

export interface BookingTool {
  definitions(): readonly ToolDefinition[];
  execute(
    name: string,
    args: Record<string, unknown>,
    options: { callId: string; referenceTime?: Date },
  ): unknown | Promise<unknown>;
  release?(callId: string): void;
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
  readonly error?: string;
}

export const REQUIRED_MODEL = "grok-voice-think-fast-2.0";
export const REQUIRED_REASONING_EFFORT = "high";

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "grok-voice-latest": REQUIRED_MODEL,
  [REQUIRED_MODEL]: REQUIRED_MODEL,
};

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;

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
  "Read back every field the proposal returns: name, callback number, exact date, start and end times, and timezone. Do not call confirm_appointment until that entire readback is finished.",
  "A material correction of name, callback number, date, time, timezone, or purpose requires a new propose_appointment and a fresh complete readback. Do not reuse an earlier proposal.",
  "Call confirm_appointment only after the caller explicitly agrees to the current readback.",
  "Do not call confirm_appointment for unclear assent, background speech, an interrupted readback, a refusal, or if the caller has not clearly agreed.",
  "If confirm_appointment returns that the time is unavailable, offer fresh alternatives from check_availability. Do not claim the appointment was booked.",
  "If confirm_appointment reports the appointment is booked, tell the caller it is booked and that Jacob will call the confirmed callback number at the agreed time. Do not send or promise any automated callback, message, or email.",
  "Never say the appointment is booked unless confirm_appointment reported that the calendar event exists.",
].join(" ");

function sessionInstructions(booking: BookingTool | undefined): string {
  if (!booking) {
    return `${AVAILABILITY_INSTRUCTIONS} Do not claim that an appointment has been booked or written to a calendar.`;
  }
  return `${AVAILABILITY_INSTRUCTIONS} ${BOOKING_INSTRUCTIONS}`;
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
      instructions: sessionInstructions(booking),
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
  },
): Promise<string[] | undefined> {
  if (typeof event.call_id !== "string" || typeof event.name !== "string") {
    return undefined;
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

export function createTelephoneSession(options: {
  callId: string;
  apiKey: string;
  availabilityTool: AvailabilityTool;
  booking?: BookingTool;
  connectWebSocket: ConnectWebSocket;
  hangupCall?: (callId: string) => Promise<void>;
  referenceTime?: Date;
  maxDurationMs?: number;
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
        let timeout: NodeJS.Timeout | undefined;

        const finish = (status: "completed" | "failed", error?: string) => {
          if (finished) {
            return;
          }
          finished = true;
          if (timeout) {
            clearTimeout(timeout);
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
            error,
          });
        };

        timeout = setTimeout(() => {
          finish("completed", "duration_limit_reached");
        }, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);

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
              socket?.send(sessionUpdatePayload(options.availabilityTool, options.booking));
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
