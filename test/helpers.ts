import { computeWebhookSignature } from "../src/admission.js";
import type { StructuredCallEvidence } from "../src/evidence.js";
import type { CallLifecycleManager } from "../src/lifecycle.js";
import type { FakeRealtimeSocket } from "./fake-socket.js";

export const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldGZvcnNpZ25pbmd3ZWI=";
export const REQUIRED_MODEL = "grok-voice-think-fast-2.0";
export const TEST_EVENT_ID = "0123456789abcdef0123456789abcdef";
export const TEST_OPERATION_ID = "fedcba9876543210fedcba9876543210";

export function incomingCallPayload(options: {
  callId: string;
  callerNumber?: string;
  calledNumber?: string;
}): string {
  return JSON.stringify({
    object: "event",
    id: `evt_${options.callId}`,
    type: "realtime.call.incoming",
    created_at: 1_750_000_000,
    data: {
      call_id: options.callId,
      sip_headers: [
        { name: "From", value: options.callerNumber ?? "+15551234567" },
        { name: "To", value: options.calledNumber ?? "+18005550199" },
      ],
      metadata: {},
    },
  });
}

export function signedHeaders(
  rawBody: string,
  options: { webhookId: string; secret?: string; timestamp?: string } = {
    webhookId: "msg_1",
  },
): { id: string; timestamp: string; signature: string; rawBody: string } {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const secret = options.secret ?? WEBHOOK_SECRET;
  return {
    id: options.webhookId,
    timestamp,
    signature: computeWebhookSignature(secret, options.webhookId, timestamp, rawBody),
    rawBody,
  };
}

export async function recordedEvidence(
  listEvidence: () => readonly StructuredCallEvidence[],
  callId: string,
  timeoutMs = 1000,
): Promise<StructuredCallEvidence> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = listEvidence().find((entry) => entry.callId === callId);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for evidence ${callId}`);
}

export function fakeGoogleCalendar(options: {
  readonly eventId?: string;
  readonly freeBusy?: unknown;
  readonly freeBusyStatus?: number;
}): {
  fetchFn: typeof fetch;
  writes: Array<{ url: string; body: { [key: string]: unknown } }>;
} {
  const eventId = options.eventId ?? TEST_EVENT_ID;
  const writes: Array<{ url: string; body: { [key: string]: unknown } }> = [];
  const emptyDay = {
    calendars: { primary: { busy: [] }, team: { busy: [] } },
  };
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (target.includes("/freeBusy")) {
      return new Response(JSON.stringify(options.freeBusy ?? emptyDay), {
        status: options.freeBusyStatus ?? 200,
      });
    }
    if (target.includes("/events") && method === "POST") {
      const body = JSON.parse(String((init as RequestInit).body)) as { [key: string]: unknown };
      writes.push({ url: target, body });
      return new Response(JSON.stringify({ id: eventId, summary: "insert-response-not-proof" }), {
        status: 200,
      });
    }
    if (target.includes(`/events/${eventId}`) && method === "GET") {
      const inserted = writes[writes.length - 1]?.body;
      // No insert was accepted, so the event is absent. A hollow 200 would
      // look like a stored event that fails the approved shape.
      if (!inserted) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: eventId,
          status: "confirmed",
          summary: inserted.summary,
          description: inserted.description,
          start: inserted.start,
          end: inserted.end,
          transparency: inserted.transparency,
          reminders: inserted.reminders,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected request ${method} ${target}`);
  }) as typeof fetch;
  return { fetchFn, writes };
}

export async function openTelephoneSession(
  sockets: FakeRealtimeSocket[],
  manager: CallLifecycleManager,
  options: { callId: string; webhookId: string; callerNumber?: string },
): Promise<FakeRealtimeSocket> {
  const payload = incomingCallPayload({
    callId: options.callId,
    callerNumber: options.callerNumber,
  });
  const response = await manager.handleWebhook(
    signedHeaders(payload, { webhookId: options.webhookId }),
  );
  if (response.statusCode !== 200) {
    throw new Error(`Expected admitted call, got ${response.statusCode}`);
  }
  const socket = sockets[0];
  if (!socket) {
    throw new Error("Expected a realtime socket after admission");
  }
  socket.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
  socket.receive({
    type: "session.updated",
    session: { model: REQUIRED_MODEL, reasoning: { effort: "high" } },
  });
  return socket;
}

/**
 * One provider assistant response. Transcript text from
 * `response.output_audio_transcript` events stays separate from transcript
 * text on the completed response payload, matching the two places the
 * session is allowed to read.
 */
export function receiveAssistantResponse(
  socket: FakeRealtimeSocket,
  options: {
    responseId: string;
    status?: string;
    eventTranscript?: string;
    doneTranscript?: string;
    payloadTranscript?: string;
  },
): void {
  if (options.eventTranscript) {
    socket.receive({
      type: "response.output_audio_transcript.delta",
      response_id: options.responseId,
      item_id: `${options.responseId}-msg`,
      delta: options.eventTranscript,
    });
  }
  if (options.doneTranscript !== undefined) {
    socket.receive({
      type: "response.output_audio_transcript.done",
      response_id: options.responseId,
      item_id: `${options.responseId}-msg`,
      transcript: options.doneTranscript,
    });
  }
  const payloadTranscript = options.payloadTranscript ?? "";
  socket.receive({
    type: "response.done",
    response: {
      id: options.responseId,
      object: "realtime.response",
      status: options.status ?? "completed",
      ...(payloadTranscript
        ? {
            output: [
              {
                id: `${options.responseId}-item`,
                type: "message",
                role: "assistant",
                content: [{ type: "output_audio", transcript: payloadTranscript }],
              },
            ],
          }
        : {}),
    },
  });
}

export async function toolRoundTrip(
  socket: FakeRealtimeSocket,
  toolCallId: string,
  name: string,
  args: unknown,
): Promise<void> {
  socket.receive({
    type: "response.function_call_arguments.done",
    call_id: toolCallId,
    name,
    arguments: JSON.stringify(args),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
}

export function toolOutputs(socket: FakeRealtimeSocket): Array<{ [key: string]: unknown }> {
  return socket.sent
    .filter(
      (entry): entry is { type: string; item: { output: string } } =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "conversation.item.create",
    )
    .map((entry) => JSON.parse(entry.item.output) as { [key: string]: unknown });
}
