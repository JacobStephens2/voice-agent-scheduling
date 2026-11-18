import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppointmentBooking, type AppointmentBookingCall } from "../src/calendar/booking-tool.js";
import { createTelephoneSession } from "../src/session.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import { completeReadback } from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("Scheduling call closes its Appointment booking interface", () => {
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
