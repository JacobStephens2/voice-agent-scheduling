import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "../ops/restore-scheduling-state.sh");

function restoreDurableTree(source: string, dest: string): void {
  execFileSync(
    "bash",
    ["-c", 'set -euo pipefail; source "$1"; restore_durable_tree "$2" "$3"', "bash", script, source, dest],
    { stdio: "pipe" },
  );
}

describe("restore durable state", () => {
  it("does not write the backup through an existing destination symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-symlink-"));
    try {
      const source = join(root, "var-lib-scheduling-agent");
      const dest = join(root, "state");
      const outside = join(root, "outside");
      mkdirSync(source);
      mkdirSync(dest);
      mkdirSync(outside);
      writeFileSync(join(source, "budget-ledger.json"), "from-backup\n");
      const sentinel = join(outside, "secret");
      writeFileSync(sentinel, "do-not-follow\n");
      symlinkSync(sentinel, join(dest, "budget-ledger.json"));

      restoreDurableTree(source, dest);

      expect(readFileSync(sentinel, "utf8")).toBe("do-not-follow\n");
      expect(lstatSync(join(dest, "budget-ledger.json")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(dest, "budget-ledger.json"), "utf8")).toBe("from-backup\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write the backup through a destination directory symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-dir-symlink-"));
    try {
      const source = join(root, "var-lib-scheduling-agent");
      const dest = join(root, "state");
      const outside = join(root, "outside");
      mkdirSync(join(source, "nested"), { recursive: true });
      mkdirSync(dest);
      mkdirSync(outside);
      writeFileSync(join(source, "nested", "budget-ledger.json"), "from-backup\n");
      writeFileSync(join(outside, "budget-ledger.json"), "do-not-follow\n");
      symlinkSync(outside, join(dest, "nested"));

      restoreDurableTree(source, dest);

      expect(readFileSync(join(outside, "budget-ledger.json"), "utf8")).toBe("do-not-follow\n");
      expect(lstatSync(join(dest, "nested")).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(dest, "nested")).isDirectory()).toBe(true);
      expect(readFileSync(join(dest, "nested", "budget-ledger.json"), "utf8")).toBe("from-backup\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to restore when the durable-state directory itself is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-root-symlink-"));
    try {
      const source = join(root, "var-lib-scheduling-agent");
      const outside = join(root, "outside");
      const dest = join(root, "state");
      mkdirSync(source);
      mkdirSync(outside);
      writeFileSync(join(source, "budget-ledger.json"), "from-backup\n");
      writeFileSync(join(outside, "secret"), "do-not-follow\n");
      symlinkSync(outside, dest);

      expect(() => restoreDurableTree(source, dest)).toThrow();

      expect(readFileSync(join(outside, "secret"), "utf8")).toBe("do-not-follow\n");
      expect(existsSync(join(outside, "budget-ledger.json"))).toBe(false);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces a regular durable file and leaves other files in place", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-regular-"));
    try {
      const source = join(root, "var-lib-scheduling-agent");
      const dest = join(root, "state");
      mkdirSync(source);
      mkdirSync(dest);
      writeFileSync(join(source, "budget-ledger.json"), "from-backup\n");
      chmodSync(join(source, "budget-ledger.json"), 0o600);
      writeFileSync(join(dest, "budget-ledger.json"), "old-ledger\n");
      writeFileSync(join(dest, "extra.json"), "keep-me\n");

      restoreDurableTree(source, dest);

      expect(readFileSync(join(dest, "budget-ledger.json"), "utf8")).toBe("from-backup\n");
      expect(lstatSync(join(dest, "budget-ledger.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dest, "extra.json"), "utf8")).toBe("keep-me\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a destination symlink the backup does not restore", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-extra-link-"));
    try {
      const source = join(root, "src");
      const dest = join(root, "state");
      const outside = join(root, "outside");
      mkdirSync(source);
      mkdirSync(dest);
      mkdirSync(outside);
      writeFileSync(join(source, "f"), "from-backup\n");
      const sentinel = join(outside, "secret");
      writeFileSync(sentinel, "sentinel\n");
      symlinkSync(sentinel, join(dest, "extra-link"));
      writeFileSync(join(dest, "extra.json"), "keep\n");

      restoreDurableTree(source, dest);

      expect(lstatSync(join(dest, "extra-link")).isSymbolicLink()).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel\n");
      expect(readFileSync(join(dest, "extra.json"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(dest, "f"), "utf8")).toBe("from-backup\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked durable-state directory before stopping the service or copying credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-partial-"));
    try {
      const bin = join(root, "bin");
      const backup = join(root, "backup");
      const etc = join(root, "etc", "scheduling-agent");
      const stateParent = join(root, "var", "lib");
      const outside = join(root, "outside");
      const state = join(stateParent, "scheduling-agent");
      const log = join(root, "actions.log");
      mkdirSync(bin);
      mkdirSync(join(backup, "etc-scheduling-agent"), { recursive: true });
      mkdirSync(join(backup, "var-lib-scheduling-agent"), { recursive: true });
      mkdirSync(etc, { recursive: true });
      mkdirSync(stateParent, { recursive: true });
      mkdirSync(outside);
      const systemctl = join(bin, "systemctl");
      writeFileSync(systemctl, `#!/bin/sh\necho "SYSTEMCTL $*" >> ${JSON.stringify(log)}\nexit 0\n`);
      chmodSync(systemctl, 0o755);
      writeFileSync(join(backup, "etc-scheduling-agent", "scheduling-agent.env"), "NEW_ENV=1\n");
      writeFileSync(join(backup, "var-lib-scheduling-agent", "budget-ledger.json"), "from-backup\n");
      writeFileSync(join(etc, "scheduling-agent.env"), "OLD_ENV=1\n");
      writeFileSync(join(outside, "secret"), "do-not-follow\n");
      symlinkSync(outside, state);

      const rewritten = join(root, "restore.sh");
      const sourceScript = readFileSync(script, "utf8")
        .replaceAll("/etc/scheduling-agent", etc)
        .replaceAll("/var/lib/scheduling-agent", state)
        .replaceAll(/^sudo /gm, "")
        .replaceAll(" sudo ", " ");
      writeFileSync(rewritten, sourceScript, { mode: 0o755 });

      let restoreExit = 0;
      try {
        execFileSync("bash", [rewritten, backup], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_LOG: log },
          stdio: "pipe",
        });
      } catch (error) {
        restoreExit = 1;
        if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
          restoreExit = error.status;
        }
      }

      const actions = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(restoreExit).not.toBe(0);
      expect(actions).not.toContain("SYSTEMCTL stop scheduling-agent");
      expect(actions).not.toContain("SYSTEMCTL start scheduling-agent");
      expect(readFileSync(join(etc, "scheduling-agent.env"), "utf8")).toBe("OLD_ENV=1\n");
      expect(lstatSync(state).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, "secret"), "utf8")).toBe("do-not-follow\n");
      expect(existsSync(join(outside, "budget-ledger.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write through a final name that is a symlink when the open runs", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-open-symlink-"));
    const source = join(root, "src");
    const dest = join(root, "state");
    const outside = join(root, "outside");
    mkdirSync(source);
    mkdirSync(dest);
    mkdirSync(outside);
    writeFileSync(join(source, "budget-ledger.json"), "from-backup\n");
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(source, `z-${index}`), "x\n");
    }
    const sentinel = join(outside, "secret");
    writeFileSync(sentinel, "do-not-follow\n");
    const link = join(dest, "budget-ledger.json");
    symlinkSync(sentinel, link);
    const replacer = spawn(
      "bash",
      ["-c", 'while true; do ln -sfn "$1" "$2" 2>/dev/null || true; done', "bash", sentinel, link],
      { stdio: "ignore", detached: true },
    );
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      try {
        restoreDurableTree(source, dest);
      } catch {
        // A failed open is the safe result. Following the symlink is not.
      }
      expect(readFileSync(sentinel, "utf8")).toBe("do-not-follow\n");
    } finally {
      if (replacer.pid !== undefined) {
        try {
          process.kill(-replacer.pid, "SIGKILL");
        } catch {
          replacer.kill("SIGKILL");
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
