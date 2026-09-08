# Telephone appointment scheduling

Design interview: September 7, 2026. Jacob answered Q1–Q17, confirmed shared understanding, and requested publication through the to-spec skill. The implementation specification is [GitHub issue #1](https://github.com/JacobStephens2/voice-agent-scheduling/issues/1), labelled `ready-for-agent`; this document preserves the supporting design and inspection notes.

## Accepted product behavior

Anyone who knows Jacob's dedicated scheduling number can call the agent, hear available times, and book a 30-minute phone appointment without Jacob approving each booking. At appointment time, Jacob calls the person himself.

| Area | Accepted decision | Reference |
| --- | --- | --- |
| Calendar destination | Primary Google Calendar on `jacob@stephens.page`. | Q3 |
| Conflicts and disclosure | Check calendars representing Jacob's real commitments; disclose available times only. Select the exact conflict calendars after account authorization exposes their metadata. | Q3 |
| Duration | 30 minutes. | Original request |
| Permitted hours | Weekdays, 10:00–17:00 in `America/New_York`. Starts on the hour or half-hour; back-to-back appointments allowed. | Q2 |
| Minimum notice | 72 elapsed hours. A Monday 14:00 scheduling call can first book Thursday 14:00. Weekends count toward the notice period. | Q7, Q15 |
| Maximum horizon | Appointment starts at most 14 days ahead. | Q15 |
| Caller details | Required name and spoken, confirmed callback number; optional short purpose. No email address required. | Q4 |
| Booking limit | One upcoming appointment per confirmed callback number. Confirming a supplied number aloud does not prove ownership. | Q8 |
| Confirmation | Read back the appointment details and require explicit agreement before creating the event. Only announce success when the matching event is confirmed in Calendar. | Q9 |
| Dropped call | Before booking confirmation, create nothing. After booking confirmation, finish and reconcile the write even if the call disconnects. | Q9 |
| Appointment expectation | Tell the caller Jacob will call their confirmed callback number at the agreed time. | Q6 |
| Changes | New bookings only. Jacob handles cancellations and rescheduling directly. | Q5, Q8 |
| Notifications | One Calendar popup reminder 10 minutes before the appointment; no email reminder, invitation email, or Google Meet link. | Original request, Q10 |
| Scheduling-call limits | At most 10 minutes and one active caller at a time initially. Additional callers receive an unavailable response and can retry. | Q16 |
| Budget | Target $25/month in additional provider charges, excluding the already-paid server. Pause new calls before the estimated allowance is exhausted. | Q14, Q16 |
| Application call records | No stored audio or transcripts. Retain operational outcomes/errors for 30 days and the minimal durable booking records needed for duplicate prevention and the booking limit. Caller details stay in the calendar event. | Q13 |

Three days means **minimum notice**, with the 14-day maximum retained.

## Call flow and edge-case handling

This section makes the accepted behavior concrete. It was included in the complete design Jacob confirmed before requesting the implementation specification.

1. Introduce the agent as Jacob's scheduling assistant and explain that it can arrange a 30-minute phone appointment.
2. Establish the caller's preferred date/time and obtain the required caller details. Use Eastern when offering times and identify the timezone explicitly; convert when requested and clarify ambiguous dates.
3. Check the booking limit and calculate permitted slots from the booking window, weekday hours, and required calendars' busy intervals. An appointment must fit entirely within the hours, making 16:30 the latest weekday start. Respect all-day busy events; events marked free do not block time.
4. Offer a few relevant options. If nothing fits, explain that no appointment is available in the permitted window and invite the caller to try again later. Do not extend the window or override a conflict at a caller's request.
5. Read back the caller's name, callback number, exact date, start/end times, and timezone. Ask for explicit booking confirmation. A correction changes the proposed details and requires a fresh confirmation.
6. On confirmation, recheck the booking rules and availability within a serialized booking operation. Persist one operation identity before writing. Repeated tool delivery and retries reconcile that operation rather than creating another appointment.
7. Create `Appointment with <caller name>` on the selected calendar, with the callback number and optional purpose in its description. Mark it busy, omit attendees and conference creation, and set only the approved popup reminder. Verify actual notification behavior with the selected account.
8. Once Calendar confirms the matching event exists, tell the caller it is booked and that Jacob will call at the agreed time. If the call has dropped, retain the outcome without initiating another call or sending a message.

If a slot is taken before the booking commits, offer fresh alternatives. If Calendar access fails or an insert's outcome is unknown, avoid announcing success; reconcile the original operation before permitting a replacement. An appointment that Jacob has cancelled should cease blocking a later booking once that change is reconciled.

Google exposes separate availability and event-creation operations. Serializing this service's bookings protects against its own competing writes, but cannot prevent a simultaneous direct edit by Jacob or another application. Check and reconcile detected conflicts; do not claim a transactional guarantee against every external writer. See the [research on races and duplicate prevention](../research/telephone-calendar-scheduling.md#prevent-duplicate-appointments-and-be-precise-about-races).

The call-duration limit must not abandon a booking already confirmed by the caller. Give a brief warning before ending a long call, stop accepting a new booking confirmation at the cutoff, and finish any already-authorized write independently. Redirect off-topic requests to scheduling.

Operational records contain call/operation identifiers, outcomes, timing, usage, and bounded error categories. Keep caller speech, names, and raw callback numbers out of those logs. Durable booking records retain the minimal associations needed to enforce the accepted rules while an operation or appointment remains relevant. Calendar events are not deleted by log cleanup. Provider-side retention is a separate setup check.

## Accepted architecture and evaluation path

- Use a new dedicated number in the existing Telnyx account.
- Evaluate Grok Voice Think Fast 2.0 High first. Use direct SIP if its exact model and practical call behavior can be verified; otherwise use LiveKit. Evaluate the other researched models if Grok fails the scheduling acceptance checks. This is an evaluation choice, not automatic failover during calls.
- Run a separate scheduling service on the existing paid server, with its own process, credentials, durable data, and public HTTPS webhook endpoint when required. Jacob provided `ssh jacob@stephens.page` and explicitly authorized inspecting it.
- Keep scheduling policy, Calendar authorization, and event writes in our application. Give the voice model narrow availability and booking tools.
- Reuse the old project's telephone and deployment knowledge. Service separation is recorded in [ADR 0001](../adr/0001-isolate-the-scheduling-service.md).

Both connection options use SIP. The difference is where Telnyx sends the call:

| Route | Audio connection | Application responsibilities |
| --- | --- | --- |
| Direct SIP | Caller ↔ Telnyx ↔ xAI | Receive the signed incoming-call webhook, join a control WebSocket, supply instructions/tools, and execute Calendar operations. xAI handles the telephone audio. |
| LiveKit | Caller ↔ Telnyx ↔ LiveKit ↔ scheduling worker ↔ xAI | Use LiveKit's agent framework and model plugin for the audio connection alongside the same scheduling policy and Calendar operations. |

Direct SIP has fewer media components and avoids LiveKit charges. LiveKit adds a service and billing layer, while providing reusable call/model integrations and an explicit model setting in its xAI plugin. Version compatibility and actual call behavior still require verification. [xAI SIP guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip), [LiveKit Telnyx integration](https://docs.livekit.io/telephony/start/providers/telnyx/), [xAI plugin](https://docs.livekit.io/agents/models/realtime/plugins/spacexai/), [LiveKit pricing](https://livekit.com/pricing)

xAI's direct-SIP control WebSocket ignores the usual `model` parameter when a `call_id` is supplied. The supported method of selecting/verifying that SIP call's model remains to be established. This does not prove the call uses an older model. Resolve it before accepting direct SIP as the production route. [xAI API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice)

## Implementation and setup checks

These are verification/setup tasks, not reasons to silently change the accepted product rules.

1. **Model and telephone access:** Verify credentials/account access without exposing secrets; establish the exact model/reasoning configuration and complete an inbound call test. Obtain the necessary Telnyx/LiveKit access for the selected path.
2. **Calendar authorization and selection:** Authorize `jacob@stephens.page` for persistent Calendar access. List calendar metadata and ask Jacob to select the calendars representing commitments. No existing Calendar authorization for that account was found; no events have been read.
3. **Host readiness:** Inspect the authorized host for capacity, runtime, edge/proxy services, and deployment access. Then verify the chosen service's DNS/TLS, ports, persistence, and recovery arrangements. The old installer and administrative service dependencies are not a scheduler deployment; avoid copying restrictions that prevent required Calendar/xAI access.
4. **Budget enforcement:** Account for number rental and other fixed charges, reserve estimated allowance for an admitted call, and leave a margin for delayed billing. Enforce the 10-minute/one-caller limits and pause new admissions near the target. Application estimates are not a guarantee against every carrier charge. If the selected route cannot fit the target, return to Jacob with measured alternatives.
5. **Records and provider settings:** Verify SDK, platform, and provider recording/retention settings against the accepted no-stored-audio/transcript application policy. Define minimal durable booking records and recovery/purge behavior without deleting calendar appointments or storing conversation content in logs.
6. **Production acceptance:** Pass the scenarios below on a test calendar and real telephone connection before using the primary calendar for callers.

## Server inspection

Read-only SSH inspection at September 7, 2026, 20:42 Eastern confirmed access to `jacob@stephens.page` and noninteractive sudo. The host runs Ubuntu 24.04.3 on four logical CPUs, with Node 22.22.0 and pnpm 11.22.0 available. Approximately 11 GiB of 15 GiB RAM was available; root storage had 23 GiB free and was 89% full.

Apache is running with HTTPS and proxy support. The existing voice-agent API/worker and related services are active, with a separate service identity, release directory, and private `/var/lib` state. A new loopback service behind Apache fits the observed hosting pattern. Port 3531 was unused at inspection, but has not been reserved. No scheduler hostname or certificate has been configured.

This short resource sample supports using the existing host for the small scheduler; it does not prove peak-load capacity or real-call latency. The LiveKit alternative assumes LiveKit Cloud with our agent worker on this host; self-hosted LiveKit media/SIP capacity was not assessed. No server, provider, DNS, or Calendar changes were made, and no telephone call was placed.

## Acceptance scenarios

- A normal booking creates exactly one 30-minute busy event with the correct caller details, no attendees/Meet link/email reminder, and the 10-minute popup.
- A Monday 14:00 scheduling call cannot book before Thursday 14:00; weekday hours, half-hour starts, the 14-day maximum, weekends, and daylight-saving boundaries are enforced.
- Busy intervals from every selected calendar block slots, including all-day busy events; unrelated event details are not disclosed.
- Date, timezone, name, and callback-number corrections appear in the final readback and event.
- No explicit confirmation means no write. A disconnect after confirmation completes the same operation. Success is spoken only after the matching event is known to exist.
- Duplicate tool delivery, a timeout after Google's accepted write, and a process restart do not create another appointment.
- An existing upcoming appointment prevents another booking for that callback number. A manual cancellation is reconciled so it does not block the person forever.
- Lost Calendar authorization, changed availability, uncertain writes, provider failure, and detected external-write conflicts do not produce false success.
- A second simultaneous caller cannot bypass admission limits. Call-duration and budget controls preserve already-confirmed booking work.
- Stored records and platform settings satisfy the agreed retention policy, and usage evidence supports the budget target.

## Supporting documents

- [Domain glossary](../../CONTEXT.md)
- [Provider research and existing-repo findings](../research/telephone-calendar-scheduling.md)
- [ADR 0001: isolate the scheduling service](../adr/0001-isolate-the-scheduling-service.md)
