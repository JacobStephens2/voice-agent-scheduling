import WebSocket from "ws";
import {
  createIncomingCallAdmission,
  type AdmissionRejectionReason,
  type IncomingCallAdmission,
  type SignedWebhook,
} from "./admission.js";
import {
  estimateCostMicroUsd,
  loadEvidence,
  maskPhoneNumber,
  persistEvidence,
  type StructuredCallEvidence,
} from "./evidence.js";
import {
  createTelephoneSession,
  type ConnectWebSocket,
  type RealtimeSocket,
  type SessionOutcome,
} from "./session.js";
import type { SyntheticAvailabilityTool } from "./synthetic-calendar.js";

export interface WebhookResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface CallLifecycleManager {
  handleWebhook(input: SignedWebhook): Promise<WebhookResponse>;
  waitForEvidence(callId: string, timeoutMs?: number): Promise<StructuredCallEvidence | undefined>;
  listEvidence(): readonly StructuredCallEvidence[];
  activeCallCount(): number;
}

export interface CallLifecycleManagerOptions {
  readonly webhookSecret: string;
  readonly apiKey: string;
  readonly availabilityTool: SyntheticAvailabilityTool;
  readonly maxConcurrentCalls?: number;
  readonly allowedCallerNumbers?: readonly string[];
  readonly connectWebSocket?: ConnectWebSocket;
  readonly hangupCall?: (callId: string) => Promise<void>;
  readonly maxCallDurationMs?: number;
  readonly dataDir?: string;
  readonly referenceTime?: Date;
}

const REJECTION_STATUS: Record<AdmissionRejectionReason, number> = {
  invalid_signature: 401,
  timestamp_out_of_range: 401,
  unauthorized_caller: 403,
  duplicate_delivery: 409,
  concurrency_limit_reached: 429,
  invalid_payload: 400,
};

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
  const evidenceByCall = new Map<string, StructuredCallEvidence>();
  if (options.dataDir) {
    for (const evidence of loadEvidence(options.dataDir)) {
      evidenceByCall.set(evidence.callId, evidence);
    }
  }
  const waiters = new Map<string, Array<(evidence: StructuredCallEvidence) => void>>();

  const record = (evidence: StructuredCallEvidence) => {
    evidenceByCall.set(evidence.callId, evidence);
    if (options.dataDir) {
      persistEvidence(options.dataDir, evidence);
    }
    const resolvers = waiters.get(evidence.callId) ?? [];
    waiters.delete(evidence.callId);
    for (const resolve of resolvers) {
      resolve(evidence);
    }
  };

  const onOutcome = (
    callId: string,
    callerNumber: string,
    calledNumber: string,
    outcome: SessionOutcome,
  ) => {
    admission.release(callId);
    record({
      callId,
      connectionRoute: "direct_sip",
      callerNumberMasked: maskPhoneNumber(callerNumber),
      calledNumber,
      status: outcome.status,
      durationMs: outcome.durationMs,
      modelVerified: outcome.modelVerified,
      reasoningVerified: outcome.reasoningVerified,
      toolRoundTrips: outcome.toolRoundTrips,
      estimatedCostMicroUsd: estimateCostMicroUsd(outcome.durationMs),
      error: outcome.error,
      recordedAt: new Date().toISOString(),
    });
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
        return {
          statusCode: REJECTION_STATUS[result.reason],
          body: JSON.stringify({ error: result.reason }),
        };
      }

      const session = createTelephoneSession({
        callId: result.callId,
        apiKey: options.apiKey,
        availabilityTool: options.availabilityTool,
        connectWebSocket,
        hangupCall,
        maxDurationMs: options.maxCallDurationMs,
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
            error: `Coordinator unhandled error: ${error instanceof Error ? error.message : String(error)}`,
          });
        });

      return {
        statusCode: 200,
        body: JSON.stringify({ status: "admitted", call_id: result.callId }),
      };
    },

    waitForEvidence(callId, timeoutMs = 10_000) {
      const existing = evidenceByCall.get(callId);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const waiting = waiters.get(callId) ?? [];
          waiters.set(
            callId,
            waiting.filter((waiter) => waiter !== onEvidence),
          );
          resolve(evidenceByCall.get(callId));
        }, timeoutMs);
        const onEvidence = (evidence: StructuredCallEvidence) => {
          clearTimeout(timer);
          resolve(evidence);
        };
        waiters.set(callId, [...(waiters.get(callId) ?? []), onEvidence]);
      });
    },

    listEvidence() {
      return [...evidenceByCall.values()];
    },

    activeCallCount() {
      return admission.activeCallCount();
    },
  };
}
