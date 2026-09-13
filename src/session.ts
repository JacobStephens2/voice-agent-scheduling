import type { SyntheticAvailabilityTool } from "./synthetic-calendar.js";

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

export interface SessionCoordinator {
  start(): Promise<SessionOutcome>;
  hangup(): void;
}

export const REQUIRED_MODEL = "grok-voice-think-fast-2.0";
export const REQUIRED_REASONING_EFFORT = "high";
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "grok-voice-latest": REQUIRED_MODEL,
  [REQUIRED_MODEL]: REQUIRED_MODEL,
};

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;

const INSTRUCTIONS = [
  "You are Jacob's scheduling assistant.",
  "You help callers learn Jacob's availability and arrange 30-minute phone appointments.",
  "This call is a synthetic availability smoke test.",
  "Identify yourself as Jacob's scheduling assistant.",
  "When the caller asks about availability, use the check_availability tool.",
  "Tell the caller the returned times in Eastern Time (America/New_York).",
  "Clearly say that the times are synthetic test availability, not a real appointment.",
  "Do not claim that an appointment has been booked or written to a calendar.",
].join(" ");

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
  availabilityTool: SyntheticAvailabilityTool;
  connectWebSocket: ConnectWebSocket;
  hangupCall?: (callId: string) => Promise<void>;
  referenceTime?: Date;
  maxDurationMs?: number;
  voice?: string;
}): SessionCoordinator {
  let socket: RealtimeSocket | undefined;

  return {
    hangup(): void {
      socket?.close();
    },

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
              const resolved = resolveVoiceModel(session?.model);
              if (session?.model !== undefined && !resolved) {
                finish(
                  "failed",
                  `Expected model ${REQUIRED_MODEL}, but provider returned ${String(session.model)}`,
                );
                return;
              }
              if (resolved) {
                modelVerified = resolved;
              }
              socket?.send(
                JSON.stringify({
                  type: "session.update",
                  session: {
                    voice: options.voice ?? "ara",
                    reasoning: { effort: REQUIRED_REASONING_EFFORT },
                    turn_detection: {
                      type: "server_vad",
                      threshold: 0.5,
                      prefix_padding_ms: 300,
                      silence_duration_ms: 200,
                    },
                    instructions: INSTRUCTIONS,
                    tools: [options.availabilityTool.definition()],
                  },
                }),
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
                  finish(
                    "failed",
                    `Expected model ${REQUIRED_MODEL}, but provider returned ${String(session.model)}`,
                  );
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
              const name = event.name;
              const callId = event.call_id;
              if (name !== "check_availability" || typeof callId !== "string") {
                break;
              }
              let args: { date?: string } = {};
              try {
                args = JSON.parse(String(event.arguments ?? "{}")) as typeof args;
              } catch {
                args = {};
              }
              const result = options.availabilityTool.execute(args, {
                referenceTime: options.referenceTime,
              });
              toolRoundTrips += 1;
              socket?.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: callId,
                    output: JSON.stringify(result),
                  },
                }),
              );
              socket?.send(JSON.stringify({ type: "response.create" }));
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
