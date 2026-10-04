import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import {
  createIncomingCallAdmission,
  type AdmissionRejectionReason,
  type IncomingCallAdmission,
  type SignedWebhook,
} from "./admission.js";
import {
  DIRECT_SIP_MICRO_USD_PER_MINUTE,
  DURATION_WARNING_LEAD_MS_DEFAULT,
  MAX_CALL_DURATION_MS_DEFAULT,
  createBudgetLedger,
  type BudgetBlockReason,
  type BudgetLedger,
  type BudgetSnapshot,
} from "./budget.js";
import {
  DIRECT_SIP_ROUTE,
  boundedErrorCategory,
  estimateCostMicroUsd,
  loadEvidence,
  maskPhoneNumber,
  persistEvidence,
  type StructuredCallEvidence,
} from "./evidence.js";
import {
  BUDGET_LEDGER_FILE,
  assessRecovery,
  inspectDurableIntegrity,
  runRetentionCleanup,
  type RecoveryAssessment,
  type RecoveryBlockReason,
} from "./maintenance.js";
import { createAppointmentLedger, type AppointmentLedger } from "./calendar/appointment-ledger.js";
import {
  createTelephoneSession,
  type AvailabilityTool,
  type BookingTool,
  type ConnectWebSocket,
  type RealtimeSocket,
  type SessionOutcome,
} from "./session.js";

export interface WebhookResponse {
  readonly statusCode: number;
  readonly body: string;
}

export type OperatorPauseReason = "operator_paused";

export type AdmissionsPauseReason =
  | BudgetBlockReason
  | RecoveryBlockReason
  | OperatorPauseReason;

export type WebhookRejectionReason =
  | AdmissionRejectionReason
  | BudgetBlockReason
  | RecoveryBlockReason
  | OperatorPauseReason;

export interface AdmissionsStatus {
  readonly paused: boolean;
  readonly reason?: AdmissionsPauseReason;
}

export interface CallLifecycleManager {
  handleWebhook(input: SignedWebhook): Promise<WebhookResponse>;
  listEvidence(): readonly StructuredCallEvidence[];
  activeCallCount(): number;
  budgetSnapshot(): BudgetSnapshot;
  recoveredStaleAdmissions(): readonly string[];
  recoveryStatus(): RecoveryAssessment;
  reloadDurableViews(): void;
  pauseAdmissions(): AdmissionsStatus;
  resumeAdmissions(): AdmissionsStatus;
  admissionsStatus(): AdmissionsStatus;
}

export interface CallLifecycleManagerOptions {
  readonly webhookSecret: string;
  readonly apiKey: string;
  readonly availabilityTool: AvailabilityTool;
  readonly booking?: BookingTool;
  /**
   * The process's shared appointment ledger, the same instance the booking
   * tool writes. Built from `dataDir` when absent.
   */
  readonly ledger?: AppointmentLedger;
  readonly maxConcurrentCalls?: number;
  readonly allowedCallerNumbers?: readonly string[];
  readonly connectWebSocket?: ConnectWebSocket;
  readonly hangupCall?: (callId: string) => Promise<void>;
  readonly maxCallDurationMs?: number;
  readonly warningLeadMs?: number;
  readonly dataDir?: string;
  readonly referenceTime?: Date;
  readonly monthlyTargetMicroUsd?: number;
  readonly fixedMonthlyMicroUsd?: number;
  readonly perMinuteMicroUsd?: number;
  readonly reserveMargin?: number;
  readonly now?: () => Date;
  readonly pauseAdmissions?: boolean;
}

const REJECTION_STATUS: Record<WebhookRejectionReason, number> = {
  invalid_signature: 401,
  timestamp_out_of_range: 401,
  unauthorized_caller: 403,
  duplicate_delivery: 409,
  concurrency_limit_reached: 429,
  invalid_payload: 400,
  budget_exhausted: 503,
  budget_unavailable: 503,
  recovery_pending: 503,
  restored_state_incomplete: 503,
  operator_paused: 503,
};

const ACTIVE_CALL_FILE = "active-call.json";
const ADMISSION_PAUSE_FILE = "admission-pause.json";

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
    const raw = readFileSync(activeCallPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as { callId?: unknown };
    if (parsed.callId !== callId) {
      return;
    }
    unlinkSync(activeCallPath(dataDir));
  } catch {
    // Absent or unreadable claim means nothing to release.
  }
}

function admissionPausePath(dataDir: string): string {
  return join(dataDir, ADMISSION_PAUSE_FILE);
}

function loadOperatorPause(dataDir: string | undefined): boolean {
  if (!dataDir) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(admissionPausePath(dataDir), "utf8")) as {
      paused?: unknown;
    };
    return parsed.paused === true;
  } catch {
    return false;
  }
}

function persistOperatorPause(dataDir: string | undefined, paused: boolean): void {
  if (!dataDir) {
    return;
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      admissionPausePath(dataDir),
      `${JSON.stringify({ paused, updatedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // In-memory pause still applies when the file cannot be written.
  }
}

/**
 * Recover a claim left by a process that died mid-call. The previous media
 * session is gone with its process, so the slot is freed; the budget ledger
 * conservatively counts its reservation as spent (see createBudgetLedger).
 */
function recoverStaleActiveCallClaim(dataDir: string): string | undefined {
  try {
    const raw = readFileSync(activeCallPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as { callId?: unknown };
    unlinkSync(activeCallPath(dataDir));
    return typeof parsed.callId === "string" ? parsed.callId : undefined;
  } catch {
    return undefined;
  }
}

function defaultConnectWebSocket(
  url: string,
  headers: Record<string, string>,
): RealtimeSocket {
  const socket = new WebSocket(url, { headers });
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    on(event, listener) {
      socket.on(event, (...args: unknown[]) => listener(...args));
    },
  };
}

function defaultHangupCall(apiKey: string): (callId: string) => Promise<void> {
  return async (callId: string) => {
    try {
      await fetch(`https://api.x.ai/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      // Hangup is best-effort; evidence still records the outcome.
    }
  };
}

export function createCallLifecycleManager(
  options: CallLifecycleManagerOptions,
): CallLifecycleManager {
  const admission: IncomingCallAdmission = createIncomingCallAdmission({
    webhookSecret: options.webhookSecret,
    maxConcurrentCalls: options.maxConcurrentCalls ?? 1,
    allowedCallerNumbers: options.allowedCallerNumbers,
  });
  const connectWebSocket = options.connectWebSocket ?? defaultConnectWebSocket;
  const hangupCall = options.hangupCall ?? defaultHangupCall(options.apiKey);
  const maxCallDurationMs = options.maxCallDurationMs ?? MAX_CALL_DURATION_MS_DEFAULT;
  const warningLeadMs = options.warningLeadMs ?? DURATION_WARNING_LEAD_MS_DEFAULT;
  const perMinuteMicroUsd = options.perMinuteMicroUsd ?? DIRECT_SIP_MICRO_USD_PER_MINUTE;
  const ledger = options.ledger ?? createAppointmentLedger({ dataDir: options.dataDir });
  const integrity = options.dataDir
    ? inspectDurableIntegrity({ dataDir: options.dataDir, ledger })
    : { complete: true, missing: [] as const };
  const persistBudget =
    Boolean(options.dataDir) &&
    (integrity.complete || !integrity.missing.includes(BUDGET_LEDGER_FILE));
  const budget: BudgetLedger = createBudgetLedger({
    dataDir: persistBudget ? options.dataDir : undefined,
    monthlyTargetMicroUsd: options.monthlyTargetMicroUsd,
    fixedMonthlyMicroUsd: options.fixedMonthlyMicroUsd,
    perMinuteMicroUsd: options.perMinuteMicroUsd,
    reserveMargin: options.reserveMargin,
    maxCallDurationMs,
    now: options.now,
  });
  let operatorPaused = loadOperatorPause(options.dataDir);
  if (options.pauseAdmissions === true) {
    operatorPaused = true;
    persistOperatorPause(options.dataDir, true);
  }
  const staleAdmissions: string[] = [];
  if (options.dataDir) {
    const staleClaim = recoverStaleActiveCallClaim(options.dataDir);
    if (staleClaim) {
      staleAdmissions.push(staleClaim);
    }
    if (integrity.complete) {
      runRetentionCleanup({ dataDir: options.dataDir, ledger, now: options.now?.() });
    }
  }
  const evidenceByCall = new Map<string, StructuredCallEvidence>();
  const reloadEvidence = () => {
    evidenceByCall.clear();
    if (!options.dataDir) {
      return;
    }
    for (const evidence of loadEvidence(options.dataDir)) {
      evidenceByCall.set(evidence.callId, evidence);
    }
  };
  reloadEvidence();
  const availableRecovery = (): RecoveryAssessment => ({
    admissionAvailable: true,
    missing: [],
    reconciliation: [],
  });
  const runAssess = () =>
    options.dataDir
      ? assessRecovery({
          dataDir: options.dataDir,
          ledger,
          reconcile: options.booking?.reconcileUnresolvedOperations
            ? () => options.booking!.reconcileUnresolvedOperations!()
            : undefined,
        })
      : Promise.resolve(availableRecovery());
  let recovery: RecoveryAssessment = availableRecovery();
  let recoveryReady = Promise.resolve();
  if (options.dataDir) {
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
      recoveryReady = runAssess().then((result) => {
        recovery = result;
      });
    }
  }
  const record = (evidence: StructuredCallEvidence) => {
    evidenceByCall.set(evidence.callId, evidence);
    if (options.dataDir) {
      persistEvidence(options.dataDir, evidence);
    }
  };

  const onOutcome = (
    callId: string,
    callerNumber: string,
    calledNumber: string,
    outcome: SessionOutcome,
  ) => {
    admission.release(callId);
    if (options.dataDir) {
      clearActiveCallClaim(options.dataDir, callId);
    }
    budget.settle(callId, outcome.durationMs);
    const error = boundedErrorCategory(outcome.error);
    record({
      callId,
      connectionRoute: DIRECT_SIP_ROUTE,
      callerNumberMasked: maskPhoneNumber(callerNumber),
      calledNumber,
      status: outcome.status,
      durationMs: outcome.durationMs,
      modelVerified: outcome.modelVerified,
      reasoningVerified: outcome.reasoningVerified,
      toolRoundTrips: outcome.toolRoundTrips,
      estimatedCostMicroUsd: estimateCostMicroUsd(outcome.durationMs, perMinuteMicroUsd),
      durationWarningSent: outcome.durationWarningSent,
      ...(error ? { error } : {}),
      recordedAt: new Date().toISOString(),
    });
  };

  const admissionsStatus = (): AdmissionsStatus => {
    if (!recovery.admissionAvailable && recovery.reason) {
      return { paused: true, reason: recovery.reason };
    }
    if (operatorPaused) {
      return { paused: true, reason: "operator_paused" };
    }
    const snapshot = budget.snapshot();
    if (snapshot.admissionsPaused) {
      return { paused: true, reason: snapshot.pauseReason };
    }
    return { paused: false };
  };

  return {
    async handleWebhook(input: SignedWebhook): Promise<WebhookResponse> {
      const result = admission.admit(input);
      if (!result.admitted) {
        if (
          result.callId &&
          (result.reason === "unauthorized_caller" ||
            result.reason === "concurrency_limit_reached")
        ) {
          void hangupCall(result.callId);
        }
        if (operatorPaused && result.reason === "concurrency_limit_reached") {
          return {
            statusCode: REJECTION_STATUS.operator_paused,
            body: JSON.stringify({ error: "operator_paused" }),
          };
        }
        return {
          statusCode: REJECTION_STATUS[result.reason],
          body: JSON.stringify({ error: result.reason }),
        };
      }

      await recoveryReady;
      if (!recovery.admissionAvailable && recovery.reason === "recovery_pending") {
        recovery = await runAssess();
      }
      if (!recovery.admissionAvailable && recovery.reason) {
        admission.release(result.callId);
        void hangupCall(result.callId);
        return {
          statusCode: REJECTION_STATUS[recovery.reason],
          body: JSON.stringify({ error: recovery.reason }),
        };
      }

      if (operatorPaused) {
        admission.release(result.callId);
        void hangupCall(result.callId);
        return {
          statusCode: REJECTION_STATUS.operator_paused,
          body: JSON.stringify({ error: "operator_paused" }),
        };
      }

      const reservation = budget.tryReserve(result.callId);
      if (!reservation.admitted) {
        admission.release(result.callId);
        void hangupCall(result.callId);
        return {
          statusCode: REJECTION_STATUS[reservation.reason],
          body: JSON.stringify({ error: reservation.reason }),
        };
      }
      if (options.dataDir) {
        writeActiveCallClaim(options.dataDir, result.callId);
      }

      const session = createTelephoneSession({
        callId: result.callId,
        apiKey: options.apiKey,
        availabilityTool: options.availabilityTool,
        booking: options.booking,
        connectWebSocket,
        hangupCall,
        maxDurationMs: maxCallDurationMs,
        warningLeadMs,
        referenceTime: options.referenceTime,
      });

      void session
        .start()
        .then((outcome) => {
          onOutcome(result.callId, result.callerNumber, result.calledNumber, outcome);
        })
        .catch((error: unknown) => {
          onOutcome(result.callId, result.callerNumber, result.calledNumber, {
            callId: result.callId,
            status: "failed",
            toolRoundTrips: 0,
            durationMs: 0,
            durationWarningSent: false,
            error: `Coordinator unhandled error: ${error instanceof Error ? error.message : String(error)}`,
          });
        });

      return {
        statusCode: 200,
        body: JSON.stringify({ status: "admitted", call_id: result.callId }),
      };
    },

    listEvidence() {
      return [...evidenceByCall.values()];
    },

    activeCallCount() {
      return admission.activeCallCount();
    },

    budgetSnapshot() {
      return budget.snapshot();
    },

    recoveredStaleAdmissions() {
      return [...staleAdmissions];
    },

    recoveryStatus() {
      return recovery;
    },

    reloadDurableViews() {
      reloadEvidence();
      if (options.dataDir) {
        operatorPaused = loadOperatorPause(options.dataDir);
      }
    },

    pauseAdmissions() {
      operatorPaused = true;
      persistOperatorPause(options.dataDir, true);
      return admissionsStatus();
    },

    resumeAdmissions() {
      operatorPaused = false;
      persistOperatorPause(options.dataDir, false);
      return admissionsStatus();
    },

    admissionsStatus,
  };
}
