/**
 * Wait for one authorized inbound PSTN smoke call and check structured evidence.
 * Does not assert incidental spoken wording.
 */

const targetUrl = process.env.SCHEDULER_URL || "http://127.0.0.1:3531";
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || "300000", 10);
const evidenceToken = process.env.EVIDENCE_TOKEN;
const startedAt = new Date().toISOString();

if (!evidenceToken) {
  console.error("[smoke:pstn] EVIDENCE_TOKEN is required");
  process.exit(1);
}

console.log(`[smoke:pstn] Target service: ${targetUrl}`);
console.log(`[smoke:pstn] Waiting up to ${timeoutMs / 1000}s for an inbound smoke call...`);
console.log("[smoke:pstn] Place the authorized call, ask for next Friday availability, then hang up.");

const deadline = Date.now() + timeoutMs;

interface SmokeEvidence {
  readonly recordedAt?: string;
  readonly status?: string;
  readonly modelVerified?: string;
  readonly reasoningVerified?: string;
  readonly toolRoundTrips?: number;
  readonly callerNumberMasked?: string;
  readonly connectionRoute?: string;
  readonly durationMs?: number;
  readonly estimatedCostMicroUsd?: number;
  readonly error?: string;
}

async function latestCompleted(): Promise<SmokeEvidence | undefined> {
  const response = await fetch(`${targetUrl}/evidence`, {
    headers: { authorization: `Bearer ${evidenceToken}` },
  });
  if (!response.ok) {
    return undefined;
  }
  const list = (await response.json()) as SmokeEvidence[];
  return list.find(
    (entry) => (entry.recordedAt ?? "") >= startedAt && entry.status === "completed",
  );
}

while (Date.now() < deadline) {
  let match: SmokeEvidence | undefined;
  try {
    match = await latestCompleted();
  } catch {
    match = undefined;
  }

  if (match) {
    if (match.connectionRoute !== "direct_sip") {
      console.error(
        `[smoke:pstn] FAILURE: Expected connection route direct_sip, got '${match.connectionRoute}'`,
      );
      process.exit(1);
    }
    if (match.modelVerified !== "grok-voice-think-fast-2.0") {
      console.error(
        `[smoke:pstn] FAILURE: Expected model grok-voice-think-fast-2.0, got '${match.modelVerified}'`,
      );
      process.exit(1);
    }
    if (match.reasoningVerified !== "high") {
      console.error(
        `[smoke:pstn] FAILURE: Expected reasoning high, got '${match.reasoningVerified}'`,
      );
      process.exit(1);
    }
    if (!match.toolRoundTrips || match.toolRoundTrips < 1) {
      console.error(
        `[smoke:pstn] FAILURE: Expected at least one synthetic availability tool round trip, got ${match.toolRoundTrips}`,
      );
      process.exit(1);
    }
    if (!/^\+\d{1,3}\*\*\*\d{4}$/.test(match.callerNumberMasked ?? "")) {
      console.error(
        `[smoke:pstn] FAILURE: Expected a masked caller number, got '${match.callerNumberMasked}'`,
      );
      process.exit(1);
    }
    if ("audio" in match || "transcript" in match || "recording" in match) {
      console.error(
        "[smoke:pstn] FAILURE: Smoke evidence must not retain audio, transcripts, or recordings",
      );
      process.exit(1);
    }

    console.log("\n[smoke:pstn] SUCCESS");
    console.log(`- Connection route: ${match.connectionRoute}`);
    console.log(`- Provider model verified: ${match.modelVerified}`);
    console.log(`- Provider reasoning verified: ${match.reasoningVerified}`);
    console.log(`- Synthetic tool round trips: ${match.toolRoundTrips}`);
    console.log(`- Call duration: ${Math.round((match.durationMs ?? 0) / 1000)}s`);
    console.log(
      `- Estimated cost: $${((match.estimatedCostMicroUsd ?? 0) / 1_000_000).toFixed(4)}`,
    );
    console.log(`- Caller number masked: ${match.callerNumberMasked}`);
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

console.error(`\n[smoke:pstn] TIMEOUT: no completed smoke call arrived within ${timeoutMs / 1000}s`);
process.exit(1);
