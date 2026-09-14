import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCallLifecycleManager } from "../src/lifecycle.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  incomingCallPayload,
  recordedEvidence,
  signedHeaders,
} from "./helpers.js";

const REQUIRED_MODEL = "grok-voice-think-fast-2.0";

function createManager(options: {
  sockets: FakeRealtimeSocket[];
  hangups?: string[];
  dataDir?: string;
  maxCallDurationMs?: number;
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
    hangupCall: async (callId) => {
      options.hangups?.push(callId);
    },
    dataDir: options.dataDir,
    maxCallDurationMs: options.maxCallDurationMs,
    referenceTime: new Date("2026-09-07T14:00:00-04:00"),
  });
}

describe("scheduling call lifecycle", () => {
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

    const stored = (await readFile(join(dataDir, "smoke-evidence.jsonl"), "utf8"))
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
    expect(evidence?.error).toContain("Simulated upstream provider outage");
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
    expect(evidence?.error).toContain(REQUIRED_MODEL);
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
