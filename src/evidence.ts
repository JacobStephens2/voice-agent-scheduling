import { join } from "node:path";
import { appendJsonl, loadJsonl, rewriteJsonl } from "./jsonl.js";
import { DIRECT_SIP_MICRO_USD_PER_MINUTE } from "./budget.js";

export const DIRECT_SIP_ROUTE = "direct_sip";
export const OPERATIONAL_RECORDS_FILE = "smoke-evidence.jsonl";
export const OPERATIONAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const OPERATIONAL_ERROR_CATEGORIES = [
  "duration_limit_reached",
  "provider_error",
  "model_mismatch",
  "websocket_failed",
  "tool_failed",
  "coordinator_error",
] as const;

export type OperationalErrorCategory = (typeof OPERATIONAL_ERROR_CATEGORIES)[number];

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
  readonly error?: OperationalErrorCategory;
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
  return join(dataDir, OPERATIONAL_RECORDS_FILE);
}

export function persistEvidence(dataDir: string, evidence: StructuredCallEvidence): void {
  appendJsonl(evidenceFile(dataDir), evidence, 0o600);
}

export function loadEvidence(dataDir: string): StructuredCallEvidence[] {
  return loadJsonl<StructuredCallEvidence>(evidenceFile(dataDir));
}

export function replaceEvidence(
  dataDir: string,
  records: readonly StructuredCallEvidence[],
): void {
  rewriteJsonl(evidenceFile(dataDir), records, 0o600);
}

export function isRetainedOperationalRecord(
  record: StructuredCallEvidence,
  now: Date,
): boolean {
  const recorded = Date.parse(record.recordedAt);
  if (Number.isNaN(recorded)) {
    return false;
  }
  return now.getTime() - recorded <= OPERATIONAL_RETENTION_MS;
}

/** Map session/provider failure text to a closed set of operational categories. */
export function boundedErrorCategory(error: string | undefined): OperationalErrorCategory | undefined {
  if (!error) {
    return undefined;
  }
  if (error === "duration_limit_reached") {
    return "duration_limit_reached";
  }
  if (error.startsWith("Expected model")) {
    return "model_mismatch";
  }
  if (error.startsWith("Failed to connect websocket") || error.startsWith("WebSocket error")) {
    return "websocket_failed";
  }
  if (error === "Scheduling tool failed") {
    return "tool_failed";
  }
  if (error.startsWith("Coordinator unhandled error")) {
    return "coordinator_error";
  }
  return "provider_error";
}
