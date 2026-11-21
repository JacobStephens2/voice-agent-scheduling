import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR_TOKEN_BODY_CEILING_BYTES } from "../src/calendar/oauth-routes.js";
import {
  createSchedulingServer,
  SIP_WEBHOOK_BODY_CEILING_BYTES,
  type SchedulingServer,
} from "../src/server.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import {
  WEBHOOK_SECRET,
  incomingCallPayload,
  recordedEvidence,
  seedPendingAppointmentRecovery,
  signedHeaders,
} from "./helpers.js";

function requestWithHost(
  port: number,
  host: string,
  path: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { host, connection: "close" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(2000, () => {
      request.destroy(new Error("timed out waiting for the scheduling server"));
    });
    request.on("error", reject);
    request.end();
  });
}

const PORT = 3598;
const EVIDENCE_TOKEN = "test-evidence-token";

function postSignedWebhook(baseUrl: string, callId: string, webhookId: string): Promise<Response> {
  const payload = incomingCallPayload({ callId });
  const signed = signedHeaders(payload, { webhookId });
  return fetch(`${baseUrl}/xai/sip-webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": signed.id,
      "webhook-timestamp": signed.timestamp,
      "webhook-signature": signed.signature,
    },
    body: payload,
  });
}

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

  it("rejects an evidence token whose UTF-8 byte length differs from the configured token", async () => {
    // "é" is one UTF-16 code unit and two UTF-8 bytes, so this bearer value
    // matches the configured token's string length and not its byte length.
    const presented = `é${"x".repeat(EVIDENCE_TOKEN.length - 1)}`;
    const response = await fetch(`http://127.0.0.1:${PORT}/evidence`, {
      headers: { authorization: `Bearer ${presented}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
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

  it("rejects an oversized POST /xai/sip-webhook with 413 before the webhook is handled", async () => {
    expect(SIP_WEBHOOK_BODY_CEILING_BYTES).toBe(64 * 1024);
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const succeed = (value: { statusCode: number; body: string }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const request = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/xai/sip-webhook",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": "msg_oversize_1",
            "webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
            "webhook-signature": "v1,not-a-valid-mac",
            connection: "close",
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            succeed({
              statusCode: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.setTimeout(2000, () => {
        request.destroy();
        fail(new Error("timed out waiting for 413 before the webhook body finished"));
      });
      request.on("error", (error) => {
        fail(error);
      });
      // One byte past the ceiling, then pause. The remainder is never written,
      // so a handler that waits for the full body cannot answer this request.
      request.write(Buffer.alloc(SIP_WEBHOOK_BODY_CEILING_BYTES + 1, 0x78));
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "payload_too_large" });
  });

  it("disables operator setup pages without an operator token", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/calendar/auth/start`);
    expect(response.status).toBe(404);
  });

  it("responds 400 when the request URL cannot be built", async () => {
    const rejected = await requestWithHost(PORT, "::1", "/health");
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body)).toEqual({ error: "bad_request" });

    const health = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(health.status).toBe(200);
  });

  it("admits a signed POST /xai/sip-webhook", async () => {
    const response = await postSignedWebhook(`http://127.0.0.1:${PORT}`, "call-server-1", "evt_server_1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "admitted",
      call_id: "call-server-1",
    });
  });
});

it("returns a bounded webhook error and admits a later call after readiness recovers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "scheduling-http-readiness-"));
  const sockets: FakeRealtimeSocket[] = [];
  const hangups: string[] = [];
  let attempts = 0;
  let app: SchedulingServer | undefined;
  try {
    app = createSchedulingServer({
      port: 0,
      webhookSecret: WEBHOOK_SECRET,
      apiKey: "test-key",
      evidenceToken: EVIDENCE_TOKEN,
      dataDir,
      booking: seedPendingAppointmentRecovery(dataDir, () => {
        attempts += 1;
        if (attempts === 2) throw new Error("internal Calendar reconciliation failure");
        return attempts === 1 ? "unresolved" : "booked";
      }),
      connectWebSocket: (url, headers) => {
        const socket = new FakeRealtimeSocket(url, headers);
        sockets.push(socket);
        return socket;
      },
      hangupCall: async (callId) => { hangups.push(callId); },
    });
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const failed = await postSignedWebhook(baseUrl, "call-http-readiness-failure", "evt-http-failed");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "internal_server_error" });
    expect(hangups).toEqual(["call-http-readiness-failure"]);
    expect(sockets).toHaveLength(0);
    expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({ activeCalls: 0 });

    const callId = "call-http-readiness-recovered";
    const later = await postSignedWebhook(baseUrl, callId, "evt-http-recovered");
    expect(later.status).toBe(200);
    expect(await later.json()).toEqual({ status: "admitted", call_id: callId });
    expect(sockets).toHaveLength(1);
    sockets[0]!.close();
    await recordedEvidence(app.lifecycleManager.listEvidence, callId);
    expect(app.lifecycleManager.listEvidence().map((row) => row.callId)).toEqual([callId]);
  } finally {
    for (const socket of sockets) socket.close();
    if (app?.server.listening) await app.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
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

  it("gates the consent page behind the operator token form and a session cookie", async () => {
    const anonymous = await fetch(`http://127.0.0.1:${OPERATOR_PORT}/calendar/auth/start`, {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(200);
    const anonBody = await anonymous.text();
    expect(anonBody).toContain('<form method="post" action="/calendar/auth/start">');
    expect(anonymous.headers.get("set-cookie")).toBeNull();

    const query = await fetch(
      `http://127.0.0.1:${OPERATOR_PORT}/calendar/auth/start?token=test-operator-token`,
      { redirect: "manual" },
    );
    expect(query.status).toBe(401);
    expect(query.headers.get("set-cookie")).toBeNull();

    const signed = await fetch(`http://127.0.0.1:${OPERATOR_PORT}/calendar/auth/start`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=test-operator-token",
    });
    expect(signed.status).toBe(303);
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

  it("rejects an oversized operator token form before accepting it", async () => {
    expect(OPERATOR_TOKEN_BODY_CEILING_BYTES).toBe(1024);
    const response = await new Promise<{ statusCode: number; body: string; setCookie?: string }>(
      (resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const succeed = (value: { statusCode: number; body: string; setCookie?: string }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const request = http.request(
          {
            host: "127.0.0.1",
            port: OPERATOR_PORT,
            path: "/calendar/auth/start",
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              connection: "close",
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            });
            incoming.on("end", () => {
              const setCookie = incoming.headers["set-cookie"];
              succeed({
                statusCode: incoming.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                setCookie: Array.isArray(setCookie) ? setCookie[0] : setCookie,
              });
            });
          },
        );
        request.setTimeout(2000, () => {
          request.destroy();
          fail(new Error("timed out waiting for 413 before the token form finished"));
        });
        request.on("error", (error) => {
          fail(error);
        });
        request.write(Buffer.alloc(OPERATOR_TOKEN_BODY_CEILING_BYTES + 1, 0x78));
      },
    );

    expect(response.statusCode).toBe(413);
    expect(response.setCookie).toBeUndefined();
    expect(response.body).not.toContain("test-operator-token");
  });
});
