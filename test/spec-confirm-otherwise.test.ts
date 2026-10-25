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

describe("spec: confirm_appointment otherwise status", () => {
  it("returns readback_incomplete unless readback, confirmed, and current proposal id all hold", async () => {
    const google = fakeGoogleCalendar({});
    const booking = createAppointmentBooking({
      fetchFn: google.fetchFn,
      tokenProvider: { getAccessToken: async () => "test-access-token" },
      selection: SELECTION,
      now: () => MONDAY_14H,
      dataDir: mkdtempSync(join(tmpdir(), "scheduling-spec-confirm-")),
      createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
      allowWrites: true,
    });
    const callId = "call-spec-otherwise";
    const proposed = (await booking.execute(
      "propose_appointment",
      {
        callerName: "Ada Lovelace",
        callbackNumber: "+15551239876",
        callbackConfirmed: true,
        date: "2026-09-11",
        startTime: "10:00",
      },
      { callId },
    )) as { proposalId?: string };

    const unclear = await booking.execute(
      "confirm_appointment",
      { confirmed: false, proposalId: proposed.proposalId },
      { callId },
    );
    const stale = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: "not-the-current-proposal" },
      { callId },
    );
    const missing = await booking.execute(
      "confirm_appointment",
      { confirmed: true, proposalId: proposed.proposalId },
      { callId: "call-with-no-proposal" },
    );

    expect(unclear.status).toBe("readback_incomplete");
    expect(stale.status).toBe("readback_incomplete");
    expect(missing.status).toBe("readback_incomplete");
    expect(google.writes).toEqual([]);
  });
});
