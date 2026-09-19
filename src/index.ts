import { resolveCallerAdmissionMode } from "./admission-policy.js";
import { createSchedulingServer } from "./server.js";
import {
  DURATION_WARNING_LEAD_MS_DEFAULT,
  FIXED_MONTHLY_MICRO_USD_DEFAULT,
  MAX_CALL_DURATION_MS_DEFAULT,
  MONTHLY_TARGET_MICRO_USD_DEFAULT,
  RESERVE_MARGIN_DEFAULT,
} from "./budget.js";
import { loadSelection } from "./calendar/selection.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

function optionalEnvNumber(
  name: string,
  parse: (raw: string) => number,
  isValid: (value: number) => boolean,
  fallback: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = parse(raw);
  if (!Number.isFinite(parsed) || !isValid(parsed)) {
    process.stderr.write(
      `[scheduling-agent] Ignoring invalid ${name}='${raw}'; using the default.\n`,
    );
    return fallback;
  }
  return parsed;
}

function optionalList(name: string): string[] | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const allowCalendarWrites = process.env.SCHEDULING_ALLOW_CALENDAR_WRITES === "true";
const admissionMode = resolveCallerAdmissionMode(
  {
    publicAdmission: process.env.SCHEDULING_PUBLIC_ADMISSION === "true",
    calendarWrites: allowCalendarWrites,
    calendarSelected: loadSelection({ dataDir: process.env.SCHEDULING_DATA_DIR }) !== undefined,
  },
  optionalList("ALLOWED_CALLER_NUMBERS"),
);
const allowedCallerNumbers =
  admissionMode.kind === "allowlist" ? [...admissionMode.allowedCallerNumbers] : undefined;

const operatorToken = process.env.OPERATOR_TOKEN?.trim() || undefined;
if (!operatorToken) {
  process.stderr.write(
    "[scheduling-agent] OPERATOR_TOKEN is not set; /calendar/auth/* setup pages are disabled.\n",
  );
}

const app = createSchedulingServer({
  port: Number.parseInt(process.env.SCHEDULING_PORT || "3531", 10),
  webhookSecret: requiredEnv("XAI_WEBHOOK_SECRET"),
  apiKey: requiredEnv("XAI_API_KEY"),
  evidenceToken: requiredEnv("EVIDENCE_TOKEN"),
  operatorToken,
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || undefined,
  maxConcurrentCalls: Number.parseInt(process.env.MAX_CONCURRENT_CALLS || "1", 10),
  allowedCallerNumbers,
  admissionMode,
  pauseAdmissions: process.env.SCHEDULING_PAUSE_ADMISSIONS === "true",
  maxCallDurationMs: optionalEnvNumber(
    "MAX_CALL_DURATION_MS",
    (raw) => Number.parseInt(raw, 10),
    (value) => value > 0,
    MAX_CALL_DURATION_MS_DEFAULT,
  ),
  warningLeadMs: optionalEnvNumber(
    "CALL_DURATION_WARNING_MS",
    (raw) => Number.parseInt(raw, 10),
    (value) => value > 0,
    DURATION_WARNING_LEAD_MS_DEFAULT,
  ),
  monthlyTargetMicroUsd: optionalEnvNumber(
    "SCHEDULING_MONTHLY_TARGET_MICRO_USD",
    (raw) => Number.parseInt(raw, 10),
    (value) => value > 0,
    MONTHLY_TARGET_MICRO_USD_DEFAULT,
  ),
  fixedMonthlyMicroUsd: optionalEnvNumber(
    "SCHEDULING_FIXED_MONTHLY_MICRO_USD",
    (raw) => Number.parseInt(raw, 10),
    (value) => value >= 0,
    FIXED_MONTHLY_MICRO_USD_DEFAULT,
  ),
  reserveMargin: optionalEnvNumber(
    "SCHEDULING_RESERVE_MARGIN",
    (raw) => Number.parseFloat(raw),
    (value) => value >= 0,
    RESERVE_MARGIN_DEFAULT,
  ),
  dataDir: process.env.SCHEDULING_DATA_DIR,
  allowCalendarWrites,
});

await app.start();
process.stdout.write(`[scheduling-agent] listening on 127.0.0.1:${process.env.SCHEDULING_PORT || "3531"}\n`);

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
