import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONAL_RECORDS_FILE, createCallEvidence, type CallEvidence } from "../src/evidence.js";
import { BUDGET_LEDGER_FILE } from "../src/budget.js";
import { createCallLifecycleManager, type CallLifecycleManagerOptions } from "../src/lifecycle.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  bookingWithPendingAppointment,
  incomingCallPayload,
  recordedEvidence,
  signedHeaders,
} from "./helpers.js";

const REQUIRED_MODEL = "grok-voice-think-fast-2.0";

function createManager(options: {
  sockets: FakeRealtimeSocket[];
  hangups?: string[];
  hangupCall?: CallLifecycleManagerOptions["hangupCall"];
  booking?: CallLifecycleManagerOptions["booking"];
  dataDir?: string;
  maxCallDurationMs?: number;
  evidence?: CallEvidence;
  perMinuteMicroUsd?: number;
  now?: () => Date;
}) {
  return createCallLifecycleManager({
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    maxConcurrentCalls: 1,
    availabilityTool: createSyntheticAvailabilityTool(),
    connectWebSocket: (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      options.sockets.push(socket);
      return socket;
    },
    hangupCall: options.hangupCall ?? (async (callId) => {
      options.hangups?.push(callId);
    }),
    booking: options.booking,
    dataDir: options.dataDir,
    evidence: options.evidence,
    perMinuteMicroUsd: options.perMinuteMicroUsd,
    now: options.now,
    maxCallDurationMs: options.maxCallDurationMs,
    referenceTime: new Date("2026-09-07T14:00:00-04:00"),
  });
}

describe("scheduling call lifecycle", () => {
  it("retries pending startup recovery on the first webhook before admitting its Scheduling call", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-first-recovery-"));
    const sockets: FakeRealtimeSocket[] = [];
    let attempts = 0;
    try {
      const manager = createManager({
        dataDir,
        sockets,
        booking: bookingWithPendingAppointment(dataDir, () => ++attempts === 1 ? "unresolved" : "booked"),
      });
      expect(manager.recoveryStatus().reason).toBe("recovery_pending");
      const response = await manager.handleWebhook(signedHeaders(incomingCallPayload({ callId: "call-first-recovery" })));
      expect(response.statusCode).toBe(200);
      expect(attempts).toBe(2);
      expect(sockets).toHaveLength(1);
      sockets[0]!.close();
      await recordedEvidence(() => manager.listEvidence(), "call-first-recovery");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("releases the provisional slot when a pending readiness assessment rejects", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-readiness-failure-"));
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: Array<{ callId: string; active: number }> = [];
    const failure = new Error("transient Calendar reconciliation failure");
    let attempts = 0;
    let resumeAssessment!: () => void;
    const assessmentGate = new Promise<void>((resolve) => { resumeAssessment = resolve; });
    try {
      const manager = createManager({
        dataDir,
        sockets,
        booking: bookingWithPendingAppointment(dataDir, async () => {
          attempts += 1;
          if (attempts === 1) return "unresolved";
          if (attempts === 2) {
            await assessmentGate;
            throw failure;
          }
          return "booked";
        }),
        hangupCall: async (callId) => {
          hangups.push({ callId, active: manager.activeCallCount() });
          if (callId === "call-readiness-failure") throw new Error("hangup unavailable");
        },
      });
      const failed = signedHeaders(incomingCallPayload({ callId: "call-readiness-failure" }));
      const later = signedHeaders(incomingCallPayload({ callId: "call-readiness-recovered" }), {
        webhookId: "evt-readiness-recovered",
      });
      const budgetPath = join(dataDir, BUDGET_LEDGER_FILE);
      const initialBudget = readFileSync(budgetPath, "utf8");
      const request = manager.handleWebhook(failed);
      try {
        expect(manager.activeCallCount()).toBe(1);
        await vi.waitFor(() => expect(attempts).toBe(2));
        expect(await manager.handleWebhook(later)).toEqual({
          statusCode: 429,
          body: '{"error":"concurrency_limit_reached"}',
        });
        expect(manager.activeCallCount()).toBe(1);
        expect(sockets).toHaveLength(0);
      } finally {
        resumeAssessment();
        await expect(request).rejects.toBe(failure);
      }

      expect(manager.activeCallCount()).toBe(0);
      expect(hangups).toEqual([
        { callId: "call-readiness-recovered", active: 1 },
        { callId: "call-readiness-failure", active: 0 },
      ]);
      expect(manager.listEvidence()).toEqual([]);
      expect(manager.budgetSnapshot()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });
      expect(readFileSync(budgetPath, "utf8")).toBe(initialBudget);
      expect(existsSync(join(dataDir, "active-call.json"))).toBe(false);
      expect(await manager.handleWebhook(failed)).toEqual({
        statusCode: 409,
        body: '{"error":"duplicate_delivery"}',
      });

      expect(await manager.handleWebhook(later)).toEqual({
        statusCode: 200,
        body: '{"status":"admitted","call_id":"call-readiness-recovered"}',
      });
      expect(attempts).toBe(3);
      expect(sockets).toHaveLength(1);
      sockets[0]!.close();
      await recordedEvidence(() => manager.listEvidence(), "call-readiness-recovered");
    } finally {
      for (const socket of sockets) socket.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves recovery, operator pause, then budget rejection precedence and releases refused calls", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-recovery-precedence-"));
    const hangups: string[] = [];
    const options = {
      webhookSecret: WEBHOOK_SECRET,
      apiKey: "test-xai-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      dataDir,
      pauseAdmissions: true,
      monthlyTargetMicroUsd: 1,
      hangupCall: async (callId: string) => { hangups.push(callId); },
    };
    try {
      writeFileSync(join(dataDir, "budget-ledger.json"), "{}\n");
      const incomplete = createCallLifecycleManager(options);
      const first = signedHeaders(incomingCallPayload({ callId: "call-incomplete" }));
      const recoveryRefusal = await incomplete.handleWebhook(first);
      expect(recoveryRefusal).toEqual({ statusCode: 503, body: '{"error":"restored_state_incomplete"}' });
      expect(incomplete.activeCallCount()).toBe(0);
      expect(JSON.parse((await incomplete.handleWebhook(first)).body)).toEqual({ error: "duplicate_delivery" });

      rmSync(join(dataDir, "budget-ledger.json"));
      const complete = createCallLifecycleManager(options);
      const operatorRefusal = await complete.handleWebhook(signedHeaders(incomingCallPayload({ callId: "call-paused" }), {
        webhookId: "evt-paused",
      }));
      expect(operatorRefusal).toEqual({ statusCode: 503, body: '{"error":"operator_paused"}' });
      expect(complete.activeCallCount()).toBe(0);
      complete.resumeAdmissions();
      const budgetRefusal = await complete.handleWebhook(signedHeaders(incomingCallPayload({ callId: "call-exhausted" }), {
        webhookId: "evt-exhausted",
      }));
      expect(budgetRefusal).toEqual({ statusCode: 503, body: '{"error":"budget_exhausted"}' });
      expect(complete.activeCallCount()).toBe(0);
      expect(hangups).toEqual(["call-incomplete", "call-paused", "call-exhausted"]);
      expect(existsSync(join(dataDir, "active-call.json"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("releases the slot and leaves usage reserved when terminal settlement fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-settlement-failure-"));
    const sockets: FakeRealtimeSocket[] = [];
    const now = new Date("2026-11-15T15:00:00.000Z");
    const settlementActiveCounts: number[] = [];
    let settling = false;
    try {
      const manager = createManager({
        dataDir,
        sockets,
        now: () => {
          if (settling) {
            settlementActiveCounts.push(manager.activeCallCount());
            if (settlementActiveCounts.length === 1) throw new Error("budget clock unavailable");
          }
          return now;
        },
      });
      const input = signedHeaders(incomingCallPayload({ callId: "call-settlement-failure" }));
      expect((await manager.handleWebhook(input)).statusCode).toBe(200);
      const reserved = manager.budgetSnapshot().reservedMicroUsd;
      expect(reserved).toBeGreaterThan(0);

      settling = true;
      sockets[0]!.close();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settlementActiveCounts).toEqual([0]);
      expect(manager.activeCallCount()).toBe(0);
      expect(manager.budgetSnapshot()).toMatchObject({ reservedMicroUsd: reserved, spentMicroUsd: 0 });
      expect(manager.listEvidence()).toEqual([]);
      const restarted = createManager({ dataDir, sockets: [], now: () => now });
      expect(restarted.budgetSnapshot()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: reserved });
    } finally {
      for (const socket of sockets) socket.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("settles a rejected Telephone session start once before recording bounded evidence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-start-rejection-"));
    const sockets: FakeRealtimeSocket[] = [];
    const recordingStates: Array<{ active: number; reserved: number }> = [];
    let starts = 0;
    try {
      const evidence = createCallEvidence({
        dataDir,
        now: () => {
          recordingStates.push({
            active: manager.activeCallCount(),
            reserved: manager.budgetSnapshot().reservedMicroUsd,
          });
          return new Date();
        },
      });
      const manager = createManager({
        dataDir,
        evidence,
        sockets,
        booking: {
          definitions: () => [],
          openCall: () => {
            starts += 1;
            throw new Error("internal Appointment setup failure");
          },
        },
      });
      const callId = "call-rejected-start";
      const response = await manager.handleWebhook(signedHeaders(incomingCallPayload({ callId })));

      expect(response).toEqual({
        statusCode: 200,
        body: '{"status":"admitted","call_id":"call-rejected-start"}',
      });
      expect(await recordedEvidence(() => manager.listEvidence(), callId)).toMatchObject({
        status: "failed",
        error: "coordinator_error",
        durationMs: 0,
        toolRoundTrips: 0,
      });
      expect(starts).toBe(1);
      expect(sockets).toHaveLength(0);
      expect(recordingStates).toEqual([{ active: 0, reserved: 0 }]);
      expect(existsSync(join(dataDir, "active-call.json"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each(["append", "projection"])("releases a call and settles usage once before evidence %s fails, without retrying finalization", async (failure) => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-evidence-append-failure-"));
    const sockets: FakeRealtimeSocket[] = [];
    let failProjection = false;
    const recordingStates: Array<{ active: number; reserved: number; spent: number }> = [];
    const evidence = createCallEvidence({ dataDir, now: () => {
      const budget = manager.budgetSnapshot();
      recordingStates.push({ active: manager.activeCallCount(), reserved: budget.reservedMicroUsd, spent: budget.spentMicroUsd });
      if (failProjection) throw new Error("evidence clock unavailable");
      return new Date();
    } });
    const manager = createManager({ sockets, dataDir, evidence });
    const path = join(dataDir, OPERATIONAL_RECORDS_FILE);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await manager.handleWebhook(signedHeaders(incomingCallPayload({ callId: "append-before" })));
      sockets[0]!.close();
      await recordedEvidence(() => manager.listEvidence(), "append-before");
      const previous = manager.listEvidence();
      const previousBytes = readFileSync(path, "utf8");
      const spentBefore = manager.budgetSnapshot().spentMicroUsd;
      await manager.handleWebhook(signedHeaders(incomingCallPayload({ callId: "append-failure" }), {
        webhookId: "evt-append-failure",
      }));
      if (failure === "append") {
        rmSync(path);
        mkdirSync(path);
      } else {
        failProjection = true;
      }
      vi.setSystemTime(Date.now() + 60_000);
      sockets[1]!.close();
      await vi.waitFor(() => expect(manager.activeCallCount()).toBe(0));
      expect(existsSync(join(dataDir, "active-call.json"))).toBe(false);
      expect(manager.budgetSnapshot()).toMatchObject({
        reservedMicroUsd: 0,
        spentMicroUsd: spentBefore + 83_200,
      });
      expect(manager.listEvidence()).toEqual(previous);
      expect(recordingStates).toHaveLength(2);
      expect(recordingStates[1]).toEqual({ active: 0, reserved: 0, spent: spentBefore + 83_200 });
      if (failure === "append") {
        rmSync(path, { recursive: true });
        writeFileSync(path, previousBytes, { mode: 0o600 });
      } else {
        expect(readFileSync(path, "utf8")).toBe(previousBytes);
        failProjection = false;
      }
      expect(createCallEvidence({ dataDir }).list()).toEqual(previous);

      await manager.handleWebhook(signedHeaders(incomingCallPayload({ callId: "append-after" }), {
        webhookId: "evt-append-after",
      }));
      sockets[2]!.close();
      await recordedEvidence(() => manager.listEvidence(), "append-after");
      expect(recordingStates).toHaveLength(3);
      expect(manager.listEvidence().map((row) => row.callId)).toEqual(["append-before", "append-after"]);
    } finally {
      for (const socket of sockets) socket.close();
      vi.useRealTimers();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("uses the configured fallback rate and preserves a supplied evidence owner's settings (supplied: %s)", async (supplied) => {
    const sockets: FakeRealtimeSocket[] = [];
    const ownerTime = new Date("2026-11-01T12:00:00.000Z");
    const evidence = supplied ? createCallEvidence({ perMinuteMicroUsd: 60_000, now: () => ownerTime }) : undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
    const manager = createManager({
      sockets,
      evidence,
      perMinuteMicroUsd: 120_000,
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    try {
      await manager.handleWebhook(signedHeaders(incomingCallPayload({ callId: "configured-rate" })));
      vi.setSystemTime(new Date("2026-11-17T12:01:00.000Z"));
      sockets[0]!.close();
      const record = await recordedEvidence(() => manager.listEvidence(), "configured-rate");
      expect(record).toMatchObject({
        durationMs: 60_000,
        estimatedCostMicroUsd: supplied ? 60_000 : 120_000,
        recordedAt: supplied ? ownerTime.toISOString() : "2026-11-17T12:01:00.000Z",
      });
      expect(manager.budgetSnapshot()).toMatchObject({ spentMicroUsd: 120_000, reservedMicroUsd: 0 });
    } finally {
      for (const socket of sockets) socket.close();
      vi.useRealTimers();
    }
  });

  it("admits a signed call, completes a synthetic availability round trip, records masked evidence, and releases the slot", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-evidence-"));
    const manager = createManager({ sockets, hangups, dataDir });
    const payload = incomingCallPayload({ callId: "call-life-1" });

    const response = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_lifecycle_1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "admitted",
      call_id: "call-life-1",
    });
    expect(sockets).toHaveLength(1);

    const socket = sockets[0]!;
    expect(socket.url).toContain("call_id=call-life-1");
    expect(socket.url).toContain("reasoning.effort=high");
    expect(socket.url).not.toContain("model=");
    expect(socket.headers.Authorization).toBe("Bearer test-xai-key");

    socket.receive({
      type: "session.created",
      session: { model: REQUIRED_MODEL },
    });

    const update = socket.messageOfType("session.update") as {
      session: {
        reasoning: { effort: string };
        tools: Array<{ name: string }>;
        instructions: string;
      };
    };
    expect(update.session.reasoning.effort).toBe("high");
    expect(update.session.tools[0]?.name).toBe("check_availability");
    expect(update.session.instructions.toLowerCase()).toContain("scheduling");
    expect(update.session.instructions.toLowerCase()).toContain("america/new_york");
    expect(update.session.instructions.toLowerCase()).not.toContain("synthetic");

    socket.receive({
      type: "session.updated",
      session: {
        model: REQUIRED_MODEL,
        reasoning: { effort: "high" },
      },
    });
    expect(socket.messageOfType("response.create")).toBeDefined();

    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-1",
      name: "check_availability",
      arguments: JSON.stringify({ date: "2026-09-11" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const toolOutput = socket.sent.find(
      (message): message is {
        type: string;
        item: { type: string; call_id: string; output: string };
      } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "conversation.item.create",
    );
    expect(toolOutput?.item.call_id).toBe("tool-1");
    const output = JSON.parse(toolOutput!.item.output) as {
      status: string;
      isSynthetic: boolean;
    };
    expect(output.status).toBe("available");
    expect(output.isSynthetic).toBe(true);

    socket.close();

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-life-1");
    expect(evidence).toMatchObject({
      callId: "call-life-1",
      connectionRoute: "direct_sip",
      status: "completed",
      modelVerified: REQUIRED_MODEL,
      reasoningVerified: "high",
      toolRoundTrips: 1,
      callerNumberMasked: "+1***4567",
      calledNumber: "+18005550199",
    });
    expect(evidence?.callerNumberMasked).not.toContain("5551234567");
    expect(evidence).not.toHaveProperty("audio");
    expect(evidence).not.toHaveProperty("transcript");
    expect(evidence).not.toHaveProperty("recording");
    expect(manager.activeCallCount()).toBe(0);

    const stored = (await readFile(join(dataDir, OPERATIONAL_RECORDS_FILE), "utf8"))
      .trim()
      .split("\n");
    expect(JSON.parse(stored[0]!)).toMatchObject({ callId: "call-life-1" });
    expect(hangups).toEqual(["call-life-1"]);

    const restarted = createManager({ sockets: [], dataDir });
    expect(restarted.listEvidence().some((entry) => entry.callId === "call-life-1")).toBe(
      true,
    );
  });

  it("records a bounded failure and releases the slot when the provider errors", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const manager = createManager({ sockets });
    const payload = incomingCallPayload({
      callId: "call-life-2",
      callerNumber: "+15559876543",
    });

    await manager.handleWebhook(signedHeaders(payload, { webhookId: "evt_lifecycle_2" }));
    sockets[0]!.receive({
      type: "error",
      error: { message: "Simulated upstream provider outage" },
    });

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-life-2");
    expect(evidence?.status).toBe("failed");
    expect(evidence?.error).toBe("provider_error");
    expect(evidence?.callerNumberMasked).toBe("+1***6543");
    expect(manager.activeCallCount()).toBe(0);
  });

  it("hangs up an unauthorized inbound call instead of leaving the PSTN leg ringing", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createCallLifecycleManager({
      webhookSecret: WEBHOOK_SECRET,
      apiKey: "test-xai-key",
      maxConcurrentCalls: 1,
      allowedCallerNumbers: ["+15550001111"],
      availabilityTool: createSyntheticAvailabilityTool(),
      connectWebSocket: (url, headers) => {
        const socket = new FakeRealtimeSocket(url, headers);
        sockets.push(socket);
        return socket;
      },
      hangupCall: async (callId) => {
        hangups.push(callId);
      },
    });
    const payload = incomingCallPayload({ callId: "call-unauth-sip" });
    const response = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_unauth_sip" }),
    );
    expect(response.statusCode).toBe(403);
    expect(hangups).toEqual(["call-unauth-sip"]);
    expect(sockets).toHaveLength(0);
    expect(manager.activeCallCount()).toBe(0);
  });

  it("verifies the model from session.updated when session.created omits it", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const manager = createManager({ sockets });
    const payload = incomingCallPayload({ callId: "call-late-model" });

    await manager.handleWebhook(signedHeaders(payload, { webhookId: "evt_late_model" }));
    sockets[0]!.receive({ type: "session.created", session: {} });
    sockets[0]!.receive({
      type: "session.updated",
      session: {
        model: REQUIRED_MODEL,
        reasoning: { effort: "high" },
      },
    });
    sockets[0]!.close();

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-late-model");
    expect(evidence?.status).toBe("completed");
    expect(evidence?.modelVerified).toBe(REQUIRED_MODEL);
  });

  it("accepts grok-voice-latest as the documented alias for grok-voice-think-fast-2.0", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const manager = createManager({ sockets });
    const payload = incomingCallPayload({ callId: "call-alias" });

    await manager.handleWebhook(signedHeaders(payload, { webhookId: "evt_alias" }));
    sockets[0]!.receive({
      type: "session.created",
      session: { model: "grok-voice-latest" },
    });
    sockets[0]!.receive({
      type: "session.updated",
      session: {
        model: "grok-voice-latest",
        reasoning: { effort: "high" },
      },
    });
    sockets[0]!.close();

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-alias");
    expect(evidence?.status).toBe("completed");
    expect(evidence?.modelVerified).toBe(REQUIRED_MODEL);
    expect(evidence?.reasoningVerified).toBe("high");
  });

  it("fails boundedly when the SIP session reports an unexpected model", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const manager = createManager({ sockets });
    const payload = incomingCallPayload({ callId: "call-wrong-model" });

    await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_wrong_model" }),
    );
    sockets[0]!.receive({
      type: "session.created",
      session: { model: "grok-voice-think-fast-1.0" },
    });

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-wrong-model");
    expect(evidence?.status).toBe("failed");
    expect(evidence?.error).toBe("model_mismatch");
    expect(manager.activeCallCount()).toBe(0);
  });

  it("ends a call when the duration limit is reached", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createManager({ sockets, hangups, maxCallDurationMs: 20 });
    const payload = incomingCallPayload({ callId: "call-timeout" });

    await manager.handleWebhook(signedHeaders(payload, { webhookId: "evt_timeout" }));
    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-timeout");
    expect(evidence?.status).toBe("completed");
    expect(evidence?.error).toBe("duration_limit_reached");
    expect(hangups).toContain("call-timeout");
    expect(manager.activeCallCount()).toBe(0);
  });
});
