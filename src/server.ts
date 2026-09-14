import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createCallLifecycleManager, type CallLifecycleManager } from "./lifecycle.js";
import {
  loadClientConfig,
  loadCredentials,
  saveClientConfig,
  saveRefreshToken,
} from "./calendar/auth.js";
import { createCalendarAvailabilityTool } from "./calendar/availability-tool.js";
import { createOAuthRouter } from "./calendar/oauth-routes.js";
import { loadSelection } from "./calendar/selection.js";
import type { AvailabilityTool, ConnectWebSocket } from "./session.js";

export interface ServerConfig {
  readonly port: number;
  readonly webhookSecret: string;
  readonly apiKey: string;
  readonly evidenceToken: string;
  readonly maxConcurrentCalls?: number;
  readonly allowedCallerNumbers?: readonly string[];
  readonly maxCallDurationMs?: number;
  readonly dataDir?: string;
  readonly availabilityTool?: AvailabilityTool;
  readonly operatorToken?: string;
  readonly publicBaseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly connectWebSocket?: ConnectWebSocket;
  readonly hangupCall?: (callId: string) => Promise<void>;
}

export interface SchedulingServer {
  readonly server: http.Server;
  readonly lifecycleManager: CallLifecycleManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function evidenceAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = headerValue(req.headers.authorization);
  const presented = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : undefined;
  if (!presented || presented.length !== token.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createSchedulingServer(config: ServerConfig): SchedulingServer {
  const fetchFn = config.fetchFn ?? fetch;
  const lifecycleManager = createCallLifecycleManager({
    webhookSecret: config.webhookSecret,
    apiKey: config.apiKey,
    availabilityTool:
      config.availabilityTool ??
      createCalendarAvailabilityTool({ fetchFn, dataDir: config.dataDir }),
    maxConcurrentCalls: config.maxConcurrentCalls ?? 1,
    allowedCallerNumbers: config.allowedCallerNumbers,
    maxCallDurationMs: config.maxCallDurationMs,
    dataDir: config.dataDir,
    connectWebSocket: config.connectWebSocket,
    hangupCall: config.hangupCall,
  });

  const oauthRouter = config.operatorToken
    ? createOAuthRouter({
        operatorToken: config.operatorToken,
        baseUrl: config.publicBaseUrl ?? "https://scheduler.stephens.page",
        client: loadClientConfig({ dataDir: config.dataDir }),
        fetchFn,
        onTokensSaved: config.dataDir
          ? (client, refreshToken) => {
              saveClientConfig(config.dataDir!, client);
              saveRefreshToken(config.dataDir!, refreshToken);
            }
          : undefined,
        loadStatus: () => ({
          authorized: loadCredentials({ dataDir: config.dataDir }) !== undefined,
          selection: loadSelection({ dataDir: config.dataDir }),
        }),
      })
    : undefined;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/calendar/auth/")) {
      if (!oauthRouter) {
        json(res, 404, { error: "operator_setup_disabled" });
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value;
      }
      void oauthRouter
        .handle(req.method ?? "GET", url, headers)
        .then((page) => {
          res.writeHead(page.statusCode, { "content-type": "text/html; charset=utf-8", ...page.headers });
          res.end(page.body);
        })
        .catch(() => {
          json(res, 500, { error: "internal_server_error" });
        });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        status: "healthy",
        activeCalls: lifecycleManager.activeCallCount(),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/evidence") {
      if (!evidenceAuthorized(req, config.evidenceToken)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      json(res, 200, lifecycleManager.listEvidence());
      return;
    }

    if (req.method === "POST" && url.pathname === "/xai/sip-webhook") {
      void readBody(req)
        .then(async (rawBody) => {
          const result = await lifecycleManager.handleWebhook({
            id: headerValue(req.headers["webhook-id"]),
            timestamp: headerValue(req.headers["webhook-timestamp"]),
            signature: headerValue(req.headers["webhook-signature"]),
            rawBody,
          });
          res.writeHead(result.statusCode, { "content-type": "application/json" });
          res.end(result.body);
        })
        .catch(() => {
          json(res, 500, { error: "internal_server_error" });
        });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  return {
    server,
    lifecycleManager,
    start: () =>
      new Promise((resolve, reject) => {
        server.listen(config.port, "127.0.0.1", () => resolve());
        server.once("error", reject);
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
