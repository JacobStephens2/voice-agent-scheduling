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

Public callers remain disabled until later tickets complete. `ALLOWED_CALLER_NUMBERS` must contain the authorized smoke-call number. Primary-calendar writes are not implemented in this slice; availability is real Google Calendar availability for Jacob's selected calendars (see [calendar setup](calendar-setup.md)).

## Privacy and retention

Application storage keeps structured smoke evidence only: call id, masked caller number, called number, status, duration, verified model/reasoning, tool round-trip count, and estimated micro-USD. It does not persist live audio, transcripts, recordings, or raw caller contact data.

Provider-side retention is separate:

- xAI: realtime audio is session-scoped; account retention settings in the xAI console govern provider logs.
- Telnyx: carrier CDRs are retained for billing. Call recording must stay disabled on the SIP connection and voice profile.

## Commands

```bash
# Isolated host setup (idempotent)
bash ops/setup-scheduling-service.sh

# Build, ship, and restart
bash ops/deploy-release.sh

# Authorized inbound PSTN smoke call
SCHEDULER_URL=https://scheduler.stephens.page \
EVIDENCE_TOKEN=... \
SMOKE_TIMEOUT_MS=300000 \
npm run smoke:pstn
```

During the smoke run, dial the dedicated number from the allowlisted caller, confirm the agent identifies itself as Jacob's scheduling assistant, ask for next Friday availability, hang up, and keep the structured pass/fail output.
