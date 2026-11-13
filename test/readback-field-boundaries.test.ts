import { describe, expect, it } from "vitest";
import type { AppointmentProposal } from "../src/calendar/booking-proposal.js";
import { createBookingReadback } from "../src/calendar/booking-readback.js";

const PROPOSAL: AppointmentProposal = {
  proposalId: "proposal-1",
  callId: "call-1",
  callerName: "Ada",
  callbackNumber: "+15551239876",
  date: "2026-09-11",
  startTime: "10:00",
  endTime: "10:30",
  timezone: "America/New_York",
};
const READBACK_TAIL = ", callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.";

describe("Readback field boundaries", () => {
  it.each([
    ["another word", "Adam Smith"],
    ["Unicode format character", "Ada\u200Bm Smith"],
    ["supplementary-plane format character", "Ada\u{E0020}m Smith"],
    ["Unicode variation selector", "Ada\uFE00m Smith"],
    ["supplementary-plane variation selector", "Ada\u{E0100}m Smith"],
    ["combining grapheme joiner", "Ada\u034Fm Smith"],
    ["combining acute accent", "Ada\u0301m Smith"],
    ["Khmer vowel inherent AQ", "Ada\u17B4m Smith"],
    ["Khmer vowel inherent AA", "Ada\u17B5m Smith"],
    ["unassigned default-ignorable code point", "Ada\u2065m Smith"],
    ["supplementary-plane unassigned default-ignorable code point", "Ada\u{E0002}m Smith"],
  ])("rejects a name continued through %s", (_label, transcriptName) => {
    const readback = createBookingReadback();
    expect(readback.observe({
      type: "response.done",
      response: {
        status: "completed",
        output: [{ content: [{ transcript: `${transcriptName}${READBACK_TAIL}` }] }],
      },
    }, PROPOSAL)).toBe(false);
  });
});
