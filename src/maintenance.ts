import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CALLBACK_SALT_FILE, type AppointmentLedger } from "./calendar/appointment-ledger.js";
import {
  OPERATIONAL_RETENTION_MS,
  isRetainedOperationalRecord,
  loadEvidence,
  replaceEvidence,
} from "./evidence.js";

export { CALLBACK_SALT_FILE, OPERATIONAL_RETENTION_MS };

export const BUDGET_LEDGER_FILE = "budget-ledger.json";

export type RecoveryBlockReason = "recovery_pending" | "restored_state_incomplete";

export interface RetentionCleanupResult {
  readonly operationalRecordsRemoved: number;
  readonly operationalRecordsKept: number;
  readonly bookingRecordsRemoved: number;
  readonly bookingRecordsKept: number;
}

export interface DurableIntegrity {
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export interface RecoveryAssessment {
  readonly admissionAvailable: boolean;
  readonly reason?: RecoveryBlockReason;
  readonly missing: readonly string[];
  readonly reconciliation: readonly { readonly status: string }[];
}

export function inspectDurableIntegrity(options: {
  readonly dataDir: string;
  readonly ledger: AppointmentLedger;
}): DurableIntegrity {
  const { dataDir, ledger } = options;
  const missing = ledger.missingFiles();
  const evidence = loadEvidence(dataDir);
  if ((ledger.hasRecords() || evidence.length > 0) && !existsSync(join(dataDir, BUDGET_LEDGER_FILE))) {
    missing.push(BUDGET_LEDGER_FILE);
  }
  return { complete: missing.length === 0, missing };
}

export function runRetentionCleanup(options: {
  readonly dataDir: string;
  readonly ledger: AppointmentLedger;
  readonly now?: Date;
}): RetentionCleanupResult {
  const now = options.now ?? new Date();
  const operational = loadEvidence(options.dataDir);
  const keptOperational = operational.filter((record) => isRetainedOperationalRecord(record, now));
  replaceEvidence(options.dataDir, keptOperational);

  const bookings = options.ledger.compact(now);

  return {
    operationalRecordsRemoved: operational.length - keptOperational.length,
    operationalRecordsKept: keptOperational.length,
    bookingRecordsRemoved: bookings.removed,
    bookingRecordsKept: bookings.kept,
  };
}

export async function assessRecovery(options: {
  readonly dataDir: string;
  readonly ledger: AppointmentLedger;
  readonly reconcile?: () => Promise<readonly { readonly status: string }[]>;
}): Promise<RecoveryAssessment> {
  const integrity = inspectDurableIntegrity(options);
  if (!integrity.complete) {
    return {
      admissionAvailable: false,
      reason: "restored_state_incomplete",
      missing: integrity.missing,
      reconciliation: [],
    };
  }
  const reconciliation = options.reconcile ? [...(await options.reconcile())] : [];
  if (reconciliation.some((row) => row.status === "unresolved")) {
    return {
      admissionAvailable: false,
      reason: "recovery_pending",
      missing: [],
      reconciliation,
    };
  }
  return {
    admissionAvailable: true,
    missing: [],
    reconciliation,
  };
}

/**
 * Copy durable scheduling files onto an isolated target. Calendar events are
 * not in this directory and are never created or deleted here. Restoring an
 * incomplete set leaves admission paused until the missing files return.
 */
export function restoreDurableState(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const from = join(sourceDir, entry.name);
    const to = join(targetDir, entry.name);
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
}
