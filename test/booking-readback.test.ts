import { describe, expect, it } from "vitest";
import type { AppointmentProposal } from "../src/calendar/booking-proposal.js";
import { createBookingReadback } from "../src/calendar/booking-readback.js";
import { assistantResponseEvents, readbackText } from "./helpers.js";

const PROPOSAL: AppointmentProposal = {
  proposalId: "proposal-1",
  callId: "call-1",
  callerName: "Ada Lovelace",
  callbackNumber: "+15551239876",
  date: "2026-09-11",
  startTime: "10:00",
  endTime: "10:30",
  timezone: "America/New_York",
};

const TEXT = readbackText(PROPOSAL);

function delta(responseId: unknown, text: unknown): Record<string, unknown> {
  return { type: "response.output_audio_transcript.delta", response_id: responseId, delta: text };
}

function done(responseId: unknown, status: unknown = "completed"): Record<string, unknown> {
  return { type: "response.done", response: { id: responseId, status } };
}

function payload(text: string, id?: unknown): Record<string, unknown> {
  return {
    type: "response.done",
    response: { id, status: "completed", output: [{ content: [{ transcript: text }] }] },
  };
}

describe("Booking confirmation Readback", () => {
  it("covers the current proposal only when its streamed response completes", () => {
    const readback = createBookingReadback();
    expect(readback.observe({
      type: "response.output_audio_transcript.delta",
      response_id: "response-1",
      delta: "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York.",
    }, PROPOSAL)).toBe(false);
    expect(readback.observe({
      type: "response.done",
      response: { id: "response-1", status: "completed" },
    }, PROPOSAL)).toBe(true);
  });

  it("keeps interleaved responses separate and preserves an unfinished response", () => {
    const readback = createBookingReadback();
    readback.observe(delta("one", "Ada Lovelace, callback +15551239876, "), PROPOSAL);
    readback.observe(delta("two", "2026-09-11 10:00 10:30 America/New_York"), PROPOSAL);
    expect(readback.observe(done("two"), PROPOSAL)).toBe(false);
    readback.observe(delta("one", "2026-09-11 10:00 10:30 America/New_York"), PROPOSAL);
    expect(readback.observe(done("one"), PROPOSAL)).toBe(true);
  });

  it.each([
    ["completed", true], ["cancelled", false], ["failed", false],
    ["incomplete", false], ["unknown", false], [null, false], [42, false],
  ])("discards stream assembly after completion status %s", (status, expected) => {
    const readback = createBookingReadback();
    readback.observe(delta("one", TEXT), PROPOSAL);
    expect(readback.observe(done("one", status), PROPOSAL)).toBe(expected);
    expect(readback.observe(done("one"), PROPOSAL)).toBe(false);
  });

  it.each([undefined, null, 42, "", {}, []])("ignores unusable stream identity %j", (id) => {
    const readback = createBookingReadback();
    readback.observe(delta(id, TEXT), PROPOSAL);
    readback.observe({ type: "response.output_audio_transcript.done", response_id: id, transcript: TEXT }, PROPOSAL);
    expect(readback.observe(done(id), PROPOSAL)).toBe(false);
    expect(readback.observe(done("one"), PROPOSAL)).toBe(false);
    expect(readback.observe(payload(TEXT, id), PROPOSAL)).toBe(true);
  });

  it("accepts payload-only completion without a response identity", () => {
    const readback = createBookingReadback();
    expect(readback.observe({
      type: "response.done",
      response: { status: "completed", output: [{ content: [{ transcript: TEXT }] }] },
    }, PROPOSAL)).toBe(true);
  });

  it("ignores malformed and unrelated records and still accepts a later complete response", () => {
    const readback = createBookingReadback();
    for (const event of [
      {}, { type: 42 }, { type: "conversation.item.input_audio_transcription.completed", transcript: TEXT },
      delta("one", 42), { type: "response.done" }, { type: "response.done", response: null },
      { type: "response.done", response: { status: "completed", output: {} } },
      { type: "response.done", response: { status: "completed", output: [null, 42, {}, { content: [null, {}, { transcript: 42 }] }] } },
    ]) {
      expect(readback.observe(event, PROPOSAL)).toBe(false);
    }
    expect(readback.observe(payload(TEXT), PROPOSAL)).toBe(true);
  });

  it("extracts transcript parts from supported payload items while ignoring malformed parts", () => {
    const readback = createBookingReadback();
    expect(readback.observe({
      type: "response.done",
      response: {
        status: "completed",
        output: [null, { content: "invalid" }, { content: [null, { transcript: "Ada Lovelace, callback +15551239876, " }] },
          { content: [{ transcript: 42 }, { transcript: "2026-09-11 10:00 10:30 America/New_York." }] }],
      },
    }, PROPOSAL)).toBe(true);
  });

  it("checks the proposal current at completion without binding to its earlier identity", () => {
    const readback = createBookingReadback();
    readback.observe(delta("one", TEXT), PROPOSAL);
    expect(readback.observe(done("one"), { ...PROPOSAL, proposalId: "replacement" })).toBe(true);
    readback.observe(delta("two", TEXT), PROPOSAL);
    expect(readback.observe(done("two"), { ...PROPOSAL, callerName: "Grace Hopper" })).toBe(false);
    readback.observe(delta("three", TEXT), undefined);
    expect(readback.observe(done("three"), undefined)).toBe(false);
    expect(readback.observe(done("three"), PROPOSAL)).toBe(false);
  });

  it("requires the exact returned values and purpose only when present", () => {
    const readback = createBookingReadback();
    expect(readback.observe(payload(TEXT), { ...PROPOSAL, purpose: "Website review" })).toBe(false);
    expect(readback.observe(payload(`${TEXT}, Website review`), { ...PROPOSAL, purpose: "Website review" })).toBe(true);
    for (const field of ["Ada Lovelace", "+15551239876", "2026-09-11", "10:00", "10:30", "America/New_York"]) {
      expect(readback.observe(payload(TEXT.replace(field, "wrong")), PROPOSAL)).toBe(false);
    }
  });

  it("isolates verifiers even when response identities coincide", () => {
    const one = createBookingReadback();
    const two = createBookingReadback();
    one.observe(delta("same", TEXT), PROPOSAL);
    expect(two.observe(done("same"), PROPOSAL)).toBe(false);
    expect(one.observe(done("same"), PROPOSAL)).toBe(true);
  });

  it("makes observations inert after idempotent close", () => {
    const readback = createBookingReadback();
    readback.observe(delta("one", TEXT), PROPOSAL);
    readback.close();
    readback.close();
    expect(readback.observe(done("one"), PROPOSAL)).toBe(false);
    for (const event of assistantResponseEvents({ responseId: "two", transcriptDelta: TEXT, payloadTranscript: TEXT })) {
      expect(readback.observe(event, PROPOSAL)).toBe(false);
    }
  });

  it("keeps repeated-fragment offsets in UTF-16 after a supplementary code point", () => {
    const readback = createBookingReadback();
    readback.observe(delta("one", "😀 0:00 Ada Lovelace +15551239876 2026-09-11 10:30 America/New_York 1"), PROPOSAL);
    readback.observe(delta("one", "0:00"), PROPOSAL);
    expect(readback.observe(done("one"), PROPOSAL)).toBe(false);
  });

  it("allows a repeated supplementary code point to finish a returned field", () => {
    const readback = createBookingReadback();
    const proposal = { ...PROPOSAL, callerName: "Ada😀" };
    readback.observe(delta("one", "😀 +15551239876 2026-09-11 10:00 10:30 America/New_York Ada"), proposal);
    readback.observe(delta("one", "😀"), proposal);
    expect(readback.observe(done("one"), proposal)).toBe(true);
  });
});
