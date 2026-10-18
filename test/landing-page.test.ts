import { afterEach, describe, expect, it } from "vitest";
import { displayPhoneNumber, renderLandingPage } from "../src/landing-page.js";
import { createSchedulingServer, type SchedulingServer } from "../src/server.js";
import { FakeRealtimeSocket } from "./fake-socket.js";
import { WEBHOOK_SECRET } from "./helpers.js";

const PORT = 3602;
const EVIDENCE_TOKEN = "test-landing-evidence-token";
const NUMBER = "+15555550142";

function startServer(options: {
  admissionMode: { kind: "public" } | { kind: "allowlist"; allowedCallerNumbers: string[] };
  publicPhoneNumber?: string;
}): SchedulingServer {
  return createSchedulingServer({
    port: PORT,
    webhookSecret: WEBHOOK_SECRET,
    apiKey: "test-key",
    evidenceToken: EVIDENCE_TOKEN,
    connectWebSocket: (url, headers) => new FakeRealtimeSocket(url, headers),
    hangupCall: async () => undefined,
    ...options,
  });
}

describe("landing page", () => {
  let app: SchedulingServer | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it("formats North American numbers for display", () => {
    expect(displayPhoneNumber("+15555550142")).toBe("(555) 555-0142");
    expect(displayPhoneNumber("+442071838750")).toBe("+442071838750");
  });

  it("shows the number as a tel: link while public callers are admitted", async () => {
    app = startServer({ admissionMode: { kind: "public" }, publicPhoneNumber: NUMBER });
    await app.start();
    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain(`href="tel:${NUMBER}"`);
    expect(body).toContain("(555) 555-0142");
  });

  it("hides the number while admission is still allowlisted", async () => {
    app = startServer({
      admissionMode: { kind: "allowlist", allowedCallerNumbers: ["+15555550100"] },
      publicPhoneNumber: NUMBER,
    });
    await app.start();
    const body = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    expect(body).not.toContain("555-0142");
    expect(body).toContain("not taking calls right now");
  });

  it("hides the number while the operator has paused admissions", async () => {
    app = startServer({ admissionMode: { kind: "public" }, publicPhoneNumber: NUMBER });
    await app.start();
    await fetch(`http://127.0.0.1:${PORT}/maintenance/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
    });
    const body = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    expect(body).not.toContain("555-0142");
    expect(body).toContain("not taking calls right now");
  });

  it("never renders a malformed configured number", () => {
    const body = renderLandingPage({ phoneNumber: '"><script>x</script>', acceptingCalls: true });
    expect(body).not.toContain("<script>");
    expect(body).toContain("not taking calls right now");
  });
});
