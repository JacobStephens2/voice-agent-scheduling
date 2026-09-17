import { join } from "node:path";
import { appendJsonl, loadJsonl } from "./jsonl.js";
import { DIRECT_SIP_MICRO_USD_PER_MINUTE } from "./budget.js";

export const DIRECT_SIP_ROUTE = "direct_sip";

export interface StructuredCallEvidence {
  readonly callId: string;
  readonly connectionRoute: typeof DIRECT_SIP_ROUTE;
  readonly callerNumberMasked: string;
  readonly calledNumber: string;
  readonly status: "completed" | "failed";
  readonly durationMs: number;
  readonly modelVerified?: string;
  readonly reasoningVerified?: string;
  readonly toolRoundTrips: number;
  readonly estimatedCostMicroUsd: number;
  readonly durationWarningSent?: boolean;
  readonly error?: string;
  readonly recordedAt: string;
}

// Per-call estimates use the combined direct-SIP rate (voice model plus
// carrier): an operating target for admission control, not a promise about
// any carrier's bill.

export function maskPhoneNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 8) {
    return "***";
  }
  const lastFour = digits.slice(-4);
  const country = digits.slice(0, Math.max(1, digits.length - 10));
  return `+${country}***${lastFour}`;
}

export function estimateCostMicroUsd(
  durationMs: number,
  perMinuteMicroUsd: number = DIRECT_SIP_MICRO_USD_PER_MINUTE,
): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  return Math.round((durationMs * perMinuteMicroUsd) / 60_000);
}

function evidenceFile(dataDir: string): string {
  return join(dataDir, "smoke-evidence.jsonl");
}

export function persistEvidence(dataDir: string, evidence: StructuredCallEvidence): void {
  appendJsonl(evidenceFile(dataDir), evidence);
}

export function loadEvidence(dataDir: string): StructuredCallEvidence[] {
  return loadJsonl<StructuredCallEvidence>(evidenceFile(dataDir));
}
