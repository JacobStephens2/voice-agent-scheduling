import { createHmac, timingSafeEqual } from "node:crypto";
import { extractE164 } from "./phone.js";

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
      release(): void;
    }
  | {
      readonly admitted: false;
      readonly reason: AdmissionRejectionReason;
      readonly callId?: string;
    };

export interface IncomingCallAdmission {
  admit(input: SignedWebhook): AdmissionResult;
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

function callerNumberFromHeader(from: string): string {
  const unquoted = unquoteDisplayName(from);
  const subscriber = firstTelephoneSubscriber(unquoted.visible);
  if (subscriber === undefined) {
    // A bare phone number has no display-name quote. An unmatched quote must
    // not put that hidden text back into the allowlist decision.
    return extractE164(unquoted.hidUnmatchedQuote ? unquoted.visible : from);
  }
  return extractE164(subscriber);
}

function unquoteDisplayName(from: string): {
  readonly visible: string;
  readonly hidUnmatchedQuote: boolean;
} {
  const closed = from.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  const unmatched = closed.indexOf('"');
  if (unmatched === -1) {
    return { visible: closed, hidUnmatchedQuote: false };
  }
  return { visible: closed.slice(0, unmatched), hidUnmatchedQuote: true };
}

function firstTelephoneSubscriber(from: string): string | undefined {
  // A non-telephone angle must not send the search back to an earlier URI.
  let rest = from;
  while (rest.includes("<")) {
    const open = rest.indexOf("<");
    const close = rest.indexOf(">", open + 1);
    if (close === -1) {
      break;
    }
    const angled = rest.slice(open + 1, close).trim();
    const telUser = telSubscriber(angled);
    if (telUser !== undefined) {
      return telUser;
    }
    const angledUser = sipUserIn(angled);
    if (angledUser !== undefined) {
      return angledUser;
    }
    rest = rest.slice(close + 1);
  }
  return firstUnbracketedTelephoneSubscriber(from);
}

function firstUnbracketedTelephoneSubscriber(value: string): string | undefined {
  const pattern = /(?:^|[^A-Za-z0-9])(tel|sips?):/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const scheme = match[1] ?? "";
    const schemeStart = match.index + match[0].length - (scheme.length + 1);
    const candidate = value.slice(schemeStart);
    if (/^tel:/i.test(candidate)) {
      return telSubscriber(candidate);
    }
    const sip = /^sips?:([^@]*)@/i.exec(candidate);
    if (sip) {
      return subscriberBeforeParameter(sip[1] ?? "");
    }
  }
  return undefined;
}

function subscriberBeforeParameter(user: string): string {
  const semi = user.indexOf(";");
  return semi === -1 ? user : user.slice(0, semi);
}

function telSubscriber(value: string): string | undefined {
  const matched = /^tel:([^;?\s]*)/i.exec(value);
  if (!matched) {
    return undefined;
  }
  return matched[1] ?? "";
}

function sipUserIn(value: string): string | undefined {
  const matched = /(?:^|[^A-Za-z0-9])sips?:([^@]*)@/i.exec(value);
  if (!matched) {
    return undefined;
  }
  return subscriberBeforeParameter(matched[1] ?? "");
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

      const callerNumber = callerNumberFromHeader(
        sipHeader(payload.data?.sip_headers, "from"),
      );
      const calledNumber = extractE164(sipHeader(payload.data?.sip_headers, "to"));

      if (allowed && allowed.length > 0 && !allowed.includes(callerNumber)) {
        return { admitted: false, reason: "unauthorized_caller", callId };
      }

      if (activeCalls.size >= options.maxConcurrentCalls) {
        return { admitted: false, reason: "concurrency_limit_reached", callId };
      }

      activeCalls.add(callId);
      processedWebhookIds.add(input.id);
      let released = false;
      return {
        admitted: true,
        callId,
        callerNumber,
        calledNumber,
        release() {
          if (released) {
            return;
          }
          released = true;
          activeCalls.delete(callId);
        },
      };
    },

    activeCallCount(): number {
      return activeCalls.size;
    },
  };
}
