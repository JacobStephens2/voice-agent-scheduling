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

  it("uses the sip or sips From user for the allowlist, not a display-name number", () => {
    for (const [label, from] of [
      ["sip", '"+15550001111" <sip:+19995550000@sip.telnyx.com>'],
      ["sips", '"+15550001111" <sips:+19995550000@sip.telnyx.com>'],
      [
        "quoted-sip",
        '"<sip:+15550001111@evil.example>" <sip:+19995550000@sip.telnyx.com>',
      ],
    ] as const) {
      const displayNameAllowlist = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+15550001111"],
      });
      expect(
        displayNameAllowlist.admit(
          signedHeaders(
            incomingCallPayload({ callId: `call-${label}-display`, callerNumber: from }),
            { webhookId: `msg_${label}_display` },
          ),
        ),
        label,
      ).toEqual({
        admitted: false,
        reason: "unauthorized_caller",
        callId: `call-${label}-display`,
      });

      const sipUserAllowlist = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+19995550000"],
      });
      expect(
        sipUserAllowlist.admit(
          signedHeaders(
            incomingCallPayload({ callId: `call-${label}-user`, callerNumber: from }),
            { webhookId: `msg_${label}_user` },
          ),
        ),
        label,
      ).toEqual({
        admitted: true,
        callId: `call-${label}-user`,
        callerNumber: "+19995550000",
        calledNumber: "+18005550199",
      });
    }
  });

  it("uses an unbracketed sip user, not a later plus-digit run", () => {
    const from = "sip:5555550177@sip.telnyx.com;tag=+15550001111";
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
    });
    expect(
      admission.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-addr-spec", callerNumber: from }),
          { webhookId: "msg_addr_spec" },
        ),
      ),
    ).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-addr-spec",
    });
  });

  it("uses a later sip angle-addr when an earlier angle is not sip or sips", () => {
    const from = "sip:5555550177@evil.example <x> <sip:+19995550000@sip.telnyx.com>";
    const rejected = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15555550177"],
    });
    expect(
      rejected.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-later-angle-reject", callerNumber: from }),
          { webhookId: "msg_later_angle_reject" },
        ),
      ),
    ).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-later-angle-reject",
    });

    const admitted = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+19995550000"],
    });
    expect(
      admitted.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-later-angle-admit", callerNumber: from }),
          { webhookId: "msg_later_angle_admit" },
        ),
      ),
    ).toEqual({
      admitted: true,
      callId: "call-later-angle-admit",
      callerNumber: "+19995550000",
      calledNumber: "+18005550199",
    });
  });

  it("uses the tel From URI for the allowlist, not a display-name number", () => {
    const from = '"+15550001111" <tel:5555550177>';
    const displayNameAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
    });
    expect(
      displayNameAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-tel-display", callerNumber: from }),
          { webhookId: "msg_tel_display" },
        ),
      ),
    ).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-tel-display",
    });

    const telAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15555550177"],
    });
    expect(
      telAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-tel-uri", callerNumber: from }),
          { webhookId: "msg_tel_uri" },
        ),
      ),
    ).toEqual({
      admitted: true,
      callId: "call-tel-uri",
      callerNumber: "+15555550177",
      calledNumber: "+18005550199",
    });
  });

  it("does not take an allowlisted tel URI from an unclosed display-name quote", () => {
    const from = '"<tel:+15550001111> <sip:+19995550000@sip.telnyx.com>';
    const displayNameAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
    });
    expect(
      displayNameAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-unclosed-tel-quote", callerNumber: from }),
          { webhookId: "msg_unclosed_tel_quote" },
        ),
      ),
    ).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-unclosed-tel-quote",
    });
  });

  it("uses a tel angle-addr, not an earlier sip prefix", () => {
    const from = "sip:+15550001111@evil.example <tel:+19995550000>";
    const prefixAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
    });
    expect(
      prefixAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-tel-prefix", callerNumber: from }),
          { webhookId: "msg_tel_prefix" },
        ),
      ),
    ).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-tel-prefix",
    });

    const telAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+19995550000"],
    });
    expect(
      telAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-tel-angle", callerNumber: from }),
          { webhookId: "msg_tel_angle" },
        ),
      ),
    ).toEqual({
      admitted: true,
      callId: "call-tel-angle",
      callerNumber: "+19995550000",
      calledNumber: "+18005550199",
    });
  });

  it("uses the first tel URI, not a later sip URI or a tel parameter", () => {
    for (const [label, from] of [
      ["later-sip", "<tel:+19995550000> <sip:+15550001111@sip.telnyx.com>"],
      ["tag", "<tel:+19995550000>;tag=+15550001111"],
      ["phone-context", "<tel:+19995550000;phone-context=+15550001111>"],
    ] as const) {
      const outsideAllowlist = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+15550001111"],
      });
      expect(
        outsideAllowlist.admit(
          signedHeaders(
            incomingCallPayload({ callId: `call-tel-${label}-outside`, callerNumber: from }),
            { webhookId: `msg_tel_${label}_outside` },
          ),
        ),
        label,
      ).toEqual({
        admitted: false,
        reason: "unauthorized_caller",
        callId: `call-tel-${label}-outside`,
      });

      const telAllowlist = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+19995550000"],
      });
      expect(
        telAllowlist.admit(
          signedHeaders(
            incomingCallPayload({ callId: `call-tel-${label}`, callerNumber: from }),
            { webhookId: `msg_tel_${label}` },
          ),
        ),
        label,
      ).toEqual({
        admitted: true,
        callId: `call-tel-${label}`,
        callerNumber: "+19995550000",
        calledNumber: "+18005550199",
      });
    }
  });

  it("uses an unbracketed tel URI for the allowlist, not a parameter", () => {
    const from = "tel:5555550177;tag=+15550001111";
    const parameterAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
    });
    expect(
      parameterAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-tel-param", callerNumber: from }),
          { webhookId: "msg_tel_param" },
        ),
      ),
    ).toEqual({
      admitted: false,
      reason: "unauthorized_caller",
      callId: "call-tel-param",
    });

    const telAllowlist = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15555550177"],
    });
    expect(
      telAllowlist.admit(
        signedHeaders(
          incomingCallPayload({ callId: "call-tel-bare", callerNumber: from }),
          { webhookId: "msg_tel_bare" },
        ),
      ),
    ).toEqual({
      admitted: true,
      callId: "call-tel-bare",
      callerNumber: "+15555550177",
      calledNumber: "+18005550199",
    });
  });

  it("uses the sip or sips subscriber, not a telephone-subscriber parameter", () => {
    for (const [label, from] of [
      ["sip", "<sip:5555550177;phone-context=+15550001111@sip.telnyx.com>"],
      ["sips", "<sips:5555550177;phone-context=+15550001111@sip.telnyx.com>"],
      ["bare", "sip:5555550177;phone-context=+15550001111@sip.telnyx.com"],
    ] as const) {
      const parameterAllowlist = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+15550001111"],
      });
      expect(
        parameterAllowlist.admit(
          signedHeaders(
            incomingCallPayload({ callId: `call-${label}-param`, callerNumber: from }),
            { webhookId: `msg_${label}_param` },
          ),
        ),
        label,
      ).toEqual({
        admitted: false,
        reason: "unauthorized_caller",
        callId: `call-${label}-param`,
      });

      const subscriberAllowlist = createIncomingCallAdmission({
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentCalls: 1,
        allowedCallerNumbers: ["+15555550177"],
      });
      expect(
        subscriberAllowlist.admit(
          signedHeaders(
            incomingCallPayload({ callId: `call-${label}-sub`, callerNumber: from }),
            { webhookId: `msg_${label}_sub` },
          ),
        ),
        label,
      ).toEqual({
        admitted: true,
        callId: `call-${label}-sub`,
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

  it("admits any caller when no allowlist is configured", () => {
    const admission = createIncomingCallAdmission({
      webhookSecret: WEBHOOK_SECRET,
      maxConcurrentCalls: 1,
    });
    const payload = incomingCallPayload({
      callId: "call-public",
      callerNumber: "+15559876543",
    });
    expect(admission.admit(signedHeaders(payload, { webhookId: "msg_public" }))).toEqual({
      admitted: true,
      callId: "call-public",
      callerNumber: "+15559876543",
      calledNumber: "+18005550199",
    });
  });
});

