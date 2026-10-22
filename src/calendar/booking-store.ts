import { join } from "node:path";
import { appendJsonl, loadJsonl, rewriteJsonl } from "../jsonl.js";
import { APPOINTMENT_MINUTES } from "./policy.js";

export type BookingRecordStatus = "pending" | "booked" | "unavailable" | "failed" | "inconclusive";

/**
 * Records that never established whether the Calendar write landed.
 * Restart recovery reconciles these against the stored event identity;
 * it never mints a replacement identity or re-inserts blindly.
 */
export const UNRESOLVED_BOOKING_STATUSES: readonly BookingRecordStatus[] = [
  "pending",
  "inconclusive",
];

export function isUnresolvedBookingStatus(status: BookingRecordStatus): boolean {
  return UNRESOLVED_BOOKING_STATUSES.includes(status);
}

export interface BookingRecord {
  readonly operationId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly proposalId: string;
  readonly calendarId: string;
  readonly startUtc: string;
  readonly status: BookingRecordStatus;
  readonly recordedAt: string;
  /**
   * Salted hash of the normalized callback number for the per-number
   * upcoming-appointment limit. Older records predate the limit and carry
   * no hash; the raw number is never stored. Absent hashes never match.
   */
  readonly numberHash?: string;
  /**
   * Set when a stored event did not match the approved shape. The row stays
   * inconclusive either way; this is how a later retry can tell that outcome
   * from an inconclusive row whose event was never established. Absent on
   * older rows.
   */
  readonly storedShape?: "mismatched";
}

function bookingFile(dataDir: string): string {
  return join(dataDir, "bookings.jsonl");
}

/** Load minimal booking records. Caller speech, names, and numbers are not stored. */
export function loadBookingRecords(dataDir: string): BookingRecord[] {
  return loadJsonl<BookingRecord>(bookingFile(dataDir));
}

export function appendBookingRecord(dataDir: string, record: BookingRecord): void {
  appendJsonl(bookingFile(dataDir), record, 0o600);
}

export function replaceBookingRecords(
  dataDir: string,
  records: readonly BookingRecord[],
): void {
  rewriteJsonl(bookingFile(dataDir), records, 0o600);
}

export function latestByOperation(records: readonly BookingRecord[]): BookingRecord[] {
  const latest = new Map<string, BookingRecord>();
  for (const record of records) {
    latest.set(record.operationId, record);
  }
  return [...latest.values()];
}

/** Keep unresolved work and still-upcoming booked appointments; drop settled history. */
export function isRelevantBookingRecord(record: BookingRecord, now: Date): boolean {
  if (isUnresolvedBookingStatus(record.status)) {
    return true;
  }
  if (record.status !== "booked") {
    return false;
  }
  const endMs = Date.parse(record.startUtc) + APPOINTMENT_MINUTES * 60_000;
  if (Number.isNaN(endMs)) {
    return true;
  }
  return endMs > now.getTime();
}

export function bookingRecord(
  fields: Omit<BookingRecord, "recordedAt"> & { recordedAt?: string },
): BookingRecord {
  return {
    operationId: fields.operationId,
    eventId: fields.eventId,
    callId: fields.callId,
    proposalId: fields.proposalId,
    calendarId: fields.calendarId,
    startUtc: fields.startUtc,
    status: fields.status,
    recordedAt: fields.recordedAt ?? new Date().toISOString(),
    ...(fields.numberHash === undefined ? {} : { numberHash: fields.numberHash }),
    ...(fields.storedShape === undefined ? {} : { storedShape: fields.storedShape }),
  };
}

export function latestForProposal(
  records: readonly BookingRecord[],
  proposalId: string,
): BookingRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.proposalId === proposalId) {
      return record;
    }
  }
  return undefined;
}

export function unresolvedOperations(
  records: readonly BookingRecord[],
): BookingRecord[] {
  const latestByOperation = new Map<string, BookingRecord>();
  for (const record of records) {
    latestByOperation.set(record.operationId, record);
  }
  return [...latestByOperation.values()].filter((record) =>
    isUnresolvedBookingStatus(record.status),
  );
}
