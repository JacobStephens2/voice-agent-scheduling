import { computeWebhookSignature } from "../src/admission.js";
import type { StructuredCallEvidence } from "../src/evidence.js";

export const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldGZvcnNpZ25pbmd3ZWI=";

export function incomingCallPayload(options: {
  callId: string;
  callerNumber?: string;
  calledNumber?: string;
}): string {
  return JSON.stringify({
    object: "event",
    id: `evt_${options.callId}`,
    type: "realtime.call.incoming",
    created_at: 1_750_000_000,
    data: {
      call_id: options.callId,
      sip_headers: [
        { name: "From", value: options.callerNumber ?? "+15551234567" },
        { name: "To", value: options.calledNumber ?? "+18005550199" },
      ],
      metadata: {},
    },
  });
}

export function signedHeaders(
  rawBody: string,
  options: { webhookId: string; secret?: string; timestamp?: string } = {
    webhookId: "msg_1",
  },
): { id: string; timestamp: string; signature: string; rawBody: string } {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const secret = options.secret ?? WEBHOOK_SECRET;
  return {
    id: options.webhookId,
    timestamp,
    signature: computeWebhookSignature(secret, options.webhookId, timestamp, rawBody),
    rawBody,
  };
}

export async function recordedEvidence(
  listEvidence: () => readonly StructuredCallEvidence[],
  callId: string,
  timeoutMs = 1000,
): Promise<StructuredCallEvidence> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = listEvidence().find((entry) => entry.callId === callId);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for evidence ${callId}`);
}
