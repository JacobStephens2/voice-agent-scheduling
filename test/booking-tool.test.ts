import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const TOKEN_PROVIDER = { getAccessToken: async () => "test-access-token" };
const EVENT_ID = "0123456789abcdef0123456789abcdef";
const OPERATION_ID = "fedcba9876543210fedcba9876543210";
const CALL_ID = "call-book-1";

const EMPTY_DAY = {
  calendars: { primary: { busy: [] }, team: { busy: [] } },
};

function storedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    status: "confirmed",
    summary: "Appointment with Ada Lovelace",
    description: "Callback number: +15551239876",
    start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
    transparency: "opaque",
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    },
    ...overrides,
  };
}

function googleFetch(options: {
  freeBusy?: unknown;
  stored?: Record<string, unknown>;
  freeBusyStatus?: number;
}): { fetchFn: typeof fetch; writes: string[] } {
  const writes: string[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (target.includes("/freeBusy")) {
      return new Response(JSON.stringify(options.freeBusy ?? EMPTY_DAY), {
        status: options.freeBusyStatus ?? 200,
      });
    }
    if (target.includes("/events") && method === "POST") {
      writes.push(target);
      return new Response(JSON.stringify({ id: EVENT_ID, summary: "insert-response-not-proof" }), {
        status: 200,
      });
    }
    if (target.includes(`/events/${EVENT_ID}`) && method === "GET") {
      return new Response(JSON.stringify(options.stored ?? storedEvent()), { status: 200 });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  }) as typeof fetch;
  return { fetchFn, writes };
}

function bookingWith(
  google: { fetchFn: typeof fetch; writes: string[] },
  extra: { dataDir?: string } = {},
) {
  return createAppointmentBooking({
    fetchFn: google.fetchFn,
    tokenProvider: TOKEN_PROVIDER,
    selection: SELECTION,
    now: () => MONDAY_14H,
    dataDir: extra.dataDir ?? mkdtempSync(join(tmpdir(), "scheduling-bookings-")),
    createIds: () => ({ operationId: OPERATION_ID, eventId: EVENT_ID }),
  });
}

describe("appointment booking tool", () => {
  it("proposes a chosen appointment with a confirmed callback number and does not write", async () => {
    const google = googleFetch({});
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

  it("creates no event when confirmation is missing, unclear, or the call has no current proposal", async () => {
    const google = googleFetch({});
    const booking = bookingWith(google);

    const withoutProposal = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(withoutProposal.status).toBe("no_proposal");
    expect(google.writes).toEqual([]);

    await booking.execute(
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

    const unclear = await booking.execute(
      "confirm_appointment",
      { confirmed: false },
      { callId: CALL_ID },
    );
    expect(unclear.status).toBe("not_confirmed");
    expect(google.writes).toEqual([]);

    booking.release(CALL_ID);
    const afterDisconnect = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(afterDisconnect.status).toBe("no_proposal");
    expect(google.writes).toEqual([]);
  });

  it("creates one stored appointment after explicit confirmation and only then reports success", async () => {
    const google = googleFetch({
      stored: storedEvent({
        summary: "Appointment with Ada Lovelace",
        description: "Callback number: +15551239876\nPurpose: Website review",
      }),
    });
    const booking = bookingWith(google);

    await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
        purpose: "Website review",
      },
      { callId: CALL_ID },
    );

    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );

    expect(result).toMatchObject({
      status: "booked",
      operationId: OPERATION_ID,
      eventId: EVENT_ID,
      eventExists: true,
    });
    expect(result.message.toLowerCase()).toContain("booked");
    expect(result.message).toContain("Jacob will call");
    expect(result.message).toContain("+15551239876");
    expect(google.writes).toHaveLength(1);

    const again = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(again).toMatchObject({
      status: "booked",
      operationId: OPERATION_ID,
      eventId: EVENT_ID,
      eventExists: true,
    });
    expect(google.writes).toHaveLength(1);
  });

  it("invalidates the earlier proposal when the caller makes a material correction", async () => {
    const google = googleFetch({
      stored: storedEvent({
        summary: "Appointment with Ada Lovelace",
        description: "Callback number: +15559876543",
        start: { dateTime: "2026-09-11T14:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-09-11T14:30:00", timeZone: "America/New_York" },
      }),
    });
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

    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(result.status).toBe("booked");
    expect(google.writes).toHaveLength(1);
  });

  it("does not write a time that is already unavailable on the required calendars", async () => {
    const google = googleFetch({
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

    await booking.execute(
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

    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true },
      { callId: CALL_ID },
    );
    expect(result.status).toBe("unavailable");
    expect(result).toMatchObject({ eventExists: false });
    expect(result.message).toContain("no longer available");
    expect(google.writes).toEqual([]);
  });

  it("stores only minimal booking records, not the conversation or caller details", async () => {
    const google = googleFetch({});
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-bookings-"));
    const booking = bookingWith(google, { dataDir });

    await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
        purpose: "Website review",
      },
      { callId: CALL_ID },
    );
    await booking.execute("confirm_appointment", { confirmed: true }, { callId: CALL_ID });

    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).toContain(OPERATION_ID);
    expect(stored).toContain(EVENT_ID);
    expect(stored).toContain("booked");
    expect(stored).not.toContain("Ada Lovelace");
    expect(stored).not.toContain("15551239876");
    expect(stored).not.toContain("Website review");
    expect(stored).not.toContain("transcript");
  });
});
