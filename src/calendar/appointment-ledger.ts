import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, loadJsonl, rewriteJsonl } from "../jsonl.js";
import { extractE164, isE164 } from "../phone.js";
import { appointmentEndMs } from "./policy.js";

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

export function isUnresolvedBookingStatus(
  status: BookingRecordStatus,
): status is "pending" | "inconclusive" {
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
    ...(fields.storedShape === undefined ? {} : { storedShape: fields.storedShape }),
  };
}

const BOOKING_RECORDS_FILE = "bookings.jsonl";
const CALLBACK_SALT_FILE = "callback-salt";

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
  /**
   * Append an outcome for an operation and return the stored record. Only
   * the record's own fields are stored, whatever else the caller passes.
   */
  record(fields: BookingRecordFields & { readonly status: BookingRecordStatus }): BookingRecord;
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
  unresolvedOperations(): Array<BookingRecord & { readonly status: "pending" | "inconclusive" }>;
  /**
   * Latest record of every operation that may hold an appointment for a
   * callback-number hash, excluding the committing operation's own records.
   */
  operationsHoldingAppointment(numberHash: string, excludeOperationId?: string): BookingRecord[];
  /** True when the ledger holds any record at all. */
  hasRecords(): boolean;
  /**
   * Hash a callback number with the data directory's salt. Equivalent
   * formats normalize to one E.164 number first, so they hash alike.
   * Undefined when the value is not a usable phone number.
   */
  hashCallbackNumber(callbackNumber: string): string | undefined;
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

/** Normalize a callback number so equivalent formats share one hash. */
function normalizeCallbackNumber(value: string): string | undefined {
  const normalized = extractE164(value);
  return isE164(normalized) ? normalized : undefined;
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
 * Reuse the data directory's salt, or write a new one while no stored
 * record carries a number hash. Hashes without their salt get the
 * unmatchable salt instead, so a restore that lost the salt never matches.
 */
function loadOrCreateSalt(dataDir: string, hashesStored: boolean): string {
  const existing = loadCallbackSalt(dataDir);
  if (existing) {
    return existing;
  }
  if (hashesStored) {
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
}

/**
 * Open the appointment ledger for a data directory, settling its
 * callback-number salt. Caller speech, names and raw numbers are never
 * stored. Without a data directory the records and salt live only in
 * memory, so the limit still holds for the life of the process.
 */
export function createAppointmentLedger(options: { readonly dataDir?: string } = {}): AppointmentLedger {
  const dataDir = options.dataDir;
  const file = dataDir ? join(dataDir, BOOKING_RECORDS_FILE) : undefined;
  let records: BookingRecord[] = file ? loadJsonl<BookingRecord>(file) : [];

  const hasNumberHashes = () => records.some((record) => typeof record.numberHash === "string");

  const salt = dataDir ? loadOrCreateSalt(dataDir, hasNumberHashes()) : randomBytes(16).toString("hex");

  const latestForOperation = (operationId: string): BookingRecord | undefined =>
    findLatest(records, (record) => record.operationId === operationId);

  const append = (record: BookingRecord): void => {
    if (file) {
      appendJsonl(file, record, 0o600);
    }
    records.push(record);
  };

  return {
    record(fields) {
      const record = bookingRecord(fields);
      append(record);
      return record;
    },

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
      return latestByOperation(records).filter(
        (record): record is BookingRecord & { readonly status: "pending" | "inconclusive" } =>
          isUnresolvedBookingStatus(record.status),
      );
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

    hashCallbackNumber(callbackNumber) {
      const normalized = normalizeCallbackNumber(callbackNumber);
      if (!normalized) {
        return undefined;
      }
      return createHash("sha256")
        .update(`callback-limit-v1:${salt}:${normalized}`)
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
