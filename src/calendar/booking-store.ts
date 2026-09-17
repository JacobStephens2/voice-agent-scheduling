import { join } from "node:path";
import { appendJsonl, loadJsonl } from "../jsonl.js";

export type BookingRecordStatus = "pending" | "booked" | "unavailable" | "failed";

export interface BookingRecord {
  readonly operationId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly proposalId: string;
  readonly calendarId: string;
  readonly startUtc: string;
  readonly status: BookingRecordStatus;
  readonly recordedAt: string;
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
