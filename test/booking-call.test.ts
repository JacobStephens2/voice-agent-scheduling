import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking, type AppointmentBookingCall, type BookingToolOptions } from "../src/calendar/booking-tool.js";
import { assistantResponseEvents, completeReadback, fakeGoogleCalendar, readbackText, TEST_EVENT_ID } from "./helpers.js";

const NOW = new Date("2026-09-07T14:00:00-04:00");
const ARGS = {
  callerName: "Ada Lovelace",
  callbackNumber: "+15551239876",
  callbackConfirmed: true,
  date: "2026-09-11",
  startTime: "10:00",
  purpose: "Website review",
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture(options: BookingToolOptions = {}) {
  const { fetchFn, ...overrides } = options;
  const google = fakeGoogleCalendar({});
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-call-lifetime-"));
  const ledger = createAppointmentLedger({ dataDir });
  let tokens = 0;
  let requests = 0;
  let identities = 0;
  const booking = createAppointmentBooking({
    fetchFn: async (input, init) => {
      requests += 1;
      if (String(input).includes("/events/prior-event")) return new Response("{}", { status: 404 });
      return (fetchFn ?? google.fetchFn)(input, init);
    },
    tokenProvider: { getAccessToken: async () => { tokens += 1; return "test-token"; } },
    selection: { primaryCalendarId: "primary", conflictCalendarIds: [], updatedAt: NOW.toISOString() },
    now: () => NOW,
    ledger,
    allowWrites: true,
    createIds: () => ({ operationId: `operation-${++identities}`, eventId: TEST_EVENT_ID }),
    ...overrides,
  });
  return { booking, google, ledger, dataDir, tokens: () => tokens, requests: () => requests };
}

async function propose(call: AppointmentBookingCall, extra: Record<string, unknown> = {}) {
  const result = await call.execute("propose_appointment", { ...ARGS, ...extra });
  if (result.status !== "proposed" || !result.proposalId || !result.readback) {
    throw new Error("Expected Appointment proposal");
  }
  return { ...result, proposalId: result.proposalId, readback: result.readback };
}

function holdReconciliation(f: ReturnType<typeof fixture>) {
  f.ledger.record({
    operationId: "prior-operation", eventId: "prior-event", callId: "prior-call",
    proposalId: "prior-proposal", calendarId: "primary", startUtc: "2026-09-11T14:00:00.000Z",
    numberHash: "prior-number-hash", status: "pending",
  });
  return f.booking.reconcileUnresolvedOperations();
}

describe("Appointment booking call lifetime", () => {
  it("makes close terminal and idempotent without sharing a proposal with a newly opened call", async () => {
    const { booking, google, tokens, requests, dataDir } = fixture();
    const call = booking.openCall({ callId: "same-call" });
    const proposed = await call.execute("propose_appointment", ARGS);
    completeReadback(call, proposed);
    const confirmation = { confirmed: true, proposalId: "proposalId" in proposed ? proposed.proposalId : undefined };
    call.close();
    call.close();
    completeReadback(call, proposed);
    expect(await call.execute("propose_appointment", ARGS)).toEqual({
      status: "invalid", message: "This scheduling call has ended.",
    });
    expect(await call.execute("confirm_appointment", confirmation)).toEqual({
      status: "readback_incomplete", message: "This scheduling call has ended.",
    });
    const fresh = booking.openCall({ callId: "same-call" });
    expect(await fresh.execute("confirm_appointment", confirmation)).toMatchObject({ status: "readback_incomplete" });
    expect(tokens()).toBe(0);
    expect(requests()).toBe(0);
    expect(google.writes).toEqual([]);
    expect(existsSync(join(dataDir, "bookings.jsonl"))).toBe(false);
    expect(await call.execute("unknown", ARGS)).toEqual({ status: "failed", message: "Unknown booking tool." });
  });

  it.each(["queue", "token", "freeBusy", "insert"] as const)(
    "drains duplicate accepted confirmations after closing during %s", async (phase) => {
      const entered = gate();
      const resume = gate();
      const google = fakeGoogleCalendar({});
      const f = fixture({
        tokenProvider: { getAccessToken: async () => {
          if (phase === "queue" || phase === "token") {
            entered.release();
            await resume.promise;
          }
          return "test-token";
        } },
        fetchFn: async (input, init) => {
          if ((phase === "freeBusy" && String(input).includes("/freeBusy")) ||
              (phase === "insert" && init?.method === "POST" && String(input).includes("/events"))) {
            entered.release();
            await resume.promise;
          }
          return google.fetchFn(input, init);
        },
      });
      const call = f.booking.openCall({ callId: "draining-call" });
      const proposed = await propose(call);
      completeReadback(call, proposed);
      const reconciliation = phase === "queue" ? holdReconciliation(f) : undefined;
      if (reconciliation) await entered.promise;
      const args = { confirmed: true, proposalId: proposed.proposalId };
      const first = call.execute("confirm_appointment", args);
      const duplicate = call.execute("confirm_appointment", args);
      await entered.promise;
      call.close();
      call.close();
      resume.release();
      await reconciliation;
      const results = await Promise.all([first, duplicate]);
      expect(results).toEqual([expect.objectContaining({ status: "booked", eventExists: true }),
        expect.objectContaining({ status: "booked", eventExists: true })]);
      expect(results[0]).toEqual(results[1]);
      expect(google.writes).toHaveLength(1);
      const result = results[0]!;
      expect("operationId" in result && f.ledger.latestForOperation(result.operationId!)).toMatchObject({ status: "booked" });
      const stored = readFileSync(join(f.dataDir, "bookings.jsonl"), "utf8");
      for (const detail of [ARGS.callerName, ARGS.callbackNumber, ARGS.purpose]) expect(stored).not.toContain(detail);
      expect(await call.execute("confirm_appointment", args)).toEqual({
        status: "readback_incomplete", message: "This scheduling call has ended.",
      });
    },
  );

  it.each(["refused", "failed", "thrown"] as const)(
    "settles %s accepted work and leaves the queue usable after close", async (outcome) => {
      const entered = gate();
      const resume = gate();
      let firstToken = true;
      const f = fixture({
        tokenProvider: { getAccessToken: async () => {
          if (firstToken) {
            firstToken = false;
            entered.release();
            await resume.promise;
          }
          return "test-token";
        } },
        allowWrites: outcome !== "failed",
        createIds: () => { throw new Error("identity generation failed"); },
      });
      const call = f.booking.openCall({ callId: "stopped-call" });
      const proposed = await propose(call);
      completeReadback(call, proposed);
      const reconciliation = holdReconciliation(f);
      await entered.promise;
      const pending = call.execute("confirm_appointment", {
        confirmed: outcome !== "refused", proposalId: proposed.proposalId,
      });
      // Attach the rejection assertion before allowing queued work to throw.
      const settlement = outcome === "thrown"
        ? expect(pending).rejects.toThrow("identity generation failed")
        : expect(pending).resolves.toMatchObject({ status: outcome === "refused" ? "readback_incomplete" : "failed" });
      call.close();
      resume.release();
      await reconciliation;
      await settlement;
      expect(await f.booking.reconcileUnresolvedOperations()).toEqual([{
        operationId: "prior-operation", eventId: "prior-event", status: "inconclusive", eventExists: false,
      }]);
      expect(f.google.writes).toEqual([]);
      expect(await call.execute("confirm_appointment", { confirmed: true, proposalId: proposed.proposalId })).toEqual({
        status: "readback_incomplete", message: "This scheduling call has ended.",
      });
    },
  );

  it("does not earn Readback readiness from observations after closing while validation is queued", async () => {
    const entered = gate();
    const resume = gate();
    const f = fixture({ tokenProvider: { getAccessToken: async () => {
      entered.release();
      await resume.promise;
      return "test-token";
    } } });
    const call = f.booking.openCall({ callId: "incomplete-readback" });
    const proposed = await propose(call);
    const events = assistantResponseEvents({ responseId: "partial", transcriptDelta: readbackText(proposed.readback) });
    call.observe(events[0]!);
    const reconciliation = holdReconciliation(f);
    await entered.promise;
    const pending = call.execute("confirm_appointment", { confirmed: true, proposalId: proposed.proposalId });
    call.close();
    call.observe(events[1]!);
    completeReadback(call, proposed);
    resume.release();
    await reconciliation;
    expect(await pending).toMatchObject({ status: "readback_incomplete", message: expect.stringContaining("not finished") });
    expect(f.google.writes).toEqual([]);
  });

  it("keeps independently opened calls isolated even when their call identities match", async () => {
    const f = fixture();
    const one = f.booking.openCall({ callId: "same-identity" });
    const two = f.booking.openCall({ callId: "same-identity" });
    const first = await propose(one);
    completeReadback(one, first);
    const second = await propose(two, { callerName: "Grace Hopper" });
    expect(await two.execute("confirm_appointment", { confirmed: true, proposalId: first.proposalId })).toMatchObject({ status: "readback_incomplete" });
    expect(await two.execute("confirm_appointment", { confirmed: true, proposalId: second.proposalId })).toMatchObject({ status: "readback_incomplete" });
    two.close();
    expect(await one.execute("confirm_appointment", { confirmed: true, proposalId: first.proposalId })).toMatchObject({ status: "booked" });
    expect(f.google.writes).toHaveLength(1);
    expect(f.google.writes[0]?.body.summary).toBe("Appointment with Ada Lovelace");
  });

  it.each(["token", "freeBusy", "unavailable"] as const)("preserves accepted replacement after close during %s", async (phase) => {
    const entered = gate();
    const resume = gate();
    const google = fakeGoogleCalendar(phase === "unavailable" ? { freeBusy: { calendars: {
      primary: { busy: [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T10:30:00-04:00" }] },
    } } } : {});
    const f = fixture({
      tokenProvider: { getAccessToken: async () => {
        if (phase === "token") { entered.release(); await resume.promise; }
        return "test-token";
      } },
      fetchFn: async (input, init) => {
        if ((phase === "freeBusy" && String(input).includes("/freeBusy")) ||
            (phase === "unavailable" && String(input).includes("/events/"))) {
          entered.release();
          await resume.promise;
        }
        return google.fetchFn(input, init);
      },
    });
    const call = f.booking.openCall({ callId: "replaced-call" });
    const first = await propose(call);
    completeReadback(call, first);
    const pending = call.execute("confirm_appointment", { confirmed: true, proposalId: first.proposalId });
    await entered.promise;
    const replacement = await propose(call, { callerName: "Grace Hopper", startTime: "14:00" });
    completeReadback(call, replacement);
    const acceptedReplacement = call.execute("confirm_appointment", { confirmed: true, proposalId: replacement.proposalId });
    call.close();
    resume.release();
    expect(await pending).toMatchObject({ status: phase === "unavailable" ? "unavailable" : "failed", eventExists: false });
    expect(await acceptedReplacement).toMatchObject({ status: "booked", eventExists: true });
    expect(google.writes).toHaveLength(1);
    expect(google.writes[0]?.body).toMatchObject({
      summary: "Appointment with Grace Hopper", start: { dateTime: "2026-09-11T14:00:00" },
    });
  });

  it("binds optional reference time at opening and otherwise uses the execution clock", async () => {
    let now = NOW;
    const f = fixture({ now: () => now });
    const bound = f.booking.openCall({ callId: "fixed-reference", referenceTime: NOW });
    const liveClock = f.booking.openCall({ callId: "execution-clock" });
    now = new Date("2026-09-30T00:00:00Z");
    const proposed = await propose(bound);
    completeReadback(bound, proposed);
    expect(await bound.execute("confirm_appointment", { confirmed: true, proposalId: proposed.proposalId })).toMatchObject({ status: "booked" });
    expect(await liveClock.execute("propose_appointment", ARGS)).toMatchObject({ status: "invalid" });
  });
});
