import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { createCalendarAvailabilityTool } from "../src/calendar/availability-tool.js";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  fakeGoogleCalendar,
  openTelephoneSession,
  recordedEvidence,
  TEST_EVENT_ID,
  TEST_OPERATION_ID,
  toolOutputs,
  toolRoundTrip,
} from "./helpers.js";

const REFERENCE_TIME = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};

function createBookingManager(
  sockets: FakeRealtimeSocket[],
  google: ReturnType<typeof fakeGoogleCalendar>,
  fetchFn: typeof fetch = google.fetchFn,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-booking-call-"));
  const tokenProvider = { getAccessToken: async () => "test-access-token" };
  const booking = createAppointmentBooking({
    fetchFn,
    tokenProvider,
    selection: SELECTION,
    now: () => REFERENCE_TIME,
    dataDir,
    createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
    allowWrites: true,
  });
  const manager = createCallLifecycleManager({
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    maxConcurrentCalls: 1,
    availabilityTool: createCalendarAvailabilityTool({
      fetchFn,
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
  return { manager, booking, dataDir };
}

describe("controlled inbound call with appointment booking", () => {
  it("books one appointment through the telephone flow after explicit confirmation", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-1",
      webhookId: "evt_book_1",
      callerNumber: "+15550001111",
    });
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

    socket.receive({ type: "response.done" });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: (proposed as { proposalId?: string }).proposalId,
    });
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
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-2",
      webhookId: "evt_book_2",
    });
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

  it("creates no event when confirmation arrives before the readback turn finishes", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-interrupt",
      webhookId: "evt_book_interrupt",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();

    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("requires a fresh readback after a material correction before writing", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-3",
      webhookId: "evt_book_3",
    });
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
    const corrected = toolOutputs(socket)[1] as { proposalId?: string };
    socket.receive({ type: "response.done" });
    await toolRoundTrip(socket, "tool-3", "confirm_appointment", {
      confirmed: true,
      proposalId: corrected.proposalId,
    });
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

  it("completes an accepted write even if the call disconnects mid-insert", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    let insertStarted = false;
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const gatedFetch = (async (url: unknown, init?: unknown) => {
      const target = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (target.includes("/events") && method === "POST") {
        insertStarted = true;
        await insertGate;
      }
      return google.fetchFn(target, init as RequestInit);
    }) as typeof fetch;
    const { manager, dataDir } = createBookingManager(sockets, google, gatedFetch);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-disconnect",
      webhookId: "evt_book_disconnect",
    });
    await toolRoundTrip(socket, "tool-1", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    socket.receive({ type: "response.done" });
    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-2",
      name: "confirm_appointment",
      arguments: JSON.stringify({ confirmed: true, proposalId: proposed.proposalId }),
    });
    const deadline = Date.now() + 1000;
    while (!insertStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(insertStarted).toBe(true);

    const pendingLog = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(pendingLog).toContain(TEST_OPERATION_ID);
    expect(pendingLog).toContain("pending");

    socket.close();
    releaseInsert();

    const outputsDeadline = Date.now() + 2000;
    while (toolOutputs(socket).length < 2 && Date.now() < outputsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(toolOutputs(socket)[1]).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-book-disconnect");
    expect(evidence.status).toBe("completed");
  });

  it("returns the same completed operation when the confirmation is repeated", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-4",
      webhookId: "evt_book_4",
    });
    await toolRoundTrip(socket, "tool-1", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    socket.receive({ type: "response.done" });
    await toolRoundTrip(socket, "tool-2", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    await toolRoundTrip(socket, "tool-3", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();

    const outputs = toolOutputs(socket);
    expect(outputs[1]).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(outputs[2]).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-book-4");
    expect(evidence.toolRoundTrips).toBe(3);
  });
});
