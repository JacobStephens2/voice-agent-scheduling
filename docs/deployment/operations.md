# Operating the scheduling service

Day-to-day procedure for the isolated scheduler on `scheduler.stephens.page`.
Do not change Jacob's administrative voice agent, its number, or its runtime.
Restart, backup, restore, and retention cleanup are in
[maintenance.md](maintenance.md). Production enablement checks are in
[production-acceptance.md](production-acceptance.md).

Application storage never includes live speech, transcripts, recordings, names,
or raw callback numbers.

## Health and outcomes

```bash
curl -fsS https://scheduler.stephens.page/health
```

`GET /health` reports `admissionsPaused`, `pauseReason` when paused,
`publicAdmission`, `calendarWrites`, and `calendarSelected`. It does not
disclose calendar IDs or caller details.

```bash
curl -fsS -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/evidence
```

Operational records are identifiers, outcomes, timing, usage, and bounded error
categories. They expire after 30 days.

A bounded campaign snapshot (no audio/transcripts) is:

```bash
SCHEDULER_URL=https://scheduler.stephens.page EVIDENCE_TOKEN=... \
  npm run acceptance:report
```

## Pause and resume admissions

Pause new callers without discarding an appointment the current caller already
confirmed:

```bash
curl -fsS -X POST -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/maintenance/pause
curl -fsS -X POST -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/maintenance/resume
```

`SCHEDULING_PAUSE_ADMISSIONS=true` in
`/etc/scheduling-agent/scheduling-agent.env` pauses on process start. Unset it
before a resume should survive the next restart. Budget exhaustion
(`budget_exhausted` / `budget_unavailable`) and incomplete restore
(`recovery_pending` / `restored_state_incomplete`) also pause admissions.

## Credential renewal

| Secret | Where it lives | Renewal |
| --- | --- | --- |
| xAI API key and webhook secret | `/etc/scheduling-agent/scheduling-agent.env` | Replace the values, `sudo systemctl restart scheduling-agent` |
| Telnyx SIP / number | Telnyx portal; not in this repo | Keep the FQDN connection on `sip.voice.x.ai` and the webhook on `/xai/sip-webhook` |
| Google OAuth client | env file and `/var/lib/scheduling-agent/google-client.json` | Recreate the Web-app client only if the client ID changes; keep the redirect `https://scheduler.stephens.page/calendar/auth/callback` |
| Google refresh token | `/var/lib/scheduling-agent/google-refresh` | Re-run the operator consent pages in [calendar-setup.md](calendar-setup.md). Testing-mode tokens expire after seven days |
| `EVIDENCE_TOKEN` / `OPERATOR_TOKEN` | env file | Replace, restart. Old bearer tokens stop working immediately |

After any credential change, confirm `/health` is healthy and that a
an allowlisted smoke call still verifies `grok-voice-think-fast-2.0` with high
reasoning.

## Cost checks

`GET /health` `admissionsPaused` plus `/evidence` `estimatedCostMicroUsd` are
the application view of the $25/month target. The durable ledger is
`/var/lib/scheduling-agent/budget-ledger.json` (period UTC calendar month).
Application estimates are not the carrier bill: check Telnyx and xAI invoices
if spend looks wrong. If Direct SIP cannot fit the target, stop and present
measured alternatives; do not silently switch to LiveKit or change the
appointment rules.

## Cancellations and rescheduling

Callers cannot cancel or reschedule through the agent. Jacob deletes or moves
the Calendar event himself. The next availability or appointment attempt for that
callback number reconciles the cancelled event so it does not block the person
forever. Do not delete rows from `bookings.jsonl` to "fix" a cancellation.

## Public admission

Public appointment creation stays off until the campaign in
[production-acceptance.md](production-acceptance.md) passes. Default start
requires `ALLOWED_CALLER_NUMBERS`. Opening the number is an explicit cutover:

1. Test-calendar campaign passes, including actual inbox notification checks.
2. Destination is the authorized primary calendar and conflict calendars Jacob
   selected.
3. `SCHEDULING_ALLOW_CALENDAR_WRITES=true`.
4. Complete one intended, controlled appointment on the primary calendar from
   the allowlisted number and confirm the caller hears that Jacob will call.
5. Then clear `ALLOWED_CALLER_NUMBERS` and set `SCHEDULING_PUBLIC_ADMISSION=true`.
6. Restart and confirm `/health` shows `publicAdmission: true`.

To close the number again, unset `SCHEDULING_PUBLIC_ADMISSION`, restore the
allowlist, and restart.
