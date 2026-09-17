# Telephone path setup

This records the isolated scheduling telephone path for GitHub issue #2.

## Isolation

Per [ADR 0001](../adr/0001-isolate-the-scheduling-service.md), the scheduler is a separate service from the existing voice agent:

- System user: `scheduling-agent`
- Loopback port: `3531`
- HTTPS edge: `https://scheduler.stephens.page`
- Credentials: `/etc/scheduling-agent/scheduling-agent.env`
- Durable state: `/var/lib/scheduling-agent`
- Unit: `scheduling-agent.service`

The existing voice agent's number and runtime are unchanged.

## Connection route

Direct SIP is the evaluated production route for this slice:

1. Dedicated Telnyx number
2. Telnyx FQDN SIP connection to `sip.voice.x.ai`
3. xAI `realtime.call.incoming` webhook to `https://scheduler.stephens.page/xai/sip-webhook`
4. Application joins `wss://api.x.ai/v1/realtime?call_id=...&reasoning.effort=high`

The SIP control WebSocket **ignores** the usual `model` query parameter when `call_id` is present. This service does not send `model=` on that URL. Model identity is taken from the provider's `session.created` / `session.updated` payload. `grok-voice-latest` is accepted only as the documented alias of `grok-voice-think-fast-2.0`. High reasoning is requested with the supported `reasoning.effort=high` query parameter and confirmed on `session.updated`.

If a live call reports a different model, Direct SIP is unsuitable and the accepted fallback is a new LiveKit Cloud worker. There is no automatic mid-call failover.

## Public admission

Public callers remain disabled until later tickets complete. `ALLOWED_CALLER_NUMBERS` must contain the authorized smoke-call number. Calendar event writes stay off unless `SCHEDULING_ALLOW_CALENDAR_WRITES=true`; keep the selected destination on a test calendar until the final release (see [calendar setup](calendar-setup.md)).

## Call bounds and monthly usage (issue #7)

One active caller, 10 minutes per scheduling call, and a $25/month
additional-provider-cost target (the already-paid server is excluded).

### Validated rates

List prices checked 2026-09-07; account rates, geography, taxes, and
billing granularity can change the actual bill:

| Component | Rate | Source |
| --- | --- | --- |
| xAI Grok voice audio | $0.08/minute | [xAI pricing](https://docs.x.ai/developers/pricing) |
| Telnyx local inbound SIP | from $0.0032/minute | [Telnyx SIP pricing](https://telnyx.com/pricing/elastic-sip) |
| Dedicated Telnyx number | from $1/month fixed | [Telnyx SIP pricing](https://telnyx.com/pricing/elastic-sip) |

The application estimates each call at the combined $0.0832/minute rate.
The $25 amount is an operating target, not a guarantee that no carrier
fee can arise after an application cutoff. When rates are unconfigured or
invalid, the service pauses admissions with a bounded `budget_unavailable`
response instead of guessing.

### Admission accounting

- Each admitted call reserves one full 10-minute estimate plus a 25%
  margin for delayed billing (`SCHEDULING_RESERVE_MARGIN`).
- Fixed monthly charges (default $1 number rental via
  `SCHEDULING_FIXED_MONTHLY_MICRO_USD`) count against the $25 target
  (`SCHEDULING_MONTHLY_TARGET_MICRO_USD`) before any call is admitted.
- New admissions pause with a bounded `budget_exhausted` response (and the
  PSTN leg hung up for retry) before the estimated allowance is exhausted.
- On call end the reservation settles to observed conversation usage.
- Accounting persists in `<dataDir>/budget-ledger.json` alongside the
  one-caller claim (`active-call.json`); a restart cannot reset spend or
  reservations. A reservation left by a crashed process counts as spent,
  and its stale caller slot is freed, so the service neither admits two
  callers nor stays permanently occupied.

### Billing period and reset

The billing period is the UTC calendar month (`YYYY-MM`). Spend and
reservations reset on the 1st at 00:00 UTC; fixed charges re-apply to the
new period.

### Duration warning and cutoff

The agent warns briefly about a minute before the limit
(`CALL_DURATION_WARNING_MS`, default 60000), stops accepting new
`confirm_appointment` calls at the cutoff (`duration_cutoff`, never
reported as booked), and ends the media session with the same call-ended
path as hangup (`duration_limit_reached`). An already-confirmed Calendar
write finishes independently of the cutoff.

### Bounded real telephone check

With public admission still allowlisted, place an authorized call and
verify: a second simultaneous caller hears the unavailable response and
can retry; a long call hears the warning and ends at 10 minutes; `/evidence`
shows structured usage (duration, estimated micro-USD, warning flag) with
no audio, transcripts, or raw caller contact data. `GET /health` also
reports `admissionsPaused` for budget monitoring.

## Privacy and retention

Application storage keeps structured smoke evidence only: call id, masked caller number, called number, status, duration, verified model/reasoning, tool round-trip count, and estimated micro-USD. It does not persist live audio, transcripts, recordings, or raw caller contact data.

Provider-side retention is separate:

- xAI: realtime audio is session-scoped; account retention settings in the xAI console govern provider logs.
- Telnyx: carrier CDRs are retained for billing. Call recording must stay disabled on the SIP connection and voice profile.

## Commands

```bash
# Isolated host setup (idempotent)
bash ops/setup-scheduling-service.sh

# Build, ship, and restart (also runs automatically on merge into master)
bash ops/deploy-release.sh

# Authorized inbound PSTN smoke call
SCHEDULER_URL=https://scheduler.stephens.page \
EVIDENCE_TOKEN=... \
SMOKE_TIMEOUT_MS=300000 \
npm run smoke:pstn
```

During an availability smoke run, dial the dedicated number from the allowlisted caller, confirm the agent identifies itself as Jacob's scheduling assistant, ask for next Friday availability, hang up, and keep the structured pass/fail output. For a booking smoke run, continue through name, confirmed callback number, readback, and explicit confirmation, then check the test calendar for one matching event.
