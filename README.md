# Voice agent scheduling

A telephone scheduling agent that describes Jacob's availability and creates 30-minute phone appointments on his Google Calendar. Jacob calls the confirmed callback number at appointment time.

The first telephone path is the isolated Direct SIP scheduler in this repository. It answers a dedicated Telnyx number, identifies itself as Jacob's scheduling assistant, offers real Google Calendar availability, and creates one 30-minute appointment after the caller confirms the readback. Public admission stays allowlisted (`ALLOWED_CALLER_NUMBERS`). Calendar writes stay off until `SCHEDULING_ALLOW_CALENDAR_WRITES=true`.

```bash
npm test
npm run typecheck
SCHEDULER_URL=https://scheduler.stephens.page EVIDENCE_TOKEN=... npm run smoke:pstn
```

- [Implementation specification and sub-issues](https://github.com/JacobStephens2/voice-agent-scheduling/issues/1)
- [First implementation ticket: answer the scheduling number with a verified voice model](https://github.com/JacobStephens2/voice-agent-scheduling/issues/2)
- [Telephone path setup](docs/deployment/telephone-path-setup.md)
- [Google Calendar authorization and calendar selection](docs/deployment/calendar-setup.md)
- [Accepted design, connection options, and acceptance scenarios](docs/design/appointment-scheduling.md)
- [Provider research and existing voice-agent findings](docs/research/telephone-calendar-scheduling.md)
- [Domain glossary](CONTEXT.md)
- [Architecture decision: isolate the scheduling service](docs/adr/0001-isolate-the-scheduling-service.md)
