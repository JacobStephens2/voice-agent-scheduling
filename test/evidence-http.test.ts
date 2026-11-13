import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATIONAL_RECORDS_FILE, createCallEvidence } from "../src/evidence.js";
import { createSchedulingServer, type SchedulingServer } from "../src/server.js";
import { createSyntheticAvailabilityTool } from "../src/synthetic-calendar.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import { WEBHOOK_SECRET, incomingCallPayload, recordedEvidence, signedHeaders } from "./helpers.js";

const TOKEN = "test-evidence-owner-http";
const HEADERS = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-11-13T15:00:00.000Z");
const applications: SchedulingServer[] = [];
const directories: string[] = [];
const sockets: FakeRealtimeSocket[] = [];

function temporaryDirectory() {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-evidence-http-"));
  directories.push(dataDir);
  return dataDir;
}

async function startServer(dataDir?: string) {
  const app = createSchedulingServer({
    port: 0,
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-xai-key",
    evidenceToken: TOKEN,
    dataDir,
    availabilityTool: createSyntheticAvailabilityTool(),
    connectWebSocket: (url, headers) => {
      const socket = new FakeRealtimeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    hangupCall: async () => undefined,
  });
  applications.push(app);
  await app.start();
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    app,
    cleanup: () => fetch(`${baseUrl}/maintenance/cleanup`, { method: "POST", headers: HEADERS }),
    listing: async () => (await fetch(`${baseUrl}/evidence`, { headers: HEADERS })).json(),
  };
}

async function admit(app: SchedulingServer, callId: string) {
  const response = await app.lifecycleManager.handleWebhook(signedHeaders(incomingCallPayload({ callId }), {
    webhookId: `evt-${callId}`,
  }));
  expect(response.statusCode).toBe(200);
  return sockets.at(-1)!;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of applications.splice(0)) await app.stop();
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Scheduling call evidence HTTP cleanup", () => {
  it("preserves in-memory evidence and operator pause without a data directory", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { app, cleanup, listing } = await startServer();
    (await admit(app, "memory-kept")).close();
    const record = await recordedEvidence(() => app.lifecycleManager.listEvidence(), "memory-kept");
    app.lifecycleManager.pauseAdmissions();
    vi.setSystemTime(new Date("2026-12-15T15:00:00.000Z"));
    const response = await cleanup();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operationalRecordsRemoved: 0,
      operationalRecordsKept: 1,
      bookingRecordsRemoved: 0,
      bookingRecordsKept: 0,
    });
    expect(await listing()).toEqual([record]);
    expect(app.lifecycleManager.admissionsStatus()).toEqual({ paused: true, reason: "operator_paused" });
  });

  it("immediately lists retained outcomes and keeps a call finishing after cleanup durable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const dataDir = temporaryDirectory();
    const { app, cleanup, listing } = await startServer(dataDir);
    (await admit(app, "durable-expired")).close();
    await recordedEvidence(() => app.lifecycleManager.listEvidence(), "durable-expired");
    vi.setSystemTime(new Date("2026-12-15T15:00:00.000Z"));
    const live = await admit(app, "durable-live");
    const budgetBefore = app.lifecycleManager.budgetSnapshot();
    const response = await cleanup();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operationalRecordsRemoved: 1, operationalRecordsKept: 0 });
    expect(await listing()).toEqual([]);
    expect(app.lifecycleManager.budgetSnapshot()).toEqual(budgetBefore);
    expect(app.lifecycleManager.activeCallCount()).toBe(1);
    live.close();
    const record = await recordedEvidence(() => app.lifecycleManager.listEvidence(), "durable-live");
    expect(await listing()).toEqual([record]);
    expect(createCallEvidence({ dataDir }).list()).toEqual([record]);
  });

  it.each([OPERATIONAL_RECORDS_FILE, "smoke-evidence.jsonl"])(
    "returns 500 for later corruption in %s without changing the previous listing or refreshing pause",
    async (filename) => {
      const dataDir = temporaryDirectory();
      const { app, cleanup, listing } = await startServer(dataDir);
      (await admit(app, "before-corruption")).close();
      const record = await recordedEvidence(() => app.lifecycleManager.listEvidence(), "before-corruption");
      app.lifecycleManager.pauseAdmissions();
      writeFileSync(join(dataDir, "admission-pause.json"), '{"paused":false}\n');
      const path = join(dataDir, filename);
      const damaged = '{"callId":\n';
      writeFileSync(path, damaged);
      const response = await cleanup();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_server_error" });
      expect(await listing()).toEqual([record]);
      expect(app.lifecycleManager.admissionsStatus()).toEqual({ paused: true, reason: "operator_paused" });
      expect(readFileSync(path, "utf8")).toBe(damaged);
    },
  );

  it("refreshes only operator pause after successful cleanup, treating missing or damaged pause state as false", async () => {
    const dataDir = temporaryDirectory();
    const { app, cleanup } = await startServer(dataDir);
    const path = join(dataDir, "admission-pause.json");
    for (const [state, paused] of [[true, true], [false, false], ["true", false]] as const) {
      writeFileSync(path, JSON.stringify({ paused: state }));
      expect((await cleanup()).status).toBe(200);
      expect(app.lifecycleManager.admissionsStatus().paused).toBe(paused);
    }
    for (const state of ["missing", "malformed", "unreadable"] as const) {
      app.lifecycleManager.pauseAdmissions();
      rmSync(path);
      if (state === "malformed") writeFileSync(path, "{");
      if (state === "unreadable") mkdirSync(path);
      expect((await cleanup()).status).toBe(200);
      expect(app.lifecycleManager.admissionsStatus()).toEqual({ paused: false });
      rmSync(path, { recursive: true, force: true });
    }
  });
});
