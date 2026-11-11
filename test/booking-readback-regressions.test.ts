import { describe, expect, it } from "vitest";
import type { AppointmentProposal } from "../src/calendar/booking-proposal.js";
import { createBookingReadback } from "../src/calendar/booking-readback.js";
import { assistantResponseEvents } from "./helpers.js";

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

function verify(events: readonly Record<string, unknown>[], proposal: AppointmentProposal): boolean {
  const readback = createBookingReadback();
  const decisions = events.map((event) => readback.observe(event, proposal));
  expect(decisions.slice(0, -1).every((decision) => decision === false)).toBe(true);
  return decisions.at(-1) ?? false;
}

describe("Readback transcript regressions", () => {
  it("does not finish a readback when a required field exists only at the delta/payload splice", () => {
    const events: Record<string, unknown>[] = [];
    const spoken =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    events.push(...assistantResponseEvents({
      responseId: "resp-splice",
      status: "completed",
      transcriptDelta: spoken,
      payloadTranscript: spoken,
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when the done transcript repeats the deltas and the start time exists only at that join", () => {
    const events: Record<string, unknown>[] = [];
    const spoken =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    events.push(...assistantResponseEvents({
      responseId: "resp-done-splice",
      status: "completed",
      transcriptDelta: spoken,
      transcriptDone: spoken,
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when a small edit of the streamed deltas forms the callback number only at that join", () => {
    const events: Record<string, unknown>[] = [];
    // One letter differs, so neither string contains the other. Neither
    // contains the callback number. Appending the done transcript forms it.
    const deltas = "9876 Ada Lovelace 2026-09-11 10:00 10:30 America/New_York +1555123";
    const doneTranscript = "9876 Ada Lovlace 2026-09-11 10:00 10:30 America/New_York +1555123";
    expect(deltas.includes("+15551239876")).toBe(false);
    expect(doneTranscript.includes("+15551239876")).toBe(false);
    expect(deltas.includes(doneTranscript)).toBe(false);
    expect(doneTranscript.includes(deltas)).toBe(false);
    expect(`${deltas}${doneTranscript}`.includes("+15551239876")).toBe(true);
    events.push(...assistantResponseEvents({
      responseId: "resp-done-small-edit",
      status: "completed",
      transcriptDelta: deltas,
      transcriptDone: doneTranscript,
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("finishes a readback when a small edit of the streamed deltas still contains every returned field", () => {
    const events: Record<string, unknown>[] = [];
    // Two small edits. The caller name is its own value only in the done
    // transcript, and the timezone is its own value only in the deltas.
    const deltas =
      "Hello Ada Lovlace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York thanks";
    const doneTranscript =
      "Hello Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_Yrok thanks";
    expect(deltas.includes("Ada Lovelace")).toBe(false);
    expect(doneTranscript.includes("America/New_York")).toBe(false);
    expect(deltas.includes("America/New_York")).toBe(true);
    expect(doneTranscript.includes("Ada Lovelace")).toBe(true);
    expect(deltas.includes(doneTranscript)).toBe(false);
    expect(doneTranscript.includes(deltas)).toBe(false);
    events.push(...assistantResponseEvents({
      responseId: "resp-done-small-edit-covered",
      status: "completed",
      transcriptDelta: deltas,
      transcriptDone: doneTranscript,
    }));
    expect(verify(events, PROPOSAL)).toBe(true);
  });

  it("finishes a readback when a done transcript continues the streamed deltas and the start time is formed at that join", () => {
    const events: Record<string, unknown>[] = [];
    // The done transcript is the rest of the utterance, not another copy.
    // "10:00" exists only across that ordinary join.
    const deltas = "Ada Lovelace, callback +15551239876, 2026-09-11 10:";
    const doneTranscript = "00 to 10:30 America/New_York.";
    expect(deltas.includes("10:00")).toBe(false);
    expect(doneTranscript.includes("10:00")).toBe(false);
    expect(`${deltas}${doneTranscript}`.includes("10:00")).toBe(true);
    expect(deltas.includes(doneTranscript)).toBe(false);
    expect(doneTranscript.includes(deltas)).toBe(false);
    events.push(...assistantResponseEvents({
      responseId: "resp-done-continues",
      status: "completed",
      transcriptDelta: deltas,
      transcriptDone: doneTranscript,
    }));
    expect(verify(events, PROPOSAL)).toBe(true);
  });

  it("does not finish a readback when near-copies of the two transcript sources form a field only at the join", () => {
    const events: Record<string, unknown>[] = [];
    // Neither source contains the other, and neither contains "10:00".
    // Concatenating them would form that start time at the boundary.
    const streamed =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    const payload =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York.";
    events.push(...assistantResponseEvents({
      responseId: "resp-near-copy",
      status: "completed",
      transcriptDelta: streamed,
      payloadTranscript: payload,
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when a contained transcript source cuts a field out of a longer number", () => {
    const events: Record<string, unknown>[] = [];
    // The shorter source is a substring of the longer one. "10:00" is its own
    // value only in the shorter source; in the longer source it sits inside "110:00".
    const contained =
      "10:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York";
    const containing = `1${contained}`;
    events.push(...assistantResponseEvents({
      responseId: "resp-contained-cut",
      status: "completed",
      transcriptDelta: contained,
      payloadTranscript: containing,
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when the streamed transcript contains the payload and the cut opens the start time", () => {
    const events: Record<string, unknown>[] = [];
    const contained =
      "10:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York";
    events.push(...assistantResponseEvents({
      responseId: "resp-contained-cut-swap",
      status: "completed",
      transcriptDelta: `1${contained}`,
      payloadTranscript: contained,
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when a required field is split across the two transcript sources", () => {
    const events: Record<string, unknown>[] = [];
    events.push(...assistantResponseEvents({
      responseId: "resp-cross-source",
      status: "completed",
      transcriptDelta: "Ada Lovelace, callback +15551239876, 2026-09-11 10:",
      payloadTranscript: "00 to 10:30 America/New_York.",
    }));
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when no single copy of the speech contains every returned field", () => {
    const events: Record<string, unknown>[] = [];
    // Each returned field is a contiguous value in one copy. Neither copy
    // contains the other, and neither contains every field.
    const streamed =
      "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30.";
    const payload = "America/New_York. Purpose: Website review.";
    const fields = [
      "Ada Lovelace",
      "+15551239876",
      "2026-09-11",
      "10:00",
      "10:30",
      "America/New_York",
      "Website review",
    ];
    expect(streamed.includes(payload)).toBe(false);
    expect(payload.includes(streamed)).toBe(false);
    expect(fields.every((field) => streamed.includes(field) || payload.includes(field))).toBe(
      true,
    );
    expect(fields.every((field) => streamed.includes(field))).toBe(false);
    expect(fields.every((field) => payload.includes(field))).toBe(false);
    events.push(...assistantResponseEvents({
      responseId: "resp-split-copies",
      status: "completed",
      transcriptDelta: streamed,
      payloadTranscript: payload,
    }));
    expect(verify(events, { ...PROPOSAL, purpose: "Website review" })).toBe(false);
  });

  it("finishes a readback when each near-copy of the speech contains every returned field", () => {
    const events: Record<string, unknown>[] = [];
    const readback =
      "Ada Lovelace, callback +15551239876, 2026-09-11 10:00 to 10:30 America/New_York";
    events.push(...assistantResponseEvents({
      responseId: "resp-near-copy-covered",
      status: "completed",
      transcriptDelta: `${readback}.`,
      payloadTranscript: `${readback}!`,
    }));
    expect(verify(events, PROPOSAL)).toBe(true);
  });

  it("finishes a readback when distinct fragments of the streamed transcript together contain each field", () => {
    const events: Record<string, unknown>[] = [];
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-stream-fragments",
      item_id: "resp-stream-fragments-msg",
      delta: "Ada Lovelace, callback +15551239876, 2026-09-11 10:",
    });
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-stream-fragments",
      item_id: "resp-stream-fragments-msg",
      delta: "00 to 10:30 America/New_York.",
    });
    events.push({
      type: "response.done",
      response: {
        id: "resp-stream-fragments",
        object: "realtime.response",
        status: "completed",
      },
    });
    expect(verify(events, PROPOSAL)).toBe(true);
  });

  it("does not finish a readback when a repeated fragment is the only thing that keeps the name inside a longer word", () => {
    const events: Record<string, unknown>[] = [];
    // The continuation is the letter m. That letter already occurs in the
    // earlier fragment, and the utterance ends in Adam.
    const earlier =
      "m callback +15551239876 2026-09-11 10:00 10:30 America/New_York Ada";
    const continuation = "m";
    expect(earlier.endsWith("Ada")).toBe(true);
    expect(earlier.includes(continuation)).toBe(true);
    expect(`${earlier}${continuation}`.endsWith("Adam")).toBe(true);
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-fragment",
      delta: earlier,
    });
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-fragment",
      delta: continuation,
    });
    events.push({
      type: "response.done",
      response: {
        id: "resp-repeated-fragment",
        object: "realtime.response",
        status: "completed",
      },
    });
    expect(verify(events, { ...PROPOSAL, callerName: "Ada" })).toBe(false);
  });

  it("does not finish a readback when a repeated fragment forms the start time only at the join", () => {
    const events: Record<string, unknown>[] = [];
    // "0:00" is already in the earlier fragment. Neither piece contains
    // "10:00". Appending the repeated fragment forms that start time at the join.
    const earlier =
      "0:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 1";
    const repeated = "0:00";
    expect(earlier.includes(repeated)).toBe(true);
    expect(repeated.includes(earlier)).toBe(false);
    expect(earlier.includes("10:00")).toBe(false);
    expect(repeated.includes("10:00")).toBe(false);
    expect(`${earlier}${repeated}`.endsWith("10:00")).toBe(true);
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-join",
      delta: earlier,
    });
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-join",
      delta: repeated,
    });
    events.push({
      type: "response.done",
      response: {
        id: "resp-repeated-join",
        object: "realtime.response",
        status: "completed",
      },
    });
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("does not finish a readback when a repeated fragment's leading edge opens a start time glued inside a longer number", () => {
    const events: Record<string, unknown>[] = [];
    // The held text has "110:00", so "10:00" is not its own value. The later
    // fragment is that text without the leading 1, which the held text already
    // contains. Appending it opens "10:00" at the fragment's leading edge.
    const body =
      "10:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York";
    const earlier = `1${body}.`;
    const repeated = body;
    expect(earlier.includes(repeated)).toBe(true);
    expect(repeated.includes(earlier)).toBe(false);
    expect(earlier.includes("110:00")).toBe(true);
    expect(`${earlier}${repeated}`.includes(`.${repeated}`)).toBe(true);
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-edge",
      delta: earlier,
    });
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-edge",
      delta: repeated,
    });
    events.push({
      type: "response.done",
      response: {
        id: "resp-repeated-edge",
        object: "realtime.response",
        status: "completed",
      },
    });
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("finishes a readback when a one-code-point prefix makes the done transcript a small edit that still contains the deltas", () => {
    const events: Record<string, unknown>[] = [];
    const deltas =
      "10:00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York";
    const doneTranscript = `1${deltas}`;
    events.push(...assistantResponseEvents({
      responseId: "resp-done-prefix-edit",
      status: "completed",
      transcriptDelta: deltas,
      transcriptDone: doneTranscript,
    }));
    expect(verify(events, PROPOSAL)).toBe(true);
  });

  it("does not finish a readback when a later copy of a contained done transcript forms the start time only at that boundary", () => {
    const events: Record<string, unknown>[] = [];
    // The done transcript contains the deltas and differs by one leading
    // code point. A later delta contains that done transcript, not the
    // doubled text. "10:00" is in none of the three fragments.
    const doneTranscript =
      "00 Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 10:";
    const deltas = doneTranscript.slice(1);
    const laterCopy = `${doneTranscript}.`;
    expect(doneTranscript.includes(deltas)).toBe(true);
    expect(deltas.includes(doneTranscript)).toBe(false);
    expect(laterCopy.includes(doneTranscript)).toBe(true);
    expect(laterCopy.includes(`${deltas}${doneTranscript}`)).toBe(false);
    expect(deltas.includes("10:00")).toBe(false);
    expect(doneTranscript.includes("10:00")).toBe(false);
    expect(laterCopy.includes("10:00")).toBe(false);
    expect(`${deltas}${doneTranscript}${laterCopy}`.includes("10:00")).toBe(true);
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-done-contained-later-copy",
      delta: deltas,
    });
    events.push({
      type: "response.output_audio_transcript.done",
      response_id: "resp-done-contained-later-copy",
      transcript: doneTranscript,
    });
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-done-contained-later-copy",
      delta: laterCopy,
    });
    events.push({
      type: "response.done",
      response: {
        id: "resp-done-contained-later-copy",
        object: "realtime.response",
        status: "completed",
      },
    });
    expect(verify(events, PROPOSAL)).toBe(false);
  });

  it("finishes a readback when a repeated one-character fragment completes the start time", () => {
    const events: Record<string, unknown>[] = [];
    const earlier =
      "Ada Lovelace, callback +15551239876, 2026-09-11 10:30 America/New_York 10:0";
    const continuation = "0";
    expect(earlier.includes(continuation)).toBe(true);
    expect(earlier.includes("10:00")).toBe(false);
    expect(`${earlier}${continuation}`.endsWith("10:00")).toBe(true);
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-digit",
      delta: earlier,
    });
    events.push({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-repeated-digit",
      delta: continuation,
    });
    events.push({
      type: "response.done",
      response: {
        id: "resp-repeated-digit",
        object: "realtime.response",
        status: "completed",
      },
    });
    expect(verify(events, PROPOSAL)).toBe(true);
  });
});
