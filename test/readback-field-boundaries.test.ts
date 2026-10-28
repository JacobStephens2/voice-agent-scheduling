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

const READBACK_TAIL =
  ", callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.";

async function confirmCallerName(transcriptName: string, callId: string, dirPrefix: string) {
  const google = fakeGoogleCalendar({});
  const booking = createAppointmentBooking({
    fetchFn: google.fetchFn,
    tokenProvider: { getAccessToken: async () => "test-access-token" },
    selection: SELECTION,
    now: () => MONDAY_14H,
    dataDir: mkdtempSync(join(tmpdir(), dirPrefix)),
    createIds: () => ({ operationId: TEST_OPERATION_ID, eventId: TEST_EVENT_ID }),
    allowWrites: true,
  });
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
    sources: [`${transcriptName}${READBACK_TAIL}`],
  });
  const result = await booking.execute(
    "confirm_appointment",
    { confirmed: true, proposalId: proposed.proposalId },
    { callId },
  );
  return { result, writes: google.writes };
}

describe("readback field boundaries", () => {
  it("does not accept a caller name that appears only inside another word", async () => {
    const { result, writes } = await confirmCallerName(
      "Adam Smith",
      "call-substring-name",
      "scheduling-substring-",
    );
    expect(result.status).toBe("readback_incomplete");
    expect(writes).toEqual([]);
  });

  it("does not accept a caller name that continues through a Unicode format character", async () => {
    const { result, writes } = await confirmCallerName(
      "Ada\u200Bm Smith",
      "call-format-name",
      "scheduling-format-",
    );
    expect(result.status).toBe("readback_incomplete");
    expect(writes).toEqual([]);
  });

  it("does not accept a caller name that continues through a supplementary-plane format character", async () => {
    const { result, writes } = await confirmCallerName(
      "Ada\u{E0020}m Smith",
      "call-format-pair-name",
      "scheduling-format-pair-",
    );
    expect(result.status).toBe("readback_incomplete");
    expect(writes).toEqual([]);
  });
});
