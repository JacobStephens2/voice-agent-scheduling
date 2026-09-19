/**
 * Collect a bounded production-acceptance report from /health and /evidence.
 * Does not retain audio, transcripts, or raw caller contact data.
 */

import {
  PARENT_SPEC_SCENARIOS,
  buildAcceptanceReport,
  type AcceptanceScenarioResult,
} from "./acceptance.js";
import type { StructuredCallEvidence } from "./evidence.js";

const targetUrl = process.env.SCHEDULER_URL || "http://127.0.0.1:3531";
const evidenceToken = process.env.EVIDENCE_TOKEN;

if (!evidenceToken) {
  console.error("[acceptance:report] EVIDENCE_TOKEN is required");
  process.exit(1);
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || !value || value.startsWith("--")) {
    return undefined;
  }
  return value;
}

async function readJsonFile(path: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const healthResponse = await fetch(`${targetUrl}/health`);
if (!healthResponse.ok) {
  console.error(`[acceptance:report] GET /health failed: ${healthResponse.status}`);
  process.exit(1);
}
const health = (await healthResponse.json()) as {
  publicAdmission?: boolean;
  calendarWrites?: boolean;
  calendarSelected?: boolean;
  admissionsPaused?: boolean;
  pauseReason?: string;
};

const evidenceResponse = await fetch(`${targetUrl}/evidence`, {
  headers: { authorization: `Bearer ${evidenceToken}` },
});
if (!evidenceResponse.ok) {
  console.error(`[acceptance:report] GET /evidence failed: ${evidenceResponse.status}`);
  process.exit(1);
}
const evidence = (await evidenceResponse.json()) as StructuredCallEvidence[];

let syntheticSuite = { passed: 0, failed: 0 };
const syntheticPath = flagValue("--synthetic");
if (syntheticPath) {
  const vitest = (await readJsonFile(syntheticPath)) as {
    numPassedTests?: number;
    numFailedTests?: number;
  };
  syntheticSuite = {
    passed: vitest.numPassedTests ?? 0,
    failed: vitest.numFailedTests ?? 0,
  };
}

let scenarios: AcceptanceScenarioResult[] = PARENT_SPEC_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  result: "pending",
}));
const scenariosPath = flagValue("--scenarios");
if (scenariosPath) {
  scenarios = (await readJsonFile(scenariosPath)) as AcceptanceScenarioResult[];
}

const report = buildAcceptanceReport({
  recordedAt: new Date().toISOString(),
  health: {
    publicAdmission: health.publicAdmission === true,
    calendarWrites: health.calendarWrites === true,
    calendarSelected: health.calendarSelected === true,
    admissionsPaused: health.admissionsPaused === true,
    pauseReason: health.pauseReason,
  },
  evidence,
  syntheticSuite,
  scenarios,
  limitations: [
    "A simultaneous direct Calendar edit by Jacob or another app can still race with a booking insert.",
    "Application storage never records audio or transcripts; xAI and Telnyx retain provider-side data under their own policies.",
    "The $25/month figure is an operating target, not a guarantee against every carrier charge after cutoff.",
  ],
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.publicAdmission) {
  process.stderr.write(
    "[acceptance:report] Public admission is enabled. Confirm the campaign passed before leaving it on.\n",
  );
}
