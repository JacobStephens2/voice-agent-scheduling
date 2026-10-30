# Google Calendar setup for availability and booking

Authorized Google Calendar access is required for both availability and
booking. The telephone flow exposes `check_availability`,
`propose_appointment`, and `confirm_appointment`. Events are created only
after explicit booking confirmation. No audio or transcripts are retained.

## What Jacob does (bounded human steps)

1. **Create a Web-app OAuth client** in the Google Cloud console for
   `jacob@stephens.page`, with this authorized redirect URI:
   `https://scheduler.stephens.page/calendar/auth/callback`.
   Request only these scopes when consenting:
   - `https://www.googleapis.com/auth/calendar.freebusy` (read availability)
   - `https://www.googleapis.com/auth/calendar.events.owned` (create the
     confirmed appointment on a calendar Jacob owns)
2. **Authorize in the browser**: put `GOOGLE_CALENDAR_CLIENT_ID`,
   `GOOGLE_CALENDAR_CLIENT_SECRET`, and `OPERATOR_TOKEN` in
   `/etc/scheduling-agent/scheduling-agent.env`, restart the service, then
   open as Jacob:
   `https://scheduler.stephens.page/calendar/auth/start?token=OPERATOR_TOKEN`
   (use the real token value once; the page immediately trades it for a
   short-lived session cookie and drops it from the address bar). Click
   through to Google, approve offline access so the server can refresh, and
   you will land on a confirmation page. The exchange happens server-side;
   codes and tokens never render, and the refresh token is stored with
   owner-only permissions in `/var/lib/scheduling-agent`.
3. **Authorize without the browser instead** (fallback; needs a Desktop-app
   client with a localhost redirect):
   ```bash
   GOOGLE_CALENDAR_CLIENT_ID=... npm run calendars:auth-url
   GOOGLE_CALENDAR_CLIENT_ID=... GOOGLE_CALENDAR_CLIENT_SECRET=... \
     SCHEDULING_DATA_DIR=/var/lib/scheduling-agent \
     npm run calendars:auth -- --code <code>
   ```
4. **Validate candidate calendar IDs** and ask Jacob to choose. The
   minimal scopes authorize `freeBusy` but not browsing by name, so copy
   candidate IDs from Google Calendar Settings > Integrate calendar and check
   reachability (prints `ok` / `UNREACHABLE` per ID, no event content read):
   ```bash
   npm run calendars:list -- --calendars <id,...>
   ```
   With no `--calendars` flag it checks the `primary` alias. Run this from a
   repo checkout with `GOOGLE_CALENDAR_CLIENT_ID`,
   `GOOGLE_CALENDAR_CLIENT_SECRET`, and `GOOGLE_CALENDAR_REFRESH_TOKEN` in
   the environment; there is no checkout on the server (deploys ship `dist/`
   only).
5. **Persist his explicit selection** (primary destination plus every
   calendar that represents a real commitment):
   ```bash
   SCHEDULING_DATA_DIR=/var/lib/scheduling-agent \
     npm run calendars:select -- --primary <id> --conflicts <id,...>
   ```
   Nothing is inferred: until this step completes, callers hear that
   calendar data is unavailable rather than an empty schedule.
6. **Verify with a controlled inbound call**: dial the dedicated number from
   the allowlisted caller, ask for a weekday date, and confirm the agent
   offers permitted 30-minute starts in Eastern Time. To book, give a name,
   speak and confirm a callback number (it may differ from caller ID),
   listen to the full readback, and explicitly agree. Then check the
   selected destination calendar for one 30-minute busy event titled
   `Appointment with <name>`, with the callback number and optional purpose
   in the description, no attendees, no Google Meet link, and only a 10-minute
   popup reminder. Confirm the authorized account received no invitation,
   update email, or email reminder. Evidence must hold no
   audio/transcript/recording fields:
   ```bash
   SCHEDULER_URL=https://scheduler.stephens.page \
   EVIDENCE_TOKEN=... \
   npm run smoke:pstn
   ```
   Until the [production campaign](production-acceptance.md) passes, keep
   `ALLOWED_CALLER_NUMBERS` set. Calendar writes stay off until
   `SCHEDULING_ALLOW_CALENDAR_WRITES=true` is set; use a test calendar as the
   selected primary destination until event-shape and inbox checks pass, then
   switch to Google's `primary` alias for the controlled production
   appointment. Opening the number to the public is a separate cutover
   (`SCHEDULING_PUBLIC_ADMISSION=true`); see [operations](operations.md).

7. **Prove stored notification fields on the authorized account** (GET, not
   insert parameters). This writes one throwaway event on a test calendar,
   inspects attendees / Meet / reminders as stored, then deletes it:
   ```bash
   npm run calendars:verify-booking -- --calendar <test-calendar-id>
   ```
   It refuses the `primary` alias unless you pass `--allow-primary`. After a
   real telephone booking, also confirm the account inbox received no
   invitation, update email, or email reminder.

On the host, credential and selection files live under
`/var/lib/scheduling-agent` (`google-client.json`, `google-refresh`,
`scheduling-calendars.json`, all mode `0600`, owned by
`scheduling-agent`). The same values may instead be supplied as
`GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`,
`GOOGLE_CALENDAR_REFRESH_TOKEN`, `SCHEDULING_PRIMARY_CALENDAR`,
`SCHEDULING_CONFLICT_CALENDARS`, and `SCHEDULING_ALLOW_CALENDAR_WRITES` in
`/etc/scheduling-agent/scheduling-agent.env`.

## Availability rules now enforced from real data

- Starts Monday–Friday on the hour or half-hour; each 30-minute appointment
  fits inside 10:00–17:00 America/New_York (latest start 16:30).
- At least 72 elapsed hours of notice and at most 14 days ahead, weekends
  included in the elapsed notice. A Monday 14:00 call first offers Thursday
  14:00.
- Busy intervals from every selected calendar block slots, including all-day
  busy events. Events marked free never block (free/busy omits them).
- The agent offers at most four options per date, names the timezone, and
  converts to a requested timezone on demand. Ambiguous dates are clarified,
  never guessed. Existing event names and details are never exposed.
- No slot produces an honest no-availability answer. A required-calendar read
  error or revoked authorization produces an unavailable answer, never an
  empty-calendar assumption.

## Notes and limits

- An OAuth app left in **Testing** gets refresh tokens that expire after
  seven days. Complete the applicable consent-screen publishing configuration
  for persistent operation.
- If authorization is revoked or Google cannot be reached, callers hear an
  unavailable response. Re-authorize from step 2; no code change is needed.
- Refresh credentials stay outside source control (`.gitignore` covers
  `.env*` and `.scratch/`), model context, and logs. Error messages carry
  bounded categories only, never secrets or caller contact data.
- Booking confirmation is tied to the current proposal on that call.
  `confirm_appointment` creates the appointment only when the caller has
  explicitly agreed (`confirmed: true`), the `proposalId` is the current one,
  and a completed assistant response has already read that proposal back.
  Otherwise it returns `readback_incomplete` and creates no appointment.
  The readback counts as finished only when `response.done` reports status
  `completed` and one copy of that response's assistant speech contains every
  returned readback field as its own value: caller name, callback number,
  date, start time, end time, timezone, and purpose when the proposal
  includes one. A field inside a longer word or number does not count.
  The transcript is taken from that response's `response.output_audio_transcript`
  events and from the completed response payload. Those are two sources of
  that response. They are compared in memory and not written to the
  appointment ledger, operational evidence, or logs. Distinct fragments of
  one source are joined. A later fragment is appended unless it already
  contains the text held for that source, in which case the fragment is
  kept. A repeated fragment can extend a field that already ends where it
  is appended. A field that appears only across that join does not count
  unless the repeated fragment is one code point that finishes the field,
  and a field opened only at the repeated fragment's leading edge does not
  count. A source that already contains the other is not appended. When the
  two sources are near-copies and neither contains the
  other, each source is compared on its own and they are not concatenated.
  The readback is finished only when one of those sources contains every
  returned field as its own value. A field in one source does not supply a
  field missing from the other, and a field cannot be formed by gluing the
  end of one source to the start of the other.
  Input transcription stays off. A response that is not a completed readback
  of the current proposal does not create an appointment. Replacing the
  proposal clears the finished readback and requires a new completed readback
  of the replacement. Unclear assent, an interrupted readback, a stale
  proposal, or a refusal creates no event. Disconnecting before explicit
  agreement creates no event. Repeating the same completed confirmation
  returns that operation's outcome and does not insert a second event.
- The synthetic availability module from the previous slice is retired from
  the call path but kept under test as regression history.
