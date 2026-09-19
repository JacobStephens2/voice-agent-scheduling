# Production acceptance campaign

Issue #9: enable and verify scheduling on Jacob's primary calendar. Public
callers stay off until this campaign passes. Do not close or edit parent
issue #1 from this work.

## Seams

- Synthetic/contract: the Vitest suite at the scheduling application's public
  call-and-appointment seam (normalized webhooks, tools, confirmation, disconnects,
  timeouts, Calendar test adapters).
- Live telephone: inbound PSTN on Direct SIP, observed through caller-facing
  outcomes, Calendar GET of the stored event, the authorized account inbox, and
  `/evidence`.
- Production gate: `resolveCallerAdmissionMode` — public admission requires
  `SCHEDULING_PUBLIC_ADMISSION=true`, calendar writes, an explicit selection,
  and no allowlist.

## Synthetic / contract suite

```bash
npm test
npm run typecheck
```

Parent-spec coverage already in the suite:

| Scenario | Tests |
| --- | --- |
| Ordinary 30-minute busy event, callback details, no attendees/Meet/email reminder, 10-minute popup | `test/calendar-client.test.ts`, `test/booking-tool.test.ts`, `test/real-booking-call.test.ts` |
| Booking window, 16:30 last start, weekdays, DST, Monday 14:00 → Thursday 14:00 | `test/calendar-availability.test.ts`, `test/calendar-tool.test.ts` |
| Cross-calendar busy, all-day, free events, no event contents returned | `test/calendar-tool.test.ts`, `test/calendar-client.test.ts` |
| Corrections, missing confirmation, interrupted readback | `test/booking-tool.test.ts`, `test/real-booking-call.test.ts` |
| Disconnect after confirmation, repeated delivery, restart around a write | `test/real-booking-call.test.ts`, `test/booking-reconciliation.test.ts` |
| One upcoming appointment per callback number; cancellation reconciled | `test/booking-limit.test.ts` |
| Cutoff, one caller, budget pause; confirmed appointment survives cutoff | `test/call-bounds.test.ts` |
| Operator pause does not discard a confirmed appointment | `test/admission-pause.test.ts` |
| Records exclude audio/transcripts; cleanup does not delete Calendar events | `test/maintenance.test.ts` |

Record the run with Vitest JSON and fold it into a bounded report:

```bash
npx vitest run --reporter=json --outputFile=.scratch/vitest.json
SCHEDULER_URL=https://scheduler.stephens.page EVIDENCE_TOKEN=... \
  npm run acceptance:report -- --synthetic .scratch/vitest.json
```

## Live PSTN campaign (allowlisted)

Keep `ALLOWED_CALLER_NUMBERS` set. Use a test calendar as
`SCHEDULING_PRIMARY_CALENDAR` until the event-shape and inbox checks pass;
Google's `primary` alias is the production destination only after that.

For each scenario, place the call, hang up, and keep `/evidence` (masked
caller, model, reasoning, duration, estimated micro-USD). Never store
recordings or transcripts.

| id | What to verify live |
| --- | --- |
| ordinary-appointment | One `Appointment with <name>` event, 30 minutes, busy, callback in the description, agent says Jacob will call |
| corrections | Date, callback number, and timezone corrections appear in the readback and the event |
| interruptions | Talk-over or unclear "yes" during readback creates no event |
| no-confirmation | Hang up before agreeing; no event |
| changed-availability | After a conflicting event is added, the agent offers other times instead of claiming success |
| callback-limit | A second appointment for the same spoken callback number is refused; changes go through Jacob |
| dropped-call | Confirm, then hang up immediately; the event still lands |
| ambiguous-write / provider-failure | Calendar outage or uncertain insert is spoken as inconclusive, not booked |
| call-budget-limits | Second simultaneous caller hears unavailable; a long call is warned and cut off |
| lifetime-pause | Pause admissions during an in-flight confirmation; the appointment still completes |
| restart-write | Restart `scheduling-agent` around a confirmation; one matching event remains |
| notifications | GET the stored event: no attendees, no Meet, no email reminder, popup 10 only (`npm run calendars:verify-booking -- --calendar <test-id>`) |
| inbox-notifications | Check the authorized account inbox: no invitation, update, or reminder email. API configuration alone is not enough |
| jacob-will-call | Caller hears that Jacob will call the confirmed callback number |

Direct SIP must report `grok-voice-think-fast-2.0` and high reasoning. If a live
call reports a different model, stop; the accepted alternative is a new LiveKit
Cloud worker, not a silent rule change.

## Production cutover

Only after the test-calendar campaign passes:

1. Set `SCHEDULING_PRIMARY_CALENDAR` to the authorized primary calendar and
   keep Jacob's conflict calendars in `SCHEDULING_CONFLICT_CALENDARS`.
2. Keep `SCHEDULING_ALLOW_CALENDAR_WRITES=true`.
3. Complete one intended, controlled appointment on the primary calendar from
   the allowlisted number.
4. Then, and only then, clear the allowlist and set
   `SCHEDULING_PUBLIC_ADMISSION=true` as described in
   [operations.md](operations.md).

## Residual limitations to report

- External Calendar writers can still race with an insert. The service
  serializes its own appointment writes; it does not claim a transactional calendar.
- Provider-side retention (xAI logs, Telnyx CDRs) is independent of
  application storage.
- Monthly budget enforcement is an application estimate against a $25 target,
  not a hard cap on every carrier fee.
