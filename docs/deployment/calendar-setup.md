# Google Calendar setup for availability (issue #3)

This slice replaces synthetic availability with real, authorized Google
Calendar availability. The telephone flow exposes one read-only tool,
`check_availability`; no calendar event is created by this slice, and no
audio or transcripts are retained.

## What Jacob does (bounded human steps)

1. **Create a Web-app OAuth client** in the Google Cloud console for
   `jacob@stephens.page`, with this authorized redirect URI:
   `https://scheduler.stephens.page/calendar/auth/callback`.
   Request only these scopes when consenting:
   - `https://www.googleapis.com/auth/calendar.freebusy` (read availability)
   - `https://www.googleapis.com/auth/calendar.events.owned` (reserved for
     the later booking slice; this slice only reads)
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
4. **List calendar metadata** and ask Jacob to choose:
   ```bash
   SCHEDULING_DATA_DIR=/var/lib/scheduling-agent npm run calendars:list
   ```
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
   offers permitted 30-minute starts in Eastern Time. Then hang up and check
   that no calendar event was created and the evidence holds no
   audio/transcript/recording fields:
   ```bash
   SCHEDULER_URL=https://scheduler.stephens.page \
   EVIDENCE_TOKEN=... \
   npm run smoke:pstn
   ```

On the host, credential and selection files live under
`/var/lib/scheduling-agent` (`google-client.json`, `google-refresh`,
`scheduling-calendars.json`, all mode `0600`, owned by
`scheduling-agent`). The same values may instead be supplied as
`GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`,
`GOOGLE_CALENDAR_REFRESH_TOKEN`, `SCHEDULING_PRIMARY_CALENDAR`, and
`SCHEDULING_CONFLICT_CALENDARS` in `/etc/scheduling-agent/scheduling-agent.env`.

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
- The synthetic availability module from the previous slice is retired from
  the call path but kept under test as regression history.
