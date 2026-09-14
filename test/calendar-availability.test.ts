import { describe, expect, it } from "vitest";
import {
  computeAvailableStarts,
  type BusyInterval,
} from "../src/calendar/policy.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");

function busy(
  startIso: string,
  endIso: string,
  transparency: BusyInterval["transparency"] = "opaque",
): BusyInterval {
  return {
    start: new Date(startIso),
    end: new Date(endIso),
    transparency,
  };
}

describe("calendar availability policy", () => {
  it("offers weekday starts on the hour and half-hour inside 10:00-17:00 Eastern", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-11",
      now: MONDAY_14H,
      busy: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.date).toBe("2026-09-11");
      expect(slot.durationMinutes).toBe(30);
      expect(slot.timezone).toBe("America/New_York");
      expect(slot.isSynthetic).toBe(false);
      expect(["00", "30"]).toContain(slot.startTime.slice(3));
      expect(slot.startTime >= "10:00").toBe(true);
      expect(slot.startTime <= "16:30").toBe(true);
    }
    expect(slots.map((slot) => slot.startTime)).toContain("16:30");
  });

  it("enforces 72 elapsed hours of notice: a Monday 14:00 call cannot offer before Thursday 14:00", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-10",
      now: MONDAY_14H,
      busy: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.startTime >= "14:00").toBe(true);
    }
    expect(slots.map((slot) => slot.startTime)).toContain("14:00");
    expect(slots.map((slot) => slot.startTime)).not.toContain("10:00");
  });

  it("enforces the 14-day horizon: only starts at most 14 days ahead are offered", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-21",
      now: MONDAY_14H,
      busy: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.startTime <= "14:00").toBe(true);
    }
    expect(slots.map((slot) => slot.startTime)).toContain("14:00");
    expect(slots.map((slot) => slot.startTime)).not.toContain("14:30");
  });

  it("offers no starts on weekends", () => {
    expect(
      computeAvailableStarts({ date: "2026-09-12", now: MONDAY_14H, busy: [] }),
    ).toEqual([]);
  });

  it("removes starts overlapping busy intervals from any required calendar", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-11",
      now: MONDAY_14H,
      busy: [
        busy("2026-09-11T10:00:00-04:00", "2026-09-11T11:00:00-04:00"),
        busy("2026-09-11T14:15:00-04:00", "2026-09-11T14:45:00-04:00"),
      ],
    });

    const starts = slots.map((slot) => slot.startTime);
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("10:30");
    expect(starts).not.toContain("14:00");
    expect(starts).not.toContain("14:30");
    expect(starts).toContain("11:00");
    expect(starts).toContain("15:00");
  });

  it("allows back-to-back appointments: a busy event ending on the half-hour frees that start", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-11",
      now: MONDAY_14H,
      busy: [busy("2026-09-11T10:00:00-04:00", "2026-09-11T10:30:00-04:00")],
    });

    const starts = slots.map((slot) => slot.startTime);
    expect(starts).not.toContain("10:00");
    expect(starts).toContain("10:30");
  });

  it("treats an all-day busy interval as blocking the whole day", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-11",
      now: MONDAY_14H,
      busy: [busy("2026-09-11T00:00:00-04:00", "2026-09-12T00:00:00-04:00")],
    });

    expect(slots).toEqual([]);
  });

  it("ignores intervals for events marked free", () => {
    const slots = computeAvailableStarts({
      date: "2026-09-11",
      now: MONDAY_14H,
      busy: [
        busy("2026-09-11T10:00:00-04:00", "2026-09-11T12:00:00-04:00", "transparent"),
      ],
    });

    const starts = slots.map((slot) => slot.startTime);
    expect(starts).toContain("10:00");
    expect(starts).toContain("11:30");
  });

  it("keeps weekday hours correct across the daylight-saving fallback", () => {
    const beforeFallback = new Date("2026-10-26T14:00:00-04:00");
    const slots = computeAvailableStarts({
      date: "2026-11-02",
      now: beforeFallback,
      busy: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.timezone).toBe("America/New_York");
    }
    const last = slots.find((slot) => slot.startTime === "16:30");
    expect(last).toBeDefined();
    expect(last?.startUtc).toBe("2026-11-02T21:30:00.000Z");
    const first = slots.find((slot) => slot.startTime === "10:00");
    expect(first?.startUtc).toBe("2026-11-02T15:00:00.000Z");
  });

  it("keeps weekday hours correct across the daylight-saving spring forward", () => {
    const beforeForward = new Date("2026-02-23T14:00:00-05:00");
    const slots = computeAvailableStarts({
      date: "2026-03-09",
      now: beforeForward,
      busy: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    const first = slots.find((slot) => slot.startTime === "10:00");
    expect(first?.startUtc).toBe("2026-03-09T14:00:00.000Z");
  });
});
