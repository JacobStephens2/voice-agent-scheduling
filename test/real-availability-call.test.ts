import { describe, expect, it } from "vitest";
import { createCalendarAvailabilityTool } from "../src/calendar/availability-tool.js";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  openTelephoneSession,
  recordedEvidence,
  toolOutputs,
  toolRoundTrip,
} from "./helpers.js";

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
  const socket = await openTelephoneSession(sockets, manager, { callId, webhookId });
  await toolRoundTrip(socket, "tool-1", "check_availability", toolArgs);
  socket.close();
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

    const output = toolOutputs(sockets[0]!)[0] as {
      status: string;
      isSynthetic: boolean;
      message: string;
    };
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

    const output = toolOutputs(sockets[0]!)[0] as {
      status: string;
      reason?: string;
      message: string;
    };
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

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-real-3",
      webhookId: "evt_real_3",
    });
    await toolRoundTrip(socket, "tool-1", "check_availability", { date: "sometime next week" });

    const first = toolOutputs(socket)[0] as { status: string; reason?: string };
    expect(first.status).toBe("unavailable");
    expect(first.reason).toBe("invalid_date");

    await toolRoundTrip(socket, "tool-2", "check_availability", { date: "2026-09-11" });
    socket.close();

    const outputs = toolOutputs(socket);
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toMatchObject({ status: "available" });

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-real-3");
    expect(evidence.toolRoundTrips).toBe(2);
  });
});
