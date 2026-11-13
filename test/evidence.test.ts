import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONAL_RECORDS_FILE, createCallEvidence, type StructuredCallEvidence } from "../src/evidence.js";

const NOW = new Date("2026-11-13T15:00:00.000Z");
const RECORD: StructuredCallEvidence = {
  callId: "call-one",
  connectionRoute: "direct_sip",
  callerNumberMasked: "+1***9876",
  calledNumber: "+18005550199",
  status: "completed",
  durationMs: 12_000,
  toolRoundTrips: 1,
  estimatedCostMicroUsd: 17,
  recordedAt: NOW.toISOString(),
};
const directories: string[] = [];

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "scheduling-evidence-owner-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe.each(["memory", "durable"])("Scheduling call evidence (%s)", (mode) => {
  it("records bounded outcomes and reopens durable records", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir });
    expect(evidence.list()).toEqual([]);
    evidence.record(RECORD);
    expect(evidence.list()).toEqual([RECORD]);
    if (dataDir) {
      expect(createCallEvidence({ dataDir }).list()).toEqual([RECORD]);
    }
  });

  it("filters physical rows before choosing the latest retained call outcome", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir });
    evidence.record({ ...RECORD, recordedAt: "2026-10-14T15:00:00.000Z" });
    evidence.record({ ...RECORD, status: "failed", recordedAt: "2026-10-14T14:59:59.999Z" });
    evidence.record({ ...RECORD, callId: "invalid", recordedAt: "invalid" });
    evidence.record({ ...RECORD, callId: "future", recordedAt: "2026-12-01T15:00:00.000Z" });
    evidence.record({ ...RECORD, callId: "future", status: "failed", recordedAt: "2026-11-01T15:00:00.000Z" });

    expect(evidence.compact(NOW)).toEqual({ removed: 2, kept: 3 });
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
    const evidence = createCallEvidence({ dataDir });
    evidence.record(RECORD);
    evidence.record({ ...RECORD, callId: "call-two" });
    evidence.record({ ...RECORD, status: "failed", recordedAt: "2026-11-01T15:00:00.000Z" });
    expect(evidence.list()).toEqual([
      { ...RECORD, status: "failed", recordedAt: "2026-11-01T15:00:00.000Z" },
      { ...RECORD, callId: "call-two" },
    ]);
  });

  it("owns its incoming records and returns fresh arrays and record copies", () => {
    const dataDir = mode === "durable" ? temporaryDirectory() : undefined;
    const evidence = createCallEvidence({ dataDir });
    const incoming = { ...RECORD };
    evidence.record(incoming);
    incoming.callId = "mutated-input";
    const listed = evidence.list();
    Object.assign(listed[0]!, { callId: "mutated-output" });
    Object.assign(listed, { length: 0 });
    expect(evidence.list()).toEqual([RECORD]);
  });
});

describe("durable Scheduling call evidence", () => {
  it("loads legacy before current rows and migrates without deduplicating physical history", () => {
    const dataDir = temporaryDirectory();
    const legacyPath = join(dataDir, "smoke-evidence.jsonl");
    const legacy = { ...RECORD, callId: "legacy" };
    writeFileSync(legacyPath, `${JSON.stringify(RECORD)}\n${JSON.stringify(legacy)}\n`);
    const evidence = createCallEvidence({ dataDir });
    evidence.record({ ...RECORD, callId: "current" });
    const current = { ...RECORD, status: "failed" as const, recordedAt: "2026-11-01T15:00:00.000Z" };
    evidence.record(current);
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
    const evidence = createCallEvidence({ dataDir });
    evidence.record(RECORD);
    createCallEvidence({ dataDir }).record({ ...RECORD, callId: "late-current" });
    writeFileSync(join(dataDir, "smoke-evidence.jsonl"), `${JSON.stringify({ ...RECORD, callId: "late-legacy" })}\n`);
    expect(evidence.list()).toEqual([RECORD]);
    expect(evidence.compact(NOW)).toEqual({ removed: 0, kept: 3 });
    expect(evidence.list().map((row) => row.callId)).toEqual(["late-legacy", "call-one", "late-current"]);
  });

  it.each([OPERATIONAL_RECORDS_FILE, "smoke-evidence.jsonl"])(
    "refuses malformed %s at construction and cleanup without rewriting files or replacing its view",
    (filename) => {
      const dataDir = temporaryDirectory();
      const evidence = createCallEvidence({ dataDir });
      evidence.record(RECORD);
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
      const evidence = createCallEvidence({ dataDir });
      evidence.record(RECORD);
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
    const evidence = createCallEvidence({ dataDir });
    evidence.record(RECORD);
    const path = join(dataDir, OPERATIONAL_RECORDS_FILE);
    rmSync(path);
    mkdirSync(path);
    expect(() => evidence.record({ ...RECORD, status: "failed" })).toThrow();
    expect(evidence.list()).toEqual([RECORD]);
    rmSync(path, { recursive: true });
    evidence.record({ ...RECORD, callId: "after-repair" });
    expect(createCallEvidence({ dataDir }).list()).toEqual([{ ...RECORD, callId: "after-repair" }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous view after a rewrite failure and rereads repaired files on retry", () => {
    const dataDir = temporaryDirectory();
    const evidence = createCallEvidence({ dataDir });
    evidence.record(RECORD);
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
    createCallEvidence({ dataDir }).record({ ...RECORD, callId: "actual-disk" });
    expect(evidence.compact(NOW)).toEqual({ removed: 0, kept: 1 });
    expect(evidence.list()).toEqual([{ ...RECORD, callId: "actual-disk" }]);
  });

  it("keeps the previous view when legacy removal fails after rewriting, then rereads physical rows on retry", () => {
    const dataDir = temporaryDirectory();
    const evidence = createCallEvidence({ dataDir });
    const old = { ...RECORD, recordedAt: "2026-01-01T00:00:00.000Z" };
    evidence.record(old);
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
