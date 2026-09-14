import { createHmac, timingSafeEqual } from "node:crypto";

export interface IncomingCallAdmissionOptions {
  readonly webhookSecret: string;
  readonly maxConcurrentCalls: number;
  readonly allowedCallerNumbers?: readonly string[];
  readonly toleranceSeconds?: number;
  readonly nowSeconds?: () => number;
}

export interface SignedWebhook {
  readonly id?: string;
  readonly timestamp?: string;
  readonly signature?: string;
  readonly rawBody: string;
}

export type AdmissionRejectionReason =
  | "invalid_signature"
  | "timestamp_out_of_range"
  | "duplicate_delivery"
  | "concurrency_limit_reached"
  | "unauthorized_caller"
  | "invalid_payload";

export type AdmissionResult =
  | {
      readonly admitted: true;
      readonly callId: string;
      readonly callerNumber: string;
      readonly calledNumber: string;
    }
  | {
      readonly admitted: false;
      readonly reason: AdmissionRejectionReason;
      readonly callId?: string;
    };

export interface IncomingCallAdmission {
  admit(input: SignedWebhook): AdmissionResult;
  release(callId: string): void;
  activeCallCount(): number;
}

interface SipHeader {
  readonly name?: unknown;
  readonly value?: unknown;
}

interface IncomingCallPayload {
  readonly data?: {
    readonly call_id?: unknown;
    readonly sip_headers?: readonly SipHeader[];
  };
}

function hmacKey(secret: string): Buffer {
  if (secret.startsWith("whsec_")) {
    return Buffer.from(secret.slice(6), "base64");
  }
  return Buffer.from(secret, "utf8");
}

export function computeWebhookSignature(
  secret: string,
  webhookId: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = createHmac("sha256", hmacKey(secret))
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest("base64");
  return `v1,${digest}`;
}

function signaturesMatch(expected: string, header: string): boolean {
  const expectedBuf = Buffer.from(expected);
  for (const candidate of header.split(" ")) {
    const candidateBuf = Buffer.from(candidate);
    if (
      candidateBuf.length === expectedBuf.length &&
      timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}

function sipHeader(headers: readonly SipHeader[] | undefined, name: string): string {
  if (!headers) {
    return "";
  }
  const match = headers.find(
    (header) => typeof header.name === "string" && header.name.toLowerCase() === name,
  );
  return typeof match?.value === "string" ? match.value : "";
}

export function extractE164(value: string): string {
  const plusMatch = value.match(/\+\d{8,15}/);
  if (plusMatch) {
    return plusMatch[0];
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return value.trim();
}

export function createIncomingCallAdmission(
  options: IncomingCallAdmissionOptions,
): IncomingCallAdmission {
  const activeCalls = new Set<string>();
  const processedWebhookIds = new Set<string>();
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const allowed = options.allowedCallerNumbers?.map(extractE164);

  return {
    admit(input: SignedWebhook): AdmissionResult {
      if (!input.id || !input.timestamp || !input.signature) {
        return { admitted: false, reason: "invalid_signature" };
      }

      const timestamp = Number.parseInt(input.timestamp, 10);
      if (!Number.isFinite(timestamp)) {
        return { admitted: false, reason: "invalid_signature" };
      }
      if (Math.abs(nowSeconds() - timestamp) > toleranceSeconds) {
        return { admitted: false, reason: "timestamp_out_of_range" };
      }

      const expected = computeWebhookSignature(
        options.webhookSecret,
        input.id,
        input.timestamp,
        input.rawBody,
      );
      if (!signaturesMatch(expected, input.signature)) {
        return { admitted: false, reason: "invalid_signature" };
      }

      if (processedWebhookIds.has(input.id)) {
        return { admitted: false, reason: "duplicate_delivery" };
      }

      let payload: IncomingCallPayload;
      try {
        payload = JSON.parse(input.rawBody) as IncomingCallPayload;
      } catch {
        return { admitted: false, reason: "invalid_payload" };
      }

      const callId = payload.data?.call_id;
      if (typeof callId !== "string" || callId.length === 0) {
        return { admitted: false, reason: "invalid_payload" };
      }

      if (activeCalls.has(callId)) {
        return { admitted: false, reason: "duplicate_delivery" };
      }

      const callerNumber = extractE164(sipHeader(payload.data?.sip_headers, "from"));
      const calledNumber = extractE164(sipHeader(payload.data?.sip_headers, "to"));

      if (allowed && allowed.length > 0 && !allowed.includes(callerNumber)) {
        return { admitted: false, reason: "unauthorized_caller", callId };
      }

      if (activeCalls.size >= options.maxConcurrentCalls) {
        return { admitted: false, reason: "concurrency_limit_reached", callId };
      }

      activeCalls.add(callId);
      processedWebhookIds.add(input.id);
      return {
        admitted: true,
        callId,
        callerNumber,
        calledNumber,
      };
    },

    release(callId: string): void {
      activeCalls.delete(callId);
    },

    activeCallCount(): number {
      return activeCalls.size;
    },
  };
}
