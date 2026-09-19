import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractE164, isE164 } from "../phone.js";
import { CalendarQueryError, getAppointmentEvent } from "./client.js";
import { loadBookingRecords, type BookingRecord } from "./booking-store.js";
import { APPOINTMENT_MINUTES } from "./policy.js";

export type CallbackLimitOutcome = "clear" | "blocked" | "unknown";

/** Normalize a supplied callback number so equivalent formats share one limit key. */
export function normalizeCallbackNumber(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = extractE164(value);
  return isE164(normalized) ? normalized : undefined;
}

export type CallbackNumberHasher = (normalizedNumber: string) => string;

function saltFile(dataDir: string): string {
  return join(dataDir, "callback-salt");
}

function validSalt(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

function loadOrCreateSalt(dataDir: string): string {
  const path = saltFile(dataDir);
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (validSalt(raw)) {
      return raw;
    }
  } catch {
    // Missing or unreadable below; create a fresh salt unless hashed
    // booking records already exist — a replacement cannot match them.
  }
  const hashedBookings = loadBookingRecords(dataDir).some(
    (record) => typeof record.numberHash === "string",
  );
  if (hashedBookings) {
    return randomBytes(16).toString("hex");
  }
  mkdirSync(dataDir, { recursive: true });
  const salt = randomBytes(16).toString("hex");
  try {
    writeFileSync(path, `${salt}\n`, { mode: 0o600, flag: "wx" });
    return salt;
  } catch {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (validSalt(raw)) {
        return raw;
      }
    } catch {
      // Fall through to the ephemeral salt below.
    }
    return salt;
  }
}

/**
 * Hash normalized callback numbers with a per-data-directory salt kept
 * outside source control. Equivalent representations hash alike because
 * callers normalize first; the raw number never reaches durable storage.
 * Without a data directory the salt is ephemeral, so the limit still holds
 * for the life of the process.
 */
export function createCallbackNumberHasher(dataDir?: string): CallbackNumberHasher {
  const salt = dataDir ? loadOrCreateSalt(dataDir) : randomBytes(16).toString("hex");
  return (normalizedNumber: string) =>
    createHash("sha256")
      .update(`callback-limit-v1:${salt}:${normalizedNumber}`)
      .digest("hex");
}

function appointmentEndMs(startUtc: string): number {
  return Date.parse(startUtc) + APPOINTMENT_MINUTES * 60_000;
}

/**
 * Decide whether a callback number already holds an upcoming
 * scheduler-created appointment. Past appointments and manually
 * cancelled or deleted events no longer block; an unreachable Calendar
 * is "unknown" rather than a guess in either direction.
 */
export async function evaluateCallbackLimit(options: {
  readonly fetchFn: typeof fetch;
  readonly accessToken: string;
  readonly records: readonly BookingRecord[];
  readonly numberHash: string;
  readonly now: Date;
  /**
   * The committing operation's own identity. Its records describe this
   * attempt's uncertain write, reconciled separately against the same
   * identity; only other operations can hold a competing appointment.
   */
  readonly excludeOperationId?: string;
}): Promise<CallbackLimitOutcome> {
  const latestByOperation = new Map<string, BookingRecord>();
  for (const record of options.records) {
    if (record.numberHash !== options.numberHash) {
      continue;
    }
    if (options.excludeOperationId !== undefined && record.operationId === options.excludeOperationId) {
      continue;
    }
    latestByOperation.set(record.operationId, record);
  }
  for (const record of latestByOperation.values()) {
    if (record.status !== "booked" && record.status !== "pending" && record.status !== "inconclusive") {
      continue;
    }
    const endMs = appointmentEndMs(record.startUtc);
    if (Number.isNaN(endMs)) {
      return "unknown";
    }
    if (endMs <= options.now.getTime()) {
      continue;
    }
    let status: string | undefined;
    try {
      const event = await getAppointmentEvent(
        options.fetchFn,
        options.accessToken,
        record.calendarId,
        record.eventId,
      );
      status = event.status;
    } catch (error) {
      if (error instanceof CalendarQueryError && error.kind === "not_found") {
        continue;
      }
      return "unknown";
    }
    if (status === "cancelled") {
      continue;
    }
    return "blocked";
  }
  return "clear";
}
