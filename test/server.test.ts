import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSchedulingServer, type SchedulingServer } from "../src/server.js";
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

  it("disables operator setup pages without an operator token", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/calendar/auth/start`);
    expect(response.status).toBe(404);
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

describe("operator setup pages", () => {
  const OPERATOR_PORT = 3599;
  let app: SchedulingServer | undefined;

  beforeAll(async () => {
    app = createSchedulingServer({
      port: OPERATOR_PORT,
      webhookSecret: WEBHOOK_SECRET,
      apiKey: "test-key",
      maxConcurrentCalls: 1,
      evidenceToken: EVIDENCE_TOKEN,
      operatorToken: "test-operator-token",
      publicBaseUrl: `http://127.0.0.1:${OPERATOR_PORT}`,
      connectWebSocket: (url, headers) => new FakeRealtimeSocket(url, headers),
      hangupCall: async () => undefined,
    });
    await app.start();
  });

  afterAll(async () => {
    await app?.stop();
  });

  it("gates the consent page behind the operator token and a session cookie", async () => {
    const anonymous = await fetch(`http://127.0.0.1:${OPERATOR_PORT}/calendar/auth/start`, {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(401);

    const signed = await fetch(
      `http://127.0.0.1:${OPERATOR_PORT}/calendar/auth/start?token=test-operator-token`,
      { redirect: "manual" },
    );
    expect(signed.status).toBe(302);
    expect(signed.headers.get("location")).toBe("/calendar/auth/start");
    const setCookie = signed.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie!.split(";")[0]!;

    const page = await fetch(`http://127.0.0.1:${OPERATOR_PORT}/calendar/auth/start`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const body = await page.text();
    expect(body).toContain("/calendar/auth/google");
    expect(body).not.toContain("test-operator-token");
  });
});
