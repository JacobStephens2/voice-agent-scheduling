import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { fakeGoogleCalendar, TEST_EVENT_ID, TEST_OPERATION_ID } from "./helpers.js";

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
  proposed: { proposalId?: string } | { status: string },
  extra: Record<string, unknown> = {},
  callId = CALL_ID,
) {
  booking.markReadbackFinished(callId);
  const proposalId = "proposalId" in proposed ? proposed.proposalId : undefined;
  return booking.execute(
    "confirm_appointment",
    { confirmed: true, proposalId, ...extra },
    { callId },
  );
}

describe("appointment booking tool", () => {
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

  it("creates no event when confirmation is missing, unclear, or belongs to another call", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);

    const withoutProposal = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(withoutProposal.status).toBe("no_proposal");
    expect(google.writes).toEqual([]);

    const proposed = await proposedOn(booking);

    const unclear = await booking.execute(
      "confirm_appointment",
      { confirmed: false, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: CALL_ID },
    );
    expect(unclear.status).toBe("not_confirmed");
    expect(google.writes).toEqual([]);

    const otherCall = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: "call-other" },
    );
    expect(otherCall.status).toBe("no_proposal");
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

    booking.markReadbackFinished(CALL_ID);
    const stale = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: "not-the-current-proposal" },
      { callId: CALL_ID },
    );
    expect(stale.status).toBe("no_proposal");
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

  it("invalidates the earlier proposal when the caller makes a material correction", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);

    const first = await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
      },
      { callId: CALL_ID },
    );
    expect(first.status).toBe("proposed");

    const second = await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "555-987-6543",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "14:00",
      },
      { callId: CALL_ID },
    );
    expect(second.status).toBe("proposed");
    expect(second).toMatchObject({
      readback: {
        callbackNumber: "+15559876543",
        startTime: "14:00",
        endTime: "14:30",
      },
    });
    expect(second.message).toContain("+15559876543");
    expect(second.message).toContain("14:00");
    expect(second.message).not.toContain("+15551239876");
    expect("proposalId" in first && "proposalId" in second).toBe(true);
    expect((second as { proposalId?: string }).proposalId).not.toBe(
      (first as { proposalId?: string }).proposalId,
    );

    const result = await confirmCurrent(booking, second);
    expect(result.status).toBe("booked");
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
