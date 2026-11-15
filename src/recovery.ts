import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGET_LEDGER_FILE,
  budgetLedgerFileState,
  createBudgetLedger,
  type BudgetLedgerOptions,
  type BudgetReserveResult,
  type BudgetSnapshot,
} from "./budget.js";
import type { AppointmentLedger } from "./calendar/appointment-ledger.js";
import type { CallEvidence } from "./evidence.js";
import { runRetentionCleanup } from "./maintenance.js";

export type RecoveryBlockReason = "recovery_pending" | "restored_state_incomplete";

export interface RecoveryAssessment {
  readonly admissionAvailable: boolean;
  readonly reason?: RecoveryBlockReason;
  readonly missing: readonly string[];
  readonly reconciliation: readonly { readonly status: string }[];
}

export interface CallRecoverySnapshot {
  readonly recovery: RecoveryAssessment;
  readonly budget: BudgetSnapshot;
  readonly recoveredStaleAdmissions: readonly string[];
}

export interface CallRecovery {
  beforeAdmission(): Promise<RecoveryAssessment>;
  reserve(callId: string): BudgetReserveResult;
  settle(callId: string, durationMs: number): number;
  snapshot(): CallRecoverySnapshot;
}

export interface CallRecoveryOptions {
  readonly dataDir?: string;
  readonly ledger: AppointmentLedger;
  readonly evidence: CallEvidence;
  readonly budget?: Omit<BudgetLedgerOptions, "dataDir">;
  readonly reconcile?: () => Promise<readonly { readonly status: string }[]>;
}

interface DurableIntegrity {
  readonly complete: boolean;
  readonly missing: readonly string[];
}

function inspectDurableIntegrity(options: {
  readonly dataDir: string;
  readonly ledger: AppointmentLedger;
  readonly evidence: CallEvidence;
}): DurableIntegrity {
  const { dataDir, ledger, evidence } = options;
  const missing = ledger.missingFiles();
  const budgetFile = budgetLedgerFileState(dataDir);
  // A failed read is not an empty month; never rebuild spend from evidence.
  if (
    budgetFile === "unusable" ||
    (budgetFile === "absent" && (ledger.hasRecords() || evidence.list().length > 0))
  ) {
    missing.push(BUDGET_LEDGER_FILE);
  }
  return { complete: missing.length === 0, missing };
}

async function assessRecovery(options: {
  readonly dataDir: string;
  readonly ledger: AppointmentLedger;
  readonly evidence: CallEvidence;
  readonly reconcile?: CallRecoveryOptions["reconcile"];
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
  return { admissionAvailable: true, missing: [], reconciliation };
}

const ACTIVE_CALL_FILE = "active-call.json";

function activeCallPath(dataDir: string): string {
  return join(dataDir, ACTIVE_CALL_FILE);
}

/** Durable one-caller claim so a restart can detect a stale admission. */
function writeActiveCallClaim(dataDir: string, callId: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      activeCallPath(dataDir),
      JSON.stringify({ callId, admittedAt: new Date().toISOString() }),
    );
  } catch {
    // Admission stays in memory when the claim cannot be persisted.
  }
}

function clearActiveCallClaim(dataDir: string, callId: string): void {
  try {
    const parsed = JSON.parse(readFileSync(activeCallPath(dataDir), "utf8")) as {
      callId?: unknown;
    };
    if (parsed.callId !== callId) {
      return;
    }
    unlinkSync(activeCallPath(dataDir));
  } catch {
    // Absent or unreadable claim means nothing to release.
  }
}

/** The old media session is gone; its budget reservation remains spent. */
function recoverStaleActiveCallClaim(dataDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(activeCallPath(dataDir), "utf8")) as {
      callId?: unknown;
    };
    unlinkSync(activeCallPath(dataDir));
    return typeof parsed.callId === "string" ? parsed.callId : undefined;
  } catch {
    return undefined;
  }
}

function copyAssessment(assessment: RecoveryAssessment): RecoveryAssessment {
  return {
    ...assessment,
    missing: [...assessment.missing],
    reconciliation: assessment.reconciliation.map((row) => ({ ...row })),
  };
}

/** Own startup readiness and durable usage accounting for Scheduling calls. */
export function createCallRecovery(options: CallRecoveryOptions): CallRecovery {
  const { dataDir, ledger, evidence } = options;
  const integrity = dataDir
    ? inspectDurableIntegrity({ dataDir, ledger, evidence })
    : { complete: true, missing: [] };
  const persistBudget =
    dataDir && (integrity.complete || !integrity.missing.includes(BUDGET_LEDGER_FILE));
  const budget = createBudgetLedger({
    ...options.budget,
    dataDir: persistBudget ? dataDir : undefined,
  });
  const recoveredStaleAdmissions: string[] = [];
  if (dataDir) {
    const staleClaim = recoverStaleActiveCallClaim(dataDir);
    if (staleClaim) {
      recoveredStaleAdmissions.push(staleClaim);
    }
    if (integrity.complete) {
      runRetentionCleanup({ ledger, evidence, now: options.budget?.now?.() });
    }
  }

  let recovery: RecoveryAssessment = {
    admissionAvailable: true,
    missing: [],
    reconciliation: [],
  };
  type StartupResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  let ready: Promise<StartupResult> = Promise.resolve({ ok: true });
  const runAssessment = () =>
    dataDir
      ? assessRecovery({ dataDir, ledger, evidence, reconcile: options.reconcile })
      : Promise.resolve(recovery);

  if (dataDir) {
    if (!integrity.complete) {
      recovery = {
        admissionAvailable: false,
        reason: "restored_state_incomplete",
        missing: integrity.missing,
        reconciliation: [],
      };
    } else if (ledger.unresolvedOperations().length > 0) {
      recovery = {
        admissionAvailable: false,
        reason: "recovery_pending",
        missing: [],
        reconciliation: [],
      };
      // Attach both handlers eagerly, retaining failures for readiness to rethrow.
      ready = runAssessment().then(
        (result): StartupResult => {
          recovery = result;
          return { ok: true };
        },
        (error: unknown): StartupResult => ({ ok: false, error }),
      );
    }
  }

  return {
    async beforeAdmission() {
      const startup = await ready;
      if (!startup.ok) {
        throw startup.error;
      }
      if (recovery.reason === "recovery_pending") {
        recovery = await runAssessment();
      }
      return copyAssessment(recovery);
    },
    reserve(callId) {
      const result = budget.tryReserve(callId);
      if (result.admitted && dataDir) {
        writeActiveCallClaim(dataDir, callId);
      }
      return result;
    },
    settle(callId, durationMs) {
      if (dataDir) {
        clearActiveCallClaim(dataDir, callId);
      }
      return budget.settle(callId, durationMs);
    },
    snapshot() {
      return {
        recovery: copyAssessment(recovery),
        budget: budget.snapshot(),
        recoveredStaleAdmissions: [...recoveredStaleAdmissions],
      };
    },
  };
}
