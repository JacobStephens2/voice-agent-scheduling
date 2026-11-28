import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const VITE_NODE = new URL("../node_modules/.bin/vite-node", import.meta.url).pathname;

function baseEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XAI_WEBHOOK_SECRET: "test-webhook-secret",
    XAI_API_KEY: "test-api-key",
    EVIDENCE_TOKEN: "test-evidence-token",
    ALLOWED_CALLER_NUMBERS: "+15555550100",
    SCHEDULING_PORT: "0",
    ...overrides,
  };
}

function runStartup(overrides: Record<string, string | undefined>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(VITE_NODE, ["src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: baseEnv(overrides),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`startup did not exit\nstdout:${stdout}\nstderr:${stderr}`));
    }, 8_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("listening")) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("Scheduling agent startup duration configuration", () => {
  it("rejects startup when CALL_DURATION_WARNING_MS is not shorter than MAX_CALL_DURATION_MS", async () => {
    const result = await runStartup({
      CALL_DURATION_WARNING_MS: "60000",
      MAX_CALL_DURATION_MS: "60000",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "CALL_DURATION_WARNING_MS must be shorter than MAX_CALL_DURATION_MS",
    );
    expect(result.stdout).not.toContain("listening");
  });

  it("rejects startup when the warning lead is longer than the call limit", async () => {
    const result = await runStartup({
      CALL_DURATION_WARNING_MS: "120000",
      MAX_CALL_DURATION_MS: "60000",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "CALL_DURATION_WARNING_MS must be shorter than MAX_CALL_DURATION_MS",
    );
    expect(result.stdout).not.toContain("listening");
  });

  it("rejects startup when the default warning is not shorter than a configured call limit", async () => {
    const result = await runStartup({
      MAX_CALL_DURATION_MS: "30000",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "CALL_DURATION_WARNING_MS must be shorter than MAX_CALL_DURATION_MS",
    );
    expect(result.stdout).not.toContain("listening");
  });

  it("starts when the warning lead is shorter than the call limit", async () => {
    const result = await runStartup({
      CALL_DURATION_WARNING_MS: "1000",
      MAX_CALL_DURATION_MS: "60000",
    });
    expect(result.stdout).toContain("listening");
    expect(result.stderr).not.toContain(
      "CALL_DURATION_WARNING_MS must be shorter than MAX_CALL_DURATION_MS",
    );
  });
});
