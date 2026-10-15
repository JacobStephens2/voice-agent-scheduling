# Voice agent scheduling

**Try it:** call the number on [scheduler.stephens.page](https://scheduler.stephens.page).

A telephone scheduling agent that describes Jacob's availability and creates 30-minute phone appointments on his Google Calendar. Jacob calls the confirmed callback number at appointment time.

Callers dial a dedicated Telnyx number. The agent identifies itself as Jacob's scheduling assistant, offers real Google Calendar availability, reads the appointment details back, and creates one calendar event only after the caller explicitly confirms. No audio or transcripts are retained.

## How a scheduling call works

1. A dedicated Telnyx number forwards the call over SIP to `sip.voice.x.ai`.
2. xAI posts a signed `realtime.call.incoming` webhook to `/xai/sip-webhook`. The service checks the signature, the caller allowlist, the concurrent-call limit, and the monthly budget before admitting the call.
3. The service joins the call's realtime WebSocket, verifies the provider reports `grok-voice-think-fast-2.0` with high reasoning effort, and anchors the session to today's Eastern date.
4. The model uses three tools: `check_availability`, `propose_appointment`, and `confirm_appointment`. A confirmation is rejected unless the full readback finished and the caller agreed.
5. The confirmed appointment is inserted into the selected Google Calendar. Durable booking records let a restarted process reconcile uncertain operations without ever creating a duplicate event.

## Booking rules

| Rule | Value |
| --- | --- |
| Appointment length | 30 minutes |
| Timezone | Eastern Time (`America/New_York`) |
| Permitted starts | Weekdays, 10:00 through 16:30 |
| Booking window | At least 72 hours ahead, at most 14 days ahead |
| Per callback number | One upcoming appointment |
| Conflicts | Any opaque busy block on the selected conflict calendars |

Availability never describes Jacob's existing events; callers only hear the open times. See the [domain glossary](CONTEXT.md) for the exact meaning of caller, callback number, booking window, and booking confirmation.

## Call and cost bounds

- One active scheduling call at a time (`MAX_CONCURRENT_CALLS`).
- Each call ends after 10 minutes, with a spoken warning one minute before the cutoff.
- A $25/month target for additional provider charges. Each admitted call reserves a full-length estimate plus a 25% margin, and admissions pause when the remaining budget cannot cover a new call or when rates cannot be estimated safely.
- Public admission stays allowlisted (`ALLOWED_CALLER_NUMBERS`) until `SCHEDULING_PUBLIC_ADMISSION=true` is set after the production campaign. Public start also requires calendar writes and an explicit calendar selection. `POST /maintenance/pause` stops new callers without discarding an appointment the caller already confirmed.

## HTTP endpoints

The service listens on `127.0.0.1:3531` behind the `https://scheduler.stephens.page` reverse proxy.

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Public landing page; shows `SCHEDULING_PUBLIC_PHONE_NUMBER` only while public admission is on and admissions are not paused |
| `POST /xai/sip-webhook` | Signed incoming-call webhook from xAI |
| `GET /health` | Status, active call count, admission pause, public/writes/selection flags |
| `GET /evidence` | Structured per-call evidence with masked caller numbers (`EVIDENCE_TOKEN` bearer) |
| `POST /maintenance/pause` | Stop new admissions (`EVIDENCE_TOKEN` bearer) |
| `POST /maintenance/resume` | Resume admissions after an operator pause (`EVIDENCE_TOKEN` bearer) |
| `POST /maintenance/cleanup` | Purge operational records older than 30 days without deleting Calendar events (`EVIDENCE_TOKEN` bearer) |
| `/calendar/auth/*` | Operator consent pages for Google Calendar authorization (`OPERATOR_TOKEN`) |

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm test
npm run typecheck
npm run build
SCHEDULER_URL=https://scheduler.stephens.page EVIDENCE_TOKEN=... npm run smoke:pstn
SCHEDULER_URL=https://scheduler.stephens.page EVIDENCE_TOKEN=... npm run acceptance:report
```

Configuration is environment-driven; [`.env.example`](.env.example) lists every variable. Calendar authorization and selection use the `calendars:*` scripts described in the [calendar setup guide](docs/deployment/calendar-setup.md).

| Path | Contents |
| --- | --- |
| `src/server.ts` | HTTP routes and service wiring |
| `src/lifecycle.ts`, `src/admission.ts` | Webhook verification, inbound-call admission, call lifecycle |
| `src/admission-policy.ts` | Public vs allowlist startup gate and production readiness |
| `src/session.ts` | Realtime voice session, instructions, and tool dispatch |
| `src/budget.ts` | Call duration limits and the monthly usage ledger |
| `src/calendar/` | Google OAuth, free/busy availability, booking policy, proposals, durable booking store, callback-number limit |
| `src/landing-page.ts` | Public landing page at `/` |
| `src/evidence.ts` | Structured call evidence |
| `src/acceptance.ts` | Bounded production-acceptance report |
| `src/maintenance.ts` | 30-day operational retention, booking compact, restore, and recovery gate |
| `ops/` | systemd unit, Apache virtual host, server setup, release deploy, and state backup/restore |
| `test/` | Vitest suites covering admission, availability, booking, reconciliation, call bounds, and maintenance |

## Deployment

Merging into `master` runs [the deploy workflow](.github/workflows/deploy.yml): it typechecks, tests, builds, ships a timestamped release to `/opt/scheduling-agent/releases/`, restarts `scheduling-agent.service`, and verifies `/health`. `ops/deploy-release.sh` runs the same release by hand.

The scheduler is deliberately isolated from Jacob's existing voice agent, with its own number, system user, credentials (`/etc/scheduling-agent/scheduling-agent.env`), and durable state (`/var/lib/scheduling-agent`).

## Documentation

- [Implementation specification and sub-issues](https://github.com/JacobStephens2/voice-agent-scheduling/issues/1)
- [Operating procedure](docs/deployment/operations.md)
- [Production acceptance campaign](docs/deployment/production-acceptance.md)
- [Telephone path setup](docs/deployment/telephone-path-setup.md)
- [Maintenance, restart, backup, and retention](docs/deployment/maintenance.md)
- [Google Calendar authorization and calendar selection](docs/deployment/calendar-setup.md)
- [Accepted design, connection options, and acceptance scenarios](docs/design/appointment-scheduling.md)
- [Provider research and existing voice-agent findings](docs/research/telephone-calendar-scheduling.md)
- [Domain glossary](CONTEXT.md)
- [Architecture decision: isolate the scheduling service](docs/adr/0001-isolate-the-scheduling-service.md)

## License

[MIT](LICENSE). The agent skills vendored under `.agents/skills/` come from [mattpocock/skills](https://github.com/mattpocock/skills) and keep their own [MIT license](.agents/skills/LICENSE).
