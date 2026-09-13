import { computeWebhookSignature } from "../src/admission.js";

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

export function signWebhook(
  secret: string,
  webhookId: string,
  timestamp: string,
  rawBody: string,
): string {
  return computeWebhookSignature(secret, webhookId, timestamp, rawBody);
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
    signature: signWebhook(secret, options.webhookId, timestamp, rawBody),
    rawBody,
  };
}
