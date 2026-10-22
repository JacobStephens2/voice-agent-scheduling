import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentLedger, type AppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { TEST_EVENT_ID, TEST_OPERATION_ID } from "./helpers.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const TOKEN_PROVIDER = { getAccessToken: async () => "test-access-token" };
const CALL_ID = "call-reconcile-1";

const PROPOSE_ARGS = {
  callerName: "Ada Lovelace",
  callbackNumber: "+15551239876",
  callbackConfirmed: true,
  date: "2026-09-11",
  startTime: "10:00",
};

interface CalendarState {
  busyAtTen: boolean;
  postBehavior: "ok" | "timeout";
  recordPost: boolean;
  getBehavior: "stored" | "missing" | "error";
}

function controllableCalendar(initial: Partial<CalendarState> = {}) {
  const state: CalendarState = {
    busyAtTen: false,
    postBehavior: "ok",
    recordPost: true,
    getBehavior: "stored",
    ...initial,
  };
  const posts: Array<{ url: string; body: { [key: string]: unknown } }> = [];
  const stored = new Map<string, { [key: string]: unknown }>();
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (target.includes("/freeBusy")) {
      const busy = state.busyAtTen
        ? [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T10:30:00-04:00" }]
        : [];
      return new Response(
        JSON.stringify({ calendars: { primary: { busy }, team: { busy: [] } } }),
        { status: 200 },
      );
    }
    if (method === "POST" && target.includes("/events")) {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        [key: string]: unknown;
      };
      if (state.recordPost && typeof body.id === "string") {
        stored.set(body.id, body);
      }
      posts.push({ url: target, body });
      if (state.postBehavior === "timeout") {
        throw new Error("timeout after accept");
      }
      return new Response(JSON.stringify({ id: body.id }), { status: 200 });
    }
    const getMatch = target.match(/\/events\/([^/?]+)/);
    if (getMatch?.[1] && method === "GET") {
      if (state.getBehavior === "error") {
        throw new Error("calendar unreachable");
      }
      const body = stored.get(getMatch[1]);
      if (state.getBehavior === "missing" || !body) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: getMatch[1],
          status: body.status === "cancelled" ? "cancelled" : "confirmed",
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
  const landEvent = (eventId: string, body: { [key: string]: unknown }) => {
    stored.set(eventId, body);
  };
  const landedCount = () => stored.size;
  return { state, fetchFn, posts, landEvent, landedCount };
}

function bookingWith(
  calendar: ReturnType<typeof controllableCalendar>,
  dataDir: string,
  createIds?: () => { operationId: string; eventId: string },
  ledger?: AppointmentLedger,
) {
  return createAppointmentBooking({
    fetchFn: calendar.fetchFn,
    tokenProvider: TOKEN_PROVIDER,
    selection: SELECTION,
    now: () => MONDAY_14H,
    dataDir,
    ledger,
    createIds: createIds ?? (() => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID })),
    allowWrites: true,
  });
}

async function propose(
  booking: ReturnType<typeof createAppointmentBooking>,
  extra: Record<string, unknown> = {},
  callId = CALL_ID,
) {
  const result = await booking.execute(
    "propose_appointment",
    { ...PROPOSE_ARGS, ...extra },
    { callId },
  );
  if (result.status !== "proposed" || !("proposalId" in result) || !result.proposalId) {
    throw new Error(`Expected a proposal, got ${result.status}`);
  }
  return result.proposalId as string;
}

async function confirm(
  booking: ReturnType<typeof createAppointmentBooking>,
  proposalId: string,
  callId = CALL_ID,
) {
  booking.markReadbackFinished(callId);
  return booking.execute("confirm_appointment", { confirmed: true, proposalId }, { callId });
}

function latestRecord(dataDir: string, operationId: string) {
  return createAppointmentLedger({ dataDir }).latestForOperation(operationId);
}

describe("confirmed booking reconciliation", () => {
  it("reconciles a timeout after Google accepted the insertion against the original identities", async () => {
    const calendar = controllableCalendar({ postBehavior: "timeout", recordPost: true });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const booking = bookingWith(calendar, dataDir);

    const proposalId = await propose(booking);
    const result = await confirm(booking, proposalId);

    expect(result).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(result.message).toContain("Jacob will call");
    expect(calendar.posts).toHaveLength(1);

    const again = await confirm(booking, proposalId);
    expect(again).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(calendar.posts).toHaveLength(1);
  });

  it("reports inconclusive instead of false success when the timed-out write left no event, then retries with the same identity", async () => {
    const calendar = controllableCalendar({
      postBehavior: "timeout",
      recordPost: false,
      getBehavior: "missing",
    });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    let created = 0;
    const booking = bookingWith(calendar, dataDir, () => {
      created += 1;
      return { operationId: `op-${created}`, eventId: `ev-${created}` };
    });

    const proposalId = await propose(booking);
    const uncertain = await confirm(booking, proposalId);

    expect(uncertain).toMatchObject({
      status: "inconclusive",
      operationId: "op-1",
      eventId: "ev-1",
      eventExists: false,
    });
    expect(uncertain.message).toContain("Do not tell the caller the appointment is booked");
    expect(created).toBe(1);

    calendar.state.postBehavior = "ok";
    calendar.state.recordPost = true;
    calendar.state.getBehavior = "stored";
    const retried = await confirm(booking, proposalId);

    expect(retried).toMatchObject({
      status: "booked",
      operationId: "op-1",
      eventId: "ev-1",
      eventExists: true,
    });
    expect(created).toBe(1);
    expect(calendar.posts).toHaveLength(2);
    expect(calendar.landedCount()).toBe(1);
    expect(latestRecord(dataDir, "op-1")).toMatchObject({ status: "booked" });
  });

  it("returns inconclusive when the reconciliation read itself fails", async () => {
    const calendar = controllableCalendar({
      postBehavior: "timeout",
      recordPost: false,
      getBehavior: "error",
    });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const booking = bookingWith(calendar, dataDir);

    const proposalId = await propose(booking);
    const result = await confirm(booking, proposalId);

    expect(result).toMatchObject({
      status: "inconclusive",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: false,
    });
    expect(result.message).toContain("could not be confirmed");
    expect(result.message).toContain("Do not tell the caller the appointment is booked");
  });

  it("serializes duplicate in-flight confirmations into a single event", async () => {
    const calendar = controllableCalendar({});
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const booking = bookingWith(calendar, dataDir);

    const proposalId = await propose(booking);
    booking.markReadbackFinished(CALL_ID);
    const [first, second] = await Promise.all([
      booking.execute("confirm_appointment", { confirmed: true, proposalId }, { callId: CALL_ID }),
      booking.execute("confirm_appointment", { confirmed: true, proposalId }, { callId: CALL_ID }),
    ]);

    expect(first).toMatchObject({ status: "booked", eventExists: true });
    expect(second).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(calendar.posts).toHaveLength(1);
  });

  it("restarts from durable storage and establishes the landed event without a transcript", async () => {
    const calendar = controllableCalendar({
      postBehavior: "timeout",
      recordPost: false,
      getBehavior: "missing",
    });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const beforeCrash = bookingWith(calendar, dataDir);
    const proposalId = await propose(beforeCrash);
    const uncertain = await confirm(beforeCrash, proposalId);
    expect(uncertain.status).toBe("inconclusive");

    // Google accepted the write late: the event is now readable under the
    // original identity even though the crashed process never saw it.
    calendar.landEvent(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
    calendar.state.getBehavior = "stored";

    // A fresh instance never saw the proposal or transcript; recovery uses
    // only the durable operation/event identities.
    const attemptsBeforeRestart = calendar.posts.length;
    const afterRestart = bookingWith(calendar, dataDir);
    const outcomes = await afterRestart.reconcileUnresolvedOperations();

    expect(calendar.posts).toHaveLength(attemptsBeforeRestart);
    expect(calendar.landedCount()).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      status: "booked",
      eventExists: true,
    });
    expect(latestRecord(dataDir, TEST_OPERATION_ID)).toMatchObject({
      eventId: TEST_EVENT_ID,
      status: "booked",
    });
    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain("Ada Lovelace");
    expect(stored).not.toContain("15551239876");
  });

  it("reports a busy slot as booked when the busy reading is the operation's own landed write", async () => {
    const calendar = controllableCalendar({ postBehavior: "timeout", recordPost: true });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const booking = bookingWith(calendar, dataDir);

    calendar.state.getBehavior = "missing";
    const proposalId = await propose(booking);
    const uncertain = await confirm(booking, proposalId);
    expect(uncertain.status).toBe("inconclusive");

    // The landed write is now visible: free/busy reports the slot taken and
    // the event reads back under the original identity.
    calendar.state.busyAtTen = true;
    calendar.state.getBehavior = "stored";
    const retried = await confirm(booking, proposalId);

    expect(retried).toMatchObject({
      status: "booked",
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      eventExists: true,
    });
    expect(calendar.posts).toHaveLength(1);
  });

  it("offers fresh alternatives when another writer took the slot and requires confirmation of the replacement", async () => {
    const calendar = controllableCalendar({ busyAtTen: true, getBehavior: "stored" });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const booking = bookingWith(calendar, dataDir);

    const proposalId = await propose(booking);
    const taken = await confirm(booking, proposalId);
    expect(taken).toMatchObject({ status: "unavailable", eventExists: false });
    expect(taken.message).toContain("fresh alternatives");
    expect(calendar.posts).toHaveLength(0);

    booking.markReadbackFinished(CALL_ID);
    const stale = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId },
      { callId: CALL_ID },
    );
    expect(stale.status).toBe("no_proposal");

    const replacementId = await propose(booking, { startTime: "14:00" });
    const replacement = await confirm(booking, replacementId);
    expect(replacement).toMatchObject({ status: "booked", eventExists: true });
    expect(calendar.posts).toHaveLength(1);
    expect(calendar.posts[0]?.body).toMatchObject({
      start: { dateTime: "2026-09-11T14:00:00", timeZone: "America/New_York" },
    });
  });

  it("leaves an absent write as a bounded inconclusive outcome on restart without minting identities", async () => {
    const calendar = controllableCalendar({
      postBehavior: "timeout",
      recordPost: false,
      getBehavior: "missing",
    });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    let created = 0;
    const beforeCrash = bookingWith(calendar, dataDir, () => {
      created += 1;
      return { operationId: `op-${created}`, eventId: `ev-${created}` };
    });
    const proposalId = await propose(beforeCrash);
    expect((await confirm(beforeCrash, proposalId)).status).toBe("inconclusive");

    const attemptsBeforeRestart = calendar.posts.length;
    const restartedLedger = createAppointmentLedger({ dataDir });
    const recordBeforeRecovery = restartedLedger.latestForOperation("op-1");
    expect(recordBeforeRecovery?.status).toBe("inconclusive");
    const afterRestart = bookingWith(
      calendar,
      dataDir,
      () => {
        created += 1;
        return { operationId: `op-${created}`, eventId: `ev-${created}` };
      },
      restartedLedger,
    );
    const outcomes = await afterRestart.reconcileUnresolvedOperations();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      operationId: "op-1",
      eventId: "ev-1",
      status: "inconclusive",
      eventExists: false,
    });
    expect(created).toBe(1);
    expect(calendar.posts).toHaveLength(attemptsBeforeRestart);
    expect(calendar.landedCount()).toBe(0);
    // Already inconclusive before the restart, so recovery records nothing
    // new: the same record object, not even an identical row appended.
    expect(restartedLedger.latestForOperation("op-1")).toBe(recordBeforeRecovery);
  });

  it("records a cancelled stored event as inconclusive on restart and does not leave it blocking", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-cancel-"));
    const ledger = createAppointmentLedger({ dataDir });
    const numberHash = ledger.hashCallbackNumber("+15551239876");
    ledger.record({
      operationId: TEST_OPERATION_ID,
      eventId: TEST_EVENT_ID,
      callId: CALL_ID,
      proposalId: "proposal-cancelled",
      calendarId: "primary",
      startUtc: "2026-09-11T14:00:00.000Z",
      status: "pending",
      numberHash,
    });
    calendar.landEvent(TEST_EVENT_ID, {
      status: "cancelled",
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });

    const booking = bookingWith(
      calendar,
      dataDir,
      () => ({ operationId: "op-after-cancel", eventId: "ev-after-cancel" }),
      ledger,
    );
    const outcomes = await booking.reconcileUnresolvedOperations();

    expect(outcomes).toEqual([
      {
        operationId: TEST_OPERATION_ID,
        eventId: TEST_EVENT_ID,
        status: "inconclusive",
        eventExists: true,
      },
    ]);
    expect(outcomes[0]?.status).not.toBe("unresolved");
    expect(ledger.latestForOperation(TEST_OPERATION_ID)).toMatchObject({
      status: "inconclusive",
    });
    expect(ledger.latestForOperation(TEST_OPERATION_ID)?.storedShape).toBeUndefined();

    const proposalId = await propose(booking, { startTime: "14:00" }, "call-after-cancel");
    const second = await confirm(booking, proposalId, "call-after-cancel");
    expect(second).toMatchObject({ status: "booked", eventExists: true });
  });

  it("reports unresolved when Calendar cannot be reached during restart recovery", async () => {
    const calendar = controllableCalendar({
      postBehavior: "timeout",
      recordPost: true,
      getBehavior: "error",
    });
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-reconcile-"));
    const beforeCrash = bookingWith(calendar, dataDir);
    const proposalId = await propose(beforeCrash);
    expect((await confirm(beforeCrash, proposalId)).status).toBe("inconclusive");

    const restartedLedger = createAppointmentLedger({ dataDir });
    const recordBefore = restartedLedger.latestForOperation(TEST_OPERATION_ID);
    expect(recordBefore?.status).toBe("inconclusive");
    const afterRestart = bookingWith(calendar, dataDir, undefined, restartedLedger);
    const outcomes = await afterRestart.reconcileUnresolvedOperations();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "unresolved", eventExists: false });
    expect(restartedLedger.latestForOperation(TEST_OPERATION_ID)).toBe(recordBefore);
    expect(calendar.posts).toHaveLength(1);
  });
});
