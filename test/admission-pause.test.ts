import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { createSchedulingServer, type SchedulingServer } from "../src/server.js";
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

const EVIDENCE_TOKEN = "test-pause-evidence-token";
const HTTP_PORT = 3601;

function createStubBooking(options: {
  onExecute?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
} = {}): BookingTool & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    definitions: () => [
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

function createPausedManager(options: {
  sockets: FakeRealtimeSocket[];
  hangups?: string[];
  dataDir?: string;
  booking?: BookingTool;
  pauseAdmissions?: boolean;
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
    dataDir: options.dataDir,
    pauseAdmissions: options.pauseAdmissions,
    referenceTime: new Date("2026-09-07T14:00:00-04:00"),
  });
}

describe("operator admission pause", () => {
  it("rejects a new caller while admissions are paused and hangs up the PSTN leg", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createPausedManager({ sockets, hangups, pauseAdmissions: true });

    const payload = incomingCallPayload({ callId: "call-paused-1" });
    const response = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_paused_1" }),
    );
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "operator_paused" });
    expect(hangups).toEqual(["call-paused-1"]);
    expect(sockets).toHaveLength(0);
    expect(manager.admissionsStatus()).toEqual({
      paused: true,
      reason: "operator_paused",
    });
  });

  it("admits the next caller after the operator resumes", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
    const manager = createPausedManager({ sockets, hangups, pauseAdmissions: true });
    manager.resumeAdmissions();

    const payload = incomingCallPayload({ callId: "call-resume-1" });
    const response = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_resume_1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "admitted",
      call_id: "call-resume-1",
    });
    expect(hangups).toEqual([]);
    expect(manager.admissionsStatus()).toEqual({ paused: false });
  });

  it("keeps the pause across a process restart from durable state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-pause-"));
    const first = createPausedManager({
      sockets: [],
      dataDir,
      pauseAdmissions: true,
    });
    expect(first.admissionsStatus().paused).toBe(true);

    const restarted = createPausedManager({ sockets: [], dataDir });
    expect(restarted.admissionsStatus()).toEqual({
      paused: true,
      reason: "operator_paused",
    });
  });

  it("finishes an already-confirmed booking after admissions pause", async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hangups: string[] = [];
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
    const manager = createPausedManager({ sockets, hangups, booking: stub });

    const payload = incomingCallPayload({ callId: "call-pause-book-1" });
    const admitted = await manager.handleWebhook(
      signedHeaders(payload, { webhookId: "evt_pause_book_1" }),
    );
    expect(admitted.statusCode).toBe(200);
    const socket = sockets[0]!;
    socket.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
    socket.receive({
      type: "session.updated",
      session: { model: REQUIRED_MODEL, reasoning: { effort: "high" } },
    });
    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "tool-confirm",
      name: "confirm_appointment",
      arguments: JSON.stringify({ confirmed: true, proposalId: "proposal-1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls).toHaveLength(1);

    manager.pauseAdmissions();

    const second = incomingCallPayload({ callId: "call-pause-book-2", callerNumber: "+15550002222" });
    const blocked = await manager.handleWebhook(
      signedHeaders(second, { webhookId: "evt_pause_book_2" }),
    );
    expect(blocked.statusCode).toBe(503);
    expect(JSON.parse(blocked.body)).toEqual({ error: "operator_paused" });
    expect(hangups).toContain("call-pause-book-2");

    resolveConfirm({ status: "booked", message: "The appointment is booked." });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const bookedDelivery = socket.sent.find(
      (entry): entry is { type: string; item: { call_id: string; output: string } } =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "conversation.item.create" &&
        "item" in entry &&
        typeof (entry as { item: unknown }).item === "object" &&
        (entry as { item: { call_id?: unknown } }).item.call_id === "tool-confirm",
    );
    expect(bookedDelivery).toBeDefined();
    expect(JSON.parse(bookedDelivery!.item.output)).toMatchObject({ status: "booked" });
    socket.close();
    const evidence = await recordedEvidence(() => manager.listEvidence(), "call-pause-book-1");
    expect(evidence.status).toBe("completed");
    expect(manager.activeCallCount()).toBe(0);
  });
});

describe("operator pause HTTP", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-pause-http-"));
  let app: SchedulingServer;

  beforeAll(async () => {
    app = createSchedulingServer({
      port: HTTP_PORT,
      webhookSecret: WEBHOOK_SECRET,
      apiKey: "test-key",
      evidenceToken: EVIDENCE_TOKEN,
      dataDir,
      allowCalendarWrites: true,
      publicAdmission: false,
      allowedCallerNumbers: ["+15551234567"],
      connectWebSocket: (url, headers) => new FakeRealtimeSocket(url, headers),
      hangupCall: async () => undefined,
    });
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("reports production readiness on health without opening public admission", async () => {
    const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      publicAdmission: boolean;
      calendarWrites: boolean;
      calendarSelected: boolean;
      admissionsPaused: boolean;
    };
    expect(body.status).toBe("healthy");
    expect(body.publicAdmission).toBe(false);
    expect(body.calendarWrites).toBe(true);
    expect(body.calendarSelected).toBe(false);
    expect(body.admissionsPaused).toBe(false);
  });

  it("pauses and resumes admissions through the maintenance endpoints", async () => {
    const denied = await fetch(`http://127.0.0.1:${HTTP_PORT}/maintenance/pause`, {
      method: "POST",
    });
    expect(denied.status).toBe(401);

    const paused = await fetch(`http://127.0.0.1:${HTTP_PORT}/maintenance/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ admissionsPaused: true, pauseReason: "operator_paused" });

    const health = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
    const healthBody = (await health.json()) as {
      admissionsPaused: boolean;
      pauseReason?: string;
    };
    expect(healthBody.admissionsPaused).toBe(true);
    expect(healthBody.pauseReason).toBe("operator_paused");

    const resumed = await fetch(`http://127.0.0.1:${HTTP_PORT}/maintenance/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ admissionsPaused: false });

    const after = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
    const afterBody = (await after.json()) as {
      admissionsPaused: boolean;
      pauseReason?: string;
    };
    expect(afterBody.admissionsPaused).toBe(false);
    expect(afterBody.pauseReason).toBeUndefined();
  });
});
