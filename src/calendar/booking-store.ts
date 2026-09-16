import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  try {
    const text = readFileSync(bookingFile(dataDir), "utf8");
    const records: BookingRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      records.push(JSON.parse(line) as BookingRecord);
    }
    return records;
  } catch {
    return [];
  }
}

export function appendBookingRecord(dataDir: string, record: BookingRecord): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(bookingFile(dataDir), `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
