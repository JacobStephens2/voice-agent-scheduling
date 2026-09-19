import type { ProductionReadiness } from "./admission-policy.js";
import type { StructuredCallEvidence } from "./evidence.js";

const MASKED_CALLER = /^\+\d{1,3}\*\*\*\d{4}$/;

export const ACCEPTANCE_SCENARIOS = [
  { id: "ordinary-appointment", title: "An ordinary call creates one matching 30-minute busy appointment" },
  { id: "corrections", title: "Date, number, and timezone corrections appear in the final readback" },
  { id: "interruptions", title: "Interrupted or unclear assent does not write an appointment" },
  { id: "no-confirmation", title: "No explicit confirmation produces no calendar write" },
  { id: "changed-availability", title: "A slot taken before insert offers fresh alternatives" },
  { id: "callback-limit", title: "One upcoming appointment per confirmed callback number" },
  { id: "dropped-call", title: "Disconnect after confirmation still completes the same operation" },
  { id: "ambiguous-write", title: "Uncertain Calendar writes stay inconclusive without a second event" },
  { id: "provider-failure", title: "Calendar or provider failure does not announce success" },
  { id: "call-budget-limits", title: "One caller, 10-minute cutoff, and monthly budget pause hold" },
  { id: "lifetime-pause", title: "Cutoff or admission pause does not discard a confirmed appointment" },
  { id: "restart-write", title: "Restart around a Calendar write converges on one matching event" },
  { id: "notifications", title: "Stored event has no attendees, Meet link, or email reminder" },
  { id: "inbox-notifications", title: "Authorized account inbox received no invitation or reminder email" },
  { id: "jacob-will-call", title: "Caller hears that Jacob will call the confirmed callback number" },
] as const;

export type AcceptanceScenarioId = (typeof ACCEPTANCE_SCENARIOS)[number]["id"];

export interface AcceptanceScenarioResult {
  readonly id: string;
  readonly result: "pass" | "fail" | "pending";
  readonly notes?: string;
}

export interface AcceptanceHealth extends ProductionReadiness {
  readonly admissionsPaused: boolean;
  readonly pauseReason?: string;
}

export interface SyntheticSuiteSummary {
  readonly passed: number;
  readonly failed: number;
}

export interface AcceptanceReport {
  readonly recordedAt: string;
  readonly production: ProductionReadiness;
  readonly admissionsPaused: boolean;
  readonly pauseReason?: string;
  readonly syntheticSuite: SyntheticSuiteSummary;
  readonly observed: {
    readonly connectionRoute?: string;
    readonly modelVerified?: string;
    readonly reasoningVerified?: string;
    readonly callCount: number;
    readonly totalDurationMs: number;
    readonly totalEstimatedCostMicroUsd: number;
  };
  readonly calls: readonly Pick<
    StructuredCallEvidence,
    | "callId"
    | "connectionRoute"
    | "callerNumberMasked"
    | "status"
    | "durationMs"
    | "modelVerified"
    | "reasoningVerified"
    | "toolRoundTrips"
    | "estimatedCostMicroUsd"
  >[];
  readonly scenarios: readonly AcceptanceScenarioResult[];
  readonly limitations: readonly string[];
}

function isSafeEvidence(entry: StructuredCallEvidence): boolean {
  if ("audio" in entry || "transcript" in entry || "recording" in entry) {
    return false;
  }
  return MASKED_CALLER.test(entry.callerNumberMasked);
}

function projectEvidence(entry: StructuredCallEvidence): AcceptanceReport["calls"][number] {
  return {
    callId: entry.callId,
    connectionRoute: entry.connectionRoute,
    callerNumberMasked: entry.callerNumberMasked,
    status: entry.status,
    durationMs: entry.durationMs,
    modelVerified: entry.modelVerified,
    reasoningVerified: entry.reasoningVerified,
    toolRoundTrips: entry.toolRoundTrips,
    estimatedCostMicroUsd: entry.estimatedCostMicroUsd,
  };
}

export function buildAcceptanceReport(input: {
  readonly recordedAt: string;
  readonly health: AcceptanceHealth;
  readonly evidence: readonly StructuredCallEvidence[];
  readonly syntheticSuite: SyntheticSuiteSummary;
  readonly scenarios: readonly AcceptanceScenarioResult[];
  readonly limitations: readonly string[];
}): AcceptanceReport {
  const calls = input.evidence.filter(isSafeEvidence).map(projectEvidence);
  const latest = [...calls].reverse().find((entry) => entry.status === "completed") ?? calls.at(-1);
  const { publicAdmission, calendarWrites, calendarSelected, admissionsPaused, pauseReason } =
    input.health;
  return {
    recordedAt: input.recordedAt,
    production: { publicAdmission, calendarWrites, calendarSelected },
    admissionsPaused,
    ...(pauseReason ? { pauseReason } : {}),
    syntheticSuite: input.syntheticSuite,
    observed: {
      connectionRoute: latest?.connectionRoute,
      modelVerified: latest?.modelVerified,
      reasoningVerified: latest?.reasoningVerified,
      callCount: calls.length,
      totalDurationMs: calls.reduce((sum, entry) => sum + entry.durationMs, 0),
      totalEstimatedCostMicroUsd: calls.reduce(
        (sum, entry) => sum + entry.estimatedCostMicroUsd,
        0,
      ),
    },
    calls,
    scenarios: input.scenarios,
    limitations: input.limitations,
  };
}
