import { join } from "node:path";
import { appendJsonl, loadJsonl } from "./jsonl.js";

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
  readonly error?: string;
  readonly recordedAt: string;
}

const GROK_VOICE_USD_PER_MINUTE = 0.08;
const MICRO_USD_PER_MILLISECOND =
  (GROK_VOICE_USD_PER_MINUTE * 1_000_000) / 60_000;

export function maskPhoneNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 8) {
    return "***";
  }
  const lastFour = digits.slice(-4);
  const country = digits.slice(0, Math.max(1, digits.length - 10));
  return `+${country}***${lastFour}`;
}

export function estimateCostMicroUsd(durationMs: number): number {
  return Math.round(durationMs * MICRO_USD_PER_MILLISECOND);
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
