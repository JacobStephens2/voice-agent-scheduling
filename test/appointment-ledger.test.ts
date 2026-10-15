import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bookingRecord,
  createAppointmentLedger,
  type BookingRecord,
  type BookingRecordStatus,
} from "../src/calendar/appointment-ledger.js";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { TEST_EVENT_ID, fakeGoogleCalendar } from "./helpers.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const FRIDAY_10H_UTC = "2026-09-11T14:00:00.000Z";
const LAST_WEEK_UTC = "2026-08-31T14:00:00.000Z";
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "scheduling-ledger-"));
}

function row(
  operationId: string,
  status: BookingRecordStatus,
  extra: Partial<BookingRecord> = {},
): BookingRecord {
  return bookingRecord({
    operationId,
    eventId: `ev-${operationId}`,
    callId: `call-${operationId}`,
    proposalId: `proposal-${operationId}`,
    calendarId: "primary",
    startUtc: FRIDAY_10H_UTC,
    status,
    ...extra,
  });
}

describe("appointment ledger", () => {
  it("answers the latest record per operation and per proposal", () => {
    const ledger = createAppointmentLedger({ dataDir: tempDir() });
    ledger.record(row("op-1", "pending"));
    ledger.record(row("op-1", "booked"));
    ledger.record(row("op-2", "pending"));

    expect(ledger.latestForOperation("op-1")?.status).toBe("booked");
    expect(ledger.latestForProposal("proposal-1")).toBeUndefined();
    expect(ledger.latestForProposal("proposal-op-2")?.status).toBe("pending");
    expect(ledger.unresolvedOperations().map((record) => record.operationId)).toEqual(["op-2"]);
  });

  it("reopens the same records from the data directory", () => {
    const dataDir = tempDir();
    const before = createAppointmentLedger({ dataDir });
    before.record(row("op-1", "inconclusive"));

    const after = createAppointmentLedger({ dataDir });
    expect(after.hasRecords()).toBe(true);
    expect(after.unresolvedOperations()).toEqual([before.latestForOperation("op-1")]);
  });

  it("records pending unless the operation's latest record is already unresolved", () => {
    const ledger = createAppointmentLedger({ dataDir: tempDir() });
    const fields = { ...row("op-1", "pending") };

    ledger.recordPending(fields);
    const first = ledger.latestForOperation("op-1");
    expect(first?.status).toBe("pending");

    ledger.recordPending(fields);
    expect(ledger.latestForOperation("op-1")).toBe(first);

    ledger.record(row("op-1", "inconclusive"));
    ledger.recordPending(fields);
    expect(ledger.latestForOperation("op-1")?.status).toBe("inconclusive");

    ledger.record(row("op-1", "failed"));
    ledger.recordPending(fields);
    expect(ledger.latestForOperation("op-1")?.status).toBe("pending");
  });

  it("lists other operations that may hold an appointment for a number hash", () => {
    const ledger = createAppointmentLedger({ dataDir: tempDir() });
    ledger.record(row("op-booked", "booked", { numberHash: "hash-a" }));
    ledger.record(row("op-pending", "pending", { numberHash: "hash-a" }));
    ledger.record(row("op-settled", "pending", { numberHash: "hash-a" }));
    ledger.record(row("op-settled", "failed", { numberHash: "hash-a" }));
    ledger.record(row("op-other", "booked", { numberHash: "hash-b" }));
    ledger.record(row("op-self", "booked", { numberHash: "hash-a" }));

    expect(
      ledger.operationsHoldingAppointment("hash-a", "op-self").map((record) => record.operationId),
    ).toEqual(["op-booked", "op-pending"]);
  });

  it("compacts the file and the in-memory view together", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    ledger.record(row("op-past", "booked", { startUtc: LAST_WEEK_UTC }));
    ledger.record(row("op-failed", "failed"));
    ledger.record(row("op-upcoming", "pending"));
    ledger.record(row("op-upcoming", "booked"));
    ledger.record(row("op-uncertain", "inconclusive"));

    expect(ledger.compact(MONDAY_14H)).toEqual({ removed: 3, kept: 2 });

    expect(ledger.latestForOperation("op-past")).toBeUndefined();
    expect(ledger.latestForOperation("op-failed")).toBeUndefined();
    expect(ledger.latestForOperation("op-upcoming")?.status).toBe("booked");
    expect(ledger.unresolvedOperations().map((record) => record.operationId)).toEqual([
      "op-uncertain",
    ]);

    const reopened = createAppointmentLedger({ dataDir });
    expect(reopened.latestForOperation("op-past")).toBeUndefined();
    expect(reopened.latestForOperation("op-upcoming")?.status).toBe("booked");
    expect(reopened.unresolvedOperations()).toHaveLength(1);
  });

  it("hashes equivalent numbers alike with a salt kept per data directory", () => {
    const dataDir = tempDir();
    const first = createAppointmentLedger({ dataDir });
    const hash = first.hashCallbackNumber("+15551239876");
    expect(hash).not.toContain("5551239876");
    expect(createAppointmentLedger({ dataDir }).hashCallbackNumber("+15551239876")).toBe(hash);
    expect(createAppointmentLedger({ dataDir: tempDir() }).hashCallbackNumber("+15551239876")).not.toBe(
      hash,
    );
  });

  it("reports the salt missing only when stored records carry number hashes", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    expect(ledger.missingFiles()).toEqual([]);

    ledger.record(row("op-1", "booked", { numberHash: ledger.hashCallbackNumber("+15551239876") }));
    expect(ledger.missingFiles()).toEqual([]);

    rmSync(join(dataDir, "callback-salt"));
    const restored = createAppointmentLedger({ dataDir });
    expect(restored.missingFiles()).toEqual(["callback-salt"]);

    // Without the original salt, a fresh hash cannot match the stored one.
    expect(restored.hashCallbackNumber("+15551239876")).not.toBe(
      ledger.latestForOperation("op-1")?.numberHash,
    );
    expect(restored.missingFiles()).toEqual(["callback-salt"]);
  });

  it("does not write a salt when opened only to inspect it", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "bookings.jsonl"), "");
    const ledger = createAppointmentLedger({ dataDir });
    expect(ledger.missingFiles()).toEqual([]);
    expect(() => rmSync(join(dataDir, "callback-salt"))).toThrow();
  });
});

describe("booking retries through the appointment ledger", () => {
  it.each(["token", "free/busy"] as const)(
    "records pending under the reused identity before retrying after a %s failure",
    async (failure) => {
      const dataDir = tempDir();
      const ledger = createAppointmentLedger({ dataDir });
      let failing = true;
      const statusesAtInsert: Array<string | undefined> = [];
      const google = fakeGoogleCalendar({});
      const fetchFn = (async (url: unknown, init?: unknown) => {
        if (failure === "free/busy" && failing && String(url).includes("/freeBusy")) {
          return new Response("{}", { status: 500 });
        }
        if ((init as RequestInit | undefined)?.method === "POST" && String(url).includes("/events")) {
          statusesAtInsert.push(ledger.latestForOperation("op-retry")?.status);
        }
        return google.fetchFn(url as string, init as RequestInit);
      }) as typeof fetch;
      let created = 0;
      const booking = createAppointmentBooking({
        fetchFn,
        tokenProvider: {
          getAccessToken: async () => {
            if (failure === "token" && failing) {
              throw new Error("token refresh failed");
            }
            return "test-access-token";
          },
        },
        selection: SELECTION,
        now: () => MONDAY_14H,
        ledger,
        createIds: () => {
          created += 1;
          return { operationId: "op-retry", eventId: TEST_EVENT_ID };
        },
        allowWrites: true,
      });

      const proposed = await booking.execute(
        "propose_appointment",
        {
          callerName: "Ada Lovelace",
          callbackNumber: "+15551239876",
          callbackConfirmed: true,
          date: "2026-09-11",
          startTime: "10:00",
        },
        { callId: "call-retry" },
      );
      const proposalId = (proposed as { proposalId: string }).proposalId;
      booking.markReadbackFinished("call-retry");

      const failed = await booking.execute(
        "confirm_appointment",
        { confirmed: true, proposalId },
        { callId: "call-retry" },
      );
      expect(failed.status).toBe("failed");
      expect(ledger.latestForOperation("op-retry")?.status).toBe("failed");

      failing = false;
      const retried = await booking.execute(
        "confirm_appointment",
        { confirmed: true, proposalId },
        { callId: "call-retry" },
      );

      expect(retried).toMatchObject({
        status: "booked",
        operationId: "op-retry",
        eventId: TEST_EVENT_ID,
      });
      expect(statusesAtInsert).toEqual(["pending"]);
      expect(created).toBe(1);
      expect(ledger.latestForOperation("op-retry")?.status).toBe("booked");
    },
  );
});
