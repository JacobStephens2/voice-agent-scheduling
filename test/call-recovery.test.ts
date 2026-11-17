import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppointmentLedger, type AppointmentLedger } from "../src/calendar/appointment-ledger.js";
import { OPERATIONAL_RECORDS_FILE, createCallEvidence, type CallEvidence } from "../src/evidence.js";
import { BUDGET_LEDGER_FILE } from "../src/budget.js";
import { createCallRecovery } from "../src/recovery.js";

const NOW = new Date("2026-11-15T15:00:00.000Z");
const directories: string[] = [];

function storage() {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-call-recovery-"));
  directories.push(dataDir);
  return {
    dataDir,
    ledger: createAppointmentLedger({ dataDir }),
    evidence: createCallEvidence({ dataDir, now: () => new Date("2026-09-01T14:00:00.000Z") }),
    budget: { now: () => NOW },
  };
}

function appointment(ledger: AppointmentLedger, status: "pending" | "failed" = "pending") {
  return ledger.record({
    operationId: `op-${status}`,
    eventId: `event-${status}`,
    callId: "call-interrupted",
    proposalId: "proposal-interrupted",
    calendarId: "primary",
    startUtc: "2026-09-01T14:00:00.000Z",
    status,
    recordedAt: "2026-09-01T14:00:00.000Z",
  });
}

function oldEvidence(evidence: CallEvidence) {
  evidence.record({
    callId: "call-old",
    status: "completed",
    durationMs: 60_000,
    toolRoundTrips: 0,
    durationWarningSent: false,
  }, {
    callId: "call-old",
    callerNumber: "+15551239876",
    calledNumber: "+18005550199",
  });
}

function pendingStorage() {
  const owners = storage();
  const recovery = createCallRecovery(owners);
  recovery.reserve("call-seed");
  recovery.settle("call-seed", 0);
  appointment(owners.ledger);
  return owners;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Scheduling call recovery", () => {
  it("admits calls in an entirely fresh durable directory", async () => {
    const recovery = createCallRecovery(storage());

    expect(await recovery.beforeAdmission()).toEqual({
      admissionAvailable: true,
      missing: [],
      reconciliation: [],
    });
    expect(recovery.reserve("call-fresh").admitted).toBe(true);
    expect(recovery.snapshot().budget.reservedMicroUsd).toBe(1_040_000);
    expect(recovery.settle("call-fresh", 60_000)).toBe(83_200);
    expect(recovery.snapshot().budget.spentMicroUsd).toBe(83_200);
  });

  it.each(["Appointment ledger", "Scheduling call evidence"])(
    "keeps a missing budget absent when %s exists, without cleanup or reconciliation",
    async (source) => {
      const owners = storage();
      if (source === "Appointment ledger") appointment(owners.ledger);
      else oldEvidence(owners.evidence);
      const recordFile = join(owners.dataDir, source === "Appointment ledger" ? "bookings.jsonl" : OPERATIONAL_RECORDS_FILE);
      const original = readFileSync(recordFile, "utf8");
      let reconciliations = 0;
      const recovery = createCallRecovery({
        ...owners,
        reconcile: async () => { reconciliations += 1; return []; },
      });

      expect(await recovery.beforeAdmission()).toEqual({
        admissionAvailable: false,
        reason: "restored_state_incomplete",
        missing: [BUDGET_LEDGER_FILE],
        reconciliation: [],
      });
      expect(recovery.snapshot().budget.spentMicroUsd).toBe(0);
      expect(existsSync(join(owners.dataDir, BUDGET_LEDGER_FILE))).toBe(false);
      expect(readFileSync(recordFile, "utf8")).toBe(original);
      expect(reconciliations).toBe(0);
    },
  );

  it.each(["not-json{\n", "{}\n", '{"periodId":"2026-11","spentMicroUsd":"12000000","reservations":{}}\n'])(
    "preserves an unusable budget and retained records: %s",
    async (original) => {
      const owners = storage();
      appointment(owners.ledger);
      appointment(owners.ledger, "failed");
      oldEvidence(owners.evidence);
      const budgetPath = join(owners.dataDir, BUDGET_LEDGER_FILE);
      writeFileSync(budgetPath, original);
      const bookings = readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8");
      const evidence = readFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "utf8");
      let reconciliations = 0;
      const recovery = createCallRecovery({
        ...owners,
        reconcile: async () => { reconciliations += 1; return []; },
      });

      expect((await recovery.beforeAdmission()).reason).toBe("restored_state_incomplete");
      expect(readFileSync(budgetPath, "utf8")).toBe(original);
      expect(readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8")).toBe(bookings);
      expect(readFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "utf8")).toBe(evidence);
      expect(recovery.snapshot().budget.spentMicroUsd).toBe(0);
      expect(reconciliations).toBe(0);
    },
  );

  it("blocks an unreadable budget path without replacing it", async () => {
    const owners = storage();
    const budgetPath = join(owners.dataDir, BUDGET_LEDGER_FILE);
    mkdirSync(budgetPath);
    const recovery = createCallRecovery(owners);
    expect((await recovery.beforeAdmission()).missing).toEqual([BUDGET_LEDGER_FILE]);
    expect(readdirSync(budgetPath)).toEqual([]);
  });

  it("keeps missing callback salt sticky while preserving budget spend and stale call identity", async () => {
    const owners = storage();
    const first = createCallRecovery(owners);
    first.reserve("call-interrupted");
    const row = appointment(owners.ledger);
    owners.ledger.record({ ...row, numberHash: owners.ledger.hashCallbackNumber("+15551239876") });
    oldEvidence(owners.evidence);
    const bookings = readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8");
    const evidence = readFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "utf8");
    const saltPath = join(owners.dataDir, "callback-salt");
    const salt = readFileSync(saltPath);
    rmSync(saltPath);
    let reconciliations = 0;
    const recovery = createCallRecovery({
      ...owners,
      ledger: createAppointmentLedger({ dataDir: owners.dataDir }),
      reconcile: async () => { reconciliations += 1; return []; },
    });

    expect((await recovery.beforeAdmission()).missing).toEqual(["callback-salt"]);
    expect(recovery.snapshot()).toMatchObject({
      recoveredStaleAdmissions: ["call-interrupted"],
      budget: { spentMicroUsd: 1_040_000, reservedMicroUsd: 0 },
    });
    expect(existsSync(join(owners.dataDir, "active-call.json"))).toBe(false);
    expect(readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8")).toBe(bookings);
    expect(readFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "utf8")).toBe(evidence);
    writeFileSync(saltPath, salt);
    expect((await recovery.beforeAdmission()).reason).toBe("restored_state_incomplete");
    expect(reconciliations).toBe(0);
  });

  it("retains interrupted usage across restarts and pairs live claims with reservations", () => {
    const owners = storage();
    const first = createCallRecovery(owners);
    expect(first.reserve("call-interrupted").admitted).toBe(true);
    const claimPath = join(owners.dataDir, "active-call.json");
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual({
      callId: "call-interrupted",
      admittedAt: expect.any(String),
    });

    const restarted = createCallRecovery(owners);
    expect(restarted.snapshot()).toMatchObject({
      recoveredStaleAdmissions: ["call-interrupted"],
      budget: { spentMicroUsd: 1_040_000, reservedMicroUsd: 0 },
    });
    expect(existsSync(claimPath)).toBe(false);
    const again = createCallRecovery(owners);
    expect(again.snapshot().budget.spentMicroUsd).toBe(1_040_000);
    expect(again.snapshot().recoveredStaleAdmissions).toEqual([]);
    again.reserve("call-live");
    expect(again.settle("call-live", 60_000)).toBe(83_200);
    expect(existsSync(claimPath)).toBe(false);
    expect(again.snapshot().budget).toMatchObject({ spentMicroUsd: 1_123_200, reservedMicroUsd: 0 });
  });

  it("writes no claim for a refused reservation", () => {
    const owners = storage();
    const recovery = createCallRecovery({
      ...owners,
      budget: { ...owners.budget, monthlyTargetMicroUsd: 1, fixedMonthlyMicroUsd: 0 },
    });
    expect(recovery.reserve("call-refused")).toMatchObject({ admitted: false, reason: "budget_exhausted" });
    expect(existsSync(join(owners.dataDir, "active-call.json"))).toBe(false);
  });

  it("clears only a matching claim before settling usage", () => {
    const owners = storage();
    const recovery = createCallRecovery(owners);
    recovery.reserve("call-first");
    recovery.reserve("call-second");
    const claimPath = join(owners.dataDir, "active-call.json");
    const secondClaim = readFileSync(claimPath, "utf8");
    recovery.settle("call-first", 60_000);
    expect(readFileSync(claimPath, "utf8")).toBe(secondClaim);
    expect(recovery.snapshot().budget).toMatchObject({ spentMicroUsd: 83_200, reservedMicroUsd: 1_040_000 });
    recovery.settle("call-second", 60_000);
    expect(existsSync(claimPath)).toBe(false);
    expect(recovery.snapshot().budget).toMatchObject({ spentMicroUsd: 166_400, reservedMicroUsd: 0 });
  });

  it("keeps claim I/O best effort", () => {
    const owners = storage();
    mkdirSync(join(owners.dataDir, "active-call.json"));
    const recovery = createCallRecovery(owners);
    expect(recovery.reserve("call-live").admitted).toBe(true);
    expect(recovery.settle("call-live", 60_000)).toBe(83_200);
    expect(recovery.snapshot().budget.reservedMicroUsd).toBe(0);
  });

  it("compacts shared owners before reconciliation, preserving unresolved Appointment identities", async () => {
    const owners = pendingStorage();
    const pending = owners.ledger.unresolvedOperations()[0];
    appointment(owners.ledger, "failed");
    oldEvidence(owners.evidence);
    let observed;
    const recovery = createCallRecovery({
      ...owners,
      reconcile: async () => {
        observed = {
          pending: owners.ledger.unresolvedOperations(),
          failed: owners.ledger.latestForOperation("op-failed"),
          evidence: owners.evidence.list(),
        };
        return [{ status: "resolved" }];
      },
    });
    expect(await recovery.beforeAdmission()).toMatchObject({ admissionAvailable: true });
    expect(observed).toEqual({ pending: [pending], failed: undefined, evidence: [] });
    expect(readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8")).toBe(`${JSON.stringify(pending)}\n`);
    expect(readFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "utf8")).toBe("");
  });

  it("throws on evidence cleanup failure after recovering usage and claim, before compacting the Appointment ledger", () => {
    const owners = pendingStorage();
    createCallRecovery(owners).reserve("call-interrupted");
    appointment(owners.ledger, "failed");
    const bookings = readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8");
    writeFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "not-json\n");
    let reconciliations = 0;
    expect(() => createCallRecovery({
      ...owners,
      reconcile: async () => { reconciliations += 1; return []; },
    })).toThrow("Failed to load");
    expect(readFileSync(join(owners.dataDir, "bookings.jsonl"), "utf8")).toBe(bookings);
    expect(existsSync(join(owners.dataDir, "active-call.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(owners.dataDir, BUDGET_LEDGER_FILE), "utf8"))).toMatchObject({
      spentMicroUsd: 1_040_000,
      reservations: {},
    });
    expect(reconciliations).toBe(0);
  });

  it("throws on Appointment cleanup failure after compacting evidence and before reconciliation", () => {
    const owners = pendingStorage();
    oldEvidence(owners.evidence);
    const bookingsPath = join(owners.dataDir, "bookings.jsonl");
    rmSync(bookingsPath);
    mkdirSync(bookingsPath);
    let reconciliations = 0;
    expect(() => createCallRecovery({
      ...owners,
      reconcile: async () => { reconciliations += 1; return []; },
    })).toThrow();
    expect(owners.evidence.list()).toEqual([]);
    expect(readFileSync(join(owners.dataDir, OPERATIONAL_RECORDS_FILE), "utf8")).toBe("");
    expect(reconciliations).toBe(0);
  });

  it("awaits deferred initial reconciliation and retries pending recovery on the first admission", async () => {
    const owners = pendingStorage();
    let finish!: (rows: { status: string }[]) => void;
    const initial = new Promise<{ status: string }[]>((resolve) => { finish = resolve; });
    let attempts = 0;
    const recovery = createCallRecovery({
      ...owners,
      reconcile: () => ++attempts === 1 ? initial : Promise.resolve([{ status: "resolved" }]),
    });
    expect(recovery.snapshot().recovery.reason).toBe("recovery_pending");
    let completed = false;
    const readiness = recovery.beforeAdmission().then((result) => { completed = true; return result; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(attempts).toBe(1);
    finish([{ status: "unresolved" }]);
    expect(await readiness).toMatchObject({ admissionAvailable: true, reconciliation: [{ status: "resolved" }] });
    expect(attempts).toBe(2);
  });

  it("makes exactly one pending retry per admission and permits later recovery", async () => {
    const owners = pendingStorage();
    let attempts = 0;
    const recovery = createCallRecovery({
      ...owners,
      reconcile: async () => [{ status: ++attempts < 4 ? "unresolved" : "resolved" }],
    });
    expect((await recovery.beforeAdmission()).reason).toBe("recovery_pending");
    expect(attempts).toBe(2);
    expect((await recovery.beforeAdmission()).reason).toBe("recovery_pending");
    expect(attempts).toBe(3);
    expect((await recovery.beforeAdmission()).admissionAvailable).toBe(true);
    expect(attempts).toBe(4);
    await recovery.beforeAdmission();
    expect(attempts).toBe(4);
  });

  it("makes newly discovered incomplete state sticky without reconciling again", async () => {
    const owners = pendingStorage();
    let attempts = 0;
    const recovery = createCallRecovery({
      ...owners,
      reconcile: async () => { attempts += 1; return [{ status: "unresolved" }]; },
    });
    const budgetPath = join(owners.dataDir, BUDGET_LEDGER_FILE);
    const original = readFileSync(budgetPath);
    rmSync(budgetPath);
    expect((await recovery.beforeAdmission()).reason).toBe("restored_state_incomplete");
    writeFileSync(budgetPath, original);
    expect((await recovery.beforeAdmission()).reason).toBe("restored_state_incomplete");
    expect(attempts).toBe(1);
  });

  it("preserves availability when no reconciliation callback is supplied", async () => {
    const recovery = createCallRecovery(pendingStorage());
    expect(recovery.snapshot().recovery.reason).toBe("recovery_pending");
    expect(await recovery.beforeAdmission()).toEqual({ admissionAvailable: true, missing: [], reconciliation: [] });
  });

  it("skips durable work without a durable directory even when the shared owners hold records", async () => {
    const owners = pendingStorage();
    oldEvidence(owners.evidence);
    const claimPath = join(owners.dataDir, "active-call.json");
    writeFileSync(claimPath, '{"callId":"other-process"}');
    rmSync(join(owners.dataDir, BUDGET_LEDGER_FILE));
    let reconciliations = 0;
    const recovery = createCallRecovery({
      ledger: owners.ledger,
      evidence: owners.evidence,
      reconcile: async () => { reconciliations += 1; return [{ status: "unresolved" }]; },
    });
    expect((await recovery.beforeAdmission()).admissionAvailable).toBe(true);
    recovery.reserve("call-memory");
    recovery.settle("call-memory", 60_000);
    expect(owners.evidence.list()).toHaveLength(1);
    expect(owners.ledger.unresolvedOperations()).toHaveLength(1);
    expect(readFileSync(claimPath, "utf8")).toBe('{"callId":"other-process"}');
    expect(existsSync(join(owners.dataDir, BUDGET_LEDGER_FILE))).toBe(false);
    expect(reconciliations).toBe(0);
  });

  it("returns detached snapshots without reading storage, cleaning records, or reconciling", async () => {
    const owners = pendingStorage();
    let attempts = 0;
    const recovery = createCallRecovery({
      ...owners,
      reconcile: async () => { attempts += 1; return [{ status: "unresolved" }]; },
    });
    await recovery.beforeAdmission();
    oldEvidence(owners.evidence);
    const evidencePath = join(owners.dataDir, OPERATIONAL_RECORDS_FILE);
    const evidence = readFileSync(evidencePath, "utf8");
    rmSync(join(owners.dataDir, BUDGET_LEDGER_FILE));
    const original = recovery.snapshot();
    const detached = recovery.snapshot();
    expect(detached).toEqual(original);
    expect(detached.recovery).not.toBe(original.recovery);
    expect(detached.recovery.missing).not.toBe(original.recovery.missing);
    expect(detached.recovery.reconciliation[0]).not.toBe(original.recovery.reconciliation[0]);
    expect(detached.recoveredStaleAdmissions).not.toBe(original.recoveredStaleAdmissions);
    expect(detached.budget).not.toBe(original.budget);
    expect(detached.recovery.reason).toBe("recovery_pending");
    expect(readFileSync(evidencePath, "utf8")).toBe(evidence);
    expect(attempts).toBe(2);
    expect((await recovery.beforeAdmission()).reason).toBe("restored_state_incomplete");
  });

  it("handles eager reconciliation rejection and rethrows it from every readiness call", async () => {
    const failure = new Error("unexpected Calendar adapter failure");
    let attempts = 0;
    const recovery = createCallRecovery({
      ...pendingStorage(),
      reconcile: async () => { attempts += 1; throw failure; },
    });
    // Give an unhandled rejection a full turn to surface before observing readiness.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(recovery.beforeAdmission()).rejects.toBe(failure);
    await expect(recovery.beforeAdmission()).rejects.toBe(failure);
    expect(recovery.snapshot().recovery.reason).toBe("recovery_pending");
    expect(attempts).toBe(1);
  });

  it("rejects unexpected admission-time assessment failures and permits a later retry", async () => {
    const failure = new Error("unexpected retry failure");
    let attempts = 0;
    const recovery = createCallRecovery({
      ...pendingStorage(),
      reconcile: async () => {
        attempts += 1;
        if (attempts === 2) throw failure;
        return [{ status: attempts === 1 ? "unresolved" : "resolved" }];
      },
    });
    await expect(recovery.beforeAdmission()).rejects.toBe(failure);
    expect((await recovery.beforeAdmission()).admissionAvailable).toBe(true);
    expect(attempts).toBe(3);
  });
});
