import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { createAppointmentLedger, type BookingRecord } from "../src/calendar/appointment-ledger.js";
import { runRetentionCleanup } from "../src/maintenance.js";

const REFERENCE = new Date("2026-09-07T14:00:00-04:00");
const CALLBACK = "+15551230000";
const SAME_NORMALIZED_CALLBACK = "5551230000";
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};

type GetMode = "match" | "mismatch" | "missing" | "error" | "cancelled";

/**
 * In-process calendar. Stored events answer free/busy so a retry sees its
 * own write as busy. No request leaves the process.
 */
function createFakeCalendar() {
  const state: { getMode: GetMode; freeBusyMode: "ok" | "throw" } = {
    getMode: "match",
    freeBusyMode: "ok",
  };
  const requests: Array<{ method: string; url: string }> = [];
  const stored = new Map<string, { [key: string]: unknown }>();
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    requests.push({ method, url: target });
    if (target.includes("/freeBusy")) {
      if (state.freeBusyMode === "throw") {
        throw new Error("freeBusy unavailable");
      }
      const busy = [...stored.values()].flatMap((body) => {
        const start = body.start as { dateTime?: unknown } | undefined;
        const end = body.end as { dateTime?: unknown } | undefined;
        if (typeof start?.dateTime !== "string" || typeof end?.dateTime !== "string") {
          return [];
        }
        return [{ start: wallTimeToOffset(start.dateTime), end: wallTimeToOffset(end.dateTime) }];
      });
      return new Response(
        JSON.stringify({
          calendars: { primary: { busy }, team: { busy: [] } },
        }),
        { status: 200 },
      );
    }
    if (method === "POST" && target.includes("/events")) {
      const body = JSON.parse(String((init as RequestInit).body)) as { [key: string]: unknown };
      if (typeof body.id === "string") {
        stored.set(body.id, body);
      }
      return new Response(JSON.stringify({ id: body.id }), { status: 200 });
    }
    if (method === "DELETE" && target.includes("/events/")) {
      return new Response(null, { status: 204 });
    }
    const getMatch = target.match(/\/events\/([^/?]+)/);
    if (getMatch?.[1] && method === "GET") {
      if (state.getMode === "error") {
        throw new Error("calendar read failed");
      }
      const body = stored.get(getMatch[1]);
      if (state.getMode === "missing" || !body) {
        return new Response("{}", { status: 404 });
      }
      const payload: { [key: string]: unknown } = {
        id: getMatch[1],
        status: state.getMode === "cancelled" ? "cancelled" : "confirmed",
        summary: body.summary,
        description: body.description,
        start: body.start,
        end: body.end,
        transparency: body.transparency,
        reminders: body.reminders,
      };
      if (state.getMode === "mismatch") {
        payload.attendees = [{ email: "shape-mismatch@example.invalid" }];
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  }) as typeof fetch;
  return { state, fetchFn, requests, stored };
}

function wallTimeToOffset(value: string): string {
  if (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  return `${value}-04:00`;
}

function eventPosts(requests: Array<{ method: string; url: string }>) {
  return requests.filter((request) => request.method === "POST" && request.url.includes("/events"));
}

function deletes(requests: Array<{ method: string; url: string }>) {
  return requests.filter((request) => request.method === "DELETE");
}

function latestRow(dataDir: string, operationId: string): BookingRecord | undefined {
  return createAppointmentLedger({ dataDir }).latestForOperation(operationId);
}

function bookingAt(dataDir: string) {
  let created = 0;
  const calendar = createFakeCalendar();
  let tokenMode: "ok" | "throw" = "ok";
  const ledger = createAppointmentLedger({ dataDir });
  const booking = createAppointmentBooking({
    fetchFn: calendar.fetchFn,
    credentials: null,
    tokenProvider: {
      async getAccessToken() {
        if (tokenMode === "throw") {
          throw new Error("token refresh failed");
        }
        return "fixture-access-token";
      },
    },
    selection: SELECTION,
    now: () => REFERENCE,
    dataDir,
    ledger,
    env: {},
    allowWrites: true,
    createIds: () => {
      created += 1;
      return { operationId: `op-${created}`, eventId: `ev-${created}` };
    },
  });
  return {
    calendar,
    booking,
    ledger,
    setTokenMode(mode: "ok" | "throw") {
      tokenMode = mode;
    },
  };
}

async function propose(
  booking: ReturnType<typeof createAppointmentBooking>,
  callId: string,
  extra: Record<string, unknown> = {},
) {
  const result = await booking.execute(
    "propose_appointment",
    {
      callerName: "Ada Lovelace",
      callbackNumber: CALLBACK,
      callbackConfirmed: true,
      date: "2026-09-11",
      startTime: "10:00",
      ...extra,
    },
    { callId },
  );
  if (result.status !== "proposed" || !("proposalId" in result) || !result.proposalId) {
    throw new Error(`expected a proposal, got ${result.status}`);
  }
  return result.proposalId;
}

async function confirm(
  booking: ReturnType<typeof createAppointmentBooking>,
  callId: string,
  proposalId: string,
) {
  booking.markReadbackFinished(callId);
  return booking.execute(
    "confirm_appointment",
    { confirmed: true, proposalId },
    { callId },
  );
}

function retainedAfterCleanup(dataDir: string, operationId: string): BookingRecord | undefined {
  const copyDir = mkdtempSync(join(tmpdir(), "scheduling-retention-"));
  cpSync(join(dataDir, "bookings.jsonl"), join(copyDir, "bookings.jsonl"));
  cpSync(join(dataDir, "callback-salt"), join(copyDir, "callback-salt"));
  runRetentionCleanup({
    dataDir: copyDir,
    ledger: createAppointmentLedger({ dataDir: copyDir }),
    now: REFERENCE,
  });
  return latestRow(copyDir, operationId);
}

describe("booking confirmation records", () => {
  it("does not book a cancelled stored event, even when the other fields match", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-cancelled-"));
    const { calendar, booking } = bookingAt(dataDir);
    calendar.state.getMode = "cancelled";
    const callId = "call-cancelled";

    const proposalId = await propose(booking, callId);
    const result = await confirm(booking, callId, proposalId);
    expect(result).toMatchObject({ status: "inconclusive", eventExists: false });
    expect(result.message).toContain("interrupted");
    expect(result.message).not.toContain("approved shape");
    expect(result.message).not.toContain("Jacob will call");
    expect(result.message).not.toContain("no longer available");
    expect(latestRow(dataDir, "op-1")).toMatchObject({ status: "inconclusive" });
    expect(latestRow(dataDir, "op-1")?.storedShape).toBeUndefined();
  });

  it("does not hide a cancelled stored event as unavailable when the slot is no longer open", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-cancelled-busy-"));
    const { calendar, booking } = bookingAt(dataDir);
    calendar.state.getMode = "cancelled";
    calendar.stored.set("ev-1", {
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551230000",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
    const callId = "call-cancelled-busy";

    const proposalId = await propose(booking, callId);
    const result = await confirm(booking, callId, proposalId);
    expect(result).toMatchObject({ status: "inconclusive", eventExists: false });
    expect(result.message).toContain("interrupted");
    expect(result.message).not.toContain("no longer available");
    expect(result.message).not.toContain("approved shape");
    expect(result.message).not.toContain("Jacob will call");
    expect(latestRow(dataDir, "op-1")).toMatchObject({ status: "inconclusive" });
    expect(latestRow(dataDir, "op-1")?.storedShape).toBeUndefined();
  });

  it("keeps a stored event that fails the approved shape distinct from a missing event", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-shape-"));
    const { calendar, booking } = bookingAt(dataDir);
    calendar.state.getMode = "mismatch";
    const callId = "call-shape";

    const proposalId = await propose(booking, callId);
    const first = await confirm(booking, callId, proposalId);
    expect(first.status).toBe("inconclusive");
    expect(first.message).toContain("does not match the approved shape");
    expect(first.message).not.toContain("no longer available");
    expect(first.message).not.toContain("interrupted");
    expect(calendar.stored.has("ev-1")).toBe(true);
    expect(deletes(calendar.requests)).toHaveLength(0);

    const missing = await confirmMissingBusySlot();
    expect(missing.status).toBe("unavailable");
    expect(missing.message).toContain("no longer available");
    expect(first.status).not.toBe(missing.status);

    const retry = await confirm(booking, callId, proposalId);
    expect(retry.status).toBe("inconclusive");
    expect(retry.status).not.toBe(missing.status);
    expect(retry.message).toContain("does not match the approved shape");
    expect(retry.message).not.toContain("no longer available");
    expect(latestRow(dataDir, "op-1")?.status).toBe("inconclusive");
    expect(calendar.stored.has("ev-1")).toBe(true);
    expect(deletes(calendar.requests)).toHaveLength(0);

    const reconciled = await booking.reconcileUnresolvedOperations();
    expect(reconciled.map((outcome) => outcome.operationId)).toContain("op-1");
    const shapeOutcome = reconciled.find((outcome) => outcome.operationId === "op-1");
    expect(shapeOutcome?.status).not.toBe("booked");
    expect(shapeOutcome).toMatchObject({ status: "inconclusive", eventExists: true });

    expect(retainedAfterCleanup(dataDir, "op-1")).toBeDefined();

    const postsBeforeLater = eventPosts(calendar.requests).length;
    const laterProposalId = await propose(booking, callId, {
      callbackNumber: SAME_NORMALIZED_CALLBACK,
      startTime: "14:00",
    });
    const later = await confirm(booking, callId, laterProposalId);
    expect(later.status).not.toBe("booked");
    expect(eventPosts(calendar.requests)).toHaveLength(postsBeforeLater);
    expect(calendar.stored.has("ev-1")).toBe(true);
    expect(calendar.stored.has("ev-2")).toBe(false);
    expect(latestRow(dataDir, "op-1")?.status).toBe("inconclusive");
  });

  it("leaves the inconclusive row in place when a retry cannot refresh the access token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-token-"));
    const { calendar, booking, ledger, setTokenMode } = bookingAt(dataDir);
    calendar.state.getMode = "error";
    const callId = "call-token";

    const proposalId = await propose(booking, callId);
    const first = await confirm(booking, callId, proposalId);
    expect(first.status).toBe("inconclusive");
    expect(calendar.stored.has("ev-1")).toBe(true);
    expect(deletes(calendar.requests)).toHaveLength(0);

    calendar.state.getMode = "match";
    const rowBeforeRetry = ledger.latestForOperation("op-1");
    setTokenMode("throw");
    const retry = await confirm(booking, callId, proposalId);
    expect(retry.status).toBe("inconclusive");
    expect(retry.message).toContain("Do not tell the caller the appointment is booked");
    // The same record object: the retry appended nothing, not even an identical row.
    expect(ledger.latestForOperation("op-1")).toBe(rowBeforeRetry);
    expect(latestRow(dataDir, "op-1")?.status).toBe("inconclusive");
    expect(calendar.stored.has("ev-1")).toBe(true);

    setTokenMode("ok");
    expect(retainedAfterCleanup(dataDir, "op-1")).toBeDefined();

    const postsBeforeLater = eventPosts(calendar.requests).length;
    const laterProposalId = await propose(booking, callId, {
      callbackNumber: SAME_NORMALIZED_CALLBACK,
      startTime: "14:00",
    });
    const later = await confirm(booking, callId, laterProposalId);
    expect(later.status).not.toBe("booked");
    expect(eventPosts(calendar.requests)).toHaveLength(postsBeforeLater);
    expect(calendar.stored.has("ev-2")).toBe(false);
    expect(latestRow(dataDir, "op-1")?.status).toBe("inconclusive");

    const reconciled = await booking.reconcileUnresolvedOperations();
    expect(reconciled).toEqual([
      {
        operationId: "op-1",
        eventId: "ev-1",
        status: "booked",
        eventExists: true,
      },
    ]);
  });

  it("leaves the inconclusive row in place when a retry cannot read free/busy", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-freebusy-"));
    const { calendar, booking, ledger } = bookingAt(dataDir);
    calendar.state.getMode = "error";
    const callId = "call-freebusy";

    const proposalId = await propose(booking, callId);
    const first = await confirm(booking, callId, proposalId);
    expect(first.status).toBe("inconclusive");
    expect(calendar.stored.has("ev-1")).toBe(true);

    calendar.state.getMode = "match";
    calendar.state.freeBusyMode = "throw";
    const rowBeforeRetry = ledger.latestForOperation("op-1");
    const retry = await confirm(booking, callId, proposalId);
    expect(retry.status).toBe("inconclusive");
    expect(ledger.latestForOperation("op-1")).toBe(rowBeforeRetry);
    expect(latestRow(dataDir, "op-1")?.status).toBe("inconclusive");
    expect(deletes(calendar.requests)).toHaveLength(0);

    calendar.state.freeBusyMode = "ok";
    expect(retainedAfterCleanup(dataDir, "op-1")).toBeDefined();

    const postsBeforeLater = eventPosts(calendar.requests).length;
    const laterProposalId = await propose(booking, callId, {
      callbackNumber: SAME_NORMALIZED_CALLBACK,
      startTime: "14:00",
    });
    const later = await confirm(booking, callId, laterProposalId);
    expect(later.status).not.toBe("booked");
    expect(eventPosts(calendar.requests)).toHaveLength(postsBeforeLater);
    expect(calendar.stored.has("ev-2")).toBe(false);
    expect(latestRow(dataDir, "op-1")?.status).toBe("inconclusive");

    const reconciled = await booking.reconcileUnresolvedOperations();
    expect(reconciled.some((outcome) => outcome.operationId === "op-1")).toBe(true);
  });

  it("keeps the mismatched-shape message when a retry cannot refresh the access token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-shape-token-"));
    const { calendar, booking, ledger, setTokenMode } = bookingAt(dataDir);
    calendar.state.getMode = "mismatch";
    const callId = "call-shape-token";

    const proposalId = await propose(booking, callId);
    const first = await confirm(booking, callId, proposalId);
    expect(first.message).toContain("does not match the approved shape");
    expect(first.message).not.toContain("interrupted");

    const rowBeforeRetry = ledger.latestForOperation("op-1");
    expect(rowBeforeRetry?.storedShape).toBe("mismatched");
    setTokenMode("throw");
    const retry = await confirm(booking, callId, proposalId);
    expect(ledger.latestForOperation("op-1")).toBe(rowBeforeRetry);
    expect(retry.status).toBe("inconclusive");
    expect(retry.message).toContain("does not match the approved shape");
    expect(retry.message).not.toContain("interrupted");
    expect(calendar.stored.has("ev-1")).toBe(true);
  });
});

async function confirmMissingBusySlot() {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-missing-"));
  const { calendar, booking } = bookingAt(dataDir);
  calendar.state.getMode = "missing";
  const callId = "call-missing";
  const proposalId = await propose(booking, callId);
  // Another commitment already occupies the slot. This operation never stored an event.
  calendar.stored.set("someone-else", {
    id: "someone-else",
    start: { dateTime: "2026-09-11T10:00:00" },
    end: { dateTime: "2026-09-11T10:30:00" },
  });
  return confirm(booking, callId, proposalId);
}
