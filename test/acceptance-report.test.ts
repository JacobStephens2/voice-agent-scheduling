import { describe, expect, it } from "vitest";
import { PARENT_SPEC_SCENARIOS, buildAcceptanceReport } from "../src/acceptance.js";
import type { StructuredCallEvidence } from "../src/evidence.js";

const SAMPLE_EVIDENCE: StructuredCallEvidence = {
  callId: "call-accept-1",
  connectionRoute: "direct_sip",
  callerNumberMasked: "+1***7773",
  calledNumber: "+18005550199",
  status: "completed",
  durationMs: 27619,
  modelVerified: "grok-voice-think-fast-2.0",
  reasoningVerified: "high",
  toolRoundTrips: 3,
  estimatedCostMicroUsd: 36825,
  recordedAt: "2026-09-14T15:00:00.000Z",
};

describe("structured acceptance report", () => {
  it("records parent-spec campaign results without audio, transcripts, or raw caller numbers", () => {
    const report = buildAcceptanceReport({
      recordedAt: "2026-09-19T18:00:00.000Z",
      health: {
        publicAdmission: false,
        calendarWrites: true,
        calendarSelected: true,
        admissionsPaused: false,
      },
      evidence: [SAMPLE_EVIDENCE],
      syntheticSuite: { passed: 120, failed: 0 },
      scenarios: [
        { id: "ordinary-booking", result: "pass" },
        { id: "inbox-notifications", result: "pending" },
      ],
      limitations: [
        "External calendar writes by Jacob can still race with a booking insert.",
      ],
    });

    expect(report.publicAdmission).toBe(false);
    expect(report.calendarWrites).toBe(true);
    expect(report.calendarSelected).toBe(true);
    expect(report.syntheticSuite).toEqual({ passed: 120, failed: 0 });
    expect(report.observed).toEqual({
      connectionRoute: "direct_sip",
      modelVerified: "grok-voice-think-fast-2.0",
      reasoningVerified: "high",
      callCount: 1,
      totalDurationMs: 27619,
      totalEstimatedCostMicroUsd: 36825,
    });
    expect(report.calls[0]).toMatchObject({
      callId: "call-accept-1",
      callerNumberMasked: "+1***7773",
      durationMs: 27619,
      estimatedCostMicroUsd: 36825,
    });
    expect(report.scenarios).toEqual([
      { id: "ordinary-booking", result: "pass" },
      { id: "inbox-notifications", result: "pending" },
    ]);
    expect(PARENT_SPEC_SCENARIOS.some((scenario) => scenario.id === "ordinary-booking")).toBe(
      true,
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/"audio"/);
    expect(serialized.toLowerCase()).not.toContain("transcript");
    expect(serialized).not.toMatch(/"recording"/);
    expect(serialized).not.toContain("4843567773");
  });

  it("drops evidence that is not a masked operational record", () => {
    const report = buildAcceptanceReport({
      recordedAt: "2026-09-19T18:00:00.000Z",
      health: {
        publicAdmission: false,
        calendarWrites: false,
        calendarSelected: false,
        admissionsPaused: false,
      },
      evidence: [
        {
          ...SAMPLE_EVIDENCE,
          callerNumberMasked: "+14843567773",
        },
        {
          ...SAMPLE_EVIDENCE,
          callId: "call-audio",
          audio: "base64",
        } as StructuredCallEvidence,
      ],
      syntheticSuite: { passed: 0, failed: 0 },
      scenarios: [],
      limitations: [],
    });
    expect(report.calls).toEqual([]);
    expect(report.observed.callCount).toBe(0);
  });
});
