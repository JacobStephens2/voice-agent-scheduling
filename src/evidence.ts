import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(evidenceFile(dataDir), `${JSON.stringify(evidence)}\n`, "utf8");
}

export function loadEvidence(dataDir: string): StructuredCallEvidence[] {
  try {
    const text = readFileSync(evidenceFile(dataDir), "utf8");
    const records: StructuredCallEvidence[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      records.push(JSON.parse(line) as StructuredCallEvidence);
    }
    return records;
  } catch {
    return [];
  }
}
