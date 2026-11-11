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
  it("isolates call-scoped handles with coincident response identities", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);
    const first = await proposedOn(booking);
    const second = await proposedOn(booking, {}, "other-call");
    if (first.status !== "proposed" || !first.readback) {
      throw new Error("Expected Readback fields");
    }
    const one = booking.openReadback(CALL_ID);
    const two = booking.openReadback("other-call");
    const events = assistantResponseEvents({ responseId: "same", transcriptDelta: readbackText(first.readback) });
    one.observe(events[0]!);
    two.observe(events[1]!);
    expect(await booking.execute("confirm_appointment", {
      confirmed: true, proposalId: "proposalId" in second ? second.proposalId : undefined,
    }, { callId: "other-call" })).toMatchObject({ status: "readback_incomplete" });
    one.observe(events[1]!);
    one.close();
    two.close();
    expect(await booking.execute("confirm_appointment", {
      confirmed: true, proposalId: first.proposalId,
    }, { callId: CALL_ID })).toMatchObject({ status: "booked" });
    expect(google.writes).toHaveLength(1);
  });

  it("does not share assembly between handles for the same call or reuse a closed handle", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);
    const proposed = await proposedOn(booking);
    if (proposed.status !== "proposed" || !proposed.readback) {
      throw new Error("Expected Readback fields");
    }
    const one = booking.openReadback(CALL_ID);
    const two = booking.openReadback(CALL_ID);
    const events = assistantResponseEvents({ responseId: "same", transcriptDelta: readbackText(proposed.readback) });
    one.observe(events[0]!);
    two.observe(events[1]!);
    one.close();
    for (const event of events) one.observe(event);
    expect(await booking.execute("confirm_appointment", {
      confirmed: true, proposalId: proposed.proposalId,
    }, { callId: CALL_ID })).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
    two.close();
  });

  it("accepts payload completion without an identity and preserves earned readiness", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);
    const proposed = await proposedOn(booking);
    if (proposed.status !== "proposed" || !proposed.readback) {
      throw new Error("Expected Readback fields");
    }
    const handle = booking.openReadback(CALL_ID);
    handle.observe({ type: "response.done", response: {
      status: "completed", output: [{ content: [{ transcript: readbackText(proposed.readback) }] }],
    } });
    handle.observe({ type: "response.done", response: { status: "cancelled" } });
    handle.observe({ type: "response.done", response: { status: "completed" } });
    expect(await proposedOn(booking, { callerName: "" })).toMatchObject({ status: "invalid" });
    expect(await booking.execute("confirm_appointment", {
      confirmed: false, proposalId: proposed.proposalId,
    }, { callId: CALL_ID })).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
    handle.close();
    expect(await booking.execute("confirm_appointment", {
      confirmed: true, proposalId: proposed.proposalId,
    }, { callId: CALL_ID })).toMatchObject({ status: "booked" });
    expect(google.writes).toHaveLength(1);
  });

  it("resets readiness after a valid replacement until that proposal is read back", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);
    const first = await proposedOn(booking);
    completeReadback(booking, CALL_ID, first);
    const replacement = await proposedOn(booking, { callerName: "Grace Hopper" });
    expect(await booking.execute("confirm_appointment", {
      confirmed: true, proposalId: "proposalId" in replacement ? replacement.proposalId : undefined,
    }, { callId: CALL_ID })).toMatchObject({ status: "readback_incomplete" });
    completeReadback(booking, CALL_ID, first);
    expect(await booking.execute("confirm_appointment", {
      confirmed: true, proposalId: "proposalId" in replacement ? replacement.proposalId : undefined,
    }, { callId: CALL_ID })).toMatchObject({ status: "readback_incomplete" });
    expect(google.writes).toEqual([]);
    expect(await confirmCurrent(booking, replacement)).toMatchObject({ status: "booked" });
  });

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

  it("creates no event when confirmation is missing, unclear, or belongs to another call", async () => {
    const google = fakeGoogleCalendar({});
    const booking = bookingWith(google);

    const withoutProposal = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(withoutProposal.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);

    const proposed = await proposedOn(booking);

    const unclear = await booking.execute(
      "confirm_appointment",
      { confirmed: false, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: CALL_ID },
    );
    expect(unclear.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);

    const otherCall = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: (proposed as { proposalId?: string }).proposalId },
      { callId: "call-other" },
    );
    expect(otherCall.status).toBe("readback_incomplete");
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
