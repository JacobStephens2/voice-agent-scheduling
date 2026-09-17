import { describe, expect, it } from "vitest";
import {
  CalendarQueryError,
  appointmentNotificationProof,
  createAppointmentEvent,
  deleteAppointmentEvent,
  getAppointmentEvent,
  queryBusyIntervals,
  validateCalendars,
} from "../src/calendar/client.js";

function cannedFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

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

  it("creates a 30-minute busy appointment and returns the stored event from GET, not the insert body", async () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const requests: Array<{ method?: string; url: string; body?: { [key: string]: unknown } }> =
      [];
    const stored = {
      id: eventId,
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
    };
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
        return Response.json({ id: eventId, summary: "insert-response-not-proof" });
      }
      if (url.includes(`/events/${eventId}`) && method === "GET") {
        return Response.json(stored);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const event = await createAppointmentEvent(fetchFn, "token", {
      calendarId: "primary",
      eventId,
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      purpose: "Website review",
      date: "2026-09-11",
      startTime: "10:00",
    });

    const insert = requests.find((entry) => entry.method === "POST");
    expect(insert?.url).toContain("/calendars/primary/events");
    expect(insert?.url).toContain("sendUpdates=none");
    expect(insert?.body).toMatchObject({
      id: eventId,
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

    expect(requests.some((entry) => entry.method === "GET" && entry.url.includes(eventId))).toBe(
      true,
    );
    expect(event.summary).toBe("Appointment with Ada Lovelace");
    expect(event.summary).not.toBe("insert-response-not-proof");
    expect(event.hangoutLink).toBeUndefined();
    expect(event.attendees).toEqual([]);
    expect(event.conferenceData).toBeUndefined();
    expect(event.reminders?.overrides).toEqual([{ method: "popup", minutes: 10 }]);
    expect(event.reminders?.useDefault).toBe(false);
    expect(appointmentNotificationProof(event)).toMatchObject({
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

  it("does not treat a stored event with a Meet link or email reminder as a successful appointment", async () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const fetchFn = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/events") && method === "POST") {
        return Response.json({ id: eventId });
      }
      if (url.includes(`/events/${eventId}`) && method === "GET") {
        return Response.json({
          id: eventId,
          summary: "Appointment with Ada Lovelace",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          attendees: [{ email: "ada@example.com" }],
          reminders: {
            useDefault: false,
            overrides: [{ method: "email", minutes: 10 }],
          },
        });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const error = await createAppointmentEvent(fetchFn, "token", {
      calendarId: "primary",
      eventId,
      callerName: "Ada Lovelace",
      callbackNumber: "+15551239876",
      date: "2026-09-11",
      startTime: "10:00",
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CalendarQueryError);
  });

  it("reports a missing event as not_found so reconciliation can distinguish absence from an outage", async () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const fetchFn = cannedFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes(`/events/${eventId}`) && method === "GET") {
        return new Response("{}", { status: 404 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const error = await getAppointmentEvent(fetchFn, "token", "primary", eventId).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(CalendarQueryError);
    expect((error as CalendarQueryError).kind).toBe("not_found");
  });
});
