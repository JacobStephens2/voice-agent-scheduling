import { createSchedulingServer } from "./server.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
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

const allowedCallerNumbers = optionalList("ALLOWED_CALLER_NUMBERS");
if (!allowedCallerNumbers || allowedCallerNumbers.length === 0) {
  throw new Error(
    "Public admission is disabled. Set ALLOWED_CALLER_NUMBERS to the authorized smoke-call numbers.",
  );
}

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
  maxCallDurationMs: Number.parseInt(process.env.MAX_CALL_DURATION_MS || "600000", 10),
  dataDir: process.env.SCHEDULING_DATA_DIR,
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
