import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppointmentBooking } from "../src/calendar/booking-tool.js";
import { fakeGoogleCalendar, TEST_EVENT_ID, TEST_OPERATION_ID } from "./helpers.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = {
  primaryCalendarId: "primary",
  conflictCalendarIds: ["team"],
  updatedAt: "2026-09-07T00:00:00.000Z",
};

describe("readback field boundaries", () => {
  it("does not accept a caller name that appears only inside another word", async () => {
    const google = fakeGoogleCalendar({});
    const booking = createAppointmentBooking({
      fetchFn: google.fetchFn,
      tokenProvider: { getAccessToken: async () => "test-access-token" },
      selection: SELECTION,
      now: () => MONDAY_14H,
      dataDir: mkdtempSync(join(tmpdir(), "scheduling-substring-")),
      createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
      allowWrites: true,
    });
    const callId = "call-substring-name";
    const proposed = (await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
      },
      { callId },
    )) as { proposalId: string };
    booking.finishReadbackIfCovered(callId, {
      status: "completed",
      transcript:
        "Adam Smith, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: proposed.proposalId },
      { callId },
    );
    expect(result.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);
  });

  it("does not accept a caller name that continues through a Unicode format character", async () => {
    const google = fakeGoogleCalendar({});
    const booking = createAppointmentBooking({
      fetchFn: google.fetchFn,
      tokenProvider: { getAccessToken: async () => "test-access-token" },
      selection: SELECTION,
      now: () => MONDAY_14H,
      dataDir: mkdtempSync(join(tmpdir(), "scheduling-format-")),
      createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
      allowWrites: true,
    });
    const callId = "call-format-name";
    const proposed = (await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
      },
      { callId },
    )) as { proposalId: string };
    booking.finishReadbackIfCovered(callId, {
      status: "completed",
      transcript:
        "Ada\u200Bm Smith, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: proposed.proposalId },
      { callId },
    );
    expect(result.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);
  });

  it("does not accept a caller name that continues through a supplementary-plane format character", async () => {
    const google = fakeGoogleCalendar({});
    const booking = createAppointmentBooking({
      fetchFn: google.fetchFn,
      tokenProvider: { getAccessToken: async () => "test-access-token" },
      selection: SELECTION,
      now: () => MONDAY_14H,
      dataDir: mkdtempSync(join(tmpdir(), "scheduling-format-pair-")),
      createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
      allowWrites: true,
    });
    const callId = "call-format-pair-name";
    const proposed = (await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
      },
      { callId },
    )) as { proposalId: string };
    booking.finishReadbackIfCovered(callId, {
      status: "completed",
      transcript:
        "Ada\u{E0020}m Smith, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    });
    const result = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: proposed.proposalId },
      { callId },
    );
    expect(result.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);
  });
});
