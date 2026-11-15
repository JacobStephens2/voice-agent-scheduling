import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "../ops/deploy-release.sh");
const repo = resolve(dirname(script), "..");
// .invalid never resolves, so a missing stub cannot reach a real host.
const host = "deploy@scheduler.invalid";
const releaseId = "20261115T000000Z";

interface ToolCall {
  tool: "npm" | "ssh" | "scp" | "rsync";
  args: string[];
  stdin: string;
}

// Runs the deploy with stub npm, ssh, scp and rsync first on PATH and returns
// each call in order. Repository paths read as <repo>, so a checkout under /tmp
// does not look like an upload from /tmp.
function runDeploy(): ToolCall[] {
  const root = mkdtempSync(join(tmpdir(), "scheduling-deploy-"));
  try {
    const bin = join(root, "bin");
    const log = join(root, "calls.jsonl");
    const recorder = join(root, "record-call.cjs");
    mkdirSync(bin);
    writeFileSync(
      recorder,
      [
        'const { appendFileSync, readFileSync } = require("node:fs");',
        "const [tool, ...args] = process.argv.slice(2);",
        'const stdin = tool === "ssh" ? readFileSync(0, "utf8") : "";',
        'appendFileSync(process.env.DEPLOY_CALLS, JSON.stringify({ tool, args, stdin }) + "\\n");',
      ].join("\n"),
    );
    for (const tool of ["npm", "ssh", "scp", "rsync"]) {
      const stub = join(bin, tool);
      writeFileSync(stub, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} ${tool} "$@"\n`);
      chmodSync(stub, 0o755);
    }

    execFileSync("bash", [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SCHEDULER_HOST: host,
        RELEASE_ID: releaseId,
        DEPLOY_CALLS: log,
      },
      input: "",
      stdio: "pipe",
    });

    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const call = JSON.parse(line) as ToolCall;
        return { ...call, args: call.args.map((arg) => arg.replaceAll(repo, "<repo>")) };
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release deploy", () => {
  it("keeps /tmp out of every upload and remote command", () => {
    const calls = runDeploy();

    const uploads = calls.filter((call) => call.tool === "scp" || call.tool === "rsync").map((call) => call.args.join(" "));
    const remoteCommands = calls
      .filter((call) => call.tool === "ssh")
      .map((call) => [...call.args.slice(1), call.stdin].join("\n"));

    expect(uploads).not.toEqual([]);
    expect(remoteCommands).not.toEqual([]);
    expect([...uploads, ...remoteCommands].filter((text) => text.includes("/tmp"))).toEqual([]);
  });

  it("installs the systemd unit from the release before scheduling-agent owns the release", () => {
    const release = `/opt/scheduling-agent/releases/${releaseId}`;
    const calls = runDeploy();

    const unitUpload = calls.find(
      (call) => call.tool === "scp" && call.args.includes("<repo>/ops/systemd/scheduling-agent.service"),
    );
    expect(unitUpload?.args.at(-1)).toBe(`${host}:${release}/`);

    const remoteSteps = calls
      .filter((call) => call.tool === "ssh")
      .flatMap((call) => call.stdin.split("\n").map((line) => line.trim()));
    const install = `sudo install -o root -g root -m 0644 '${release}/scheduling-agent.service' /etc/systemd/system/scheduling-agent.service`;
    expect(remoteSteps).toContain(install);
    const handOver = remoteSteps.findIndex((step) => step.startsWith("sudo chown -R scheduling-agent:scheduling-agent "));
    expect(handOver, "remote step hands the release to scheduling-agent").not.toBe(-1);
    expect(remoteSteps.indexOf(install)).toBeLessThan(handOver);
  });
});
