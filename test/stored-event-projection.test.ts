import { describe, expect, it } from "vitest";
import { projectStoredKind, settleRecovery } from "../src/calendar/stored-event-projection.js";
import type { StoredEventKind } from "../src/calendar/client.js";

describe("stored-event projection", () => {
  it("projects a matching stored event as a booked appointment the caller may hear", () => {
    expect(projectStoredKind("matching")).toEqual({
      commit: { status: "booked" },
      announce: true,
      eventStored: true,
      callbackHold: "held",
    });
  });

  it("projects a mismatched stored event as a shape miss that still holds the callback number", () => {
    expect(projectStoredKind("mismatched")).toEqual({
      commit: { status: "inconclusive", storedShape: "mismatched" },
      announce: false,
      eventStored: true,
      callbackHold: "held",
    });
  });

  it("projects a cancelled stored event as stored, not booked, and not holding the callback number", () => {
    const projection = projectStoredKind("cancelled");
    expect(projection).toEqual({
      commit: { status: "inconclusive" },
      announce: false,
      eventStored: true,
      callbackHold: "not_held",
    });
    expect(projection.commit).not.toHaveProperty("storedShape");
  });

  it("projects a missing stored event as not stored and not holding the callback number", () => {
    const projection = projectStoredKind("missing");
    expect(projection).toEqual({
      commit: { status: "inconclusive" },
      announce: false,
      eventStored: false,
      callbackHold: "not_held",
    });
    expect(projection.commit).not.toHaveProperty("storedShape");
  });

  it("projects an unreachable calendar as unknown, with nothing stored and nothing announced", () => {
    const projection = projectStoredKind("unreachable");
    expect(projection).toEqual({
      commit: { status: "inconclusive" },
      announce: false,
      eventStored: false,
      callbackHold: "unknown",
    });
    expect(projection.commit).not.toHaveProperty("storedShape");
  });

  it("throws for a stored-event kind outside the five instead of recording it booked", () => {
    expect(() => projectStoredKind("other" as StoredEventKind)).toThrow(
      "Unknown stored event kind: other",
    );
  });
});

describe("restart recovery settlement", () => {
  it("appends nothing and reports unresolved when the callback hold is unknown, even for a pending row", () => {
    expect(settleRecovery(projectStoredKind("unreachable"), { status: "pending" })).toEqual({
      status: "unresolved",
    });
  });

  it("appends the booked commit when the projection announces, even if the previous row already had a shape mark", () => {
    const projection = projectStoredKind("matching");
    const settlement = settleRecovery(projection, {
      status: "inconclusive",
      storedShape: "mismatched",
    });
    expect(settlement).toEqual({
      append: { status: "booked" },
      status: "booked",
    });
    expect(settlement.append).toBe(projection.commit);
  });

  it("appends a pending row's commit, including a shape miss", () => {
    const projection = projectStoredKind("mismatched");
    const settlement = settleRecovery(projection, { status: "pending" });
    expect(settlement).toEqual({
      append: { status: "inconclusive", storedShape: "mismatched" },
      status: "inconclusive",
    });
    expect(settlement.append).toBe(projection.commit);
  });

  it("appends a pending missing event as inconclusive with no shape mark", () => {
    const projection = projectStoredKind("missing");
    const settlement = settleRecovery(projection, { status: "pending" });
    expect(settlement).toEqual({
      append: { status: "inconclusive" },
      status: "inconclusive",
    });
    expect(settlement.append).toBe(projection.commit);
    expect(settlement.append).not.toHaveProperty("storedShape");
  });

  it("appends a pending cancelled event as inconclusive and clears no extra mark onto the commit", () => {
    const projection = projectStoredKind("cancelled");
    const settlement = settleRecovery(projection, { status: "pending" });
    expect(settlement).toEqual({
      append: { status: "inconclusive" },
      status: "inconclusive",
    });
    expect(settlement.append).toBe(projection.commit);
  });

  it("clears a shape mark when a cancelled stored event no longer holds the callback number", () => {
    const projection = projectStoredKind("cancelled");
    const settlement = settleRecovery(projection, {
      status: "inconclusive",
      storedShape: "mismatched",
    });
    expect(settlement).toEqual({
      append: { status: "inconclusive" },
      status: "inconclusive",
    });
    expect(settlement.append).toBe(projection.commit);
    expect(settlement.append).not.toHaveProperty("storedShape");
  });

  it("appends nothing for a cancelled event whose previous row is already inconclusive without a shape mark", () => {
    expect(
      settleRecovery(projectStoredKind("cancelled"), { status: "inconclusive" }),
    ).toEqual({ status: "inconclusive" });
  });

  it("does not clear a shape mark for a missing event that is already inconclusive", () => {
    expect(
      settleRecovery(projectStoredKind("missing"), {
        status: "inconclusive",
        storedShape: "mismatched",
      }),
    ).toEqual({ status: "inconclusive" });
  });

  it("does not backfill a shape mark onto an already-inconclusive mismatched event", () => {
    expect(settleRecovery(projectStoredKind("mismatched"), { status: "inconclusive" })).toEqual({
      status: "inconclusive",
    });
  });

  it("does not append again when an already-inconclusive mismatched event still has its shape mark", () => {
    expect(
      settleRecovery(projectStoredKind("mismatched"), {
        status: "inconclusive",
        storedShape: "mismatched",
      }),
    ).toEqual({ status: "inconclusive" });
  });
});
