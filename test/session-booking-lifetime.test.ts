import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppointmentBooking, type AppointmentBookingCall } from "../src/calendar/booking-tool.js";
import { connectProductionRealtimeSocket } from "../src/lifecycle.js";
import { createTelephoneSession } from "../src/session.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import { completeReadback } from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("Scheduling call closes its Appointment booking interface", () => {
  it("reports the Appointment startup error when the provider hangup also rejects", async () => {
    const setupError = new Error("Appointment setup failed");
    const hangups: string[] = [];
    const callId = "call-startup-failure";
    const session = createTelephoneSession({
      callId,
      apiKey: "test-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      booking: {
        definitions: () => [],
        openCall() { throw setupError; },
      },
      connectWebSocket() { throw new Error("Unexpected Telephone socket"); },
      async hangupCall(id) {
        hangups.push(id);
        throw new Error("Provider hangup rejected");
      },
    });

    await expect(session.start()).rejects.toBe(setupError);
    await setImmediate();
    expect(hangups).toEqual([callId]);
  });

  it.each(["connection failure", "provider failure", "socket error", "socket closure", "duration cutoff", "model failure"] as const)(
    "seals the call on %s", async (ending) => {
      vi.useFakeTimers();
      const booking = createAppointmentBooking({
        now: () => new Date("2026-09-07T14:00:00-04:00"),
        credentials: null,
        selection: null,
        dataDir: mkdtempSync(join(tmpdir(), "scheduling-session-lifetime-")),
      });
      let call: AppointmentBookingCall | undefined;
      const socket = new FakeRealtimeSocket("test-socket", {});
      const session = createTelephoneSession({
        callId: "session-lifetime",
        apiKey: "test-key",
        availabilityTool: createSyntheticAvailabilityTool(),
        maxDurationMs: 1000,
        warningLeadMs: 100,
        booking: { ...booking, openCall(options) {
          call = booking.openCall(options);
          return call;
        } },
        connectWebSocket: () => {
          if (ending === "connection failure") throw new Error("connection failed");
          return socket;
        },
      });
      const finished = session.start();
      if (!call) throw new Error("Expected booking to open before connection");
      const args = {
        callerName: "Ada Lovelace", callbackNumber: "+15551239876", callbackConfirmed: true,
        date: "2026-09-11", startTime: "10:00",
      };
      const proposed = await call.execute("propose_appointment", args);
      if (ending !== "connection failure") completeReadback(call, proposed);
      switch (ending) {
        case "provider failure": socket.receive({ type: "error", error: "provider failed" }); break;
        case "socket error": socket.fail("socket failed"); break;
        case "socket closure": socket.close(); break;
        case "model failure": socket.receive({ type: "session.created", session: { model: "unexpected-model" } }); break;
        case "duration cutoff": await vi.advanceTimersByTimeAsync(1000); break;
      }
      expect((await finished).status).toBe(ending === "socket closure" || ending === "duration cutoff" ? "completed" : "failed");
      expect(await call.execute("propose_appointment", args)).toEqual({ status: "invalid", message: "This scheduling call has ended." });
      expect(await call.execute("confirm_appointment", { confirmed: true, proposalId: "proposalId" in proposed ? proposed.proposalId : undefined })).toEqual({
        status: "readback_incomplete", message: "This scheduling call has ended.",
      });
    },
  );
});

function noticeText(data: string): string | undefined {
  const parsed = JSON.parse(data) as { item?: { content?: Array<{ text?: string }> } };
  return parsed.item?.content?.[0]?.text;
}

class CutoffNoticeFailingSocket extends FakeRealtimeSocket {
  override send(data: string): void {
    const text = noticeText(data);
    if (text?.includes("limit is reached")) {
      throw new Error("cutoff notice failed");
    }
    super.send(data);
  }
}

describe("Telephone session finishes a caught callback failure", () => {
  it("records a provider error event as Provider error without the provider payload", async () => {
    const payload = "caller callback +15551239876 and private speech";
    const hangups: string[] = [];
    const socket = new FakeRealtimeSocket("wss://example.test", {});
    const session = createTelephoneSession({
      callId: "call-provider-error",
      apiKey: "test-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      connectWebSocket: () => socket,
      async hangupCall(id) {
        hangups.push(id);
      },
    });
    const finished = session.start();
    socket.receive({ type: "error", error: { message: payload, transcript: payload } });
    const outcome = await finished;
    expect(outcome).toMatchObject({ status: "failed", error: "Provider error" });
    expect(JSON.stringify(outcome)).not.toContain(payload);
    expect(JSON.stringify(outcome)).not.toContain("transcript");
    await setImmediate();
    expect(hangups).toEqual(["call-provider-error"]);
  });

  it("finishes the Scheduling call as failed when the duration cutoff notice cannot be sent", async () => {
    vi.useFakeTimers();
    const hangups: string[] = [];
    const socket = new CutoffNoticeFailingSocket("wss://example.test", {});
    const session = createTelephoneSession({
      callId: "call-cutoff-notice",
      apiKey: "test-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      maxDurationMs: 1_000,
      warningLeadMs: 100,
      connectWebSocket: () => socket,
      async hangupCall(id) {
        hangups.push(id);
      },
    });
    const finished = session.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await finished;
    expect(outcome).toMatchObject({
      status: "failed",
      error: "WebSocket error: cutoff notice failed",
    });
    await setImmediate();
    expect(hangups).toEqual(["call-cutoff-notice"]);
  });

  it("finishes the Scheduling call as failed when the duration warning cannot be sent", async () => {
    vi.useFakeTimers();
    const hangups: string[] = [];
    const socket = new FakeRealtimeSocket("wss://example.test", {});
    socket.send = () => {
      throw new Error("warning send failed");
    };
    const session = createTelephoneSession({
      callId: "call-warning-send",
      apiKey: "test-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      maxDurationMs: 1_000,
      warningLeadMs: 100,
      connectWebSocket: () => socket,
      async hangupCall(id) {
        hangups.push(id);
      },
    });
    const finished = session.start();
    await vi.advanceTimersByTimeAsync(900);
    const outcome = await finished;
    expect(outcome).toMatchObject({
      status: "failed",
      error: "WebSocket error: warning send failed",
    });
    await setImmediate();
    expect(hangups).toEqual(["call-warning-send"]);
  });

  it("finishes the Scheduling call as failed when handling a provider message throws", async () => {
    const hangups: string[] = [];
    const socket = new FakeRealtimeSocket("wss://example.test", {});
    const session = createTelephoneSession({
      callId: "call-message-throw",
      apiKey: "test-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      booking: {
        definitions: () => [],
        openCall: () => ({
          execute() {
            return {};
          },
          close() {},
          observe() {
            throw new Error("transcript observe failed");
          },
        }),
      },
      connectWebSocket: () => socket,
      async hangupCall(id) {
        hangups.push(id);
      },
    });
    const finished = session.start();
    socket.receive({ type: "response.output_audio_transcript.delta", delta: "hello" });
    const outcome = await finished;
    expect(outcome).toMatchObject({
      status: "failed",
      error: "WebSocket error: transcript observe failed",
    });
    await setImmediate();
    expect(hangups).toEqual(["call-message-throw"]);
  });

  it("finishes as a websocket error when the realtime upgrade does not complete", async () => {
    const connections: Array<{ destroy(): void }> = [];
    const server = createServer((connection) => {
      connections.push(connection);
      connection.on("error", () => {});
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const hangups: string[] = [];
    const session = createTelephoneSession({
      callId: "call-handshake-timeout",
      apiKey: "test-key",
      availabilityTool: createSyntheticAvailabilityTool(),
      maxDurationMs: 60_000,
      warningLeadMs: 1_000,
      connectWebSocket: () =>
        connectProductionRealtimeSocket(`ws://127.0.0.1:${address.port}/`, {
          Authorization: "Bearer test-key",
        }),
      async hangupCall(id) {
        hangups.push(id);
      },
    });
    try {
      const outcome = await session.start();
      expect(outcome).toMatchObject({
        status: "failed",
        error: "WebSocket error: Opening handshake has timed out",
      });
      await setImmediate();
      expect(hangups).toEqual(["call-handshake-timeout"]);
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 20_000);
});
