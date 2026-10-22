import { describe, expect, it } from "vitest";
import {
  CalendarQueryError,
  appointmentNotificationProof,
  commitStoredCalendarEvent,
  deleteAppointmentEvent,
  queryBusyIntervals,
  readStoredCalendarEvent,
  validateCalendars,
} from "../src/calendar/client.js";

const EVENT_ID = "0123456789abcdef0123456789abcdef";

function cannedFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

function approvedEvent(overrides: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  return {
    id: EVENT_ID,
    status: "confirmed",
    summary: "Appointment with Ada Lovelace",
    description: "Callback number: +15551239876\nPurpose: Website review",
    start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
    transparency: "opaque",
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    },
    ...overrides,
  };
}

const COMMIT_OPTIONS = {
  calendarId: "primary",
  eventId: EVENT_ID,
  callerName: "Ada Lovelace",
  callbackNumber: "+15551239876",
  purpose: "Website review",
  date: "2026-09-11",
  startTime: "10:00",
};

describe("calendar client", () => {
  it("validates candidate calendars through freeBusy without reading event content", async () => {
    let requestUrl = "";
    const fetchFn = cannedFetch((url) => {
      requestUrl = url;
      return Response.json({
        calendars: {
          primary: { busy: [] },
          "team@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
            busy: [],
          },
        },
      });
    });

    const validated = await validateCalendars(fetchFn, "token", [
      "primary",
      "team@example.com",
    ]);
    expect(requestUrl).toContain("/freeBusy");
    expect(requestUrl).not.toContain("/calendarList");
    expect(validated).toEqual([
      { id: "primary", reachable: true },
      { id: "team@example.com", reachable: false, error: "notFound" },
    ]);
    const serialized = JSON.stringify(validated);
    expect(serialized).not.toContain("Appointment");
  });

  it("maps revoked authorization to an auth failure", async () => {
    const fetchFn = cannedFetch(() => new Response("{}", { status: 401 }));
    const error = await validateCalendars(fetchFn, "stale", ["primary"]).catch(
      (value: unknown) => value,
    );
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

  it("creates a 30-minute busy appointment and classifies the stored event, not the insert body", async () => {
    const requests: Array<{ method?: string; url: string; body?: { [key: string]: unknown } }> =
      [];
    const stored = approvedEvent();
    const fetchFn = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url,
        body: init?.body
          ? (JSON.parse(String(init.body)) as { [key: string]: unknown })
          : undefined,
      });
      if (url.includes("/events") && method === "POST") {
        return Response.json({
          id: EVENT_ID,
          summary: "insert-response-not-proof",
          hangoutLink: "https://meet.google.com/insert-not-proof",
          attendees: [{ email: "insert@example.com" }],
        });
      }
      if (url.includes(`/events/${EVENT_ID}`) && method === "GET") {
        return Response.json(stored);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const reading = await commitStoredCalendarEvent(fetchFn, "token", COMMIT_OPTIONS);

    const insert = requests.find((entry) => entry.method === "POST");
    expect(insert?.url).toContain("/calendars/primary/events");
    expect(insert?.url).toContain("sendUpdates=none");
    expect(insert?.body).toMatchObject({
      id: EVENT_ID,
      summary: "Appointment with Ada Lovelace",
      description: "Callback number: +15551239876\nPurpose: Website review",
      start: { dateTime: "2026-09-11T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-11T10:30:00", timeZone: "America/New_York" },
      transparency: "opaque",
      reminders: {
        useDefault: false,
        overrides: [{ method: "popup", minutes: 10 }],
      },
    });
    expect(insert?.body).not.toHaveProperty("attendees");
    expect(insert?.body).not.toHaveProperty("conferenceData");
    expect(JSON.stringify(insert?.body)).not.toContain("email");

    expect(reading.kind).toBe("matching");
    expect(reading.event?.summary).toBe("Appointment with Ada Lovelace");
    expect(reading.event?.summary).not.toBe("insert-response-not-proof");
    expect(reading.event?.hangoutLink).toBeUndefined();
    expect(reading.event?.attendees).toEqual([]);
    expect(reading.event?.conferenceData).toBeUndefined();
    expect(reading.event?.reminders?.overrides).toEqual([{ method: "popup", minutes: 10 }]);
    expect(reading.event?.reminders?.useDefault).toBe(false);
    const storedEvent = reading.event;
    expect(storedEvent).toBeDefined();
    if (!storedEvent) {
      return;
    }
    expect(appointmentNotificationProof(storedEvent)).toMatchObject({
      hasAttendees: false,
      hasHangoutLink: false,
      hasConferenceData: false,
      hasEmailReminder: false,
      popupReminderMinutes: [10],
      matchesApprovedShape: true,
    });
  });

  it("deletes a leftover live-verification event without sending updates", async () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const requests: Array<{ method?: string; url: string }> = [];
    const fetchFn = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
    await deleteAppointmentEvent(fetchFn, "token", "test-calendar", eventId);
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toContain("/calendars/test-calendar/events/");
    expect(requests[0]?.url).toContain("sendUpdates=none");
  });

  it("classifies a stored event that matches the approved shape as matching", async () => {
    const fetchFn = cannedFetch(() => Response.json(approvedEvent()));
    const reading = await readStoredCalendarEvent(fetchFn, "token", "primary", EVENT_ID);
    expect(reading.kind).toBe("matching");
    expect(reading.event?.summary).toBe("Appointment with Ada Lovelace");
    expect(reading.event?.id).toBe(EVENT_ID);
  });

  it("classifies a tentative event with the approved shape as matching", async () => {
    const fetchFn = cannedFetch(() => Response.json(approvedEvent({ status: "tentative" })));
    const reading = await readStoredCalendarEvent(fetchFn, "token", "primary", EVENT_ID);
    expect(reading.kind).toBe("matching");
    expect(reading.event?.status).toBe("tentative");
  });

  it("classifies a shape miss as mismatched and does not throw a transport failure", async () => {
    const stored = approvedEvent({
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      attendees: [{ email: "ada@example.com" }],
      reminders: {
        useDefault: false,
        overrides: [{ method: "email", minutes: 10 }],
      },
    });
    const fetchFn = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/events") && method === "POST") {
        return Response.json({ id: EVENT_ID, summary: "insert-response-not-proof" });
      }
      if (method === "GET") {
        return Response.json(stored);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const read = await readStoredCalendarEvent(fetchFn, "token", "primary", EVENT_ID);
    expect(read.kind).toBe("mismatched");
    expect(read.event?.hangoutLink).toBe("https://meet.google.com/abc-defg-hij");

    const committed = await commitStoredCalendarEvent(fetchFn, "token", COMMIT_OPTIONS);
    expect(committed.kind).toBe("mismatched");
    expect(committed.event?.summary).toBe("Appointment with Ada Lovelace");
    expect(committed.event?.summary).not.toBe("insert-response-not-proof");
  });

  it("classifies a cancelled stored event as cancelled even when the other fields match", async () => {
    const matching = cannedFetch(() => Response.json(approvedEvent({ status: "cancelled" })));
    const matchingRead = await readStoredCalendarEvent(matching, "token", "primary", EVENT_ID);
    expect(matchingRead.kind).toBe("cancelled");
    expect(matchingRead.event?.status).toBe("cancelled");
    expect(matchingRead.event?.summary).toBe("Appointment with Ada Lovelace");

    const missed = cannedFetch(() =>
      Response.json(
        approvedEvent({
          status: "cancelled",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          attendees: [{ email: "ada@example.com" }],
        }),
      ),
    );
    const missedRead = await readStoredCalendarEvent(missed, "token", "primary", EVENT_ID);
    expect(missedRead.kind).toBe("cancelled");
    expect(missedRead.kind).not.toBe("mismatched");
  });

  it("classifies a proven-absent event as missing", async () => {
    for (const status of [404, 410]) {
      const fetchFn = cannedFetch(() => new Response("{}", { status }));
      const reading = await readStoredCalendarEvent(fetchFn, "token", "primary", EVENT_ID);
      expect(reading.kind).toBe("missing");
      expect(reading.event).toBeUndefined();
    }
  });

  it("classifies an unusable read as unreachable and does not throw", async () => {
    const cases: Array<{ name: string; fetchFn: typeof fetch }> = [
      {
        name: "network failure",
        fetchFn: cannedFetch(() => {
          throw new Error("socket reset");
        }),
      },
      {
        name: "rejected credentials",
        fetchFn: cannedFetch(() => new Response("{}", { status: 401 })),
      },
      {
        name: "other unsuccessful response",
        fetchFn: cannedFetch(() => new Response("{}", { status: 503 })),
      },
      {
        name: "body is not a usable event",
        fetchFn: cannedFetch(
          () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
        ),
      },
      {
        name: "empty id",
        fetchFn: cannedFetch(() => Response.json({ id: "", summary: "Appointment with Ada Lovelace" })),
      },
    ];
    for (const entry of cases) {
      const reading = await readStoredCalendarEvent(entry.fetchFn, "token", "primary", EVENT_ID);
      expect(reading.kind, entry.name).toBe("unreachable");
      expect(reading.event, entry.name).toBeUndefined();
    }
  });

  it("classifies the stored event when the insert times out or conflicts", async () => {
    const timedOut = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        throw new Error("timeout after accept");
      }
      if (method === "GET") {
        return Response.json(approvedEvent());
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
    const afterTimeout = await commitStoredCalendarEvent(timedOut, "token", COMMIT_OPTIONS);
    expect(afterTimeout.kind).toBe("matching");
    expect(afterTimeout.event?.summary).toBe("Appointment with Ada Lovelace");

    const conflicted = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return Response.json(
          { id: EVENT_ID, summary: "insert-response-not-proof", status: "confirmed" },
          { status: 409 },
        );
      }
      if (method === "GET") {
        return Response.json(approvedEvent({ status: "cancelled" }));
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
    const afterConflict = await commitStoredCalendarEvent(conflicted, "token", COMMIT_OPTIONS);
    expect(afterConflict.kind).toBe("cancelled");
    expect(afterConflict.event?.status).toBe("cancelled");
    expect(afterConflict.event?.summary).not.toBe("insert-response-not-proof");
  });

  it("throws when a read or commit is missing an event id", async () => {
    const fetchFn = cannedFetch(() => {
      throw new Error("should not be called");
    });
    const readError = await readStoredCalendarEvent(fetchFn, "token", "primary", "").catch(
      (value: unknown) => value,
    );
    expect(readError).toBeInstanceOf(Error);
    expect(readError).not.toBeInstanceOf(CalendarQueryError);
    expect((readError as Error).message).toMatch(/event id/);

    const commitError = await commitStoredCalendarEvent(fetchFn, "token", {
      ...COMMIT_OPTIONS,
      eventId: "",
    }).catch((value: unknown) => value);
    expect(commitError).toBeInstanceOf(Error);
    expect(commitError).not.toBeInstanceOf(CalendarQueryError);
    expect((commitError as Error).message).toMatch(/event id/);
  });
});
