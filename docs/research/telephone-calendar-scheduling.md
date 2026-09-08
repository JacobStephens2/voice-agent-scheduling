# Telephone appointment scheduling

Researched 2026-09-07 against vendor documentation, Artificial Analysis's own benchmark page, and the local `voice-agent` source. This is research for the design interview, not an accepted architecture. No paid calls, credential authentication, or Calendar writes were performed.

This note preserves the research snapshot. See the [design decisions](../design/appointment-scheduling.md) for subsequent accepted policies, including three days of minimum advance notice and the Telnyx/Grok evaluation path.

## Provisional recommendation

Start with Telnyx and evaluate Grok Voice Think Fast 2.0 first. Keep the Calendar policy and writes in a small application service with two model-facing operations: find permitted availability and confirm one 30-minute appointment. The caller's spoken confirmation and a successful Calendar write must precede the agent saying the appointment is scheduled. These are design recommendations, pending Jacob's scheduling policy and practical call tests.

There are two credible starting paths:

1. **Telnyx → xAI direct SIP → Calendar service** has the fewest media components. xAI documents Telnyx support, incoming-call webhooks, a control WebSocket, and local function tools. The unresolved issue is selecting and verifying the exact voice model on a SIP call. [xAI SIP guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip)
2. **Telnyx → LiveKit → a new scheduling worker → Calendar service** reuses the old project's telephony knowledge and makes comparisons between providers easier. LiveKit documents Telnyx trunks and an xAI Node.js plugin. This adds another service and billing layer. [Telnyx setup](https://docs.livekit.io/telephony/start/providers/telnyx/), [xAI plugin](https://docs.livekit.io/agents/models/realtime/plugins/spacexai/)

Prefer direct SIP if its model selection and call behavior pass the initial probe; use LiveKit if exact model pinning or provider comparison makes it the faster dependable path. There is no evidence here that replacing Telnyx with Twilio would improve this specific application.

## What the benchmark establishes

The current Artificial Analysis table has the following values. Its overall index combines speech reasoning, agentic performance, arena preference, and task success. These values differ from launch-day screenshots and vendor blog tables. [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech)

| Benchmark label | Overall index | Task success | Time to first audio |
| --- | ---: | ---: | ---: |
| Grok Voice Think Fast 2.0 High | 79.0% | 94.7% | 0.70 seconds |
| GPT-Realtime-2.1 High | 73.9% | 91.5% | 1.21 seconds |
| Gemini 3.1 Flash Live High | 71.5% | 71.8% | 2.99 seconds |

These are benchmark results, not measurements of this scheduler. Artificial Analysis measures first audio on Big Bench Audio; its normalized audio-cost benchmark is not a telephone bill. Grok is a sensible first candidate, but calendar accuracy, caller corrections, noisy telephone audio, and function-call handling still require application tests. [Benchmark definitions and table](https://artificialanalysis.ai/speech-to-speech)

## Model and API comparison

| Candidate | Public API identifier and reasoning | Relevant capabilities and limits |
| --- | --- | --- |
| xAI Grok Voice Think Fast 2.0 | `grok-voice-think-fast-2.0`; `grok-voice-latest` currently aliases it. `reasoning.effort` accepts `high` or `none`, defaulting to `high`. | Bidirectional audio, custom JSON-schema function tools, server VAD, PCM and G.711 μ-law/A-law audio. Direct WebSocket connections can specify the versioned model. [Voice guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) |
| OpenAI GPT-Realtime-2.1 | `gpt-realtime-2.1`; “High” is a reasoning configuration, not a separate model ID. | Public Realtime model with audio input/output and function calling. Higher reasoning can increase latency and output usage. [Model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) |
| Google Gemini 3.1 Flash Live | `gemini-3.1-flash-live-preview`; `thinkingLevel` supports `minimal`, `low`, `medium`, and `high`; default is `minimal`. | Public preview model supporting audio generation, Live API, thinking, and function calling. Preview status is a production dependency to track. [Model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) |

OpenAI supports WebRTC, WebSocket, and SIP voice-agent connections. Its guidance recommends starting production voice agents at low reasoning and increasing it only when the workflow benefits. Compare the user's requested High configuration with Low for this bounded task. [Realtime overview](https://developers.openai.com/api/docs/guides/realtime), [reasoning guidance](https://developers.openai.com/api/docs/guides/realtime-models-prompting#set-reasoning-effort)

Gemini's documented native transport is a stateful WebSocket: raw 16-bit little-endian PCM, natively 16 kHz input and 24 kHz output. Input can be resampled. A telephone deployment therefore needs a media bridge such as LiveKit or another integration; the reviewed Gemini Developer API docs do not establish a native SIP endpoint. [Live overview](https://ai.google.dev/gemini-api/docs/live-api), [audio formats](https://ai.google.dev/gemini-api/docs/live-api/capabilities#audio-formats)

Gemini 3.1 Live currently supports **synchronous function calling only**: it does not start responding until the application returns the tool result. Keep Calendar requests bounded and test the caller experience during delays. [Live tool support](https://ai.google.dev/gemini-api/docs/live-api/tools)

### xAI direct SIP: promising, with a specific gap

Register a customer-owned number using `POST /v2/phone-numbers` and `origin: "byo_trunk"`; configure carrier routing, verify the signed incoming webhook, then join the call with `wss://api.x.ai/v1/realtime?call_id=...`. The SIP guide supports Telnyx and Twilio, including G.711 μ-law/A-law and G.722 in its Telnyx instructions. It does not provision a new xAI number through the API. [SIP setup](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip)

**A `model` query parameter is explicitly ignored when `call_id` is supplied.** The reviewed phone-number and SIP schemas do not establish how to pin a SIP call to Think Fast 2.0. Do not assume that appending the model to the control WebSocket selects it. Resolve this through the provider's supported configuration and observed session metadata before accepting direct SIP. A model-pinned direct WebSocket behind a media bridge is the documented alternative. [xAI REST reference](https://docs.x.ai/developers/rest-api-reference/inference/voice)

xAI custom function calls are executed by the application, which returns `function_call_output` and resumes the response. Its documentation requires collecting all function results before sending one continuation when the model emits parallel calls. Recommendation: availability reads may run concurrently, but appointment writes must be serialized and deduplicated by the application. [Function-call lifecycle](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech#handling-function-call-responses)

### Other telephony choices

OpenAI direct SIP is another compact path. A carrier routes to the OpenAI project SIP endpoint; a signed incoming webhook supplies a call ID; the application's accept request explicitly selects `gpt-realtime-2.1`; a sideband WebSocket handles tools and call control. This documents model selection more clearly than the reviewed xAI SIP path. [OpenAI SIP guide](https://developers.openai.com/api/docs/guides/realtime-sip)

Twilio can supply SIP trunks for direct provider routing, or bidirectional Media Streams for a custom WebSocket bridge. Media Streams uses μ-law audio at 8 kHz; the application must manage buffered playback and interruption clearing. Choose this route if it solves an observed integration problem or an account/setup constraint. [Media Streams](https://www.twilio.com/docs/voice/media-streams), [WebSocket audio protocol](https://www.twilio.com/docs/voice/media-streams/websocket-messages)

Telnyx AI Assistants is the relevant managed alternative: attach a phone number, configure an assistant, and connect custom webhook tools. It could reduce voice orchestration code, while the Calendar service still owns correctness. Its documented custom LLM path uses Chat Completions; selecting a Grok TTS voice is not evidence that it runs Think Fast 2.0 speech-to-speech. Confirm the exact model path if evaluating it. [Assistant setup](https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant), [tools and workflows](https://developers.telnyx.com/docs/inference/ai-assistants/workflows), [custom LLMs](https://developers.telnyx.com/docs/inference/ai-assistants/custom-llm)

## Cost snapshot

USD list prices checked 2026-09-07. Account rates, geography, taxes, plan allowances, carrier features, reasoning, and conversation length can change the total. These are components, not equivalent all-inclusive per-call quotes.

| Component | Published price | Interpretation |
| --- | --- | --- |
| Grok Think Fast 2.0 | $0.08/minute audio; $0.004/text input | The pricing table does not sufficiently define silence, overlapping audio, or text-input billing units to derive an exact telephone-call bill here. Verify against session usage. [xAI pricing](https://docs.x.ai/developers/pricing) |
| GPT-Realtime-2.1 | Per million audio tokens: $32 input, $0.40 cached input, $64 output. Text: $4 input, $0.40 cached input, $24 output. | Measure actual usage; do not label this a fixed per-minute rate. [OpenAI pricing](https://developers.openai.com/api/docs/pricing#audio-tokens) |
| Gemini 3.1 Flash Live Preview | Per million tokens: audio $3 input/$12 output; text $0.75 input/$4.50 output, including thinking. The page also lists $0.005/input audio minute and $0.018/output audio minute. | Input and output are separate; application usage is needed for a total. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-live-preview) |
| Telnyx local inbound SIP | From $0.0032/minute; phone numbers advertised from $1/month | Destination/account-dependent. [Telnyx SIP pricing](https://telnyx.com/pricing/elastic-sip) |
| Twilio US local inbound SIP | $0.0034/minute | Number rental is separate. These are SIP rates, not Programmable Voice + Media Streams rates. [Twilio SIP pricing](https://www.twilio.com/en-us/sip-trunking/pricing/us) |
| LiveKit | Plan-specific inclusions, then third-party SIP usage; agent and other usage can also apply | Price the actual hosting arrangement and existing plan. Do not add cloud worker charges blindly to a self-hosted worker, or assume SIP is the only billable component. [LiveKit pricing](https://livekit.com/pricing) |

If a test consumes five billable xAI audio minutes, that component is $0.40 before other charges. The 30-minute appointment duration does not require a 30-minute agent call; cost follows the scheduling conversation and its usage.

## Google Calendar boundary

### Authorization for one person's calendar

Use Google's user OAuth flow and request offline access so the server can refresh credentials after Jacob leaves the authorization page. Persist the refresh credential securely outside the repository. A voice-model API key does not authorize access to Google Calendar. [Server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server)

An external OAuth app left in **Testing** receives a refresh token that expires after seven days when Calendar scopes are requested. Persistent operation needs the appropriate consent-screen publishing configuration and any applicable verification completed; refresh access can still later be revoked or expire. Treat an authorization failure as inability to schedule, not as an empty calendar. [OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

For a preconfigured calendar Jacob owns, a narrowly scoped starting set is:

- `https://www.googleapis.com/auth/calendar.freebusy` to read his availability.
- `https://www.googleapis.com/auth/calendar.events.owned` to create and reconcile events in calendars he owns.

The event scope still permits viewing, changing, and deleting owned-calendar events; Google does not offer a create-only scope for an existing primary calendar. Enforce the smaller application capability through code. `calendar.app.created` applies to secondary calendars created by the application and does not authorize writing Jacob's existing primary calendar. If availability must include calendars owned by others, assess `calendar.events.freebusy` and their sharing permissions. [Scope definitions](https://developers.google.com/workspace/calendar/api/auth)

Both `freeBusy.query` and `events.insert` publish their accepted scopes. In particular, the event-write scope alone is not in the free/busy endpoint's accepted list. [Free/busy authorization](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [event insertion authorization](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

### Availability and the resulting event

`freeBusy.query` returns busy intervals for requested calendar IDs and can report errors per calendar. It does not return appointment titles or calculate Jacob's permitted appointment hours. Compute candidate 30-minute slots from the scheduling policy minus all required busy intervals; fail closed on missing required calendar data. Give the model available slots, not unrelated calendar contents. The latter rules are proposed application behavior. [Free/busy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)

Create an ordinary event with an exact start and end, explicit time zone/offset, no attendees, and no conference creation request. Use `sendUpdates: "none"`; omit `conferenceData` and leave `conferenceDataVersion` at zero. Do not use deprecated `sendNotifications`. Google documents that some emails might still be sent, so verify the intended behavior with Jacob's account rather than promise suppression of every account-level notification. [Insert parameters](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

Set `transparency: "opaque"` so the event blocks time. If no reminders are desired, use `reminders: { "useDefault": false, "overrides": [] }`; otherwise explicitly allow only the reminder types Jacob approves. The event title and caller details remain interview questions. [Event fields](https://developers.google.com/workspace/calendar/api/v3/reference/events)

### Prevent duplicate appointments and be precise about races

The reviewed API exposes separate free/busy and insert operations, with no documented conditional “insert only if this interval is still free” transaction. Therefore, a successful availability query cannot guarantee the interval remains free until insertion. This is an inference from the API contracts. [Free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

Recommended application design:

1. After the caller confirms the exact date, time, time zone, and duration, serialize conflicting appointment attempts in a durable store shared by the workers. A process-local mutex is insufficient if multiple workers can accept calls.
2. Within that serialized operation, recheck policy and all required calendars before writing. Keep competing scheduler writes excluded until the outcome is recorded or an ambiguous result is reconciled.
3. Assign one durable operation ID and one Google event ID before insertion. On a timeout or repeated tool call, reconcile that same operation instead of creating another ID.
4. Return a confirmed result only when the matching event is known to exist. A disconnect after confirmation must not make the committed result disappear from the application's records.

Google permits caller-supplied event IDs using base32hex-compatible characters and recommends UUID-based IDs; it also warns that ID collisions are not guaranteed to be detected at creation. Treat IDs as one deduplication aid, not the entire concurrency mechanism. [Event IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events)

On a duplicate-ID `409`, retrieve and compare the intended event rather than blindly generating a new ID. Retry transient failures with bounded backoff and reconcile ambiguous insert outcomes first. An application lock protects this scheduler's callers; it cannot stop Jacob or another application writing directly to Google during the check/insert interval. Decide how to handle that residual race. [Error semantics](https://developers.google.com/workspace/calendar/api/guides/errors)

## Reuse from the existing voice-agent repository

Source examined at local HEAD `691cc0f7e9bb2ccab1bf21e1acdb3d9373b2eb15`; deployment health was not tested.

- The setup script already describes Telnyx FQDN routing, LiveKit trunks, and dispatch to `voice-agent-telephone`. Reuse that setup knowledge and relevant service patterns. [Setup source](https://github.com/JacobStephens2/voice-agent/blob/691cc0f7e9bb2ccab1bf21e1acdb3d9373b2eb15/ops/setup-agent-host.sh#L258)
- Its admission path is designed for an owner callback handshake. The scheduling agent needs its own caller-admission policy. [Telephone admission](https://github.com/JacobStephens2/voice-agent/blob/691cc0f7e9bb2ccab1bf21e1acdb3d9373b2eb15/apps/worker/src/telephone-agent.ts#L295), [callback rules](https://github.com/JacobStephens2/voice-agent/blob/691cc0f7e9bb2ccab1bf21e1acdb3d9373b2eb15/packages/runtime/src/callback-handshake.ts#L705)
- The worker disables independent model replies and uses `openai/gpt-5.4-mini` with a 16-token budget for a narrow turn interpreter. It is not an existing general speech-to-speech function-calling scheduler. Build a small new conversation path. [Voice worker](https://github.com/JacobStephens2/voice-agent/blob/691cc0f7e9bb2ccab1bf21e1acdb3d9373b2eb15/apps/worker/src/livekit-telephone-session.ts#L766)

LiveKit's xAI plugin documentation currently lists Think Fast 1.0 as its default even though xAI recommends 2.0. Explicitly configure the model and inspect the installed plugin's support before claiming reuse is complete. [Plugin parameters](https://docs.livekit.io/agents/models/realtime/plugins/spacexai/)

Recommendation: a dedicated scheduling number and worker would keep initial rollout independent of the existing service. Reusing or rerouting the old number is an unresolved product choice.

## Questions and practical evaluation

Resolve scheduling policy before implementation: which calendar receives appointments; which calendars block availability; permitted weekdays/hours and time zone; minimum notice and maximum horizon; start-time increments and buffers; who may call; caller name/contact details; what the caller understands the appointment to involve; reminders; cancellation/rescheduling scope; and behavior when calendar access fails. These are product decisions, not facts the model should infer from an empty calendar.

Suggested evaluation, after the relevant setup and test access are authorized:

1. Verify usable model credentials without exposing values, select the exact model/reasoning configuration, and record provider-reported session identity. An injected key's presence does not establish endpoint entitlement or balance. Resolve xAI SIP version selection before choosing that path.
2. Run a browser/direct-audio comparison using synthetic availability and identical tools. Test a normal appointment, corrections, ambiguous dates, multiple time zones, interruption during confirmation, background speech, and attempted requests outside scheduling scope.
3. Run real inbound telephone tests with the leading candidate. Measure time to first greeting, response latency after caller speech, interruptions, numeric/date accuracy, and completed appointments. Browser performance does not establish PSTN behavior.
4. Use a test calendar to verify 30-minute busy events, expected titles, no attendees or Meet links, approved reminder behavior, actual email behavior, and correct handling of all-day conflicts and daylight-saving transitions.
5. Exercise two callers choosing overlapping slots, duplicate tool delivery, timeout after an accepted Google write, hangup around confirmation, process restart, and revoked OAuth access. Confirm that retries do not create another appointment or produce false spoken success.
6. Compare cost per successfully scheduled appointment from provider usage and carrier bills. Choose the simplest path that passes; retain other providers as evaluated alternatives, not automatic failover in the first release.

Remaining external unknowns include current Telnyx/LiveKit account configuration, the existing number's intended use, xAI SIP model pinning and billing granularity, actual provider access/limits, and Google consent/account settings. No live system claim is made by this note.
