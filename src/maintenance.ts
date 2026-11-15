import { chmodSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppointmentLedger } from "./calendar/appointment-ledger.js";
import type { CallEvidence } from "./evidence.js";

export interface RetentionCleanupResult {
  readonly operationalRecordsRemoved: number;
  readonly operationalRecordsKept: number;
  readonly bookingRecordsRemoved: number;
  readonly bookingRecordsKept: number;
}

export function runRetentionCleanup(options: {
  readonly ledger: AppointmentLedger;
  readonly evidence: CallEvidence;
  readonly now?: Date;
}): RetentionCleanupResult {
  const now = options.now ?? new Date();
  const operational = options.evidence.compact(now);

  const compaction = options.ledger.compact(now);

  return {
    operationalRecordsRemoved: operational.removed,
    operationalRecordsKept: operational.kept,
    bookingRecordsRemoved: compaction.removed,
    bookingRecordsKept: compaction.kept,
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
