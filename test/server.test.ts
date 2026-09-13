import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSchedulingServer } from "../src/server.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  incomingCallPayload,
  signedHeaders,
} from "./helpers.js";

const PORT = 3598;
const EVIDENCE_TOKEN = "test-evidence-token";

describe("scheduling HTTP boundary", () => {
  const app = createSchedulingServer({
    port: PORT,
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-key",
    maxConcurrentCalls: 1,
    evidenceToken: EVIDENCE_TOKEN,
    connectWebSocket: (url, headers) => new FakeRealtimeSocket(url, headers),
    hangupCall: async () => undefined,
  });

  beforeAll(async () => {
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("serves GET /health", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; activeCalls: number };
    expect(body.status).toBe("healthy");
    expect(body.activeCalls).toBe(0);
  });

  it("rejects GET /evidence without the evidence token", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/evidence`);
    expect(response.status).toBe(401);
  });

  it("serves GET /evidence with the evidence token", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/evidence`, {
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("rejects an unsigned POST /xai/sip-webhook", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/xai/sip-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("admits a signed POST /xai/sip-webhook", async () => {
    const payload = incomingCallPayload({ callId: "call-server-1" });
    const signed = signedHeaders(payload, { webhookId: "evt_server_1" });
    const response = await fetch(`http://127.0.0.1:${PORT}/xai/sip-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": signed.id,
        "webhook-timestamp": signed.timestamp,
        "webhook-signature": signed.signature,
      },
      body: payload,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "admitted",
      call_id: "call-server-1",
    });
  });
});
