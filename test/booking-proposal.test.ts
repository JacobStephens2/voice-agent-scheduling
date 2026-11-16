import { describe, expect, it } from "vitest";
import { createAppointmentProposals } from "../src/calendar/booking-proposal.js";
import { assistantResponseEvents, readbackText } from "./helpers.js";

const NOW = new Date("2026-09-07T14:00:00-04:00");
const CALL_ID = "proposal-call";
const ARGS = {
  callerName: "Ada Lovelace",
  callbackNumber: "+15551239876",
  callbackConfirmed: true,
  date: "2026-09-11",
  startTime: "10:00",
};

function owner() {
  return createAppointmentProposals({ now: () => NOW });
}

function propose(
  proposals: ReturnType<typeof owner>,
  extra: Record<string, unknown> = {},
  callId = CALL_ID,
) {
  const result = proposals.propose({ ...ARGS, ...extra }, { callId });
  if (result.status !== "proposed" || !result.proposalId || !result.readback) {
    throw new Error("Expected Appointment proposal and Readback fields");
  }
  return { ...result, proposalId: result.proposalId, readback: result.readback };
}

function check(proposals: ReturnType<typeof owner>, proposalId: string, callId = CALL_ID) {
  return proposals.checkConfirmation({ confirmed: true, proposalId }, { callId });
}

function eligible(proposals: ReturnType<typeof owner>, proposalId: string, callId = CALL_ID) {
  const result = check(proposals, proposalId, callId);
  if (result.status !== "eligible") {
    throw new Error(result.message);
  }
  return result.proposal;
}

function speak(
  proposals: ReturnType<typeof owner>,
  proposed: ReturnType<typeof propose>,
  callId = CALL_ID,
) {
  const handle = proposals.openReadback(callId);
  for (const event of assistantResponseEvents({
    responseId: "readback",
    transcriptDelta: readbackText(proposed.readback),
  })) {
    handle.observe(event);
  }
  handle.close();
}

describe("Appointment proposal eligibility", () => {
  it("normalizes the proposal and requires completed Readback before returning an eligible snapshot", () => {
    const proposals = owner();
    const proposed = propose(proposals, {
      callerName: " Ada Lovelace ", callbackNumber: "555-123-9876", purpose: " Website review ",
    });
    expect(proposed.readback).toEqual({
      callerName: "Ada Lovelace", callbackNumber: "+15551239876", date: "2026-09-11",
      startTime: "10:00", endTime: "10:30", timezone: "America/New_York", purpose: "Website review",
    });
    expect(proposed.proposalId).toMatch(/^[0-9a-f]{32}$/);
    expect(check(proposals, proposed.proposalId)).toMatchObject({ status: "readback_incomplete" });
    expect(proposals.currentForInsert({
      ...proposed.readback, callId: CALL_ID, proposalId: proposed.proposalId,
    })).toBeUndefined();
    speak(proposals, proposed);
    expect(check(proposals, proposed.proposalId)).toEqual({
      status: "eligible", proposal: { ...proposed.readback, callId: CALL_ID, proposalId: proposed.proposalId },
    });
  });

  it.each([
    [{ callerName: "" }, "ask the caller for their name"],
    [{ callerName: 42 }, "ask the caller for their name"],
    [{ callbackConfirmed: false }, "confirm the callback number aloud"],
    [{ callbackNumber: "not a number" }, "repeat it, including the area code"],
    [{ date: "" }, "include the chosen date and Eastern start time"],
    [{ startTime: undefined }, "include the chosen date and Eastern start time"],
    [{ date: "2026-09-12" }, "not a permitted 30-minute weekday start"],
    [{ startTime: "10:15" }, "not a permitted 30-minute weekday start"],
    [{ date: "2026-09-08" }, "not a permitted 30-minute weekday start"],
    [{ date: "2026-09-22" }, "not a permitted 30-minute weekday start"],
  ])("preserves eligibility after invalid proposal input %j", (extra, message) => {
    const proposals = owner();
    const proposed = propose(proposals);
    speak(proposals, proposed);
    const captured = eligible(proposals, proposed.proposalId);
    expect(proposals.propose({ ...ARGS, ...extra }, { callId: CALL_ID })).toEqual({
      status: "invalid", message: expect.stringContaining(message),
    });
    expect(eligible(proposals, proposed.proposalId)).toEqual(captured);
    expect(proposals.currentForInsert(captured)).toEqual(captured);
  });

  it("uses the supplied reference time instead of the clock and omits blank purpose", () => {
    const proposals = createAppointmentProposals({ now: () => new Date("2026-09-30T00:00:00Z") });
    expect(proposals.propose({ ...ARGS, purpose: "  " }, { callId: CALL_ID })).toMatchObject({ status: "invalid" });
    const result = proposals.propose({ ...ARGS, purpose: "  " }, { callId: CALL_ID, referenceTime: NOW });
    expect(result).toMatchObject({ status: "proposed" });
    expect(result.readback).not.toHaveProperty("purpose");
    expect(result.message).toBe(
      "Please read back: Ada Lovelace, callback +15551239876, 2026-09-11 10:00–10:30 America/New_York. Wait for explicit agreement before confirming.",
    );
  });

  it("keeps the initial refusal precedence and never consumes earned readiness", () => {
    const proposals = owner();
    expect(proposals.checkConfirmation({ confirmed: false, proposalId: "stale" }, { callId: CALL_ID })).toEqual({
      status: "readback_incomplete", message: "There is no current appointment proposal on this call to confirm.",
    });
    const proposed = propose(proposals);
    expect(proposals.checkConfirmation({ confirmed: false, proposalId: "stale" }, { callId: CALL_ID })).toEqual({
      status: "readback_incomplete",
      message: "Do not create the appointment. Unclear assent, background speech, or a refusal is not confirmation.",
    });
    for (const proposalId of [undefined, 42, "stale"]) {
      expect(proposals.checkConfirmation({ confirmed: true, proposalId }, { callId: CALL_ID })).toEqual({
        status: "readback_incomplete",
        message: "That confirmation does not match the current proposal on this call. Finish a fresh complete readback first.",
      });
    }
    expect(check(proposals, proposed.proposalId)).toEqual({
      status: "readback_incomplete",
      message: "The readback is not finished. Complete the full readback without interruption before confirming. Do not create the appointment.",
    });
    speak(proposals, proposed);
    const captured = eligible(proposals, proposed.proposalId);
    expect(check(proposals, proposed.proposalId, "other-call")).toMatchObject({ status: "readback_incomplete" });
    for (const confirmed of [false, undefined, "true"]) {
      expect(proposals.checkConfirmation({ confirmed, proposalId: proposed.proposalId }, { callId: CALL_ID })).toMatchObject({ status: "readback_incomplete" });
    }
    expect(check(proposals, "stale")).toMatchObject({ status: "readback_incomplete" });
    expect(eligible(proposals, proposed.proposalId)).toEqual(captured);
    expect(eligible(proposals, proposed.proposalId)).toEqual(captured);
  });

  it.each([{}, { callerName: "Grace Hopper", callbackNumber: "555-987-6543", startTime: "14:00" }])(
    "requires new Readback and refuses a captured identity after valid replacement %j", (extra) => {
      const proposals = owner();
      const first = propose(proposals);
      speak(proposals, first);
      const captured = eligible(proposals, first.proposalId);
      const replacement = propose(proposals, extra);
      expect(replacement.proposalId).not.toBe(first.proposalId);
      expect(check(proposals, first.proposalId)).toMatchObject({ status: "readback_incomplete", message: expect.stringContaining("does not match") });
      expect(check(proposals, replacement.proposalId)).toMatchObject({ status: "readback_incomplete" });
      expect(proposals.currentForInsert(captured)).toBeUndefined();
      speak(proposals, replacement);
      const current = eligible(proposals, replacement.proposalId);
      expect(proposals.currentForInsert(current)).toEqual(current);
      expect(proposals.currentForInsert(captured)).toBeUndefined();
      expect(proposals.currentForInsert({ ...current, callId: "other-call" })).toBeUndefined();
    },
  );

  it("tests response coverage against the proposal current at completion", () => {
    const proposals = owner();
    const first = propose(proposals);
    const handle = proposals.openReadback(CALL_ID);
    const events = assistantResponseEvents({ responseId: "same", transcriptDelta: readbackText(first.readback) });
    handle.observe(events[0]!);
    const identical = propose(proposals);
    expect(check(proposals, identical.proposalId)).toMatchObject({ status: "readback_incomplete" });
    handle.observe(events[1]!);
    expect(check(proposals, identical.proposalId)).toMatchObject({ status: "eligible" });

    handle.observe(events[0]!);
    const changed = propose(proposals, { callerName: "Grace Hopper" });
    handle.observe(events[1]!);
    expect(check(proposals, changed.proposalId)).toMatchObject({ status: "readback_incomplete" });
    speak(proposals, changed);
    expect(check(proposals, changed.proposalId)).toMatchObject({ status: "eligible" });
    handle.close();
  });

  it.each([CALL_ID, "other-call"])("keeps transcript assembly separate for handles on %s", (otherCall) => {
    const proposals = owner();
    const proposed = propose(proposals);
    const other = otherCall === CALL_ID ? proposed : propose(proposals, {}, otherCall);
    const one = proposals.openReadback(CALL_ID);
    const two = proposals.openReadback(otherCall);
    const events = assistantResponseEvents({ responseId: "same", transcriptDelta: readbackText(proposed.readback) });
    one.observe(events[0]!);
    two.observe(events[1]!);
    expect(check(proposals, other.proposalId, otherCall)).toMatchObject({ status: "readback_incomplete" });
    one.observe(events[1]!);
    expect(check(proposals, proposed.proposalId)).toMatchObject({ status: "eligible" });
    expect(check(proposals, other.proposalId, otherCall)).toMatchObject({
      status: otherCall === CALL_ID ? "eligible" : "readback_incomplete",
    });
    one.close();
    two.close();
  });

  it("makes a closed handle inert without dropping the proposal or shared earned readiness", () => {
    const proposals = owner();
    const proposed = propose(proposals);
    const closed = proposals.openReadback(CALL_ID);
    const events = assistantResponseEvents({ responseId: "same", transcriptDelta: readbackText(proposed.readback) });
    closed.observe(events[0]!);
    closed.close();
    closed.close();
    for (const event of events) closed.observe(event);
    expect(check(proposals, proposed.proposalId)).toMatchObject({ status: "readback_incomplete" });
    speak(proposals, proposed);
    const captured = eligible(proposals, proposed.proposalId);
    closed.close();
    expect(proposals.currentForInsert(captured)).toEqual(captured);
  });

  it("preserves earned readiness after later cancelled and noncovering responses", () => {
    const proposals = owner();
    const proposed = propose(proposals);
    const handle = proposals.openReadback(CALL_ID);
    handle.observe({ type: "response.done", response: {
      status: "completed", output: [{ content: [{ transcript: readbackText(proposed.readback) }] }],
    } });
    expect(check(proposals, proposed.proposalId)).toMatchObject({ status: "eligible" });
    for (const options of [
      { status: "cancelled", transcriptDelta: readbackText(proposed.readback) },
      { transcriptDelta: "An incomplete Readback" },
    ]) {
      for (const event of assistantResponseEvents({ responseId: "same", ...options })) handle.observe(event);
      expect(check(proposals, proposed.proposalId)).toMatchObject({ status: "eligible" });
    }
    handle.close();
  });

  it("returns defensive snapshots of proposal fields at both eligibility gates", () => {
    const proposals = owner();
    const proposed = propose(proposals);
    const originalFields = { ...proposed.readback };
    Object.assign(proposed.readback, { callerName: "Changed result", startTime: "14:00" });
    speak(proposals, { ...proposed, readback: originalFields });
    const captured = eligible(proposals, proposed.proposalId);
    Object.assign(captured, { callerName: "Changed snapshot", startTime: "15:00" });
    const current = proposals.currentForInsert(captured);
    expect(current).toEqual({ ...originalFields, callId: CALL_ID, proposalId: proposed.proposalId });
    Object.assign(current!, { callerName: "Changed insertion copy", startTime: "16:00" });
    expect(eligible(proposals, proposed.proposalId)).toEqual({ ...originalFields, callId: CALL_ID, proposalId: proposed.proposalId });
    expect(proposals.currentForInsert(captured)).toEqual({ ...originalFields, callId: CALL_ID, proposalId: proposed.proposalId });
  });

  it("retires only the captured current identity and leaves replacements and other calls eligible", () => {
    const proposals = owner();
    const first = propose(proposals);
    speak(proposals, first);
    const stale = eligible(proposals, first.proposalId);
    const replacement = propose(proposals, { startTime: "14:00" });
    speak(proposals, replacement);
    const current = eligible(proposals, replacement.proposalId);
    const other = propose(proposals, {}, "other-call");
    speak(proposals, other, "other-call");
    proposals.discard(stale);
    proposals.discard(stale);
    proposals.discard({ ...current, callId: "other-call" });
    expect(proposals.currentForInsert(current)).toEqual(current);
    expect(check(proposals, other.proposalId, "other-call")).toMatchObject({ status: "eligible" });
    proposals.discard(current);
    proposals.discard(current);
    expect(proposals.currentForInsert(current)).toBeUndefined();
    expect(check(proposals, current.proposalId)).toMatchObject({
      status: "readback_incomplete", message: expect.stringContaining("no current appointment proposal"),
    });
    expect(check(proposals, other.proposalId, "other-call")).toMatchObject({ status: "eligible" });
    const next = propose(proposals, { startTime: "14:00" });
    expect(check(proposals, next.proposalId)).toMatchObject({ status: "readback_incomplete" });
  });
});
