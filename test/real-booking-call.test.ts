import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
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
const EVENT_ID = "0123456789abcdef0123456789abcdef";
const OPERATION_ID = "fedcba9876543210fedcba9876543210";

function googleCalendar(freeBusy: unknown = {
  calendars: { primary: { busy: [] }, team: { busy: [] } },
}) {
  const writes: Array<{ url: string; body: { [key: string]: unknown } }> = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (target.includes("/freeBusy")) {
      return new Response(JSON.stringify(freeBusy), { status: 200 });
    }
    if (target.includes("/events") && method === "POST") {
      writes.push({
        url: target,
        body: JSON.parse(String((init as RequestInit).body)) as { [key: string]: unknown },
      });
      return new Response(JSON.stringify({ id: EVENT_ID, summary: "insert-response-not-proof" }), {
        status: 200,
      });
    }
    if (target.includes(`/events/${EVENT_ID}`) && method === "GET") {
      const inserted = writes[0]?.body ?? {};
      return new Response(
        JSON.stringify({
          id: EVENT_ID,
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

async function openCall(
  sockets: FakeRealtimeSocket[],
  manager: ReturnType<typeof createCallLifecycleManager>,
  callId: string,
  webhookId: string,
): Promise<FakeRealtimeSocket> {
  const payload = incomingCallPayload({ callId, callerNumber: "+15550001111" });
  const response = await manager.handleWebhook(signedHeaders(payload, { webhookId }));
  expect(response.statusCode).toBe(200);
  const socket = sockets[0]!;
  socket.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
  socket.receive({
    type: "session.updated",
    session: { model: REQUIRED_MODEL, reasoning: { effort: "high" } },
  });
  return socket;
}

function toolOutputs(socket: FakeRealtimeSocket): Array<{ [key: string]: unknown }> {
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

async function toolRoundTrip(
  socket: FakeRealtimeSocket,
  callId: string,
  name: string,
  args: unknown,
): Promise<void> {
  socket.receive({
    type: "response.function_call_arguments.done",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function createBookingManager(sockets: FakeRealtimeSocket[], google: ReturnType<typeof googleCalendar>) {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-booking-call-"));
  const tokenProvider = { getAccessToken: async () => "test-access-token" };
  const booking = createAppointmentBooking({
    fetchFn: google.fetchFn,
    tokenProvider,
    selection: SELECTION,
    now: () => REFERENCE_TIME,
    dataDir,
    createIds: () => ({ operationId: OPERATION_ID, eventId: EVENT_ID }),
  });
  const manager = createCallLifecycleManager({
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    maxConcurrentCalls: 1,
    availabilityTool: createCalendarAvailabilityTool({
      fetchFn: google.fetchFn,
      tokenProvider,
      selection: SELECTION,
      now: () => REFERENCE_TIME,
    }),
    booking,
    connectWebSocket: (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    hangupCall: async () => undefined,
    referenceTime: REFERENCE_TIME,
  });
  return { manager, booking };
}

describe("controlled inbound call with appointment booking", () => {
  it("books one appointment through the telephone flow after explicit confirmation", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = googleCalendar();
    const { manager } = createBookingManager(sockets, google);

    const socket = await openCall(sockets, manager, "call-book-1", "evt_book_1");
    const update = socket.messageOfType("session.update") as {
      session: { tools: Array<{ name: string }>; instructions: string };
    };
    expect(update.session.tools.map((tool) => tool.name)).toEqual([
      "check_availability",
      "propose_appointment",
      "confirm_appointment",
    ]);
    expect(update.session.instructions.toLowerCase()).toContain("callback");
    expect(update.session.instructions.toLowerCase()).toContain("confirm");
    expect(update.session.instructions.toLowerCase()).toContain("do not request an email");
    expect(update.session.instructions.toLowerCase()).toContain("jacob will call");

    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "555-123-9876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
      purpose: "Website review",
    });
    expect(google.writes).toEqual([]);
    const proposed = toolOutputs(socket)[0] as {
      status: string;
      readback: { callbackNumber: string; startTime: string; endTime: string };
    };
    expect(proposed.status).toBe("proposed");
    expect(proposed.readback.callbackNumber).toBe("+15551239876");
    expect(proposed.readback.startTime).toBe("10:00");
    expect(proposed.readback.endTime).toBe("10:30");

    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", { confirmed: true });
    socket.close();

    const confirmed = toolOutputs(socket)[1] as {
      status: string;
      eventExists: boolean;
      message: string;
    };
    expect(confirmed.status).toBe("booked");
    expect(confirmed.eventExists).toBe(true);
    expect(confirmed.message).toContain("Jacob will call");
    expect(google.writes).toHaveLength(1);
    expect(google.writes[0]?.body).toMatchObject({
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876\nPurpose: Website review",
      transparency: "opaque",
    });
    expect(google.writes[0]?.body).not.toHaveProperty("attendees");
    expect(google.writes[0]?.url).toContain("sendUpdates=none");

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-book-1");
    expect(evidence).toMatchObject({ status: "completed", toolRoundTrips: 2 });
    expect(evidence).not.toHaveProperty("audio");
    expect(JSON.stringify(evidence)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(evidence)).not.toContain("15551239876");
  });

  it("creates no event when the caller disconnects before explicit confirmation", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = googleCalendar();
    const { manager } = createBookingManager(sockets, google);

    const socket = await openCall(sockets, manager, "call-book-2", "evt_book_2");
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    socket.close();

    expect(google.writes).toEqual([]);
    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-book-2");
    expect(evidence.status).toBe("completed");
  });

  it("requires a fresh readback after a material correction before writing", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = googleCalendar();
    const { manager } = createBookingManager(sockets, google);

    const socket = await openCall(sockets, manager, "call-book-3", "evt_book_3");
    await toolRoundTrip(socket, "tool-1", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    await toolRoundTrip(socket, "tool-2", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15559876543",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "14:00",
    });
    await toolRoundTrip(socket, "tool-3", "confirm_appointment", { confirmed: true });
    socket.close();

    const outputs = toolOutputs(socket);
    expect(outputs[1]).toMatchObject({
      status: "proposed",
      readback: { callbackNumber: "+15559876543", startTime: "14:00" },
    });
    expect(outputs[2]).toMatchObject({ status: "booked", eventExists: true });
    expect(google.writes).toHaveLength(1);
    expect(google.writes[0]?.body).toMatchObject({
      description: "Callback number: +15559876543",
      start: { dateTime: "2026-09-11T14:00:00", timeZone: "America/New_York" },
    });
  });

  it("returns the same completed operation when the confirmation is repeated", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = googleCalendar();
    const { manager } = createBookingManager(sockets, google);

    const socket = await openCall(sockets, manager, "call-book-4", "evt_book_4");
    await toolRoundTrip(socket, "tool-1", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    await toolRoundTrip(socket, "tool-2", "confirm_appointment", { confirmed: true });
    await toolRoundTrip(socket, "tool-3", "confirm_appointment", { confirmed: true });
    socket.close();

    const outputs = toolOutputs(socket);
    expect(outputs[1]).toMatchObject({
      status: "booked",
      operationId: OPERATION_ID,
      eventId: EVENT_ID,
      eventExists: true,
    });
    expect(outputs[2]).toMatchObject({
      status: "booked",
      operationId: OPERATION_ID,
      eventId: EVENT_ID,
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-book-4");
    expect(evidence.toolRoundTrips).toBe(3);
  });
});
