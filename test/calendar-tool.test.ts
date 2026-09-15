import { describe, expect, it } from "vitest";
import { createCalendarAvailabilityTool } from "../src/calendar/availability-tool.js";

const MONDAY_14H = new Date("2026-09-07T14:00:00-04:00");
const SELECTION = { primaryCalendarId: "primary", conflictCalendarIds: ["team"], updatedAt: "2026-09-07T00:00:00.000Z" };
const TOKEN_PROVIDER = { getAccessToken: async () => "test-access-token" };

function googleFetch(freeBusy: unknown, status = 200): typeof fetch {
  return (async (url: unknown) => {
    if (String(url).includes("/freeBusy")) {
      return new Response(JSON.stringify(freeBusy), { status });
    }
    throw new Error(`unexpected request ${String(url)}`);
  }) as typeof fetch;
}

const EMPTY_DAY = {
  calendars: { primary: { busy: [] }, team: { busy: [] } },
};

function toolWith(freeBusy: unknown, extra: Record<string, unknown> = {}) {
  return createCalendarAvailabilityTool({
    fetchFn: googleFetch(freeBusy),
    tokenProvider: TOKEN_PROVIDER,
    selection: SELECTION,
    now: () => MONDAY_14H,
    ...extra,
  });
}

describe("calendar availability tool", () => {
  it("describes a real check_availability tool", () => {
    const definition = toolWith(EMPTY_DAY).definition();
    expect(definition.type).toBe("function");
    expect(definition.name).toBe("check_availability");
    expect(definition.description.toLowerCase()).not.toContain("synthetic");
  });

  it("offers a few real permitted options and names the timezone", async () => {
    const result = await toolWith(EMPTY_DAY).execute({ date: "2026-09-11" });

    expect(result.status).toBe("available");
    expect(result.isSynthetic).toBe(false);
    expect(result.timezone).toBe("America/New_York");
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots.length).toBeLessThanOrEqual(4);
    expect(result.message).toContain("America/New_York");
    expect(JSON.stringify(result)).not.toContain("Weekly Sync");
  });

  it("removes cross-calendar conflicts from the offered options", async () => {
    const result = await toolWith({
      calendars: {
        primary: { busy: [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T12:00:00-04:00" }] },
        team: { busy: [{ start: "2026-09-11T14:00:00-04:00", end: "2026-09-11T15:00:00-04:00" }] },
      },
    }).execute({ date: "2026-09-11" });

    expect(result.status).toBe("available");
    const starts = result.slots.map((slot) => slot.startTime);
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("14:00");
  });

  it("converts offered starts into a requested timezone", async () => {
    const result = await toolWith(EMPTY_DAY).execute({
      date: "2026-09-11",
      timezone: "America/Chicago",
    });

    expect(result.status).toBe("available");
    const first = result.slots[0]!;
    expect(first.startTime).toBe("10:00");
    expect(first.requestedStartTime).toBe("09:00");
    expect(first.requestedTimezone).toBe("America/Chicago");
    expect(result.message).toContain("America/Chicago");
  });

  it("asks for clarification on an ambiguous date instead of guessing", async () => {
    const result = await toolWith(EMPTY_DAY).execute({ date: "next Friday" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("invalid_date");
    expect(result.slots).toEqual([]);
  });

  it("asks for clarification on an impossible calendar date instead of normalizing it", async () => {
    const result = await toolWith(EMPTY_DAY).execute({ date: "2026-02-30" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("invalid_date");
    expect(result.slots).toEqual([]);
  });

  it("rejects a date inside the 72-hour notice period", async () => {
    const result = await toolWith(EMPTY_DAY).execute({ date: "2026-09-09" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("notice_insufficient");
  });

  it("honors the Monday 14:00 earliest-start edge on Thursday", async () => {
    const result = await toolWith(EMPTY_DAY).execute({ date: "2026-09-10" });
    expect(result.status).toBe("available");
    expect(result.slots[0]?.startTime).toBe("14:00");
  });

  it("returns an honest no-availability response when an all-day event blocks the day", async () => {
    const result = await toolWith({
      calendars: {
        primary: { busy: [{ start: "2026-09-11", end: "2026-09-12" }] },
        team: { busy: [] },
      },
    }).execute({ date: "2026-09-11" });

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("no_slots_available");
    expect(result.slots).toEqual([]);
  });

  it("reports unavailable rather than empty when a required calendar errors", async () => {
    const result = await toolWith({
      calendars: {
        primary: { busy: [] },
        team: { errors: [{ reason: "notFound" }], busy: [] },
      },
    }).execute({ date: "2026-09-11" });

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("calendar_unavailable");
    expect(result.slots).toEqual([]);
  });

  it("reports unavailable when authorization was revoked", async () => {
    const tool = createCalendarAvailabilityTool({
      fetchFn: googleFetch({}, 401),
      tokenProvider: TOKEN_PROVIDER,
      selection: SELECTION,
      now: () => MONDAY_14H,
    });
    const result = await tool.execute({ date: "2026-09-11" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("calendar_unavailable");
  });

  it("reports unavailable until Jacob selects calendars, without inferring", async () => {
    const tool = createCalendarAvailabilityTool({
      fetchFn: googleFetch(EMPTY_DAY),
      tokenProvider: TOKEN_PROVIDER,
      selection: null,
      now: () => MONDAY_14H,
    });
    const result = await tool.execute({ date: "2026-09-11" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("calendars_not_selected");
  });

  it("reports unavailable when the calendar is not connected", async () => {
    const tool = createCalendarAvailabilityTool({
      fetchFn: googleFetch(EMPTY_DAY),
      credentials: null,
      selection: SELECTION,
      now: () => MONDAY_14H,
    });
    const result = await tool.execute({ date: "2026-09-11" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("calendar_unavailable");
  });
});
