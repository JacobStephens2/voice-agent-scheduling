import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
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
import { completeReadback, TEST_EVENT_ID, fakeGoogleCalendar } from "./helpers.js";

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
    const attempt = ledger.beginAttempt(fields);

    attempt.pending();
    const first = ledger.latestForOperation("op-1");
    expect(first?.status).toBe("pending");

    attempt.pending();
    expect(ledger.latestForOperation("op-1")).toBe(first);

    ledger.record(row("op-1", "inconclusive"));
    attempt.pending();
    expect(ledger.latestForOperation("op-1")?.status).toBe("inconclusive");

    ledger.record(row("op-1", "failed"));
    attempt.pending();
    expect(ledger.latestForOperation("op-1")?.status).toBe("pending");
  });

  it("durably records pending after a failed append is repaired", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    const fields = { ...row("op-1", "pending") };
    const attempt = ledger.beginAttempt(fields);
    const recordsPath = join(dataDir, "bookings.jsonl");
    mkdirSync(recordsPath);
    expect(() => attempt.pending()).toThrow();
    expect(ledger.latestForOperation("op-1")).toBeUndefined();
    rmSync(recordsPath, { recursive: true });
    attempt.pending();
    expect(createAppointmentLedger({ dataDir }).latestForOperation("op-1")?.status).toBe("pending");
  });

  it("opens an attempt without appending or allocating an identity", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    ledger.beginAttempt(row("op-1", "booked"));

    expect(ledger.hasRecords()).toBe(false);
    expect(existsSync(join(dataDir, "bookings.jsonl"))).toBe(false);
  });

  describe.each(["fail", "unavailable"] as const)("attempt %s", (transition) => {
    it.each([undefined, "failed", "unavailable", "booked"] as const)(
      "closes a %s start before and after its own pending row",
      (status) => {
        for (const afterPending of [false, true]) {
          const dataDir = tempDir();
          const ledger = createAppointmentLedger({ dataDir });
          const identity = row("op-1", "pending", { numberHash: "hash-a" });
          if (status) {
            ledger.record({ ...identity, status });
          }
          const attempt = ledger.beginAttempt(identity);
          if (afterPending) {
            attempt.pending();
          }

          const outcome = attempt[transition]();
          expect(outcome.status).toBe(transition === "fail" ? "failed" : "unavailable");
          expect(ledger.latestForOperation("op-1")).toBe(outcome);
          expect(ledger.operationsHoldingAppointment("hash-a")).toEqual([]);
          expect(createAppointmentLedger({ dataDir }).latestForOperation("op-1")).toEqual(outcome);
        }
      },
    );

    it.each(["pending", "inconclusive"] as const)(
      "preserves a prior %s row, shape mark and callback-number hold without appending",
      (status) => {
        const dataDir = tempDir();
        const ledger = createAppointmentLedger({ dataDir });
        const prior = ledger.record(row("op-1", status, {
          storedShape: "mismatched",
          numberHash: "hash-a",
        }));
        const before = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
        const attempt = ledger.beginAttempt(prior);

        expect(attempt[transition]()).toBe(prior);
        attempt.pending();
        expect(attempt[transition]()).toBe(prior);
        expect(readFileSync(join(dataDir, "bookings.jsonl"), "utf8")).toBe(before);
        expect(ledger.operationsHoldingAppointment("hash-a")).toEqual([prior]);
        expect(createAppointmentLedger({ dataDir }).latestForOperation("op-1")).toEqual(prior);
      },
    );
  });

  it("captures the proposal's prior row separately from the operation's live pending row", () => {
    const ledger = createAppointmentLedger({ dataDir: tempDir() });
    const prior = ledger.record(row("old-op", "inconclusive", { proposalId: "shared-proposal" }));
    const attempt = ledger.beginAttempt(row("new-op", "pending", { proposalId: "shared-proposal" }));
    attempt.pending();
    expect(ledger.latestForOperation("new-op")?.status).toBe("pending");
    ledger.compact(MONDAY_14H);
    expect(attempt.fail()).toBe(prior);
    expect(attempt.unavailable()).toBe(prior);
  });

  it("commits only the captured identity and new outcome, clearing old shape marks", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    const handed = {
      ...row("op-1", "inconclusive", {
        recordedAt: "2020-01-01T00:00:00.000Z",
        storedShape: "mismatched",
        numberHash: "hash-a",
      }),
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
    };
    ledger.record(handed);
    const attempt = ledger.beginAttempt(handed);
    handed.eventId = "changed-after-open";
    handed.numberHash = "changed-after-open";

    const outcome = attempt.commit({ status: "booked" });
    expect(outcome).toEqual({
      operationId: "op-1",
      eventId: "ev-op-1",
      callId: "call-op-1",
      proposalId: "proposal-op-1",
      calendarId: "primary",
      startUtc: FRIDAY_10H_UTC,
      numberHash: "hash-a",
      status: "booked",
      recordedAt: expect.any(String),
    });
    expect(outcome.recordedAt).not.toBe(handed.recordedAt);
    expect(attempt.commit({ status: "booked" })).not.toBe(outcome);
    expect(attempt.commit({ status: "inconclusive", storedShape: "mismatched" }).storedShape).toBe(
      "mismatched",
    );
    const cleared = attempt.commit({ status: "inconclusive" });
    expect(cleared.storedShape).toBeUndefined();
    expect(createAppointmentLedger({ dataDir }).latestForOperation("op-1")).toEqual(cleared);
    const stored = readFileSync(join(dataDir, "bookings.jsonl"), "utf8");
    expect(stored).not.toContain("Ada Lovelace");
    expect(stored).not.toContain("15551239876");
  });

  it("does not claim booked in memory or on reopen after a commit append fails", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    const attempt = ledger.beginAttempt(row("op-1", "pending"));
    attempt.pending();
    const prior = ledger.latestForOperation("op-1");
    const recordsPath = join(dataDir, "bookings.jsonl");
    const savedPath = join(dataDir, "saved.jsonl");
    renameSync(recordsPath, savedPath);
    mkdirSync(recordsPath);

    expect(() => attempt.commit({ status: "booked" })).toThrow();
    expect(ledger.latestForOperation("op-1")).toBe(prior);
    rmSync(recordsPath, { recursive: true });
    renameSync(savedPath, recordsPath);
    expect(createAppointmentLedger({ dataDir }).latestForOperation("op-1")).toEqual(prior);

    const committed = attempt.commit({ status: "booked" });
    expect(createAppointmentLedger({ dataDir }).latestForOperation("op-1")).toEqual(committed);
  });

  it("never stores a caller name handed to record", () => {
    const dataDir = tempDir();
    const ledger = createAppointmentLedger({ dataDir });
    const handed = { ...row("op-1", "booked"), callerName: "Ada Lovelace" };
    ledger.record(handed);
    expect(readFileSync(join(dataDir, "bookings.jsonl"), "utf8")).not.toContain("Ada Lovelace");
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

  it("hashes a callback number with a salt kept per data directory", () => {
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

  it("hashes equivalent formats of a callback number alike", () => {
    const ledger = createAppointmentLedger({ dataDir: tempDir() });
    const hash = ledger.hashCallbackNumber("+15551239876");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.hashCallbackNumber("(555) 123-9876")).toBe(hash);
  });

  it("does not hash a value that is not a phone number", () => {
    const ledger = createAppointmentLedger({ dataDir: tempDir() });
    expect(ledger.hashCallbackNumber("call me later")).toBeUndefined();
  });

  it("writes the callback-number salt when the booking tool is constructed", () => {
    const dataDir = tempDir();
    createAppointmentBooking({ dataDir, credentials: null, selection: null, allowWrites: true });
    expect(existsSync(join(dataDir, "callback-salt"))).toBe(true);
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
      completeReadback(booking, "call-retry", proposed);

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
