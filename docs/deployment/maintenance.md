# Scheduling service maintenance

Operator procedures for the isolated scheduling service: inspecting bounded
outcomes, restarting through a release, restoring durable state, and running
retention cleanup. Application storage never includes live speech, transcripts,
recordings, names, or raw callback numbers.

This service does not use the administrative voice agent's privileged runtime.
Credentials live in `/etc/scheduling-agent`; durable state lives in
`/var/lib/scheduling-agent`; releases live under `/opt/scheduling-agent/releases`.

## What backup and restore protect

A backup of the isolated directories is a point-in-time copy of:

| Path | What it holds |
| --- | --- |
| `/var/lib/scheduling-agent` | Booking identities and salted callback hashes, the monthly usage ledger, callback salt, operational records, Calendar OAuth refresh material, and calendar selection |
| `/etc/scheduling-agent/scheduling-agent.env` | Provider credentials and admission configuration (`0600`, `root:scheduling-agent`) |

It does **not** hold:

- Google Calendar appointments. Those stay in Calendar. Cleanup and restore never delete them.
- In-flight SIP media, xAI session audio, or Telnyx CDRs.
- Provider-side logs. Disabling application recording does not change xAI or Telnyx retention.

Restoring an older copy cannot reconstruct bookings or spend that happened after the snapshot. If the restored files are incomplete (hashed bookings without `callback-salt`, or bookings/operational records without `budget-ledger.json`), admission stays unavailable (`restored_state_incomplete`) until the missing files are restored. If pending Calendar operations cannot be read back, admission stays unavailable (`recovery_pending`) until reconciliation finishes.

File permissions: data directory `0750` owned by `scheduling-agent`; booking, salt, ledger, operational, and OAuth files `0600`.

## Inspect operational outcomes

Structured records are identifiers, outcomes, timing, usage, and bounded error
categories only. They expire after 30 days.

```bash
curl -fsS -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/evidence
```

`GET /health` reports `admissionsPaused` and, when paused, `pauseReason`
(`budget_exhausted`, `budget_unavailable`, `recovery_pending`,
`restored_state_incomplete`, or `operator_paused`). It also reports
`publicAdmission`, `calendarWrites`, and `calendarSelected`. Operator pause
and resume:

```bash
curl -fsS -X POST -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/maintenance/pause
curl -fsS -X POST -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/maintenance/resume
```

## Retention cleanup

Cleanup removes operational records older than 30 days and compacts booking
history down to unresolved operations and still-upcoming appointments. It does
not touch the usage ledger and does not call Calendar.

The process runs cleanup on a complete start. A maintainer can also run it
without a restart:

```bash
curl -fsS -X POST -H "Authorization: Bearer $EVIDENCE_TOKEN" \
  https://scheduler.stephens.page/maintenance/cleanup
```

## Upgrade and restart

Releases replace `/opt/scheduling-agent/current` only. Credentials and
`/var/lib/scheduling-agent` stay in place.

```bash
bash ops/deploy-release.sh
sudo systemctl restart scheduling-agent
curl -fsS https://scheduler.stephens.page/health
```

After restart the process reconciles pending Calendar operations against stored
event identities (it never inserts a replacement event), keeps the
callback-number limit, and keeps exhausted monthly usage exhausted. A stale
in-progress call claim is freed; its budget reservation counts as spent.

## Backup and restore (isolated data)

On the host, as a maintainer who can sudo:

```bash
# Point-in-time copy of credentials and durable state
sudo bash ops/backup-scheduling-state.sh /var/backups/scheduling-agent

# Restore onto isolated test data, then restart
sudo systemctl stop scheduling-agent
sudo bash ops/restore-scheduling-state.sh /var/backups/scheduling-agent/<stamp>
sudo systemctl start scheduling-agent
curl -fsS https://scheduler.stephens.page/health
```

Use a throwaway copy of `/var/lib/scheduling-agent` when rehearsing restore.
Do not point a rehearsal at the live Calendar destination.

## Application recording settings vs provider retention

The scheduling process never enables xAI input transcription
(`audio.input.transcription.model` is not set on `session.update`) and never
writes audio, transcripts, or recordings to disk. xAI realtime audio is
session-scoped; account retention in the xAI console is independent. Telnyx
CDRs remain for billing; call recording on the SIP connection and voice
profile must stay disabled there. Turning off application recording does not
change those provider policies.
