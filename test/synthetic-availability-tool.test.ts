import { describe, expect, it } from "vitest";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";

describe("synthetic availability tool", () => {
  const tool = createSyntheticAvailabilityTool();
  const mondayAfternoon = new Date("2026-09-07T14:00:00-04:00");

  it("describes a synthetic check_availability tool", () => {
    const definition = tool.definition();
    expect(definition.type).toBe("function");
    expect(definition.name).toBe("check_availability");
    expect(definition.description.toLowerCase()).toContain("synthetic");
  });

  it("returns synthetic 30-minute weekday slots in America/New_York inside the booking window", () => {
    const result = tool.execute(
      { date: "2026-09-11" },
      { referenceTime: mondayAfternoon },
    );

    expect(result.status).toBe("available");
    expect(result.isSynthetic).toBe(true);
    expect(result.timezone).toBe("America/New_York");
    expect(result.slots.length).toBeGreaterThan(0);

    for (const slot of result.slots) {
      expect(slot).toMatchObject({
        date: "2026-09-11",
        durationMinutes: 30,
        timezone: "America/New_York",
        isSynthetic: true,
      });
      const startHour = Number(slot.startTime.slice(0, 2));
      expect(startHour).toBeGreaterThanOrEqual(10);
      expect(startHour).toBeLessThanOrEqual(16);
    }
  });

  it("rejects a date with less than 72 hours of notice", () => {
    const result = tool.execute(
      { date: "2026-09-09" },
      { referenceTime: mondayAfternoon },
    );

    expect(result.status).toBe("unavailable");
    expect(result.isSynthetic).toBe(true);
    expect(result.slots).toEqual([]);
    expect(result.reason).toBe("notice_insufficient");
  });

  it("rejects a date beyond the 14-day booking horizon", () => {
    const result = tool.execute(
      { date: "2026-09-28" },
      { referenceTime: mondayAfternoon },
    );

    expect(result.status).toBe("unavailable");
    expect(result.slots).toEqual([]);
    expect(result.reason).toBe("beyond_horizon");
  });

  it("rejects weekend dates", () => {
    const result = tool.execute(
      { date: "2026-09-12" },
      { referenceTime: mondayAfternoon },
    );

    expect(result.status).toBe("unavailable");
    expect(result.slots).toEqual([]);
    expect(result.reason).toBe("weekend_not_permitted");
  });

  it("rejects an invalid date", () => {
    const result = tool.execute({ date: "not-a-date" }, { referenceTime: mondayAfternoon });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("invalid_date");
  });
});
