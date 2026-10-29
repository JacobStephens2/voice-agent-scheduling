import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { createCalendarAvailabilityTool } from "../src/calendar/availability-tool.js";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  fakeGoogleCalendar,
  openTelephoneSession,
  receiveAssistantResponse,
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
    const { manager, dataDir } = createBookingManager(sockets, google);

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
    expect(JSON.stringify(update.session)).not.toMatch(/transcription/i);
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

    receiveAssistantResponse(socket, {
      responseId: "resp-readback-1",
      transcriptDelta: "Ada Lovelace, callback +15551239876, 2026-09-11 ",
      transcriptDone: "10:00 to 10:30 ",
      payloadTranscript: "America/New_York. Purpose: Website review.",
    });
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
    expect(JSON.stringify(evidence)).not.toContain("Website review");
    expect(evidence).not.toHaveProperty("transcript");
    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain("Ada Lovelace");
    expect(stored).not.toContain("15551239876");
    expect(stored).not.toContain("Website review");
    expect(stored).not.toContain("transcript");
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

  it("leaves no durable booking behind when the caller disconnects before confirmation", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager, dataDir } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-no-confirm",
      webhookId: "evt_book_no_confirm",
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
    // Work without explicit confirmation never starts a calendar insertion,
    // so no pending or booked operation may survive the disconnect.
    expect(createAppointmentLedger({ dataDir }).hasRecords()).toBe(false);

    const evidence = await recordedEvidence(
      () => manager.listEvidence(),
      "call-book-no-confirm",
    );
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

  it("creates no event when the assistant response is not a completed readback of the current proposal", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-not-readback",
      webhookId: "evt_book_not_readback",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
      purpose: "Website review",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };

    // A different response already spoke the fields. This completed response did not.
    socket.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-other",
      delta:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York. Purpose: Website review.",
    });
    socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York. Purpose: Website review.",
    });
    receiveAssistantResponse(socket, {
      responseId: "resp-chatter",
      status: "completed",
      transcriptDelta: "I can help you find a time.",
      payloadTranscript: "Let me know what day works.",
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();

    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("creates no event when the readback response did not complete", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-cancelled-readback",
      webhookId: "evt_book_cancelled_readback",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
      purpose: "Website review",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    receiveAssistantResponse(socket, {
      responseId: "resp-cut-off",
      status: "cancelled",
      transcriptDelta:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York. Purpose: Website review.",
      payloadTranscript:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York. Purpose: Website review.",
    });
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
    receiveAssistantResponse(socket, {
      responseId: "resp-first-readback",
      transcriptDelta:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
    await toolRoundTrip(socket, "tool-2", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15559876543",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "14:00",
    });
    const corrected = toolOutputs(socket)[1] as { proposalId?: string };
    await toolRoundTrip(socket, "tool-3", "confirm_appointment", {
      confirmed: true,
      proposalId: corrected.proposalId,
    });
    receiveAssistantResponse(socket, {
      responseId: "resp-old-readback",
      transcriptDelta:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
    await toolRoundTrip(socket, "tool-4", "confirm_appointment", {
      confirmed: true,
      proposalId: corrected.proposalId,
    });
    receiveAssistantResponse(socket, {
      responseId: "resp-new-readback",
      transcriptDelta:
        "Ada Lovelace, callback +15559876543, 2026-09-11 14:00 to 14:30 America/New_York.",
    });
    await toolRoundTrip(socket, "tool-5", "confirm_appointment", {
      confirmed: true,
      proposalId: corrected.proposalId,
    });
    socket.close();

    const outputs = toolOutputs(socket);
    expect(outputs[1]).toMatchObject({
      status: "proposed",
      readback: { callbackNumber: "+15559876543", startTime: "14:00" },
    });
    expect(outputs[2]).toMatchObject({ status: "readback_incomplete" });
    expect(outputs[3]).toMatchObject({ status: "readback_incomplete" });
    expect(outputs[4]).toMatchObject({ status: "booked", eventExists: true });
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
    receiveAssistantResponse(socket, {
      responseId: "resp-disconnect",
      payloadTranscript:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
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

    expect(
      createAppointmentLedger({ dataDir }).latestForOperation(TEST_OPERATION_ID)?.status,
    ).toBe("pending");

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

    // Booking completion has its own lifetime: the confirmed write lands in
    // durable storage even though the telephone connection already ended.
    expect(createAppointmentLedger({ dataDir }).latestForOperation(TEST_OPERATION_ID)).toMatchObject({
      eventId: TEST_EVENT_ID,
      status: "booked",
    });

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-book-disconnect");
    expect(evidence.status).toBe("completed");
    // Evidence carries structured outcomes only: no caller speech, contact
    // details, audio, or transcripts.
    expect(JSON.stringify(evidence)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(evidence)).not.toContain("15551239876");
    expect(evidence).not.toHaveProperty("audio");
    expect(evidence).not.toHaveProperty("transcript");
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
    receiveAssistantResponse(socket, {
      responseId: "resp-repeat",
      transcriptDelta:
        "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
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

  it("does not finish a readback when a required field exists only at the delta/payload splice", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-splice",
      webhookId: "evt_book_splice",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    const spoken =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    receiveAssistantResponse(socket, {
      responseId: "resp-splice",
      status: "completed",
      transcriptDelta: spoken,
      payloadTranscript: spoken,
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("does not finish a readback when the done transcript repeats the deltas and the start time exists only at that join", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-done-splice",
      webhookId: "evt_book_done_splice",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    const spoken =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    receiveAssistantResponse(socket, {
      responseId: "resp-done-splice",
      status: "completed",
      transcriptDelta: spoken,
      transcriptDone: spoken,
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("does not finish a readback when near-copies of the two transcript sources form a field only at the join", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-near-copy",
      webhookId: "evt_book_near_copy",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    // Neither source contains the other, and neither contains "10:00".
    // Concatenating them would form that start time at the boundary.
    const streamed =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    const payload =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York.";
    receiveAssistantResponse(socket, {
      responseId: "resp-near-copy",
      status: "completed",
      transcriptDelta: streamed,
      payloadTranscript: payload,
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("does not finish a readback when a contained transcript source cuts a field out of a longer number", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-contained-cut",
      webhookId: "evt_book_contained_cut",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    // The shorter source is a substring of the longer one. "10:00" is its own
    // value only in the shorter source; in the longer source it sits inside "110:00".
    const contained =
      "10:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York";
    const containing = `1${contained}`;
    receiveAssistantResponse(socket, {
      responseId: "resp-contained-cut",
      status: "completed",
      transcriptDelta: contained,
      payloadTranscript: containing,
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("does not finish a readback when the streamed transcript contains the payload and the cut opens the start time", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-contained-cut-swap",
      webhookId: "evt_book_contained_cut_swap",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    const contained =
      "10:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York";
    receiveAssistantResponse(socket, {
      responseId: "resp-contained-cut-swap",
      status: "completed",
      transcriptDelta: `1${contained}`,
      payloadTranscript: contained,
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("does not finish a readback when a required field is split across the two transcript sources", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-cross-source",
      webhookId: "evt_book_cross_source",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    receiveAssistantResponse(socket, {
      responseId: "resp-cross-source",
      status: "completed",
      transcriptDelta: "Ada Lovelace, callback +15551239876, 2026-09-11 10:",
      payloadTranscript: "00 to 10:30 America/New_York.",
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });

  it("finishes a readback when each field appears in one of two near-copy transcript sources", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-near-copy-covered",
      webhookId: "evt_book_near_copy_covered",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    const readback =
      "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York";
    receiveAssistantResponse(socket, {
      responseId: "resp-near-copy-covered",
      status: "completed",
      transcriptDelta: `${readback}.`,
      payloadTranscript: `${readback}!`,
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({
      status: "booked",
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);
  });

  it("finishes a readback when distinct fragments of the streamed transcript together contain each field", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-stream-fragments",
      webhookId: "evt_book_stream_fragments",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    socket.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-stream-fragments",
      item_id: "resp-stream-fragments-msg",
      delta: "Ada Lovelace, callback +15551239876, 2026-09-11 10:",
    });
    socket.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-stream-fragments",
      item_id: "resp-stream-fragments-msg",
      delta: "00 to 10:30 America/New_York.",
    });
    socket.receive({
      type: "response.done",
      response: {
        id: "resp-stream-fragments",
        object: "realtime.response",
        status: "completed",
      },
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({
      status: "booked",
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);
  });

  it("does not finish a readback when a repeated fragment is the only thing that keeps the name inside a longer word", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const google = fakeGoogleCalendar({});
    const { manager } = createBookingManager(sockets, google);
    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-book-repeated-fragment",
      webhookId: "evt_book_repeated_fragment",
    });
    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: "Ada",
      callbackNumber: "+15551239876",
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
    });
    const proposed = toolOutputs(socket)[0] as { proposalId?: string };
    // The continuation is the letter m. That letter already occurs in the
    // earlier fragment, and the utterance ends in Adam.
    const earlier =
      "m callback +15551239876 2026-09-11 10:00 10:30 America/New_York Ada";
    const continuation = "m";
    expect(earlier.endsWith("Ada")).toBe(true);
    expect(earlier.includes(continuation)).toBe(true);
    expect(`${earlier}${continuation}`.endsWith("Adam")).toBe(true);
    socket.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-fragment",
      delta: earlier,
    });
    socket.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-fragment",
      delta: continuation,
    });
    socket.receive({
      type: "response.done",
      response: {
        id: "resp-repeated-fragment",
        object: "realtime.response",
        status: "completed",
      },
    });
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    expect(toolOutputs(socket)[1]).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
  });
});
