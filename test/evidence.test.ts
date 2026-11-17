import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATIONAL_RECORDS_FILE, createCallEvidence, type StructuredCallEvidence } from "../src/evidence.js";
import type { SessionOutcome } from "../src/session.js";

const NOW = new Date("2026-11-13T15:00:00.000Z");
const OUTCOME: SessionOutcome = {
  callId: "call-one",
  status: "completed",
  durationMs: 12_000,
  toolRoundTrips: 1,
  durationWarningSent: false,
};
const CONTEXT = {
  callId: "call-one",
  callerNumber: "+15551239876",
  calledNumber: "+18005550199",
};
const RECORD: StructuredCallEvidence = {
  callId: "call-one",
  connectionRoute: "direct_sip",
  callerNumberMasked: "+1***9876",
  calledNumber: "+18005550199",
  status: "completed",
  durationMs: 12_000,
  toolRoundTrips: 1,
  estimatedCostMicroUsd: 16_640,
  durationWarningSent: false,
  recordedAt: NOW.toISOString(),
};
const directories: string[] = [];

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "scheduling-evidence-owner-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe.each(["memory", "durable"])("Scheduling call evidence (%s)", (mode) => {
  it("projects raw outcomes without retaining extra runtime fields or caller-provided evidence overrides", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    expect(evidence.list()).toEqual([]);
    const extras = {
      name: "Private Caller",
      callbackNumber: "+15558887777",
      speech: "private speech",
      transcript: "private transcript",
      recording: "private recording",
      audio: "private audio",
      connectionRoute: "forged-route",
      callerNumberMasked: "+15551239876",
      estimatedCostMicroUsd: 999,
      recordedAt: "forged-time",
      errorCategory: "forged-category",
    };
    const outcome = { ...OUTCOME, ...extras, callId: "conflicting-outcome", calledNumber: "forged-called", error: "raw failure with private details" };
    const context = {
      ...CONTEXT,
      ...extras,
      status: "failed",
      durationMs: 999,
      modelVerified: "forged-model",
      reasoningVerified: "forged-reasoning",
      toolRoundTrips: 999,
      durationWarningSent: true,
      error: "forged-error",
    };
    evidence.record(outcome, context);
    const expected = { ...RECORD, error: "provider_error" };
    expect(evidence.list()).toEqual([expected]);
    expect(Object.keys(evidence.list()[0]!).sort()).toEqual([
      ...Object.keys(RECORD), "modelVerified", "reasoningVerified", "error",
    ].sort());
    if (dataDir) {
      expect(createCallEvidence({ dataDir }).list()).toEqual([expected]);
      const bytes = readFileSync(join(dataDir, OPERATIONAL_RECORDS_FILE), "utf8");
      expect(JSON.parse(bytes)).toEqual(expected);
      for (const privateValue of [...Object.values(extras), outcome.error, outcome.callId, outcome.calledNumber, CONTEXT.callerNumber, "forged-model", "forged-reasoning", context.error]) {
        expect(bytes).not.toContain(String(privateValue));
      }
    }
  });

  it.each([
    [undefined, undefined],
    ["", undefined],
    ["duration_limit_reached", "duration_limit_reached"],
    ["Expected model grok but received other", "model_mismatch"],
    ["Failed to connect websocket: private details", "websocket_failed"],
    ["WebSocket error: private details", "websocket_failed"],
    ["Scheduling tool failed", "tool_failed"],
    ["Coordinator unhandled error: private details", "coordinator_error"],
    ["unrecognized provider error with private details", "provider_error"],
  ])("classifies raw error %s as %s", (error, category) => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    evidence.record({ ...OUTCOME, status: "failed", error }, CONTEXT);
    const expected = { ...RECORD, status: "failed", ...(category ? { error: category } : {}) };
    expect(evidence.list()).toEqual([expected]);
    if (!category) expect(evidence.list()[0]).not.toHaveProperty("error");
    if (dataDir) {
      expect(createCallEvidence({ dataDir }).list()).toEqual([expected]);
      expect(JSON.parse(readFileSync(join(dataDir, OPERATIONAL_RECORDS_FILE), "utf8"))).toEqual(expected);
    }
  });

  it.each([
    ["+1 (555) 123-9876", "+1***9876"],
    ["+44 20 7946 0958", "+44***0958"],
    ["5551239876", "+5***9876"],
    ["12345678", "+1***5678"],
    ["1234567", "***"],
    ["anonymous", "***"],
  ])("masks raw caller number %s as %s and preserves the called number", (callerNumber, masked) => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    evidence.record(OUTCOME, { ...CONTEXT, callerNumber });
    const expected = { ...RECORD, callerNumberMasked: masked };
    expect(evidence.list()).toEqual([expected]);
    if (dataDir) expect(createCallEvidence({ dataDir }).list()).toEqual([expected]);
  });

  it.each([
    [undefined, 12_000, 16_640],
    [120_000, 12_000, 24_000],
    [120_000, 1, 2],
    [undefined, 0, 0],
    [undefined, -1, 0],
    [undefined, NaN, 0],
    [undefined, Infinity, 0],
  ])("estimates usage at rate %s for duration %s", (perMinuteMicroUsd, durationMs, cost) => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir, perMinuteMicroUsd, now: () => NOW });
    evidence.record({ ...OUTCOME, durationMs }, CONTEXT);
    expect(evidence.list()[0]?.estimatedCostMicroUsd).toBe(cost);
    if (dataDir) expect(createCallEvidence({ dataDir }).list()[0]?.estimatedCostMicroUsd).toBe(cost);
  });

  it("samples its clock at recording time and keeps optional model and reasoning values", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    let at = NOW;
    const evidence = createCallEvidence({ dataDir, now: () => at });
    at = new Date("2026-11-14T15:00:00.000Z");
    evidence.record({ ...OUTCOME, modelVerified: "verified-model", reasoningVerified: "high", durationWarningSent: true }, CONTEXT);
    const expected = { ...RECORD, modelVerified: "verified-model", reasoningVerified: "high", durationWarningSent: true, recordedAt: at.toISOString() };
    expect(evidence.list()).toEqual([expected]);
    if (dataDir) expect(createCallEvidence({ dataDir }).list()).toEqual([expected]);
  });

  it("uses a fresh current instant by default", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const evidence = createCallEvidence({ dataDir });
    vi.setSystemTime(new Date("2026-11-14T15:00:00.000Z"));
    evidence.record(OUTCOME, CONTEXT);
    expect(evidence.list()[0]?.recordedAt).toBe("2026-11-14T15:00:00.000Z");
  });

  it.each(["throws", "invalid"])("does not append or publish when its clock %s and can record after repair", (failure) => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    let broken = false;
    const evidence = createCallEvidence({ dataDir, now: () => {
      if (broken && failure === "throws") throw new Error("clock unavailable");
      return broken ? new Date("invalid") : NOW;
    } });
    evidence.record(OUTCOME, CONTEXT);
    const path = dataDir ? join(dataDir, OPERATIONAL_RECORDS_FILE) : undefined;
    const beforeBytes = path ? readFileSync(path, "utf8") : undefined;
    broken = true;
    expect(() => evidence.record({ ...OUTCOME, status: "failed" }, CONTEXT)).toThrow();
    expect(evidence.list()).toEqual([RECORD]);
    if (path) expect(readFileSync(path, "utf8")).toBe(beforeBytes);
    broken = false;
    evidence.record(OUTCOME, { ...CONTEXT, callId: "after-repair" });
    expect(evidence.list()).toEqual([RECORD, { ...RECORD, callId: "after-repair" }]);
    if (dataDir) expect(createCallEvidence({ dataDir }).list()).toEqual(evidence.list());
  });

  it("filters physical rows before choosing the latest retained call outcome", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    let at = new Date("2026-10-14T15:00:00.000Z");
    const evidence = createCallEvidence({ dataDir, now: () => at });
    evidence.record(OUTCOME, CONTEXT);
    at = new Date("2026-10-14T14:59:59.999Z");
    evidence.record({ ...OUTCOME, status: "failed" }, CONTEXT);
    at = new Date("2026-12-01T15:00:00.000Z");
    evidence.record(OUTCOME, { ...CONTEXT, callId: "future" });
    at = new Date("2026-11-01T15:00:00.000Z");
    evidence.record({ ...OUTCOME, status: "failed" }, { ...CONTEXT, callId: "future" });

    expect(evidence.compact(NOW)).toEqual({ removed: 1, kept: 3 });
    expect(evidence.list()).toEqual([
      { ...RECORD, recordedAt: "2026-10-14T15:00:00.000Z" },
      { ...RECORD, callId: "future", status: "failed", recordedAt: "2026-11-01T15:00:00.000Z" },
    ]);
    if (dataDir) {
      const reopened = createCallEvidence({ dataDir });
      expect(reopened.list()).toEqual(evidence.list());
      expect(reopened.compact(NOW)).toEqual({ removed: 0, kept: 3 });
    }
  });

  it("keeps first-appearance order and the last encountered row without sorting timestamps", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    let at = NOW;
    const evidence = createCallEvidence({ dataDir, now: () => at });
    evidence.record(OUTCOME, CONTEXT);
    evidence.record(OUTCOME, { ...CONTEXT, callId: "call-two" });
    at = new Date("2026-11-01T15:00:00.000Z");
    evidence.record({ ...OUTCOME, status: "failed" }, CONTEXT);
    expect(evidence.list()).toEqual([
      { ...RECORD, status: "failed", recordedAt: "2026-11-01T15:00:00.000Z" },
      { ...RECORD, callId: "call-two" },
    ]);
  });

  it("owns its projected outcomes and returns fresh arrays and record copies", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    const outcome = { ...OUTCOME };
    const context = { ...CONTEXT };
    evidence.record(outcome, context);
    outcome.durationMs = 999;
    context.callId = "mutated-input";
    context.calledNumber = "mutated-number";
    const listed = evidence.list();
    Object.assign(listed[0]!, { callId: "mutated-output" });
    Object.assign(listed, { length: 0 });
    expect(evidence.list()).toEqual([RECORD]);
  });
});

describe("durable Scheduling call evidence", () => {
  it("loads historical rows unchanged and only removes invalid timestamps during compaction", () => {
    const dataDir = temporaryDirectory();
    const legacy = { ...RECORD, callId: "historical", callerNumberMasked: "preexisting-number", error: "historical error", estimatedCostMicroUsd: 17, extra: "preexisting field" };
    const invalid = { ...RECORD, callId: "invalid", recordedAt: "invalid" };
    writeFileSync(join(dataDir, "smoke-evidence.jsonl"), `${JSON.stringify(legacy)}\n`);
    writeFileSync(join(dataDir, OPERATIONAL_RECORDS_FILE), `${JSON.stringify(invalid)}\n`);
    const evidence = createCallEvidence({ dataDir });
    expect(evidence.list()).toEqual([legacy, invalid]);
    expect(evidence.compact(NOW)).toEqual({ removed: 1, kept: 1 });
    expect(evidence.list()).toEqual([legacy]);
    expect(createCallEvidence({ dataDir }).list()).toEqual([legacy]);
  });

  it("loads legacy before current rows and migrates without deduplicating physical history", () => {
    const dataDir = temporaryDirectory();
    const legacyPath = join(dataDir, "smoke-evidence.jsonl");
    const legacy = { ...RECORD, callId: "legacy" };
    writeFileSync(legacyPath, `${JSON.stringify(RECORD)}\n${JSON.stringify(legacy)}\n`);
    let at = NOW;
    const evidence = createCallEvidence({ dataDir, now: () => at });
    evidence.record(OUTCOME, { ...CONTEXT, callId: "current" });
    const current = { ...RECORD, status: "failed" as const, recordedAt: "2026-11-01T15:00:00.000Z" };
    at = new Date(current.recordedAt);
    evidence.record({ ...OUTCOME, status: "failed" }, CONTEXT);
    const reopened = createCallEvidence({ dataDir });
    expect(reopened.list()).toEqual([current, legacy, { ...RECORD, callId: "current" }]);
    chmodSync(join(dataDir, OPERATIONAL_RECORDS_FILE), 0o644);
    expect(reopened.compact(NOW)).toEqual({ removed: 0, kept: 4 });
    expect(existsSync(legacyPath)).toBe(false);
    expect(statSync(join(dataDir, OPERATIONAL_RECORDS_FILE)).mode & 0o777).toBe(0o600);
    expect(createCallEvidence({ dataDir }).list()).toEqual(reopened.list());
    expect(createCallEvidence({ dataDir }).compact(NOW)).toEqual({ removed: 0, kept: 4 });
  });

  it("includes rows appended to either file since construction, while list performs no disk reads", () => {
    const dataDir = temporaryDirectory();
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    evidence.record(OUTCOME, CONTEXT);
    createCallEvidence({ dataDir, now: () => NOW }).record(OUTCOME, { ...CONTEXT, callId: "late-current" });
    writeFileSync(join(dataDir, "smoke-evidence.jsonl"), `${JSON.stringify({ ...RECORD, callId: "late-legacy" })}\n`);
    expect(evidence.list()).toEqual([RECORD]);
    expect(evidence.compact(NOW)).toEqual({ removed: 0, kept: 3 });
    expect(evidence.list().map((row) => row.callId)).toEqual(["late-legacy", "call-one", "late-current"]);
  });

  it.each([OPERATIONAL_RECORDS_FILE, "smoke-evidence.jsonl"])(
    "refuses malformed %s at construction and cleanup without rewriting files or replacing its view",
    (filename) => {
      const dataDir = temporaryDirectory();
      const evidence = createCallEvidence({ dataDir, now: () => NOW });
      evidence.record(OUTCOME, CONTEXT);
      const path = join(dataDir, filename);
      const currentPath = join(dataDir, OPERATIONAL_RECORDS_FILE);
      const currentBytes = readFileSync(currentPath, "utf8");
      const damaged = `${JSON.stringify(RECORD)}\n{"callId":\n`;
      writeFileSync(path, damaged);
      expect(() => createCallEvidence({ dataDir })).toThrow("at line 2");
      expect(() => evidence.compact(NOW)).toThrow("at line 2");
      expect(evidence.list()).toEqual([RECORD]);
      expect(readFileSync(path, "utf8")).toBe(damaged);
      if (filename !== OPERATIONAL_RECORDS_FILE) {
        expect(readFileSync(currentPath, "utf8")).toBe(currentBytes);
      }
      writeFileSync(path, `${JSON.stringify({ ...RECORD, callId: "repaired" })}\n`);
      expect(evidence.compact(NOW).kept).toBe(filename === OPERATIONAL_RECORDS_FILE ? 1 : 2);
      expect(evidence.list().some((row) => row.callId === "repaired")).toBe(true);
    },
  );

  it.each([OPERATIONAL_RECORDS_FILE, "smoke-evidence.jsonl"])(
    "treats unreadable %s as a failed load rather than empty input",
    (filename) => {
      const dataDir = temporaryDirectory();
      const evidence = createCallEvidence({ dataDir, now: () => NOW });
      evidence.record(OUTCOME, CONTEXT);
      const path = join(dataDir, filename);
      rmSync(path, { force: true });
      mkdirSync(path);
      expect(() => createCallEvidence({ dataDir })).toThrow();
      expect(() => evidence.compact(NOW)).toThrow();
      expect(evidence.list()).toEqual([RECORD]);
      expect(statSync(path).isDirectory()).toBe(true);
      rmSync(path, { recursive: true });
      expect(evidence.compact(NOW).kept).toBe(filename === OPERATIONAL_RECORDS_FILE ? 0 : 1);
    },
  );

  it("does not publish a failed append and succeeds after repair", () => {
    const dataDir = temporaryDirectory();
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    evidence.record(OUTCOME, CONTEXT);
    const path = join(dataDir, OPERATIONAL_RECORDS_FILE);
    rmSync(path);
    mkdirSync(path);
    expect(() => evidence.record({ ...OUTCOME, status: "failed" }, CONTEXT)).toThrow();
    expect(evidence.list()).toEqual([RECORD]);
    rmSync(path, { recursive: true });
    evidence.record(OUTCOME, { ...CONTEXT, callId: "after-repair" });
    expect(createCallEvidence({ dataDir }).list()).toEqual([{ ...RECORD, callId: "after-repair" }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous view after a rewrite failure and rereads repaired files on retry", () => {
    const dataDir = temporaryDirectory();
    const evidence = createCallEvidence({ dataDir, now: () => NOW });
    evidence.record(OUTCOME, CONTEXT);
    const currentPath = join(dataDir, OPERATIONAL_RECORDS_FILE);
    rmSync(currentPath);
    // Reads succeed with a missing current file in a non-writable directory,
    // but creating the replacement must fail.
    chmodSync(dataDir, 0o500);
    try {
      expect(() => evidence.compact(NOW)).toThrow();
      expect(evidence.list()).toEqual([RECORD]);
    } finally {
      chmodSync(dataDir, 0o700);
    }
    createCallEvidence({ dataDir, now: () => NOW }).record(OUTCOME, { ...CONTEXT, callId: "actual-disk" });
    expect(evidence.compact(NOW)).toEqual({ removed: 0, kept: 1 });
    expect(evidence.list()).toEqual([{ ...RECORD, callId: "actual-disk" }]);
  });

  it("keeps the previous view when legacy removal fails after rewriting, then rereads physical rows on retry", () => {
    const dataDir = temporaryDirectory();
    const old = { ...RECORD, recordedAt: "2026-01-01T00:00:00.000Z" };
    const evidence = createCallEvidence({ dataDir, now: () => new Date(old.recordedAt) });
    evidence.record(OUTCOME, CONTEXT);
    const legacyPath = join(dataDir, "smoke-evidence.jsonl");
    const legacyBytes = `${JSON.stringify({ ...RECORD, callId: "legacy" })}\n`;
    writeFileSync(legacyPath, legacyBytes);
    chmodSync(dataDir, 0o500);
    try {
      expect(() => evidence.compact(NOW)).toThrow();
      expect(evidence.list()).toEqual([old]);
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
      // The rewrite already succeeded; there is no filesystem rollback.
      expect(createCallEvidence({ dataDir }).list()).toEqual([{ ...RECORD, callId: "legacy" }]);
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(evidence.compact(NOW)).toEqual({ removed: 0, kept: 2 });
    expect(evidence.list()).toEqual([{ ...RECORD, callId: "legacy" }]);
    expect(existsSync(legacyPath)).toBe(false);
  });
});
