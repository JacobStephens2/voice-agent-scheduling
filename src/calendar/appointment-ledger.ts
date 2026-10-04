import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, loadJsonl, rewriteJsonl } from "../jsonl.js";
import { APPOINTMENT_MINUTES } from "./policy.js";

export type BookingRecordStatus = "pending" | "booked" | "unavailable" | "failed" | "inconclusive";

/**
 * Records that never established whether the Calendar write landed.
 * Restart recovery reconciles these against the stored event identity;
 * it never mints a replacement identity or re-inserts blindly.
 */
const UNRESOLVED_BOOKING_STATUSES: readonly BookingRecordStatus[] = ["pending", "inconclusive"];

/** Statuses whose operation may hold an appointment on Calendar. */
const APPOINTMENT_HOLDING_STATUSES: readonly BookingRecordStatus[] = [
  "booked",
  ...UNRESOLVED_BOOKING_STATUSES,
];

function isUnresolvedBookingStatus(status: BookingRecordStatus): boolean {
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
}

export type BookingRecordFields = Omit<BookingRecord, "recordedAt" | "status"> & {
  readonly recordedAt?: string;
};

export function bookingRecord(
  fields: BookingRecordFields & { readonly status: BookingRecordStatus },
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
  };
}

export const BOOKING_RECORDS_FILE = "bookings.jsonl";
export const CALLBACK_SALT_FILE = "callback-salt";

/** Not a stored salt; hashing with it cannot match existing number hashes. */
const UNMATCHABLE_CALLBACK_SALT = "restored-state-without-original-salt";

export interface LedgerCompaction {
  readonly removed: number;
  readonly kept: number;
}

/**
 * The scheduler's durable record of each attempt to create an appointment
 * and its outcome, for one data directory. One instance per process owns
 * the file, the in-memory view and the callback-number salt, so every
 * reader sees the same records. Operations are synchronous: an append can
 * never interleave with a compaction.
 */
export interface AppointmentLedger {
  /** Append an outcome for an operation. */
  record(record: BookingRecord): void;
  /**
   * Record that a Calendar insert is about to start under these
   * identities. Writes `pending` unless the operation's latest record is
   * already unresolved, so a retry after a failed attempt is always
   * reconcilable if the process stops mid-insert.
   */
  recordPending(fields: BookingRecordFields): void;
  /** The latest record for a proposal, across operations. */
  latestForProposal(proposalId: string): BookingRecord | undefined;
  /** The latest record for one operation. */
  latestForOperation(operationId: string): BookingRecord | undefined;
  /** Latest record of every operation that never settled its Calendar write. */
  unresolvedOperations(): BookingRecord[];
  /**
   * Latest record of every operation that may hold an appointment for a
   * callback-number hash, excluding the committing operation's own records.
   */
  operationsHoldingAppointment(numberHash: string, excludeOperationId?: string): BookingRecord[];
  /** True when the ledger holds any record at all. */
  hasRecords(): boolean;
  /** Hash a normalized callback number with the data directory's salt. */
  hashCallbackNumber(normalizedNumber: string): string;
  /**
   * Durable files the ledger needs but cannot find. The salt is missing
   * when stored records carry number hashes but no salt file exists.
   */
  missingFiles(): string[];
  /**
   * Drop settled history: keep the latest record of every unresolved
   * operation and every still-upcoming booked appointment. Rewrites the
   * file and the in-memory view together.
   */
  compact(now: Date): LedgerCompaction;
}

function latestByOperation(records: readonly BookingRecord[]): BookingRecord[] {
  const latest = new Map<string, BookingRecord>();
  for (const record of records) {
    latest.set(record.operationId, record);
  }
  return [...latest.values()];
}

function findLatest(
  records: readonly BookingRecord[],
  matches: (record: BookingRecord) => boolean,
): BookingRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && matches(record)) {
      return record;
    }
  }
  return undefined;
}

export function appointmentEndMs(startUtc: string): number {
  return Date.parse(startUtc) + APPOINTMENT_MINUTES * 60_000;
}

/** Keep unresolved work and still-upcoming booked appointments; drop settled history. */
function isRelevantBookingRecord(record: BookingRecord, now: Date): boolean {
  if (isUnresolvedBookingStatus(record.status)) {
    return true;
  }
  if (record.status !== "booked") {
    return false;
  }
  const endMs = appointmentEndMs(record.startUtc);
  if (Number.isNaN(endMs)) {
    return true;
  }
  return endMs > now.getTime();
}

function validSalt(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

function loadCallbackSalt(dataDir: string): string | undefined {
  try {
    const raw = readFileSync(join(dataDir, CALLBACK_SALT_FILE), "utf8").trim();
    if (validSalt(raw)) {
      return raw;
    }
  } catch {
    // Missing or unreadable salt is treated as absent.
  }
  return undefined;
}

/**
 * Open the appointment ledger for a data directory. Caller speech, names
 * and raw numbers are never stored. Without a data directory the records
 * and salt live only in memory, so the limit still holds for the life of
 * the process.
 */
export function createAppointmentLedger(options: { readonly dataDir?: string } = {}): AppointmentLedger {
  const dataDir = options.dataDir;
  const file = dataDir ? join(dataDir, BOOKING_RECORDS_FILE) : undefined;
  let records: BookingRecord[] = file ? loadJsonl<BookingRecord>(file) : [];
  let salt: string | undefined;

  const hasNumberHashes = () => records.some((record) => typeof record.numberHash === "string");

  const loadOrCreateSalt = (): string => {
    if (!dataDir) {
      return randomBytes(16).toString("hex");
    }
    const existing = loadCallbackSalt(dataDir);
    if (existing) {
      return existing;
    }
    if (hasNumberHashes()) {
      return UNMATCHABLE_CALLBACK_SALT;
    }
    mkdirSync(dataDir, { recursive: true });
    const created = randomBytes(16).toString("hex");
    try {
      writeFileSync(join(dataDir, CALLBACK_SALT_FILE), `${created}\n`, { mode: 0o600, flag: "wx" });
      return created;
    } catch {
      return loadCallbackSalt(dataDir) ?? created;
    }
  };

  const latestForOperation = (operationId: string): BookingRecord | undefined =>
    findLatest(records, (record) => record.operationId === operationId);

  const append = (record: BookingRecord): void => {
    records.push(record);
    if (file) {
      appendJsonl(file, record, 0o600);
    }
  };

  return {
    record: append,

    recordPending(fields) {
      const latest = latestForOperation(fields.operationId);
      if (latest && isUnresolvedBookingStatus(latest.status)) {
        return;
      }
      append(bookingRecord({ ...fields, status: "pending" }));
    },

    latestForProposal(proposalId) {
      return findLatest(records, (record) => record.proposalId === proposalId);
    },

    latestForOperation,

    unresolvedOperations() {
      return latestByOperation(records).filter((record) => isUnresolvedBookingStatus(record.status));
    },

    operationsHoldingAppointment(numberHash, excludeOperationId) {
      return latestByOperation(
        records.filter(
          (record) => record.numberHash === numberHash && record.operationId !== excludeOperationId,
        ),
      ).filter((record) => APPOINTMENT_HOLDING_STATUSES.includes(record.status));
    },

    hasRecords() {
      return records.length > 0;
    },

    hashCallbackNumber(normalizedNumber) {
      // Settled on first use, so opening a ledger only to inspect it never
      // writes a salt into the data directory.
      salt ??= loadOrCreateSalt();
      return createHash("sha256")
        .update(`callback-limit-v1:${salt}:${normalizedNumber}`)
        .digest("hex");
    },

    missingFiles() {
      if (dataDir && hasNumberHashes() && !loadCallbackSalt(dataDir)) {
        return [CALLBACK_SALT_FILE];
      }
      return [];
    },

    compact(now) {
      const kept = latestByOperation(records).filter((record) => isRelevantBookingRecord(record, now));
      const removed = records.length - kept.length;
      if (file) {
        rewriteJsonl(file, kept, 0o600);
      }
      records = kept;
      return { removed, kept: kept.length };
    },
  };
}
