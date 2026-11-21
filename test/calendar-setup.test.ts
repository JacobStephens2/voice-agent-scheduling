import { afterEach, expect, it, vi } from "vitest";

const originalArgv = process.argv.slice();
const originalOperatorEmail = process.env.OPERATOR_EMAIL;
const originalClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;

afterEach(() => {
  process.argv = originalArgv;
  if (originalOperatorEmail === undefined) {
    delete process.env.OPERATOR_EMAIL;
  } else {
    process.env.OPERATOR_EMAIL = originalOperatorEmail;
  }
  if (originalClientId === undefined) {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  } else {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = originalClientId;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

it("names the configured operator address on the desktop consent URL", async () => {
  process.env.OPERATOR_EMAIL = "other@example.com";
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "test-client";
  process.argv = ["node", "calendar-setup.ts", "auth-url"];
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  await import("../src/calendar-setup.js");
  const text = chunks.join("");
  expect(text).toContain("Open this URL as other@example.com");
  expect(text).not.toContain("jacob@stephens.page");
});
