import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const AFTER_APPOINTMENT = new Date("2026-09-12T10:00:00-04:00");
const FRIDAY_DATE = "2026-09-11";
const LATER_FRIDAY_DATE = "2026-09-18";
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const TOKEN_PROVIDER = { getAccessToken: async () => "test-access-token" };
const CALLBACK_NUMBER = "+15551239876";

type EventBody = Record<string, unknown>;

function controllableCalendar() {
  const events = new Map<string, EventBody>();
  const cancelled = new Set<string>();
  const writes: Array<{ url: string; body: EventBody }> = [];
  let eventReadStatus: number | "throw" = 200;
  let failPostOnce = false;
  let suppressReads = false;
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (target.includes("/freeBusy")) {
      return new Response(
        JSON.stringify({ calendars: { primary: { busy: [] }, team: { busy: [] } } }),
        { status: 200 },
      );
    }
    if (method === "POST" && target.includes("/events")) {
      const body = JSON.parse(String((init as RequestInit).body)) as EventBody;
      if (typeof body.id === "string") {
        events.set(body.id, body);
      }
      writes.push({ url: target, body });
      if (failPostOnce) {
        failPostOnce = false;
        throw new Error("timeout after accept");
      }
      return new Response(JSON.stringify({ id: body.id }), { status: 200 });
    }
    const getMatch = target.match(/\/events\/([^/?]+)/);
    if (getMatch?.[1] && method === "GET") {
      if (eventReadStatus === "throw") {
        throw new Error("calendar unreachable");
      }
      if (eventReadStatus !== 200) {
        return new Response("{}", { status: eventReadStatus });
      }
      if (suppressReads) {
        return new Response("{}", { status: 404 });
      }
      const body = events.get(getMatch[1]);
      if (!body) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: getMatch[1],
          status: cancelled.has(getMatch[1]) ? "cancelled" : "confirmed",
          summary: body.summary,
          description: body.description,
          start: body.start,
          end: body.end,
          transparency: body.transparency,
          reminders: body.reminders,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected request ${method} ${target}`);
  }) as typeof fetch;
  return {
    fetchFn,
    writes,
    deleteEvent: (eventId: string) => {
      events.delete(eventId);
    },
    cancelEvent: (eventId: string) => {
      cancelled.add(eventId);
    },
    setEventReadStatus: (status: number | "throw") => {
      eventReadStatus = status;
    },
    failNextPost: () => {
      failPostOnce = true;
    },
    setSuppressReads: (value: boolean) => {
      suppressReads = value;
    },
  };
}

function sequencedIds() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return { operationId: `op-limit-${sequence}`, eventId: `ev-limit-${sequence}` };
  };
}

function bookingWith(
  calendar: ReturnType<typeof controllableCalendar>,
  dataDir: string,
  createIds: () => { operationId: string; eventId: string },
  now: () => Date = () => MONDAY_14H,
) {
  return createAppointmentBooking({
    fetchFn: calendar.fetchFn,
    tokenProvider: TOKEN_PROVIDER,
    selection: SELECTION,
    now,
    dataDir,
    createIds,
    allowWrites: true,
  });
}

async function proposeAndConfirm(
  booking: ReturnType<typeof createAppointmentBooking>,
  options: {
    callId: string;
    callerName?: string;
    callbackNumber?: string;
    date?: string;
    startTime?: string;
  },
) {
  const proposed = await booking.execute(
    "propose_appointment",
    {
      callerName: options.callerName ?? "Ada Lovelace",
      callbackNumber: options.callbackNumber ?? CALLBACK_NUMBER,
      callbackConfirmed: true,
      date: options.date ?? FRIDAY_DATE,
      startTime: options.startTime ?? "10:00",
    },
    { callId: options.callId },
  );
  if (proposed.status !== "proposed" || !proposed.proposalId) {
    return proposed;
  }
  booking.markReadbackFinished(options.callId);
  return booking.execute(
    "confirm_appointment",
    { confirmed: true, proposalId: proposed.proposalId },
    { callId: options.callId },
  );
}

describe("one upcoming appointment per callback number", () => {
  it("refuses a second upcoming appointment for an equivalently formatted number", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const createIds = sequencedIds();
    const booking = bookingWith(calendar, dataDir, createIds);

    const first = await proposeAndConfirm(booking, { callId: "call-limit-1" });
    expect(first.status).toBe("booked");
    expect(calendar.writes).toHaveLength(1);

    const second = await proposeAndConfirm(booking, {
      callId: "call-limit-2",
      callbackNumber: "(555) 123-9876",
    });
    expect(second.status).toBe("unavailable");
    expect(second).toMatchObject({ eventExists: false });
    expect(second.message).toMatch(/already has an upcoming appointment/i);
    expect(second.message).toMatch(/contact Jacob directly/i);
    expect(second.message).not.toContain(FRIDAY_DATE);
    expect(calendar.writes).toHaveLength(1);

    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain(CALLBACK_NUMBER);
    expect(stored).not.toContain("5551239876");
    expect(stored).not.toContain("Ada Lovelace");
  });

  it("refuses another caller on a later call who supplies the same callback number", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const booking = bookingWith(calendar, dataDir, sequencedIds());

    const first = await proposeAndConfirm(booking, { callId: "call-limit-a" });
    expect(first.status).toBe("booked");

    const second = await proposeAndConfirm(booking, {
      callId: "call-limit-b",
      callerName: "Grace Hopper",
      startTime: "14:00",
    });
    expect(second.status).toBe("unavailable");
    expect(second.message).toMatch(/contact Jacob directly/i);
    expect(calendar.writes).toHaveLength(1);
  });

  it("books only once when repeat attempts race with fresh operation identities", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const booking = bookingWith(calendar, dataDir, sequencedIds());

    const firstProposed = await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: CALLBACK_NUMBER,
        callbackConfirmed: true,
        date: FRIDAY_DATE,
        startTime: "10:00",
      },
      { callId: "call-limit-race-1" },
    );
    const secondProposed = await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "555-123-9876",
        callbackConfirmed: true,
        date: FRIDAY_DATE,
        startTime: "10:00",
      },
      { callId: "call-limit-race-2" },
    );
    if (firstProposed.status !== "proposed" || secondProposed.status !== "proposed") {
      throw new Error("Expected both proposals to be recorded");
    }
    booking.markReadbackFinished("call-limit-race-1");
    booking.markReadbackFinished("call-limit-race-2");

    const [first, second] = await Promise.all([
      booking.execute(
        "confirm_appointment",
        { confirmed: true, proposalId: firstProposed.proposalId },
        { callId: "call-limit-race-1" },
      ),
      booking.execute(
        "confirm_appointment",
        { confirmed: true, proposalId: secondProposed.proposalId },
        { callId: "call-limit-race-2" },
      ),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["booked", "unavailable"]);
    expect(calendar.writes).toHaveLength(1);
  });

  it("refuses after an application restart while the appointment is still upcoming", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const createIds = sequencedIds();

    const before = bookingWith(calendar, dataDir, createIds);
    const first = await proposeAndConfirm(before, { callId: "call-limit-restart-1" });
    expect(first.status).toBe("booked");

    const after = bookingWith(calendar, dataDir, createIds);
    const second = await proposeAndConfirm(after, { callId: "call-limit-restart-2" });
    expect(second.status).toBe("unavailable");
    expect(second.message).toMatch(/contact Jacob directly/i);
    expect(calendar.writes).toHaveLength(1);
  });

  it("books again after Jacob deletes the appointment from the calendar", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const booking = bookingWith(calendar, dataDir, sequencedIds());

    const first = await proposeAndConfirm(booking, { callId: "call-limit-delete-1" });
    expect(first.status).toBe("booked");
    expect(first).toMatchObject({ eventId: "ev-limit-1" });

    calendar.deleteEvent("ev-limit-1");

    const second = await proposeAndConfirm(booking, {
      callId: "call-limit-delete-2",
      startTime: "14:00",
    });
    expect(second.status).toBe("booked");
    expect(second).toMatchObject({ eventId: "ev-limit-2", eventExists: true });
    expect(calendar.writes).toHaveLength(2);
  });

  it("books again after Jacob cancels the appointment on the calendar", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const booking = bookingWith(calendar, dataDir, sequencedIds());

    const first = await proposeAndConfirm(booking, { callId: "call-limit-cancel-1" });
    expect(first.status).toBe("booked");
    expect(first).toMatchObject({ eventId: "ev-limit-1" });

    calendar.cancelEvent("ev-limit-1");

    const second = await proposeAndConfirm(booking, {
      callId: "call-limit-cancel-2",
      startTime: "14:00",
    });
    expect(second.status).toBe("booked");
    expect(second).toMatchObject({ eventId: "ev-limit-2", eventExists: true });
    expect(calendar.writes).toHaveLength(2);
  });

  it("keeps enforcing the limit for an appointment recovered after a restart", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const createIds = sequencedIds();

    const before = bookingWith(calendar, dataDir, createIds);
    calendar.failNextPost();
    calendar.setSuppressReads(true);
    const uncertain = await proposeAndConfirm(before, { callId: "call-limit-recover-1" });
    expect(uncertain.status).toBe("inconclusive");

    // Google accepted the write late: the event is now readable under the
    // original identity even though the first process never saw it.
    calendar.setSuppressReads(false);
    const after = bookingWith(calendar, dataDir, createIds);
    const outcomes = await after.reconcileUnresolvedOperations();
    expect(outcomes).toEqual([
      {
        operationId: "op-limit-1",
        eventId: "ev-limit-1",
        status: "booked",
        eventExists: true,
      },
    ]);

    // The recovered durable rows keep the number association, so the limit
    // does not depend on earlier superseded rows surviving alongside them.
    const ledger = createAppointmentLedger({ dataDir });
    expect(ledger.latestForOperation("op-limit-1")).toMatchObject({
      status: "booked",
      numberHash: ledger.hashCallbackNumber(CALLBACK_NUMBER),
    });

    const second = await proposeAndConfirm(after, {
      callId: "call-limit-recover-2",
      startTime: "14:00",
    });
    expect(second.status).toBe("unavailable");
    expect(second.message).toMatch(/already has an upcoming appointment/i);
    expect(second.message).toMatch(/contact Jacob directly/i);
    expect(second.message).not.toContain(FRIDAY_DATE);
    expect(calendar.writes).toHaveLength(1);
  });

  it("books again after the earlier appointment has passed", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const createIds = sequencedIds();

    const before = bookingWith(calendar, dataDir, createIds);
    const first = await proposeAndConfirm(before, { callId: "call-limit-past-1" });
    expect(first.status).toBe("booked");

    const after = bookingWith(calendar, dataDir, createIds, () => AFTER_APPOINTMENT);
    const second = await proposeAndConfirm(after, {
      callId: "call-limit-past-2",
      date: LATER_FRIDAY_DATE,
    });
    expect(second.status).toBe("booked");
    expect(second).toMatchObject({ eventExists: true });
    expect(calendar.writes).toHaveLength(2);
  });

  it("returns unavailable instead of guessing when the calendar cannot be reached", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const booking = bookingWith(calendar, dataDir, sequencedIds());

    const first = await proposeAndConfirm(booking, { callId: "call-limit-error-1" });
    expect(first.status).toBe("booked");

    calendar.setEventReadStatus(500);
    const second = await proposeAndConfirm(booking, { callId: "call-limit-error-2" });
    expect(second.status).toBe("unavailable");
    expect(second).toMatchObject({ eventExists: false });
    expect(second.message).toMatch(/could not be verified/i);
    expect(second.message).not.toMatch(/Jacob will call/);
    expect(calendar.writes).toHaveLength(1);
  });

  it("exposes no cancellation or rescheduling tool", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-limit-"));
    const booking = bookingWith(calendar, dataDir, sequencedIds());

    expect(booking.definitions().map((tool) => tool.name)).toEqual([
      "propose_appointment",
      "confirm_appointment",
    ]);
  });
});
