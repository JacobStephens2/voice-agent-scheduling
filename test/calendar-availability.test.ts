import { describe, expect, it } from "vitest";
import { prepareBookingDay, type BusyInterval } from "../src/calendar/policy.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");

function preparedDay(date: string, referenceTime = MONDAY_14H) {
  const day = prepareBookingDay(date, referenceTime);
  if (day.window === "invalid_date") throw new Error(`Expected a prepared day for ${date}`);
  return day;
}

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

describe("Booking window", () => {
  it("keeps the nominal last start after the 72-hour notice edge closes", () => {
    const date = "2026-09-10";
    const atEdge = preparedDay(date, new Date("2026-09-07T20:30:00.000Z"));
    expect(atEdge.window).toBe("open");
    expect(atEdge.eligibleStarts().map((slot) => slot.startTime)).toEqual(["16:30"]);

    const afterEdge = preparedDay(date, new Date("2026-09-07T20:30:00.001Z"));
    expect(afterEdge.window).toBe("notice_insufficient");
    expect(afterEdge.eligibleStarts()).toEqual([]);
    expect(afterEdge.nominalStart("16:30")?.startUtc).toBe("2026-09-10T20:30:00.000Z");
  });

  it("includes the first start exactly 14 days ahead", () => {
    const date = "2026-09-21";
    const atEdge = preparedDay(date, new Date("2026-09-07T14:00:00.000Z"));
    expect(atEdge.window).toBe("open");
    expect(atEdge.eligibleStarts().map((slot) => slot.startTime)).toEqual(["10:00"]);

    const beforeEdge = preparedDay(date, new Date("2026-09-07T13:59:59.999Z"));
    expect(beforeEdge.window).toBe("beyond_horizon");
    expect(beforeEdge.eligibleStarts()).toEqual([]);
  });

  it("offers weekday starts on the hour and half-hour inside 10:00-17:00 Eastern", () => {
    const slots = preparedDay("2026-09-11").eligibleStarts();

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
    const slots = preparedDay("2026-09-10").eligibleStarts();

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.startTime >= "14:00").toBe(true);
    }
    expect(slots.map((slot) => slot.startTime)).toContain("14:00");
    expect(slots.map((slot) => slot.startTime)).not.toContain("10:00");
  });

  it("enforces the 14-day horizon: only starts at most 14 days ahead are offered", () => {
    const slots = preparedDay("2026-09-21").eligibleStarts();

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.startTime <= "14:00").toBe(true);
    }
    expect(slots.map((slot) => slot.startTime)).toContain("14:00");
    expect(slots.map((slot) => slot.startTime)).not.toContain("14:30");
  });

  it("offers no starts for an impossible calendar date", () => {
    // 2026-02-30 normalizes to 2026-03-02, which is inside this window;
    // without a strict date check the policy would label March slots "2026-02-30".
    const nearMiss = new Date("2026-02-23T14:00:00-05:00");
    expect(prepareBookingDay("2026-02-30", nearMiss)).toEqual({ window: "invalid_date" });
    expect(prepareBookingDay("2026-2-28", nearMiss)).toEqual({ window: "invalid_date" });
  });

  it("offers no starts on weekends", () => {
    const day = preparedDay("2026-09-12");
    expect(day.window).toBe("weekend_not_permitted");
    expect(day.nominalStart("10:00")).toBeUndefined();
    expect(day.eligibleStarts()).toEqual([]);
  });

  it("removes starts overlapping busy intervals from any required calendar", () => {
    const slots = preparedDay("2026-09-11").eligibleStarts([
      busy("2026-09-11T10:00:00-04:00", "2026-09-11T11:00:00-04:00"),
      busy("2026-09-11T14:15:00-04:00", "2026-09-11T14:45:00-04:00"),
    ]);

    const starts = slots.map((slot) => slot.startTime);
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("10:30");
    expect(starts).not.toContain("14:00");
    expect(starts).not.toContain("14:30");
    expect(starts).toContain("11:00");
    expect(starts).toContain("15:00");
  });

  it("allows back-to-back appointments: a busy event ending on the half-hour frees that start", () => {
    const slots = preparedDay("2026-09-11").eligibleStarts([
      busy("2026-09-11T10:00:00-04:00", "2026-09-11T10:30:00-04:00"),
    ]);

    const starts = slots.map((slot) => slot.startTime);
    expect(starts).not.toContain("10:00");
    expect(starts).toContain("10:30");
  });

  it("treats an all-day busy interval as blocking the whole day", () => {
    const slots = preparedDay("2026-09-11").eligibleStarts([
      busy("2026-09-11T00:00:00-04:00", "2026-09-12T00:00:00-04:00"),
    ]);

    expect(slots).toEqual([]);
  });

  it("ignores intervals for events marked free", () => {
    const slots = preparedDay("2026-09-11").eligibleStarts([
      busy("2026-09-11T10:00:00-04:00", "2026-09-11T12:00:00-04:00", "transparent"),
    ]);

    const starts = slots.map((slot) => slot.startTime);
    expect(starts).toContain("10:00");
    expect(starts).toContain("11:30");
  });

  it("keeps weekday hours correct across the daylight-saving fallback", () => {
    const beforeFallback = new Date("2026-10-26T14:00:00-04:00");
    const slots = preparedDay("2026-11-02", beforeFallback).eligibleStarts();

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
    const slots = preparedDay("2026-03-09", beforeForward).eligibleStarts();

    expect(slots.length).toBeGreaterThan(0);
    const first = slots.find((slot) => slot.startTime === "10:00");
    expect(first?.startUtc).toBe("2026-03-09T14:00:00.000Z");
  });

  it("counts elapsed notice across the spring-forward weekend", () => {
    const friday = new Date("2026-03-06T10:00:00-05:00");
    const monday = preparedDay("2026-03-09", friday);
    expect(monday.nominalStart("10:00")?.startUtc).toBe("2026-03-09T14:00:00.000Z");
    expect(monday.eligibleStarts()[0]?.startUtc).toBe("2026-03-09T15:00:00.000Z");
  });

  it.each([
    ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:00.000Z"],
    ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:00.000Z"],
  ])("uses Eastern free/busy bounds on the daylight-saving transition %s", (date, start, end) => {
    const { freeBusyBounds } = preparedDay(date);
    expect(freeBusyBounds.timeMin.toISOString()).toBe(start);
    expect(freeBusyBounds.timeMax.toISOString()).toBe(end);
  });
});
