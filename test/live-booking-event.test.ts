import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenProvider, loadCredentials } from "../src/calendar/auth.js";
import {
  appointmentNotificationProof,
  commitStoredCalendarEvent,
  deleteAppointmentEvent,
} from "../src/calendar/client.js";
import { computeAvailableStarts, SCHEDULING_TIMEZONE } from "../src/calendar/policy.js";

const live = process.env.SCHEDULING_LIVE_BOOKING_TEST === "1";
const calendarId = process.env.SCHEDULING_LIVE_BOOKING_CALENDAR?.trim();
const credentials = loadCredentials({
  env: process.env,
  dataDir: process.env.SCHEDULING_DATA_DIR,
});

function easternDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function firstPermittedSlot(now: Date): { date: string; startTime: string } {
  for (let offset = 3; offset <= 14; offset += 1) {
    const date = easternDate(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000));
    const slot = computeAvailableStarts({ date, now, busy: [] })[0];
    if (slot) {
      return { date: slot.date, startTime: slot.startTime };
    }
  }
  throw new Error("No permitted weekday slot in the booking window.");
}

describe.skipIf(!live || !calendarId || !credentials)(
  "authorized test calendar notifications",
  () => {
    it("GETs a stored event with no attendees, Meet link, or email reminder, then deletes it", async () => {
      if (calendarId === "primary" && process.env.SCHEDULING_ALLOW_PRIMARY_WRITES !== "true") {
        throw new Error(
          "Refusing to write the Google primary calendar. Set SCHEDULING_LIVE_BOOKING_CALENDAR to a test calendar.",
        );
      }
      const slot = firstPermittedSlot(new Date());
      const eventId = randomBytes(16).toString("hex");
      const token = await createTokenProvider(credentials!, fetch).getAccessToken();
      try {
        const reading = await commitStoredCalendarEvent(fetch, token, {
          calendarId: calendarId!,
          eventId,
          callerName: "Live verification",
          callbackNumber: "+15555550100",
          purpose: "Notification proof",
          date: slot.date,
          startTime: slot.startTime,
        });
        expect(reading.kind).toBe("matching");
        const stored = reading.event;
        expect(stored).toBeDefined();
        if (!stored) {
          return;
        }
        expect(appointmentNotificationProof(stored)).toMatchObject({
          hasAttendees: false,
          hasHangoutLink: false,
          hasConferenceData: false,
          hasEmailReminder: false,
          popupReminderMinutes: [10],
          matchesApprovedShape: true,
        });
      } finally {
        await deleteAppointmentEvent(fetch, token, calendarId!, eventId);
      }
    });
  },
);
