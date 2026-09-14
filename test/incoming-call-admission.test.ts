import { describe, expect, it } from "vitest";
import { createIncomingCallAdmission } from "../src/admission.js";
import {
  WEBHOOK_SECRET,
  incomingCallPayload,
  signedHeaders,
} from "./helpers.js";

describe("incoming call admission", () => {
  it("admits a valid signed incoming call within the concurrency limit", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15551234567"],
    });
    const payload = incomingCallPayload({ callId: "call-1" });

    const result = admission.admit(signedHeaders(payload, { webhookId: "msg_1" }));

    expect(result).toEqual({
      admitted: true,
      callId: "call-1",
      callerNumber: "+15551234567",
      calledNumber: "+18005550199",
    });
  });

  it("rejects an invalid webhook signature", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
    });
    const payload = incomingCallPayload({ callId: "call-bad-sig" });
    const signed = signedHeaders(payload, { webhookId: "msg_bad" });

    const result = admission.admit({ ...signed, signature: "v1,invalidsignature==" });

    expect(result).toEqual({ admitted: false, reason: "invalid_signature" });
  });

  it("rejects a replay of the same webhook id or an already-active call id", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 2,
    });
    const payload = incomingCallPayload({ callId: "call-dup" });
    const first = signedHeaders(payload, { webhookId: "msg_dup_1" });

    expect(admission.admit(first).admitted).toBe(true);
    expect(admission.admit(first)).toEqual({
      admitted: false,
      reason: "duplicate_delivery",
    });

    const second = signedHeaders(payload, { webhookId: "msg_dup_2" });
    expect(admission.admit(second)).toEqual({
      admitted: false,
      reason: "duplicate_delivery",
    });
  });

  it("rejects a second caller while one scheduling call is active, then admits after release", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
    });
    const firstPayload = incomingCallPayload({ callId: "call-a" });
    const secondPayload = incomingCallPayload({
      callId: "call-b",
      callerNumber: "+15559876543",
    });

    expect(
      admission.admit(signedHeaders(firstPayload, { webhookId: "msg_a" })).admitted,
    ).toBe(true);

    expect(admission.admit(signedHeaders(secondPayload, { webhookId: "msg_b" }))).toEqual({
      admitted: false,
      reason: "concurrency_limit_reached",
      callId: "call-b",
    });

    admission.release("call-a");
    expect(admission.activeCallCount()).toBe(0);
    expect(
      admission.admit(signedHeaders(secondPayload, { webhookId: "msg_b2" })),
    ).toEqual({
      admitted: true,
      callId: "call-b",
      callerNumber: "+15559876543",
      calledNumber: "+18005550199",
    });
  });

  it("rejects a webhook whose timestamp is outside the tolerance window", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      nowSeconds: () => 1_800_000_000,
    });
    const payload = incomingCallPayload({ callId: "call-stale" });

    expect(
      admission.admit(
        signedHeaders(payload, { webhookId: "msg_stale", timestamp: "1000" }),
      ),
    ).toEqual({ admitted: false, reason: "timestamp_out_of_range" });
  });

  it("admits the allowlisted caller when From is a SIP URI or national number", () => {
    for (const [label, from] of [
      ["sip-uri", "<sip:+15555550177@sip.telnyx.com>"],
      ["national", "5555550177"],
      ["pretty", "+1 (555) 555-0177"],
      ["eleven-digit", "15555550177"],
    ] as const) {
      const admission = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+15555550177"],
      });
      const payload = incomingCallPayload({
        callId: `call-${label}`,
        callerNumber: from,
      });
      const result = admission.admit(signedHeaders(payload, { webhookId: `msg_${label}` }));
      expect(result, label).toEqual({
        admitted: true,
        callId: `call-${label}`,
        callerNumber: "+15555550177",
        calledNumber: "+18005550199",
      });
    }
  });

  it("rejects callers outside the smoke-mode allowlist", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
    });
    const payload = incomingCallPayload({ callId: "call-unauth" });

    expect(admission.admit(signedHeaders(payload, { webhookId: "msg_unauth" }))).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-unauth",
    });
  });
});

