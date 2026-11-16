import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking, type BookingToolResult } from "../src/calendar/booking-tool.js";
import { assistantResponseEvents, completeReadback, fakeGoogleCalendar, readbackText, TEST_EVENT_ID, TEST_OPERATION_ID } from "./helpers.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const TOKEN_PROVIDER = { getAccessToken: async () => "test-access-token" };
const CALL_ID = "call-book-1";

const PROPOSE_ARGS = {
  callerName: "Ada Lovelace",
  callbackNumber: "+15551239876",
  callbackConfirmed: true,
  date: "2026-09-11",
  startTime: "10:00",
};

function bookingWith(
  google: ReturnType<typeof fakeGoogleCalendar>,
  extra: { dataDir?: string; allowWrites?: boolean } = {},
) {
  return createAppointmentBooking({
    fetchFn: google.fetchFn,
    tokenProvider: TOKEN_PROVIDER,
    selection: SELECTION,
    now: () => MONDAY_14H,
    dataDir: extra.dataDir ?? mkdtempSync(join(tmpdir(), "scheduling-bookings-")),
    createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
    allowWrites: extra.allowWrites ?? true,
  });
}

async function proposedOn(
  booking: ReturnType<typeof createAppointmentBooking>,
  extra: Record<string, unknown> = {},
  callId = CALL_ID,
) {
  return booking.execute("propose_appointment", { ...PROPOSE_ARGS, ...extra }, { callId });
}

async function confirmCurrent(
  booking: ReturnType<typeof createAppointmentBooking>,
  proposed: BookingToolResult,
  extra: Record<string, unknown> = {},
  callId = CALL_ID,
) {
  completeReadback(booking, callId, proposed);
  const proposalId = "proposalId" in proposed ? proposed.proposalId : undefined;
  return booking.execute(
    "confirm_appointment",
    { confirmed: true, proposalId, ...extra },
    { callId },
  );
}

describe("appointment booking tool", () => {
  it("finishes an authorized write when its handle closes before the final insertion recheck", async () => {
    const google = fakeGoogleCalendar({});
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const booking = bookingWith({ ...google, fetchFn: async (input, init) => {
      if (String(input).includes("/freeBusy")) {
        reached();
        await gate;
      }
      return google.fetchFn(input, init);
    } });
    const proposed = await proposedOn(booking);
    if (proposed.status !== "proposed" || !proposed.readback) {
      throw new Error("Expected Readback fields");
    }
    const handle = booking.openReadback(CALL_ID);
    for (const event of assistantResponseEvents({ responseId: "authorized", transcriptDelta: readbackText(proposed.readback) })) {
      handle.observe(event);
    }
    const pending = booking.execute("confirm_appointment", {
      confirmed: true, proposalId: proposed.proposalId,
    }, { callId: CALL_ID });
    await started;
    handle.close();
    handle.close();
    release();
    expect(await pending).toMatchObject({ status: "booked", eventExists: true });
    expect(google.writes).toHaveLength(1);
  });

  it("proposes a chosen appointment with a confirmed callback number and does not write", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);

    const names = booking.definitions().map((tool) => tool.name);
    expect(names).toContain("propose_appointment");
    expect(names).toContain("confirm_appointment");
    const propertyNames = booking.definitions().flatMap((tool) =>
      Object.keys(tool.parameters.properties),
    );
    expect(propertyNames).not.toContain("email");
    expect(propertyNames).not.toContain("emailAddress");

    const result = await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "555-123-9876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
        purpose: "Website review",
      },
      { callId: CALL_ID },
    );

    expect(result).toMatchObject({
      status: "proposed",
      readback: {
        callerName: "Ada Lovelace",
        callbackNumber: "+15551239876",
        date: "2026-09-11",
        startTime: "10:00",
        endTime: "10:30",
        timezone: "America/New_York",
        purpose: "Website review",
      },
    });
    expect(result.message).toContain("Ada Lovelace");
    expect(result.message).toContain("+15551239876");
    expect(result.message).toContain("2026-09-11");
    expect(result.message).toContain("10:00");
    expect(result.message).toContain("10:30");
    expect(result.message).toContain("America/New_York");
    expect(google.writes).toEqual([]);
  });

  it("creates no event when the readback was not finished or the proposalId is stale", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);
    const proposed = await proposedOn(booking);

    const interrupted = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: CALL_ID },
    );
    expect(interrupted.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);

    completeReadback(booking, CALL_ID, proposed);
    const stale = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: "not-the-current-proposal" },
      { callId: CALL_ID },
    );
    expect(stale.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);
  });

  it("does not insert when the current proposal is replaced before the calendar write", async () => {
    const google = fakeGoogleCalendar({});
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-bookings-"));
    let booking: ReturnType<typeof createAppointmentBooking> | undefined;
    let replacedProposalId: string | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/freeBusy") && booking && !replacedProposalId) {
        const replaced = await booking.execute(
          "propose_appointment",
          {
            callerName: "Grace Hopper",
            callbackNumber: "+15559876543",
            callbackConfirmed: true,
            date: "2026-09-11",
            startTime: "14:00",
          },
          { callId: CALL_ID },
        );
        if (replaced.status !== "proposed" || !("proposalId" in replaced) || !replaced.proposalId) {
          throw new Error("replacement proposal was not stored");
        }
        replacedProposalId = replaced.proposalId;
      }
      return google.fetchFn(input, init);
    };
    booking = createAppointmentBooking({
      fetchFn,
      tokenProvider: TOKEN_PROVIDER,
      selection: SELECTION,
      now: () => MONDAY_14H,
      dataDir,
      createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
      allowWrites: true,
    });

    const proposed = await proposedOn(booking);
    completeReadback(booking, CALL_ID, proposed);
    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: CALL_ID },
    );

    expect(replacedProposalId).toEqual(expect.any(String));
    expect(result).toMatchObject({
      status: "failed",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: false,
      message:
        "The calendar event could not be confirmed. Do not tell the caller the appointment is booked.",
    });
    expect(google.writes).toEqual([]);

    const ledger = createAppointmentLedger({ dataDir });
    const numberHash = ledger.hashCallbackNumber("+15551239876");
    expect(numberHash).toEqual(expect.any(String));
    expect(ledger.latestForOperation(TEST_OPERATION_ID)?.status).toBe("failed");
    expect(ledger.operationsHoldingAppointment(numberHash as string)).toEqual([]);
    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain("+15551239876");
    expect(stored).not.toContain("15551239876");

    const originalAfterReplacement = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: CALL_ID },
    );
    expect(originalAfterReplacement.status).toBe("readback_incomplete");
    expect(originalAfterReplacement.message).toContain("does not match the current proposal");
    expect(google.writes).toEqual([]);
  });

  it("checks a queued confirmation against the proposal current when validation begins", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-queued-confirmation-"));
    createAppointmentLedger({ dataDir }).record({
      operationId: "prior-operation", eventId: "prior-event", callId: "prior-call",
      proposalId: "prior-proposal", calendarId: "primary", startUtc: "2026-09-11T14:00:00.000Z",
      status: "pending",
    });
    const google = fakeGoogleCalendar({});
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    let availabilityReads = 0;
    const booking = bookingWith({ ...google, fetchFn: async (input, init) => {
      if (String(input).includes("/events/prior-event")) {
        reached();
        await gate;
        return new Response("{}", { status: 404 });
      }
      if (String(input).includes("/freeBusy")) availabilityReads += 1;
      return google.fetchFn(input, init);
    } }, { dataDir });
    const original = await proposedOn(booking);
    completeReadback(booking, CALL_ID, original);
    const reconciliation = booking.reconcileUnresolvedOperations();
    await reading;
    const queued = booking.execute("confirm_appointment", {
      confirmed: true, proposalId: "proposalId" in original ? original.proposalId : undefined,
    }, { callId: CALL_ID });
    const replacement = await proposedOn(booking, { startTime: "14:00" });
    completeReadback(booking, CALL_ID, replacement);
    release();
    await reconciliation;
    expect(await queued).toMatchObject({
      status: "readback_incomplete", message: expect.stringContaining("does not match the current proposal"),
    });
    expect(availabilityReads).toBe(0);
    expect(google.writes).toEqual([]);
  });

  it("does not write when calendar writes are disabled on this deployment", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google, { allowWrites: false });
    const proposed = await proposedOn(booking);
    const result = await confirmCurrent(booking, proposed);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("not enabled");
    expect(google.writes).toEqual([]);
  });

  it("creates one stored appointment after explicit confirmation and only then reports success", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);

    const proposed = await proposedOn(booking, { purpose: "Website review" });
    const result = await confirmCurrent(booking, proposed);

    expect(result).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(result.message.toLowerCase()).toContain("booked");
    expect(result.message).toContain("Jacob will call");
    expect(result.message).toContain("+15551239876");
    expect(google.writes).toHaveLength(1);

    const again = await confirmCurrent(booking, proposed);
    expect(again).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);
  });

  it("does not write a time that is already unavailable on the required calendars", async () => {
    const google = fakeGoogleCalendar({
      freeBusy: {
        calendars: {
          primary: {
            busy: [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T10:30:00-04:00" }],
          },
          team: { busy: [] },
        },
      },
    });
    const booking = bookingWith(google);

    const proposed = await proposedOn(booking);
    const result = await confirmCurrent(booking, proposed);
    expect(result.status).toBe("unavailable");
    expect(result).toMatchObject({ eventExists: false });
    expect(result.message).toContain("no longer available");
    expect(google.writes).toEqual([]);
  });

  it("preserves a replacement when the old unavailable proposal's stored-event read returns missing", async () => {
    const google = fakeGoogleCalendar({
      freeBusy: {
        calendars: {
          primary: {
            busy: [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T10:30:00-04:00" }],
          },
          team: { busy: [] },
        },
      },
    });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    let reads = 0;
    const booking = bookingWith({ ...google, fetchFn: async (input, init) => {
      if (String(input).includes("/events/") && ++reads === 1) {
        reached();
        await gate;
      }
      return google.fetchFn(input, init);
    } });
    const original = await proposedOn(booking);
    const pending = confirmCurrent(booking, original);
    await reading;
    const replacement = await proposedOn(booking, { startTime: "14:00" });
    release();
    expect(await pending).toMatchObject({ status: "unavailable", eventExists: false });
    expect(google.writes).toEqual([]);

    const confirmReplacement = () => booking.execute("confirm_appointment", {
      confirmed: true,
      proposalId: "proposalId" in replacement ? replacement.proposalId : undefined,
    }, { callId: CALL_ID });
    expect(await confirmReplacement()).toMatchObject({
      status: "readback_incomplete",
      message: "The readback is not finished. Complete the full readback without interruption before confirming. Do not create the appointment.",
    });
    completeReadback(booking, CALL_ID, replacement);
    expect(await confirmReplacement()).toMatchObject({ status: "booked", eventExists: true });
    expect(await confirmReplacement()).toMatchObject({ status: "booked", eventExists: true });
    expect(google.writes).toHaveLength(1);
    expect(google.writes[0]?.body.start).toMatchObject({ dateTime: "2026-09-11T14:00:00" });
  });

  it("stores only minimal booking records, not the conversation or caller details", async () => {
    const google = fakeGoogleCalendar({});
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-bookings-"));
    const booking = bookingWith(google, { dataDir });

    const proposed = await proposedOn(booking, { purpose: "Website review" });
    await confirmCurrent(booking, proposed);

    expect(createAppointmentLedger({ dataDir }).latestForOperation(TEST_OPERATION_ID)).toMatchObject({
      eventId: TEST_EVENT_ID,
      status: "booked",
    });
    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain("Ada Lovelace");
    expect(stored).not.toContain("15551239876");
    expect(stored).not.toContain("Website review");
    expect(stored).not.toContain("transcript");
  });
});
