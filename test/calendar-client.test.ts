import { describe, expect, it } from "vitest";
import {
  CalendarQueryError,
  listCalendars,
  queryBusyIntervals,
} from "../src/calendar/client.js";

function cannedFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

describe("calendar client", () => {
  it("presents calendar metadata for selection without event content", async () => {
    const fetchFn = cannedFetch((url) => {
      expect(url).toContain("/calendarList");
      return Response.json({
        items: [
          { id: "primary-id", summary: "Jacob", primary: true, accessRole: "owner" },
          { id: "team-id", summary: "Team", accessRole: "reader" },
          { id: "", summary: "Bad" },
        ],
      });
    });

    const calendars = await listCalendars(fetchFn, "token");
    expect(calendars).toEqual([
      { id: "primary-id", summary: "Jacob", primary: true, accessRole: "owner" },
      { id: "team-id", summary: "Team", primary: false, accessRole: "reader" },
    ]);
    const serialized = JSON.stringify(calendars);
    expect(serialized).not.toContain("Appointment");
  });

  it("maps revoked authorization to an auth failure", async () => {
    const fetchFn = cannedFetch(() => new Response("{}", { status: 401 }));
    const error = await listCalendars(fetchFn, "stale").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CalendarQueryError);
    expect((error as CalendarQueryError).kind).toBe("auth");
  });

  it("merges busy intervals across every required calendar", async () => {
    let requestBody: { items?: Array<{ id: string }>; timeMin?: string; timeMax?: string } = {};
    const fetchFn = cannedFetch((url, init) => {
      expect(url).toContain("/freeBusy");
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return Response.json({
        calendars: {
          primary: { busy: [{ start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T11:00:00-04:00" }] },
          conflicts: { busy: [{ start: "2026-09-11T14:00:00-04:00", end: "2026-09-11T14:30:00-04:00" }] },
        },
      });
    });

    const busy = await queryBusyIntervals(fetchFn, "token", {
      calendarIds: ["primary", "conflicts"],
      timeMin: new Date("2026-09-11T00:00:00-04:00"),
      timeMax: new Date("2026-09-11T23:59:00-04:00"),
    });

    expect(requestBody.items).toEqual([{ id: "primary" }, { id: "conflicts" }]);
    expect(requestBody.timeMin).toBe("2026-09-11T04:00:00.000Z");
    expect(busy).toHaveLength(2);
    expect(busy[0]?.start.toISOString()).toBe("2026-09-11T14:00:00.000Z");
  });

  it("fails closed when any required calendar reports an error", async () => {
    const fetchFn = cannedFetch(() =>
      Response.json({
        calendars: {
          primary: { busy: [] },
          conflicts: { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
        },
      }),
    );

    const error = await queryBusyIntervals(fetchFn, "token", {
      calendarIds: ["primary", "conflicts"],
      timeMin: new Date("2026-09-11T00:00:00-04:00"),
      timeMax: new Date("2026-09-11T23:59:00-04:00"),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CalendarQueryError);
    expect((error as CalendarQueryError).kind).toBe("required_calendar");
  });

  it("ignores entries for events marked free", async () => {
    const fetchFn = cannedFetch(() =>
      Response.json({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-09-11T10:00:00-04:00",
                end: "2026-09-11T11:00:00-04:00",
                transparency: "transparent",
              },
            ],
          },
        },
      }),
    );

    const busy = await queryBusyIntervals(fetchFn, "token", {
      calendarIds: ["primary"],
      timeMin: new Date("2026-09-11T00:00:00-04:00"),
      timeMax: new Date("2026-09-11T23:59:00-04:00"),
    });

    expect(busy).toEqual([]);
  });

  it("expands all-day date-only bounds to Eastern day edges", async () => {
    const fetchFn = cannedFetch(() =>
      Response.json({
        calendars: {
          primary: { busy: [{ start: "2026-09-11", end: "2026-09-12" }] },
        },
      }),
    );

    const busy = await queryBusyIntervals(fetchFn, "token", {
      calendarIds: ["primary"],
      timeMin: new Date("2026-09-11T00:00:00-04:00"),
      timeMax: new Date("2026-09-11T23:59:00-04:00"),
    });

    expect(busy).toHaveLength(1);
    expect(busy[0]?.start.toISOString()).toBe("2026-09-11T04:00:00.000Z");
    expect(busy[0]?.end.toISOString()).toBe("2026-09-12T04:00:00.000Z");
  });
});
