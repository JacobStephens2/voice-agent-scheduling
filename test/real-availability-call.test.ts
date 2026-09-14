import { describe, expect, it } from "vitest";
import { createCalendarAvailabilityTool } from "../src/calendar/availability-tool.js";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  incomingCallPayload,
  recordedEvidence,
  signedHeaders,
} from "./helpers.js";

const REQUIRED_MODEL = "grok-voice-think-fast-2.0";
const REFERENCE_TIME = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};

function googleFetch(freeBusy: unknown, status = 200): {
  fetchFn: typeof fetch;
  eventWriteAttempts: string[];
} {
  const eventWriteAttempts: string[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    if (target.includes("/events")) {
      eventWriteAttempts.push(target);
    }
    if (target.includes("/freeBusy")) {
      const body = JSON.parse(String((init as RequestInit)?.body)) as {
        items?: Array<{ id: string }>;
      };
      expect(body.items).toEqual([{ id: "primary" }, { id: "team" }]);
      return new Response(JSON.stringify(freeBusy), { status });
    }
    throw new Error(`unexpected request ${target}`);
  }) as typeof fetch;
  return { fetchFn, eventWriteAttempts };
}

function createRealManager(sockets: FakeRealtimeSocket[], freeBusy: unknown, status = 200) {
  const { fetchFn, eventWriteAttempts } = googleFetch(freeBusy, status);
  const manager = createCallLifecycleManager({
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    maxConcurrentCalls: 1,
    availabilityTool: createCalendarAvailabilityTool({
      fetchFn,
      tokenProvider: { getAccessToken: async () => "test-access-token" },
      selection: SELECTION,
    }),
    connectWebSocket: (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    hangupCall: async () => undefined,
    referenceTime: REFERENCE_TIME,
  });
  return { manager, eventWriteAttempts };
}

async function driveAvailabilityCall(
  sockets: FakeRealtimeSocket[],
  callId: string,
  webhookId: string,
  manager: ReturnType<typeof createCallLifecycleManager>,
  toolArgs: unknown,
): Promise<void> {
  const payload = incomingCallPayload({ callId });
  const response = await manager.handleWebhook(signedHeaders(payload, { webhookId }));
  expect(response.statusCode).toBe(200);

  const socket = sockets[0]!;
  socket.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
  socket.receive({
    type: "session.updated",
    session: { model: REQUIRED_MODEL, reasoning: { effort: "high" } },
  });
  socket.receive({
    type: "response.function_call_arguments.done",
    call_id: "tool-1",
    name: "check_availability",
    arguments: JSON.stringify(toolArgs),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  socket.close();
}

function toolOutput(socket: FakeRealtimeSocket): {
  status: string;
  isSynthetic: boolean;
  reason?: string;
  message: string;
} {
  const message = socket.sent.find(
    (entry): entry is { type: string; item: { type: string; call_id: string; output: string } } =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "conversation.item.create",
  );
  expect(message).toBeDefined();
  return JSON.parse(message!.item.output) as {
    status: string;
    isSynthetic: boolean;
    reason?: string;
    message: string;
  };
}

describe("controlled inbound call with real availability", () => {
  it("runs a real availability round trip without creating any calendar event", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const { manager, eventWriteAttempts } = createRealManager(sockets, {
      calendars: {
        primary: { busy: [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T11:00:00-04:00" }] },
        team: { busy: [] },
      },
    });

    await driveAvailabilityCall(sockets, "call-real-1", "evt_real_1", manager, {
      date: "2026-09-11",
    });

    const output = toolOutput(sockets[0]!);
    expect(output.status).toBe("available");
    expect(output.isSynthetic).toBe(false);
    expect(output.message).toContain("Eastern");
    expect(eventWriteAttempts).toEqual([]);

    const update = sockets[0]!.messageOfType("session.update") as {
      session: { tools: Array<{ name: string }> };
    };
    expect(update.session.tools.map((tool) => tool.name)).toEqual(["check_availability"]);

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-real-1");
    expect(evidence).toMatchObject({ status: "completed", toolRoundTrips: 1 });
    expect(evidence).not.toHaveProperty("audio");
    expect(evidence).not.toHaveProperty("transcript");
  });

  it("gives an honest unavailable answer when the calendar cannot be reached", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const { manager } = createRealManager(
      sockets,
      { calendars: { primary: { busy: [] }, team: { errors: [{ reason: "notFound" }] } } },
    );

    await driveAvailabilityCall(sockets, "call-real-2", "evt_real_2", manager, {
      date: "2026-09-11",
    });

    const output = toolOutput(sockets[0]!);
    expect(output.status).toBe("unavailable");
    expect(output.reason).toBe("calendar_unavailable");
    expect(output.message).not.toContain("10:00");

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-real-2");
    expect(evidence.status).toBe("completed");
  });

  it("clarifies a corrected date on the next tool call", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const { manager } = createRealManager(sockets, {
      calendars: { primary: { busy: [] }, team: { busy: [] } },
    });

    const payload = incomingCallPayload({ callId: "call-real-3" });
    await manager.handleWebhook(signedHeaders(payload, { webhookId: "evt_real_3" }));
    const socket = sockets[0]!;
    socket.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
    socket.receive({
      type: "session.updated",
      session: { model: REQUIRED_MODEL, reasoning: { effort: "high" } },
    });
    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-1",
      name: "check_availability",
      arguments: JSON.stringify({ date: "sometime next week" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const first = toolOutput(socket);
    expect(first.status).toBe("unavailable");
    expect(first.reason).toBe("invalid_date");

    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-2",
      name: "check_availability",
      arguments: JSON.stringify({ date: "2026-09-11" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    socket.close();

    const outputs = socket.sent.filter(
      (entry): entry is { type: string; item: { output: string } } =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "conversation.item.create",
    );
    expect(outputs).toHaveLength(2);
    const second = JSON.parse(outputs[1]!.item.output) as { status: string };
    expect(second.status).toBe("available");

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-real-3");
    expect(evidence.toolRoundTrips).toBe(2);
  });
});
