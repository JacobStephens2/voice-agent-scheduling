import { describe, expect, it } from "vitest";
import { createTelephoneSession } from "../src/session.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import { FakeRealtimeSocket } from "./fake-socket.js";

const REQUIRED_MODEL = "grok-voice-think-fast-2.0";
// Thursday, September 17, 2026, 10:00 AM Eastern.
const REFERENCE_TIME = new Date("2026-09-17T14:00:00.000Z");

async function sessionInstructionsText(referenceTime?: Date): Promise<string> {
  let socket: FakeRealtimeSocket | undefined;
  const session = createTelephoneSession({
    callId: "call-date-anchor-1",
    apiKey: "test-xai-key",
    availabilityTool: createSyntheticAvailabilityTool(),
    connectWebSocket: (url, headers) => {
      socket = new FakeRealtimeSocket(url, headers);
      return socket;
    },
    ...(referenceTime === undefined ? {} : { referenceTime }),
  });
  const outcome = session.start();
  socket!.receive({ type: "session.created", session: { model: REQUIRED_MODEL } });
  const update = socket!.messageOfType("session.update") as {
    session: { instructions: string };
  };
  const instructions = update.session.instructions;
  socket!.close();
  await outcome;
  return instructions;
}

describe("session date anchor", () => {
  it("tells the agent today's Eastern date so relative days resolve", async () => {
    const instructions = await sessionInstructionsText(REFERENCE_TIME);
    expect(instructions).toContain("Thursday, September 17, 2026");
    expect(instructions).toContain("America/New_York");
    expect(instructions.toLowerCase()).toContain("relative");
  });

  it("anchors to the current date when no reference time is supplied", async () => {
    const instructions = await sessionInstructionsText();
    expect(instructions).toContain("Today is");
    expect(instructions).toContain("America/New_York");
  });
});
