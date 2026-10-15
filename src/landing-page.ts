import { isE164 } from "./phone.js";

export const REPOSITORY_URL = "https://github.com/JacobStephens2/voice-agent-scheduling";

export interface LandingPageOptions {
  /** E.164 scheduling number, shown only while callers can actually get through. */
  readonly phoneNumber?: string;
  /** Public admission is on and the operator has not paused new calls. */
  readonly acceptingCalls: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a North American E.164 number as (XXX) XXX-XXXX; leave others as given. */
export function displayPhoneNumber(e164: string): string {
  const match = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

function callSection(options: LandingPageOptions): string {
  const number = options.phoneNumber && isE164(options.phoneNumber) ? options.phoneNumber : undefined;
  if (number && options.acceptingCalls) {
    return [
      '<section class="call" aria-labelledby="call-heading">',
      '<h2 id="call-heading" class="eyebrow">Call the scheduler</h2>',
      `<a class="number" href="tel:${escapeHtml(number)}">${escapeHtml(displayPhoneNumber(number))}</a>`,
      '<p class="note">US number. One call at a time; if it is busy, try again in a few minutes.</p>',
      "</section>",
    ].join("\n");
  }
  return [
    '<section class="call closed" aria-labelledby="call-heading">',
    '<h2 id="call-heading" class="eyebrow">Call the scheduler</h2>',
    '<p class="number-closed">The scheduling line is not taking calls right now.</p>',
    '<p class="note">Check back later, or read how it works below.</p>',
    "</section>",
  ].join("\n");
}

const STYLES = `
:root {
  --bg: #f7f5f0; --surface: #ffffff; --text: #1d1c1a; --muted: #5f5b53;
  --line: #e2ddd2; --accent: #1f5f4a; --accent-soft: #e3efe9;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --surface: #1e1e1c; --text: #ecebe7; --muted: #a29e95;
    --line: #2f2e2b; --accent: #7cc8a8; --accent-soft: #1d2d27;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 17px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 680px; margin: 0 auto; padding: 56px 16px 72px; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
h2 { font-size: 1.1rem; margin: 40px 0 8px; }
.lede { color: var(--muted); margin: 0 0 32px; }
.eyebrow {
  font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin: 0 0 6px;
}
.call {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  padding: 24px; border-left: 4px solid var(--accent);
}
.call.closed { border-left-color: var(--line); }
.number {
  display: inline-block; font-size: 2.1rem; font-weight: 650; color: var(--accent);
  text-decoration: none; font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
}
.number:hover, .number:focus-visible { text-decoration: underline; }
.number-closed { font-size: 1.15rem; font-weight: 600; margin: 4px 0 0; }
.note { color: var(--muted); font-size: 0.92rem; margin: 6px 0 0; }
ol, ul { padding-left: 1.25rem; margin: 0; }
li { margin: 6px 0; }
.rules {
  display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px;
  margin: 0; padding: 16px 20px; background: var(--accent-soft); border-radius: 10px;
}
.rules dt { color: var(--muted); }
.rules dd { margin: 0; }
code {
  font: 0.88em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--accent-soft); padding: 1px 5px; border-radius: 4px;
}
a { color: var(--accent); }
footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.92rem; }
@media (max-width: 480px) {
  main { padding-top: 36px; }
  h1 { font-size: 1.6rem; }
  .number { font-size: 1.7rem; }
  .rules { grid-template-columns: 1fr; gap: 0; }
  .rules dd { margin-bottom: 8px; }
}
`;

export function renderLandingPage(options: LandingPageOptions): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Schedule a call with Jacob</title>",
    '<meta name="description" content="Call a voice agent that checks Jacob Stephens\'s Google Calendar and books a 30-minute phone appointment.">',
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>Schedule a call with Jacob</h1>",
    '<p class="lede">Call this number and a voice agent will book a 30-minute phone appointment on my Google Calendar. I call you back at the time you pick.</p>',
    callSection(options),
    "<h2>What happens on the call</h2>",
    "<ol>",
    "<li>The agent introduces itself as my scheduling assistant.</li>",
    "<li>It checks my real calendar and offers open times. It never describes what is already on my calendar.</li>",
    "<li>You pick a time and say the number I should call.</li>",
    "<li>It reads the appointment back. Nothing is booked until you confirm.</li>",
    "<li>Once you confirm, the event goes on my calendar and I call you at that time.</li>",
    "</ol>",
    "<h2>Booking rules</h2>",
    '<dl class="rules">',
    "<dt>Length</dt><dd>30 minutes, by phone</dd>",
    "<dt>Start times</dt><dd>Weekdays, 10:00 to 16:30 Eastern</dd>",
    "<dt>Window</dt><dd>At least 3 days and at most 14 days ahead</dd>",
    "<dt>Limit</dt><dd>One upcoming appointment per callback number</dd>",
    "<dt>Call length</dt><dd>Up to 10 minutes, with a warning one minute before the end</dd>",
    "</dl>",
    "<h2>Privacy</h2>",
    "<p>The service keeps no audio or transcripts. It stores only the appointment and short-lived call records, which expire after 30 days. The phone and voice providers (Telnyx and xAI) handle call data under their own retention policies.</p>",
    "<h2>How it works</h2>",
    "<p>A Telnyx number forwards the call over SIP to xAI&#39;s <code>grok-voice-think-fast-2.0</code> realtime voice model. A small TypeScript service on Node.js admits the call, gives the model three tools (check availability, propose, confirm), and writes the event through the Google Calendar API. Durable booking records let a restarted process finish an interrupted booking without ever creating a duplicate event.</p>",
    "<footer>",
    `<p>Source code, design notes, and the issue trail are on <a href="${REPOSITORY_URL}">GitHub</a>.</p>`,
    "</footer>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
