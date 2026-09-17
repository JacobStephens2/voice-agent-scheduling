import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIRECT_SIP_MICRO_USD_PER_MINUTE,
  MONTHLY_TARGET_MICRO_USD_DEFAULT,
  createBudgetLedger,
  estimateCallCostMicroUsd,
  fullCallReservationMicroUsd,
} from "../src/budget.js";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import type { BookingTool } from "../src/session.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  REQUIRED_MODEL,
  WEBHOOK_SECRET,
  incomingCallPayload,
  recordedEvidence,
  signedHeaders,
} from "./helpers.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;

function fullCallReservation(): number {
  return fullCallReservationMicroUsd(
    TEN_MINUTES_MS,
    DIRECT_SIP_MICRO_USD_PER_MINUTE,
    0.25,
  );
}

function createStubBooking(options: {
  onExecute?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
} = {}): BookingTool & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    definitions: () => [
      {
        type: "function",
        name: "propose_appointment",
        description: "Record a proposal for readback.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        type: "function",
        name: "confirm_appointment",
        description: "Create the proposed appointment.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    execute: async (name, args) => {
      calls.push({ name, args });
      if (options.onExecute) {
        return options.onExecute(name, args);
      }
      return { status: "booked", message: "The appointment is booked." };
    },
    markReadbackFinished: () => undefined,
  };
}

function createBoundedManager(options: {
  sockets: FakeRealtimeSocket[];
  hangups?: string[];
  dataDir?: string;
  booking?: BookingTool;
  maxCallDurationMs?: number;
  warningLeadMs?: number;
  monthlyTargetMicroUsd?: number;
  fixedMonthlyMicroUsd?: number;
  perMinuteMicroUsd?: number;
  reserveMargin?: number;
}) {
  return createCallLifecycleManager({
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    maxConcurrentCalls: 1,
    availabilityTool: createSyntheticAvailabilityTool(),
    booking: options.booking,
    connectWebSocket: (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      options.sockets.push(socket);
      return socket;
    },
    hangupCall: async (callId) => {
      options.hangups?.push(callId);
    },
    maxCallDurationMs: options.maxCallDurationMs,
    warningLeadMs: options.warningLeadMs,
    dataDir: options.dataDir,
    monthlyTargetMicroUsd: options.monthlyTargetMicroUsd,
    fixedMonthlyMicroUsd: options.fixedMonthlyMicroUsd,
    perMinuteMicroUsd: options.perMinuteMicroUsd,
    reserveMargin: options.reserveMargin,
    referenceTime: new Date("2026-09-07T14:00:00-04:00"),
  });
}

async function admitAndHandshake(
  manager: ReturnType<typeof createBoundedManager>,
  sockets: FakeRealtimeSocket[],
  options: { callId: string; webhookId: string; callerNumber?: string },
): Promise<FakeRealtimeSocket> {
  const payload = incomingCallPayload({
    callId: options.callId,
    callerNumber: options.callerNumber,
  });
  const response = await manager.handleWebhook(
    signedHeaders(payload, { webhookId: options.webhookId }),
  );
  expect(response.statusCode).toBe(200);
  const socket = sockets[sockets.length - 1];
  if (!socket) {
    throw new Error("Expected a realtime socket after admission");
  }
  socket.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
  socket.receive({
    type: "session.updated",
    session: { model: REQUIRED_MODEL, reasoning: { effort: "high" } },
  });
  return socket;
}

describe("scheduling call bounds and monthly provider usage", () => {
  it("rejects a simultaneous second caller and admits a retry after hangup", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createBoundedManager({ sockets, hangups });

    await admitAndHandshake(manager, sockets, {
      callId: "call-sim-1",
      webhookId: "evt_sim_1",
    });

    const secondPayload = incomingCallPayload({ callId: "call-sim-2" });
    const second = await manager.handleWebhook(
      signedHeaders(secondPayload, { webhookId: "evt_sim_2" }),
    );
    expect(second.statusCode).toBe(429);
    expect(JSON.parse(second.body)).toEqual({ error: "concurrency_limit_reached" });
    expect(hangups).toEqual(["call-sim-2"]);
    expect(sockets).toHaveLength(1);

    const repeatPayload = incomingCallPayload({ callId: "call-sim-1" });
    const repeat = await manager.handleWebhook(
      signedHeaders(repeatPayload, { webhookId: "evt_sim_1_retry" }),
    );
    expect(repeat.statusCode).toBe(409);
    expect(sockets).toHaveLength(1);

    sockets[0]!.close();
    await recordedEvidence(() => manager.listEvidence(), "call-sim-1");

    const retryPayload = incomingCallPayload({ callId: "call-sim-3" });
    const retry = await manager.handleWebhook(
      signedHeaders(retryPayload, { webhookId: "evt_sim_3" }),
    );
    expect(retry.statusCode).toBe(200);
    expect(manager.activeCallCount()).toBe(1);
    sockets[sockets.length - 1]!.close();
  });

  it("releases admission after provider failure so the next caller is admitted", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const manager = createBoundedManager({ sockets });

    await admitAndHandshake(manager, sockets, {
      callId: "call-fail-1",
      webhookId: "evt_fail_1",
    });
    sockets[0]!.receive({
      type: "error",
      error: { message: "Simulated upstream provider outage" },
    });

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-fail-1");
    expect(evidence.status).toBe("failed");
    expect(manager.activeCallCount()).toBe(0);

    await admitAndHandshake(manager, sockets, {
      callId: "call-fail-2",
      webhookId: "evt_fail_2",
    });
    expect(manager.activeCallCount()).toBe(1);
    sockets[sockets.length - 1]!.close();
  });

  it("warns before the cutoff, blocks new booking confirmations, and ends the media session", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const stub = createStubBooking();
    const manager = createBoundedManager({
      sockets,
      hangups,
      booking: stub,
      maxCallDurationMs: 160,
      warningLeadMs: 100,
    });

    const socket = await admitAndHandshake(manager, sockets, {
      callId: "call-cutoff-1",
      webhookId: "evt_cutoff_1",
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    const warningNotice = socket.sent.find(
      (entry): entry is {
        type: string;
        item: { type: string; role: string; content: Array<{ text: string }> };
      } =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "conversation.item.create" &&
        "item" in entry &&
        typeof (entry as { item: unknown }).item === "object" &&
        (entry as { item: { role?: unknown } }).item.role === "system",
    );
    expect(warningNotice).toBeDefined();
    expect(JSON.stringify(warningNotice).toLowerCase()).toContain("limit");
    expect(socket.messageOfType("response.create")).toBeDefined();

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-cutoff-1");
    expect(evidence.status).toBe("completed");
    expect(evidence.error).toBe("duration_limit_reached");

    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-late-confirm",
      name: "confirm_appointment",
      arguments: JSON.stringify({ confirmed: true, proposalId: "proposal-1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const outputs = socket.sent.filter(
      (entry): entry is { type: string; item: { call_id: string; output: string } } =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "conversation.item.create" &&
        "item" in entry &&
        typeof (entry as { item: unknown }).item === "object" &&
        (entry as { item: { type?: unknown } }).item.type === "function_call_output",
    );
    const late = outputs.find((entry) => entry.item.call_id === "tool-late-confirm");
    expect(late).toBeDefined();
    expect(JSON.parse(late!.item.output)).toMatchObject({ status: "duration_cutoff" });
    expect(stub.calls).toHaveLength(0);

    expect(evidence).toMatchObject({ durationWarningSent: true });
    expect(hangups).toContain("call-cutoff-1");
    expect(manager.activeCallCount()).toBe(0);
  });

  it("completes an already-confirmed booking independently of the cutoff", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    let resolveConfirm!: (value: unknown) => void;
    const confirmGate = new Promise<unknown>((resolve) => {
      resolveConfirm = resolve;
    });
    const stub = createStubBooking({
      onExecute: (name) =>
        name === "confirm_appointment"
          ? confirmGate
          : { status: "failed", message: "unexpected tool" },
    });
    const manager = createBoundedManager({
      sockets,
      booking: stub,
      maxCallDurationMs: 120,
      warningLeadMs: 60,
    });

    const socket = await admitAndHandshake(manager, sockets, {
      callId: "call-cutoff-2",
      webhookId: "evt_cutoff_2",
    });
    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-early-confirm",
      name: "confirm_appointment",
      arguments: JSON.stringify({ confirmed: true, proposalId: "proposal-1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls).toHaveLength(1);

    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-cutoff-2");
    expect(evidence.error).toBe("duration_limit_reached");

    resolveConfirm({ status: "booked", message: "The appointment is booked." });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(stub.calls).toHaveLength(1);
    const bookedDelivery = socket.sent.find(
      (entry): entry is { type: string; item: { call_id: string; output: string } } =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "conversation.item.create" &&
        "item" in entry &&
        typeof (entry as { item: unknown }).item === "object" &&
        (entry as { item: { call_id?: unknown } }).item.call_id === "tool-early-confirm",
    );
    expect(bookedDelivery).toBeDefined();
    expect(JSON.parse(bookedDelivery!.item.output)).toMatchObject({ status: "booked" });
    expect(manager.activeCallCount()).toBe(0);
  });

  it("pauses admissions when fixed charges alone cover the monthly allowance", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createBoundedManager({
      sockets,
      hangups,
      monthlyTargetMicroUsd: MONTHLY_TARGET_MICRO_USD_DEFAULT,
      fixedMonthlyMicroUsd: MONTHLY_TARGET_MICRO_USD_DEFAULT,
    });

    const payload = incomingCallPayload({ callId: "call-fixed-1" });
    const response = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_fixed_1" }),
    );
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "budget_exhausted" });
    expect(hangups).toEqual(["call-fixed-1"]);
    expect(sockets).toHaveLength(0);
    expect(manager.budgetSnapshot().admissionsPaused).toBe(true);
  });

  it("reserves allowance on admit and settles observed usage on hangup", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-budget-"));
    const manager = createBoundedManager({
      sockets,
      dataDir,
      monthlyTargetMicroUsd: 1_000_000_000,
      fixedMonthlyMicroUsd: 1_000_000,
    });

    await admitAndHandshake(manager, sockets, {
      callId: "call-reserve-1",
      webhookId: "evt_reserve_1",
    });
    const reserved = manager.budgetSnapshot();
    expect(reserved.reservedMicroUsd).toBe(fullCallReservation());
    expect(reserved.spentMicroUsd).toBe(0);

    sockets[0]!.close();
    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-reserve-1");
    const settled = manager.budgetSnapshot();
    expect(settled.reservedMicroUsd).toBe(0);
    expect(settled.spentMicroUsd).toBe(estimateCallCostMicroUsd(evidence.durationMs));
  });

  it("pauses near-budget admissions and preserves spend across restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-budget-near-"));
    const target = fullCallReservation() + 100_000;
    // Seed one settled full-length call through the public ledger API so the
    // near-budget gate is exercised deterministically.
    const seed = createBudgetLedger({
      dataDir,
      monthlyTargetMicroUsd: target,
      fixedMonthlyMicroUsd: 0,
    });
    expect(seed.tryReserve("call-near-0").admitted).toBe(true);
    seed.settle("call-near-0", TEN_MINUTES_MS);
    expect(seed.snapshot().spentMicroUsd).toBeGreaterThan(0);

    const manager = createBoundedManager({
      sockets: [],
      dataDir,
      monthlyTargetMicroUsd: target,
      fixedMonthlyMicroUsd: 0,
    });
    expect(manager.budgetSnapshot().spentMicroUsd).toBe(seed.snapshot().spentMicroUsd);

    const blockedPayload = incomingCallPayload({ callId: "call-near-2" });
    const blocked = await manager.handleWebhook(
      signedHeaders(blockedPayload, { webhookId: "evt_near_2" }),
    );
    expect(blocked.statusCode).toBe(503);
    expect(JSON.parse(blocked.body)).toEqual({ error: "budget_exhausted" });

    const restarted = createBoundedManager({
      sockets: [],
      dataDir,
      monthlyTargetMicroUsd: target,
      fixedMonthlyMicroUsd: 0,
    });
    expect(restarted.activeCallCount()).toBe(0);
    expect(restarted.budgetSnapshot().spentMicroUsd).toBe(
      manager.budgetSnapshot().spentMicroUsd,
    );
    const afterRestart = await restarted.handleWebhook(
      signedHeaders(incomingCallPayload({ callId: "call-near-3" }), {
        webhookId: "evt_near_3",
      }),
    );
    expect(afterRestart.statusCode).toBe(503);
  });

  it("recovers a stale admission after restart without staying occupied", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-budget-stale-"));
    const manager = createBoundedManager({
      sockets,
      dataDir,
      monthlyTargetMicroUsd: 1_000_000_000,
      maxCallDurationMs: 30_000,
      warningLeadMs: 10_000,
    });

    await admitAndHandshake(manager, sockets, {
      callId: "call-stale-1",
      webhookId: "evt_stale_1",
    });
    expect(manager.activeCallCount()).toBe(1);

    const restartedSockets: FakeRealtimeSocket[] = [];
    const restarted = createBoundedManager({ sockets: restartedSockets, dataDir });
    expect(restarted.recoveredStaleAdmissions()).toEqual(["call-stale-1"]);
    expect(restarted.activeCallCount()).toBe(0);
    expect(restarted.budgetSnapshot().spentMicroUsd).toBe(
      fullCallReservationMicroUsd(30_000, DIRECT_SIP_MICRO_USD_PER_MINUTE, 0.25),
    );

    await admitAndHandshake(restarted, restartedSockets, {
      callId: "call-stale-2",
      webhookId: "evt_stale_2",
    });
    expect(restarted.activeCallCount()).toBe(1);

    sockets[0]!.close();
    restartedSockets[0]!.close();
  });

  it("returns a bounded unavailable state when usage cannot be estimated", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createBoundedManager({
      sockets,
      hangups,
      perMinuteMicroUsd: Number.NaN,
    });

    const payload = incomingCallPayload({ callId: "call-norate-1" });
    const response = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_norate_1" }),
    );
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "budget_unavailable" });
    expect(hangups).toEqual(["call-norate-1"]);
    expect(sockets).toHaveLength(0);
  });

  it("starts a new billing period without carrying last month's spend", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scheduling-budget-period-"));
    let now = new Date("2026-09-15T12:00:00Z");
    const september = createBudgetLedger({
      dataDir,
      monthlyTargetMicroUsd: fullCallReservation() + 10_000,
      fixedMonthlyMicroUsd: 0,
      now: () => now,
    });
    expect(september.tryReserve("call-sept-1").admitted).toBe(true);
    september.settle("call-sept-1", TEN_MINUTES_MS);
    expect(september.snapshot().spentMicroUsd).toBeGreaterThan(0);

    now = new Date("2026-10-01T00:00:01Z");
    const october = createBudgetLedger({
      dataDir,
      monthlyTargetMicroUsd: fullCallReservation() + 10_000,
      fixedMonthlyMicroUsd: 0,
      now: () => now,
    });
    expect(october.snapshot().periodId).toBe("2026-10");
    expect(october.snapshot().spentMicroUsd).toBe(0);
    expect(october.tryReserve("call-oct-1").admitted).toBe(true);
  });
});
