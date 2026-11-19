import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import {
  createIncomingCallAdmission,
  type AdmissionRejectionReason,
  type AdmissionResult,
  type IncomingCallAdmission,
  type SignedWebhook,
} from "./admission.js";
import {
  DURATION_WARNING_LEAD_MS_DEFAULT,
  MAX_CALL_DURATION_MS_DEFAULT,
  type BudgetBlockReason,
  type BudgetSnapshot,
} from "./budget.js";
import {
  createCallEvidence,
  type CallEvidence,
  type StructuredCallEvidence,
} from "./evidence.js";
import {
  createCallRecovery,
  type RecoveryAssessment,
  type RecoveryBlockReason,
} from "./recovery.js";
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
  reloadOperatorPause(): void;
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
  /** The same Scheduling call evidence owner used by maintenance. */
  readonly evidence?: CallEvidence;
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

function rejectWebhook(reason: WebhookRejectionReason): WebhookResponse {
  return { statusCode: REJECTION_STATUS[reason], body: JSON.stringify({ error: reason }) };
}

const ADMISSION_PAUSE_FILE = "admission-pause.json";

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
    await fetch(`https://api.x.ai/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
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
  const requestProviderHangup = options.hangupCall ?? defaultHangupCall(options.apiKey);
  const hangupCall = async (callId: string): Promise<void> => {
    try {
      await requestProviderHangup(callId);
    } catch {
      // Hangup is best-effort. Local cleanup continues.
    }
  };
  const maxCallDurationMs = options.maxCallDurationMs ?? MAX_CALL_DURATION_MS_DEFAULT;
  const warningLeadMs = options.warningLeadMs ?? DURATION_WARNING_LEAD_MS_DEFAULT;
  const ledger = options.ledger ?? createAppointmentLedger({ dataDir: options.dataDir });
  const evidence = options.evidence ?? createCallEvidence({
    dataDir: options.dataDir,
    perMinuteMicroUsd: options.perMinuteMicroUsd,
  });
  const recovery = createCallRecovery({
    dataDir: options.dataDir,
    ledger,
    evidence,
    budget: {
      monthlyTargetMicroUsd: options.monthlyTargetMicroUsd,
      fixedMonthlyMicroUsd: options.fixedMonthlyMicroUsd,
      perMinuteMicroUsd: options.perMinuteMicroUsd,
      reserveMargin: options.reserveMargin,
      maxCallDurationMs,
      now: options.now,
    },
    reconcile: options.booking?.reconcileUnresolvedOperations
      ? () => options.booking!.reconcileUnresolvedOperations!()
      : undefined,
  });
  let operatorPaused = loadOperatorPause(options.dataDir);
  if (options.pauseAdmissions === true) {
    operatorPaused = true;
    persistOperatorPause(options.dataDir, true);
  }
  async function runAdmittedSession(
    session: ReturnType<typeof createTelephoneSession>,
    allocation: Extract<AdmissionResult, { admitted: true }>,
  ): Promise<void> {
    let outcome: SessionOutcome;
    try {
      outcome = await session.start();
    } catch {
      outcome = {
        callId: allocation.callId,
        status: "failed",
        toolRoundTrips: 0,
        durationMs: 0,
        durationWarningSent: false,
        error: "Coordinator unhandled error",
      };
    }

    allocation.release();
    try {
      recovery.settle(allocation.callId, outcome.durationMs);
      evidence.record(outcome, allocation);
    } catch {
      // Make a single settlement attempt. Recovery accounts for any
      // outstanding durable reservation after a restart.
    }
  }

  const admissionsStatus = (): AdmissionsStatus => {
    const snapshot = recovery.snapshot();
    if (!snapshot.recovery.admissionAvailable && snapshot.recovery.reason) {
      return { paused: true, reason: snapshot.recovery.reason };
    }
    if (operatorPaused) {
      return { paused: true, reason: "operator_paused" };
    }
    if (snapshot.budget.admissionsPaused) {
      return { paused: true, reason: snapshot.budget.pauseReason };
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
          return rejectWebhook("operator_paused");
        }
        return rejectWebhook(result.reason);
      }

      let handedOff = false;
      try {
        const readiness = await recovery.beforeAdmission();
        if (!readiness.admissionAvailable && readiness.reason) {
          return rejectWebhook(readiness.reason);
        }

        if (operatorPaused) {
          return rejectWebhook("operator_paused");
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
        const reservation = recovery.reserve(result.callId);
        if (!reservation.admitted) {
          return rejectWebhook(reservation.reason);
        }

        handedOff = true;
        void runAdmittedSession(session, result);

        return {
          statusCode: 200,
          body: JSON.stringify({ status: "admitted", call_id: result.callId }),
        };
      } finally {
        if (!handedOff) {
          result.release();
          void hangupCall(result.callId);
        }
      }
    },

    listEvidence() {
      return evidence.list();
    },

    activeCallCount() {
      return admission.activeCallCount();
    },

    budgetSnapshot() {
      return recovery.snapshot().budget;
    },

    recoveredStaleAdmissions() {
      return recovery.snapshot().recoveredStaleAdmissions;
    },

    recoveryStatus() {
      return recovery.snapshot().recovery;
    },

    reloadOperatorPause() {
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
