import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { loadBookingRecords } from "../src/calendar/booking-store.js";
import {
  DIRECT_SIP_MICRO_USD_PER_MINUTE,
  createBudgetLedger,
  estimateCallCostMicroUsd,
  fullCallReservationMicroUsd,
} from "../src/budget.js";
import {
  OPERATIONAL_RECORDS_FILE,
  persistEvidence,
  type StructuredCallEvidence,
} from "../src/evidence.js";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import {
  OPERATIONAL_RETENTION_MS,
  inspectDurableIntegrity,
  restoreDurableState,
  runRetentionCleanup,
} from "../src/maintenance.js";
import { createSchedulingServer, type SchedulingServer } from "../src/server.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  REQUIRED_MODEL,
  WEBHOOK_SECRET,
  incomingCallPayload,
  openTelephoneSession,
  recordedEvidence,
  signedHeaders,
  toolOutputs,
  toolRoundTrip,
} from "./helpers.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const FRIDAY_DATE = "2026-09-11";
const CALLBACK_NUMBER = "+15551239876";
const CALLER_NAME = "Ada Lovelace";
const EVIDENCE_TOKEN = "test-maintenance-evidence";
const HTTP_PORT = 3599;
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const TOKEN_PROVIDER = { getAccessToken: async () => "test-access-token" };

type EventBody = Record<string, unknown>;

function controllableCalendar() {
  const events = new Map<string, EventBody>();
  const cancelled = new Set<string>();
  const writes: Array<{ method: string; url: string; body?: EventBody }> = [];
  let eventReadStatus: number | "throw" = 200;
  let failPostOnce = false;
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const target = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    writes.push({
      method,
      url: target,
      body: (init as RequestInit | undefined)?.body
        ? (JSON.parse(String((init as RequestInit).body)) as EventBody)
        : undefined,
    });
    if (target.includes("/freeBusy")) {
      return new Response(
        JSON.stringify({ calendars: { primary: { busy: [] }, team: { busy: [] } } }),
        { status: 200 },
      );
    }
    if (method === "POST" && target.includes("/events")) {
      const body = JSON.parse(String((init as RequestInit).body)) as EventBody;
      if (failPostOnce) {
        failPostOnce = false;
        throw new Error("timeout after accept");
      }
      if (typeof body.id === "string") {
        events.set(body.id, body);
      }
      return new Response(JSON.stringify({ id: body.id }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response("{}", { status: 204 });
    }
    const getMatch = target.match(/\/events\/([^/?]+)/);
    if (getMatch?.[1] && method === "GET") {
      if (eventReadStatus === "throw") {
        throw new Error("calendar unreachable");
      }
      if (eventReadStatus !== 200) {
        return new Response("{}", { status: eventReadStatus });
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
    cancelEvent: (eventId: string) => {
      cancelled.add(eventId);
    },
    failNextPost: () => {
      failPostOnce = true;
    },
    setEventReadStatus: (status: number | "throw") => {
      eventReadStatus = status;
    },
    landEvent: (eventId: string, body: EventBody) => {
      events.set(eventId, body);
    },
  };
}

function sequencedIds() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return { operationId: `op-maint-${sequence}`, eventId: `ev-maint-${sequence}` };
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
      callerName: options.callerName ?? CALLER_NAME,
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

function createManager(options: {
  sockets: FakeRealtimeSocket[];
  hangups?: string[];
  dataDir: string;
  booking?: ReturnType<typeof createAppointmentBooking>;
  calendar?: ReturnType<typeof controllableCalendar>;
  monthlyTargetMicroUsd?: number;
  fixedMonthlyMicroUsd?: number;
  now?: () => Date;
}) {
  const calendar = options.calendar ?? controllableCalendar();
  const booking =
    options.booking ??
    bookingWith(calendar, options.dataDir, sequencedIds(), options.now ?? (() => MONDAY_14H));
  return createCallLifecycleManager({
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    maxConcurrentCalls: 1,
    availabilityTool: {
      definition: () => ({
        type: "function",
        name: "check_availability",
        description: "Check availability.",
        parameters: { type: "object", properties: {}, required: [] },
      }),
      execute: async () => ({ status: "available", starts: [] }),
    },
    booking,
    connectWebSocket: (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      options.sockets.push(socket);
      return socket;
    },
    hangupCall: async (callId) => {
      options.hangups?.push(callId);
    },
    dataDir: options.dataDir,
    monthlyTargetMicroUsd: options.monthlyTargetMicroUsd ?? 1_000_000_000,
    fixedMonthlyMicroUsd: options.fixedMonthlyMicroUsd ?? 0,
    referenceTime: MONDAY_14H,
    now: options.now,
  });
}

function eventInserts(calendar: ReturnType<typeof controllableCalendar>) {
  return calendar.writes.filter((row) => row.method === "POST" && row.url.includes("/events"));
}

function latestBookings(dataDir: string) {
  return loadBookingRecords(dataDir);
}

function operationalLines(dataDir: string): StructuredCallEvidence[] {
  const path = join(dataDir, OPERATIONAL_RECORDS_FILE);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StructuredCallEvidence);
}

function assertSafeOperationalPayload(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(CALLER_NAME);
  expect(serialized).not.toContain("Ada");
  expect(serialized).not.toContain("15551239876");
  expect(serialized).not.toContain(CALLBACK_NUMBER);
  expect(serialized.toLowerCase()).not.toContain("transcript");
  expect(serialized).not.toMatch(/"audio"/);
  expect(serialized).not.toMatch(/"recording"/);
}

describe("retention cleanup and recovery", () => {
  it("drops operational records after 30 days and keeps recent bounded outcomes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-ops-"));
    const now = new Date("2026-10-08T14:00:00-04:00");
    persistEvidence(dataDir, {
      callId: "call-old",
      connectionRoute: "direct_sip",
      callerNumberMasked: "+1***9876",
      calledNumber: "+18005550199",
      status: "completed",
      durationMs: 12_000,
      toolRoundTrips: 1,
      estimatedCostMicroUsd: 17,
      recordedAt: new Date(now.getTime() - OPERATIONAL_RETENTION_MS - 60_000).toISOString(),
    });
    persistEvidence(dataDir, {
      callId: "call-recent",
      connectionRoute: "direct_sip",
      callerNumberMasked: "+1***9876",
      calledNumber: "+18005550199",
      status: "failed",
      durationMs: 3_000,
      toolRoundTrips: 0,
      estimatedCostMicroUsd: 4,
      error: "provider_error",
      recordedAt: now.toISOString(),
    });

    const result = runRetentionCleanup({ dataDir, now });
    expect(result.operationalRecordsRemoved).toBe(1);
    expect(result.operationalRecordsKept).toBe(1);

    const kept = operationalLines(dataDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.callId).toBe("call-recent");
    expect(kept[0]?.error).toBe("provider_error");
    assertSafeOperationalPayload(kept);
  });

  it("reads operational records left in the previous filename and writes them to the current one", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-legacy-ops-"));
    const now = new Date("2026-10-08T14:00:00-04:00");
    writeFileSync(
      join(dataDir, "smoke-evidence.jsonl"),
      `${JSON.stringify({
        callId: "call-legacy",
        connectionRoute: "direct_sip",
        callerNumberMasked: "+1***9876",
        calledNumber: "+18005550199",
        status: "completed",
        durationMs: 8_000,
        toolRoundTrips: 0,
        estimatedCostMicroUsd: 11,
        recordedAt: now.toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const result = runRetentionCleanup({ dataDir, now });
    expect(result.operationalRecordsKept).toBe(1);
    expect(existsSync(join(dataDir, "smoke-evidence.jsonl"))).toBe(false);
    expect(operationalLines(dataDir)[0]?.callId).toBe("call-legacy");
  });

  it("keeps an uncertain booking through cleanup so restart can still reconcile it", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-uncertain-"));
    const createIds = sequencedIds();
    const before = bookingWith(calendar, dataDir, createIds);
    calendar.failNextPost();
    const uncertain = await proposeAndConfirm(before, { callId: "call-uncertain" });
    expect(uncertain.status).toBe("inconclusive");
    const postsBeforeCleanup = eventInserts(calendar).length;

    const cleanup = runRetentionCleanup({ dataDir, now: MONDAY_14H });
    expect(cleanup.bookingRecordsKept).toBeGreaterThan(0);
    expect(calendar.writes.filter((row) => row.method === "DELETE")).toHaveLength(0);

    calendar.landEvent("ev-maint-1", {
      id: "ev-maint-1",
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });

    const after = bookingWith(calendar, dataDir, createIds);
    const outcomes = await after.reconcileUnresolvedOperations();
    expect(outcomes).toEqual([
      {
        operationId: "op-maint-1",
        eventId: "ev-maint-1",
        status: "booked",
        eventExists: true,
      },
    ]);
    expect(eventInserts(calendar)).toHaveLength(postsBeforeCleanup);

    const second = await proposeAndConfirm(after, { callId: "call-uncertain-2", startTime: "14:00" });
    expect(second.status).toBe("unavailable");
    expect(calendar.writes.filter((row) => row.method === "DELETE")).toHaveLength(0);
  });

  it("does not let cleanup make a second upcoming appointment possible", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-upcoming-"));
    const createIds = sequencedIds();
    const before = bookingWith(calendar, dataDir, createIds);
    const first = await proposeAndConfirm(before, { callId: "call-upcoming-1" });
    expect(first.status).toBe("booked");

    runRetentionCleanup({ dataDir, now: MONDAY_14H });
    expect(latestBookings(dataDir).some((row) => row.status === "booked")).toBe(true);

    const after = bookingWith(calendar, dataDir, createIds);
    const second = await proposeAndConfirm(after, { callId: "call-upcoming-2", startTime: "14:00" });
    expect(second.status).toBe("unavailable");
    expect(second.message).toMatch(/contact Jacob directly/i);
    expect(eventInserts(calendar)).toHaveLength(1);
    expect(calendar.writes.filter((row) => row.method === "DELETE")).toHaveLength(0);
    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain(CALLER_NAME);
    expect(stored).not.toContain("15551239876");
  });

  it("keeps a booked record so a manual cancellation can still be reconciled after cleanup", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-cancel-"));
    const createIds = sequencedIds();
    const before = bookingWith(calendar, dataDir, createIds);
    const first = await proposeAndConfirm(before, { callId: "call-cancel-1" });
    expect(first.status).toBe("booked");
    calendar.cancelEvent("ev-maint-1");

    runRetentionCleanup({ dataDir, now: MONDAY_14H });
    expect(latestBookings(dataDir).some((row) => row.status === "booked")).toBe(true);

    const after = bookingWith(calendar, dataDir, createIds);
    const second = await proposeAndConfirm(after, { callId: "call-cancel-2", startTime: "14:00" });
    expect(second.status).toBe("booked");
    expect(eventInserts(calendar)).toHaveLength(2);
    expect(calendar.writes.filter((row) => row.method === "DELETE")).toHaveLength(0);
  });

  it("does not reset spend or an active monthly reservation during cleanup", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-budget-"));
    const reservation = fullCallReservationMicroUsd(
      10 * 60 * 1000,
      DIRECT_SIP_MICRO_USD_PER_MINUTE,
      0.25,
    );
    const manager = createManager({
      sockets,
      dataDir,
      monthlyTargetMicroUsd: reservation * 10,
    });
    const payload = incomingCallPayload({ callId: "call-budget-live" });
    const admitted = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt-budget-live" }),
    );
    expect(admitted.statusCode).toBe(200);
    const reserved = manager.budgetSnapshot();
    expect(reserved.reservedMicroUsd).toBe(reservation);
    expect(reserved.spentMicroUsd).toBe(0);

    runRetentionCleanup({ dataDir, now: MONDAY_14H });
    manager.reloadDurableViews();
    expect(manager.budgetSnapshot()).toMatchObject({
      reservedMicroUsd: reservation,
      spentMicroUsd: 0,
    });

    sockets[0]!.close();
    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-budget-live");
    expect(manager.budgetSnapshot().reservedMicroUsd).toBe(0);
    expect(manager.budgetSnapshot().spentMicroUsd).toBe(
      estimateCallCostMicroUsd(evidence.durationMs),
    );
  });

  it("restores isolated state so pending work, the callback limit, and exhausted budget still hold", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-backup-"));
    const createIds = sequencedIds();
    const booking = bookingWith(calendar, dataDir, createIds);
    calendar.failNextPost();
    const uncertain = await proposeAndConfirm(booking, { callId: "call-restore-pending" });
    expect(uncertain.status).toBe("inconclusive");

    const bookedDir = mkdtempSync(join(tmpdir(), "scheduling-maint-backup-booked-"));
    const bookedIds = sequencedIds();
    const booked = bookingWith(calendar, bookedDir, bookedIds);
    const first = await proposeAndConfirm(booked, { callId: "call-restore-booked" });
    expect(first.status).toBe("booked");

    const budgetDir = mkdtempSync(join(tmpdir(), "scheduling-maint-backup-budget-"));
    const target = 50_000;
    const seed = createBudgetLedger({
      dataDir: budgetDir,
      monthlyTargetMicroUsd: target,
      fixedMonthlyMicroUsd: target,
    });
    expect(seed.snapshot().admissionsPaused).toBe(true);

    writeFileSync(join(dataDir, "google-refresh"), "test-refresh-token\n", { mode: 0o600 });
    const backupDir = mkdtempSync(join(tmpdir(), "scheduling-maint-snapshot-"));
    cpSync(dataDir, join(backupDir, "pending"), { recursive: true });
    cpSync(bookedDir, join(backupDir, "booked"), { recursive: true });
    cpSync(budgetDir, join(backupDir, "budget"), { recursive: true });

    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    restoreDurableState(join(backupDir, "pending"), dataDir);
    calendar.landEvent("ev-maint-1", {
      id: "ev-maint-1",
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
    const restoredPending = bookingWith(calendar, dataDir, createIds);
    const pendingOutcomes = await restoredPending.reconcileUnresolvedOperations();
    expect(pendingOutcomes[0]).toMatchObject({ status: "booked", eventExists: true });

    const restoredBookedDir = mkdtempSync(join(tmpdir(), "scheduling-maint-restored-booked-"));
    restoreDurableState(join(backupDir, "booked"), restoredBookedDir);
    const restoredBooked = bookingWith(calendar, restoredBookedDir, bookedIds);
    const second = await proposeAndConfirm(restoredBooked, {
      callId: "call-restore-booked-2",
      startTime: "14:00",
    });
    expect(second.status).toBe("unavailable");

    const restoredBudgetDir = mkdtempSync(join(tmpdir(), "scheduling-maint-restored-budget-"));
    restoreDurableState(join(backupDir, "budget"), restoredBudgetDir);
    const sockets: FakeRealtimeSocket[] = [];
    const restoredBudget = createManager({
      sockets,
      dataDir: restoredBudgetDir,
      monthlyTargetMicroUsd: target,
      fixedMonthlyMicroUsd: target,
    });
    const blocked = await restoredBudget.handleWebhook(
      signedHeaders(incomingCallPayload({ callId: "call-restore-budget" }), {
        webhookId: "evt-restore-budget",
      }),
    );
    expect(blocked.statusCode).toBe(503);
    expect(JSON.parse(blocked.body)).toEqual({ error: "budget_exhausted" });

    expect(readFileSync(join(dataDir, "google-refresh"), "utf8")).toContain("test-refresh-token");
    expect(statSync(join(dataDir, "google-refresh")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "bookings.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "callback-salt")).mode & 0o777).toBe(0o600);
  });

  it("pauses admission when restored state cannot enforce the callback-number limit", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-stale-"));
    const booked = bookingWith(calendar, dataDir, sequencedIds());
    const first = await proposeAndConfirm(booked, { callId: "call-stale-1" });
    expect(first.status).toBe("booked");

    const backupDir = mkdtempSync(join(tmpdir(), "scheduling-maint-stale-backup-"));
    restoreDurableState(dataDir, backupDir);
    rmSync(join(backupDir, "callback-salt"), { force: true });
    expect(inspectDurableIntegrity(backupDir).complete).toBe(false);

    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createManager({ sockets, hangups, dataDir: backupDir, calendar });
    const response = await manager.handleWebhook(
      signedHeaders(incomingCallPayload({ callId: "call-stale-admit" }), {
        webhookId: "evt-stale-admit",
      }),
    );
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "restored_state_incomplete" });
    expect(hangups).toContain("call-stale-admit");
    expect(manager.recoveryStatus().admissionAvailable).toBe(false);
  });

  it("keeps admission unavailable until pending Calendar reconciliation can finish", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-recon-"));
    const createIds = sequencedIds();
    const before = bookingWith(calendar, dataDir, createIds);
    calendar.failNextPost();
    const uncertain = await proposeAndConfirm(before, { callId: "call-recon-1" });
    expect(uncertain.status).toBe("inconclusive");

    const usage = createBudgetLedger({
      dataDir,
      monthlyTargetMicroUsd: 1_000_000_000,
      fixedMonthlyMicroUsd: 0,
    });
    usage.tryReserve("recon-warmup");
    usage.settle("recon-warmup", 0);

    calendar.setEventReadStatus("throw");
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createManager({
      sockets,
      hangups,
      dataDir,
      calendar,
      booking: bookingWith(calendar, dataDir, createIds),
    });
    const blocked = await manager.handleWebhook(
      signedHeaders(incomingCallPayload({ callId: "call-recon-blocked" }), {
        webhookId: "evt-recon-blocked",
      }),
    );
    expect(blocked.statusCode).toBe(503);
    expect(JSON.parse(blocked.body)).toEqual({ error: "recovery_pending" });
    expect(hangups).toContain("call-recon-blocked");

    calendar.setEventReadStatus(200);
    calendar.landEvent("ev-maint-1", {
      id: "ev-maint-1",
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
    const admitted = await manager.handleWebhook(
      signedHeaders(incomingCallPayload({ callId: "call-recon-admitted" }), {
        webhookId: "evt-recon-admitted",
      }),
    );
    expect(admitted.statusCode).toBe(200);
    expect(manager.recoveryStatus().admissionAvailable).toBe(true);
    sockets[sockets.length - 1]?.close();
  });

  it("shows caller-facing booking behavior before and after cleanup on isolated storage", async () => {
    const calendar = controllableCalendar();
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-public-"));
    const createIds = sequencedIds();
    const booking = bookingWith(calendar, dataDir, createIds);
    const sockets: FakeRealtimeSocket[] = [];
    const manager = createManager({ sockets, dataDir, booking, calendar });

    const socket = await openTelephoneSession(sockets, manager, {
      callId: "call-public-1",
      webhookId: "evt-public-1",
      callerNumber: "+15550001111",
    });
    const update = socket.messageOfType("session.update") as { session: Record<string, unknown> };
    expect(JSON.stringify(update.session)).not.toMatch(/transcription/i);
    expect(JSON.stringify(update.session)).not.toMatch(/"recording"/i);

    await toolRoundTrip(socket, "tool-propose", "propose_appointment", {
      callerName: CALLER_NAME,
      callbackNumber: CALLBACK_NUMBER,
      callbackConfirmed: true,
      date: FRIDAY_DATE,
      startTime: "10:00",
    });
    socket.receive({ type: "response.done" });
    const proposed = toolOutputs(socket)[0] as { status: string; proposalId?: string };
    expect(proposed.status).toBe("proposed");
    await toolRoundTrip(socket, "tool-confirm", "confirm_appointment", {
      confirmed: true,
      proposalId: proposed.proposalId,
    });
    socket.close();
    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-public-1");
    expect(evidence.status).toBe("completed");
    assertSafeOperationalPayload(evidence);
    expect(evidence.error).toBeUndefined();

    runRetentionCleanup({ dataDir, now: MONDAY_14H });

    const afterSockets: FakeRealtimeSocket[] = [];
    const afterBooking = bookingWith(calendar, dataDir, createIds);
    const after = createManager({
      sockets: afterSockets,
      dataDir,
      booking: afterBooking,
      calendar,
    });
    const afterSocket = await openTelephoneSession(afterSockets, after, {
      callId: "call-public-2",
      webhookId: "evt-public-2",
      callerNumber: "+15550002222",
    });
    await toolRoundTrip(afterSocket, "tool-propose-2", "propose_appointment", {
      callerName: CALLER_NAME,
      callbackNumber: "(555) 123-9876",
      callbackConfirmed: true,
      date: FRIDAY_DATE,
      startTime: "14:00",
    });
    afterSocket.receive({ type: "response.done" });
    const proposedAgain = toolOutputs(afterSocket)[0] as { proposalId?: string };
    await toolRoundTrip(afterSocket, "tool-confirm-2", "confirm_appointment", {
      confirmed: true,
      proposalId: proposedAgain.proposalId,
    });
    afterSocket.close();
    const refused = toolOutputs(afterSocket)[1] as { status: string; message: string };
    expect(refused.status).toBe("unavailable");
    expect(refused.message).toMatch(/contact Jacob directly/i);
    expect(calendar.writes.filter((row) => row.method === "DELETE")).toHaveLength(0);

    const afterEvidence = await recordedEvidence(() => after.listEvidence(), "call-public-2");
    assertSafeOperationalPayload(afterEvidence);
  });
});

describe("operator maintenance HTTP", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-maint-http-"));
  let app: SchedulingServer;

  beforeAll(async () => {
    const ledger = createBudgetLedger({
      dataDir,
      monthlyTargetMicroUsd: 1_000_000_000,
      fixedMonthlyMicroUsd: 0,
    });
    ledger.tryReserve("http-warmup");
    ledger.settle("http-warmup", 0);
    persistEvidence(dataDir, {
      callId: "call-http-recent",
      connectionRoute: "direct_sip",
      callerNumberMasked: "+1***1111",
      calledNumber: "+18005550199",
      status: "failed",
      durationMs: 2000,
      toolRoundTrips: 0,
      estimatedCostMicroUsd: 2,
      error: "provider_error",
      recordedAt: new Date().toISOString(),
    });
    app = createSchedulingServer({
      port: HTTP_PORT,
      webhookSecret: WEBHOOK_SECRET,
      apiKey: "test-key",
      evidenceToken: EVIDENCE_TOKEN,
      dataDir,
      connectWebSocket: (url, headers) => new FakeRealtimeSocket(url, headers),
      hangupCall: async () => undefined,
    });
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("lets a maintainer inspect bounded operational outcomes", async () => {
    const unauthorized = await fetch(`http://127.0.0.1:${HTTP_PORT}/evidence`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/evidence`, {
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as StructuredCallEvidence[];
    assertSafeOperationalPayload(body);
    expect(body.some((row) => row.callId === "call-http-recent")).toBe(true);
  });

  it("runs retention cleanup and reports health", async () => {
    persistEvidence(dataDir, {
      callId: "call-http-old",
      connectionRoute: "direct_sip",
      callerNumberMasked: "+1***0000",
      calledNumber: "+18005550199",
      status: "completed",
      durationMs: 1000,
      toolRoundTrips: 0,
      estimatedCostMicroUsd: 1,
      recordedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    });
    const denied = await fetch(`http://127.0.0.1:${HTTP_PORT}/maintenance/cleanup`, {
      method: "POST",
    });
    expect(denied.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/maintenance/cleanup`, {
      method: "POST",
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      operationalRecordsRemoved: number;
    };
    expect(body.operationalRecordsRemoved).toBeGreaterThanOrEqual(1);

    const evidence = await fetch(`http://127.0.0.1:${HTTP_PORT}/evidence`, {
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    const records = (await evidence.json()) as StructuredCallEvidence[];
    expect(records.some((row) => row.callId === "call-http-old")).toBe(false);
    expect(records.some((row) => row.callId === "call-http-recent")).toBe(true);

    const health = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as {
      status: string;
      admissionsPaused: boolean;
    };
    expect(healthBody.status).toBe("healthy");
    expect(healthBody.admissionsPaused).toBe(false);
  });
});
