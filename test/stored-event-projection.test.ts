import { describe, expect, it } from "vitest";
import { project } from "../src/calendar/stored-event-projection.js";
import type { StoredEventKind } from "../src/calendar/client.js";

describe("stored-event projection confirm", () => {
  it("books a matching stored event and lets the caller be told the appointment exists", () => {
    expect(project("matching").confirm()).toEqual({
      commit: { status: "booked" },
      speechKey: "booked",
      tellCaller: true,
    });
  });

  it("does not tell the caller a shape miss is booked, and the commit keeps the shape mark", () => {
    const confirmation = project("mismatched").confirm();
    expect(confirmation).toEqual({
      commit: { status: "inconclusive", storedShape: "mismatched" },
      speechKey: "mismatched",
      tellCaller: false,
    });
  });

  it("treats a cancelled stored event after the insert as an interrupted write with no shape mark", () => {
    const confirmation = project("cancelled").confirm();
    expect(confirmation).toEqual({
      commit: { status: "inconclusive" },
      speechKey: "interrupted",
      tellCaller: false,
    });
    expect(confirmation.commit).not.toHaveProperty("storedShape");
  });

  it("treats a missing event after the insert as an interrupted write, not an unavailable time", () => {
    const confirmation = project("missing").confirm();
    expect(confirmation).toEqual({
      commit: { status: "inconclusive" },
      speechKey: "interrupted",
      tellCaller: false,
    });
    expect(confirmation.commit).not.toHaveProperty("storedShape");
    expect(confirmation.commit.status).not.toBe("unavailable");
  });

  it("treats an unreachable calendar after the insert as an interrupted write with no shape mark", () => {
    const confirmation = project("unreachable").confirm();
    expect(confirmation).toEqual({
      commit: { status: "inconclusive" },
      speechKey: "interrupted",
      tellCaller: false,
    });
    expect(confirmation.commit).not.toHaveProperty("storedShape");
  });
});

describe("stored-event projection closed start", () => {
  it("refuses a missing event when the proposed start is already not open, without a commit", () => {
    expect(project("missing").confirmClosedStart()).toEqual({ outcome: "unavailable" });
  });

  it("keeps an unreachable calendar as an interrupted commit when the proposed start is already not open", () => {
    expect(project("unreachable").confirmClosedStart()).toEqual({
      outcome: "commit",
      confirmation: {
        commit: { status: "inconclusive" },
        speechKey: "interrupted",
        tellCaller: false,
      },
    });
  });

  it("keeps a matching event as a booked commit when the proposed start is already not open", () => {
    expect(project("matching").confirmClosedStart()).toEqual({
      outcome: "commit",
      confirmation: {
        commit: { status: "booked" },
        speechKey: "booked",
        tellCaller: true,
      },
    });
  });

  it("keeps a shape miss when the proposed start is already not open", () => {
    expect(project("mismatched").confirmClosedStart()).toEqual({
      outcome: "commit",
      confirmation: {
        commit: { status: "inconclusive", storedShape: "mismatched" },
        speechKey: "mismatched",
        tellCaller: false,
      },
    });
  });

  it("keeps a cancelled event as an interrupted commit when the proposed start is already not open", () => {
    const decision = project("cancelled").confirmClosedStart();
    expect(decision).toEqual({
      outcome: "commit",
      confirmation: {
        commit: { status: "inconclusive" },
        speechKey: "interrupted",
        tellCaller: false,
      },
    });
    if (decision.outcome === "commit") {
      expect(decision.confirmation.commit).not.toHaveProperty("storedShape");
    }
  });
});

describe("stored-event projection hold", () => {
  it("holds the callback number for a matching stored event", () => {
    expect(project("matching").hold()).toBe("held");
  });

  it("holds the callback number for a shape miss", () => {
    expect(project("mismatched").hold()).toBe("held");
  });

  it("does not hold the callback number for a cancelled stored event", () => {
    expect(project("cancelled").hold()).toBe("not_held");
  });

  it("does not hold the callback number for a missing event", () => {
    expect(project("missing").hold()).toBe("not_held");
  });

  it("reports an unknown callback hold when the calendar cannot be reached", () => {
    expect(project("unreachable").hold()).toBe("unknown");
  });
});

describe("stored-event projection recovery", () => {
  it("appends nothing and reports unresolved when the callback hold is unknown, even for a pending row", () => {
    expect(project("unreachable").recover({ status: "pending" })).toEqual({
      status: "unresolved",
      eventStored: false,
    });
  });

  it("appends the booked commit when the caller may be told, even if the previous row had a shape mark", () => {
    const decision = project("matching").recover({
      status: "inconclusive",
      storedShape: "mismatched",
    });
    expect(decision).toEqual({
      append: { status: "booked" },
      status: "booked",
      eventStored: true,
    });
    expect(decision.append).not.toHaveProperty("storedShape");
  });

  it("appends a pending row's commit, including a shape miss", () => {
    expect(project("mismatched").recover({ status: "pending" })).toEqual({
      append: { status: "inconclusive", storedShape: "mismatched" },
      status: "inconclusive",
      eventStored: true,
    });
  });

  it("appends a pending missing event as inconclusive with no shape mark", () => {
    const decision = project("missing").recover({ status: "pending" });
    expect(decision).toEqual({
      append: { status: "inconclusive" },
      status: "inconclusive",
      eventStored: false,
    });
    expect(decision.append).not.toHaveProperty("storedShape");
  });

  it("appends a pending cancelled event as inconclusive with no shape mark", () => {
    const decision = project("cancelled").recover({ status: "pending" });
    expect(decision).toEqual({
      append: { status: "inconclusive" },
      status: "inconclusive",
      eventStored: true,
    });
    expect(decision.append).not.toHaveProperty("storedShape");
  });

  it("clears a shape mark when a cancelled stored event no longer holds the callback number", () => {
    const decision = project("cancelled").recover({
      status: "inconclusive",
      storedShape: "mismatched",
    });
    expect(decision).toEqual({
      append: { status: "inconclusive" },
      status: "inconclusive",
      eventStored: true,
    });
    expect(decision.append).not.toHaveProperty("storedShape");
  });

  it("appends nothing for a cancelled event whose previous row is already inconclusive without a shape mark", () => {
    expect(project("cancelled").recover({ status: "inconclusive" })).toEqual({
      status: "inconclusive",
      eventStored: true,
    });
  });

  it("does not clear a shape mark for a missing event that is already inconclusive", () => {
    expect(
      project("missing").recover({
        status: "inconclusive",
        storedShape: "mismatched",
      }),
    ).toEqual({ status: "inconclusive", eventStored: false });
  });

  it("does not backfill a shape mark onto an already-inconclusive mismatched event", () => {
    expect(project("mismatched").recover({ status: "inconclusive" })).toEqual({
      status: "inconclusive",
      eventStored: true,
    });
  });

  it("does not append again when an already-inconclusive mismatched event still has its shape mark", () => {
    expect(
      project("mismatched").recover({
        status: "inconclusive",
        storedShape: "mismatched",
      }),
    ).toEqual({ status: "inconclusive", eventStored: true });
  });
});

describe("stored-event projection kind guard", () => {
  it("throws for a stored-event kind outside the five before confirm or recovery", () => {
    expect(() => project("other" as StoredEventKind)).toThrow(
      "Unknown stored event kind: other",
    );
  });
});
