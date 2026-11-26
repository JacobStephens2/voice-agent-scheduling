import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenProvider, loadCredentials } from "../src/calendar/auth.js";
import {
  appointmentNotificationProof,
  commitStoredCalendarEvent,
  deleteAppointmentEvent,
} from "../src/calendar/client.js";
import { firstVerificationStart } from "../src/calendar/policy.js";

const live = process.env.SCHEDULING_LIVE_BOOKING_TEST === "1";
const calendarId = process.env.SCHEDULING_LIVE_BOOKING_CALENDAR?.trim();
const credentials = loadCredentials({
  env: process.env,
  dataDir: process.env.SCHEDULING_DATA_DIR,
});

describe.skipIf(!live || !calendarId || !credentials)(
  "authorized test calendar notifications",
  () => {
    it("GETs a stored event with no attendees, Meet link, or email reminder, then deletes it", async () => {
      if (calendarId === "primary" && process.env.SCHEDULING_ALLOW_PRIMARY_WRITES !== "true") {
        throw new Error(
          "Refusing to write the Google primary calendar. Set SCHEDULING_LIVE_BOOKING_CALENDAR to a test calendar.",
        );
      }
      const slot = firstVerificationStart(new Date());
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
        if (reading.kind !== "matching") {
          return;
        }
        expect(appointmentNotificationProof(reading.event)).toMatchObject({
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
