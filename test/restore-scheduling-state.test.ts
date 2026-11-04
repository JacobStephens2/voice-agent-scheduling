import { execFileSync } from "node:child_process";
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
});
