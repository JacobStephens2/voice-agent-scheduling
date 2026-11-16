import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

const opsDir = join(dirname(fileURLToPath(import.meta.url)), "../ops");
const script = join(opsDir, "restore-scheduling-state.sh");
const backupScript = join(opsDir, "backup-scheduling-state.sh");
const restorePy = join(opsDir, "restore_durable_tree.py");
const backupPy = join(opsDir, "backup_durable_files.py");

const KNOWN_DURABLE_FILES = [
  "bookings.jsonl",
  "callback-salt",
  "budget-ledger.json",
  "operational-records.jsonl",
  "smoke-evidence.jsonl",
  "active-call.json",
  "admission-pause.json",
  "scheduling-calendars.json",
  "google-client.json",
  "google-refresh",
] as const;

function currentUid(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("POSIX getuid is required for restore/backup tests");
  }
  return String(uid);
}

interface HelperOptions {
  expectedUid?: string;
  env?: NodeJS.ProcessEnv;
}

function runDurableHelper(
  scriptPath: string,
  fnName: "restore_durable_tree" | "backup_durable_files",
  source: string,
  dest: string,
  options: HelperOptions = {},
): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };
  if (options.expectedUid !== undefined) {
    env.SCHEDULING_AGENT_UID = options.expectedUid;
  } else if (!("SCHEDULING_AGENT_UID" in (options.env ?? {}))) {
    env.SCHEDULING_AGENT_UID = currentUid();
  }
  execFileSync(
    "bash",
    ["-c", `set -euo pipefail; source "$1"; ${fnName} "$2" "$3"`, "bash", scriptPath, source, dest],
    { env, stdio: "pipe" },
  );
}

function restoreDurableTree(source: string, dest: string, options: HelperOptions = {}): void {
  runDurableHelper(script, "restore_durable_tree", source, dest, options);
}

function backupDurableFiles(source: string, dest: string, options: HelperOptions = {}): void {
  runDurableHelper(backupScript, "backup_durable_files", source, dest, options);
}

function expectDefaultUidResolution(
  scriptPath: string,
  fnName: "restore_durable_tree" | "backup_durable_files",
): void {
  const root = mkdtempSync(join(tmpdir(), `scheduling-${fnName}-uid-`));
  try {
    const bin = join(root, "bin");
    const source = join(root, "src");
    const dest = join(root, "dest");
    mkdirSync(bin);
    mkdirSync(source);
    if (fnName === "restore_durable_tree") {
      mkdirSync(dest);
    }
    writeFileSync(join(source, "budget-ledger.json"), "from-backup\n");

    const fakeId = join(bin, "id");
    writeFileSync(
      fakeId,
      `#!/bin/sh\nif [ "$1" = "-u" ] && [ "$2" = "scheduling-agent" ]; then echo ${currentUid()}; exit 0; fi\nexit 1\n`,
    );
    chmodSync(fakeId, 0o755);

    const envWithoutOverride = { ...process.env };
    delete envWithoutOverride.SCHEDULING_AGENT_UID;
    const basePath = process.env.PATH ?? "";
    const envWithFakeId: NodeJS.ProcessEnv = { ...envWithoutOverride, PATH: `${bin}:${basePath}` };

    execFileSync(
      "bash",
      ["-c", `set -euo pipefail; source "$1"; ${fnName} "$2" "$3"`, "bash", scriptPath, source, dest],
      { env: envWithFakeId, stdio: "pipe" },
    );
    expect(readFileSync(join(dest, "budget-ledger.json"), "utf8")).toBe("from-backup\n");

    writeFileSync(fakeId, "#!/bin/sh\nexit 1\n");
    expect(() =>
      execFileSync(
        "bash",
        ["-c", `set -euo pipefail; source "$1"; ${fnName} "$2" "$3"`, "bash", scriptPath, source, join(root, "dest2")],
        { env: envWithFakeId, stdio: "pipe" },
      ),
    ).toThrow();

    expect(() =>
      runDurableHelper(scriptPath, fnName, source, dest, { expectedUid: "" }),
    ).toThrow();
    expect(() =>
      runDurableHelper(scriptPath, fnName, source, dest, { expectedUid: "not-a-uid" }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

  it("restores all known top-level durable state files and rejects nested directories or unknown filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-allowlist-"));
    try {
      const validSource = join(root, "valid-src");
      const validDest = join(root, "valid-dest");
      mkdirSync(validSource);
      mkdirSync(validDest);
      for (const name of KNOWN_DURABLE_FILES) {
        writeFileSync(join(validSource, name), `content:${name}\n`);
      }

      restoreDurableTree(validSource, validDest);

      for (const name of KNOWN_DURABLE_FILES) {
        expect(readFileSync(join(validDest, name), "utf8")).toBe(`content:${name}\n`);
      }

      const dirSource = join(root, "dir-src");
      const dirDest = join(root, "dir-dest");
      mkdirSync(join(dirSource, "nested"), { recursive: true });
      mkdirSync(dirDest);
      writeFileSync(join(dirSource, "budget-ledger.json"), "from-backup\n");
      writeFileSync(join(dirSource, "nested", "bookings.jsonl"), "nested\n");

      expect(() => restoreDurableTree(dirSource, dirDest)).toThrow();
      expect(existsSync(join(dirDest, "nested"))).toBe(false);
      expect(existsSync(join(dirDest, "budget-ledger.json"))).toBe(false);

      const unknownSource = join(root, "unknown-src");
      const unknownDest = join(root, "unknown-dest");
      mkdirSync(unknownSource);
      mkdirSync(unknownDest);
      writeFileSync(join(unknownSource, "budget-ledger.json"), "from-backup\n");
      writeFileSync(join(unknownSource, "unexpected.txt"), "evil\n");

      expect(() => restoreDurableTree(unknownSource, unknownDest)).toThrow();
      expect(existsSync(join(unknownDest, "unexpected.txt"))).toBe(false);
      expect(existsSync(join(unknownDest, "budget-ledger.json"))).toBe(false);
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
      writeFileSync(join(source, "bookings.jsonl"), "from-backup\n");
      const sentinel = join(outside, "secret");
      writeFileSync(sentinel, "sentinel\n");
      symlinkSync(sentinel, join(dest, "extra-link"));
      writeFileSync(join(dest, "extra.json"), "keep\n");

      restoreDurableTree(source, dest);

      expect(lstatSync(join(dest, "extra-link")).isSymbolicLink()).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel\n");
      expect(readFileSync(join(dest, "extra.json"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(dest, "bookings.jsonl"), "utf8")).toBe("from-backup\n");
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
      symlinkSync(restorePy, join(root, "restore_durable_tree.py"));
      symlinkSync(join(opsDir, "durable_state.py"), join(root, "durable_state.py"));

      let restoreExit = 0;
      let restoreStderr = "";
      try {
        execFileSync("bash", [rewritten, backup], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_LOG: log },
          stdio: "pipe",
        });
      } catch (error) {
        restoreExit = 1;
        if (typeof error === "object" && error !== null) {
          if ("status" in error && typeof error.status === "number") {
            restoreExit = error.status;
          }
          if ("stderr" in error && Buffer.isBuffer(error.stderr)) {
            restoreStderr = error.stderr.toString("utf8");
          }
        }
      }

      const actions = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(restoreExit).not.toBe(0);
      expect(restoreStderr).toContain("is a symlink");
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
    for (const name of KNOWN_DURABLE_FILES) {
      writeFileSync(join(source, name), `from-backup:${name}\n`);
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
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          restoreDurableTree(source, dest);
        } catch {
          // A failed open is the safe result. Following the symlink is not.
        }
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

  it("does not install a set-id executable as root", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-setid-"));
    try {
      const source = join(root, "src");
      const dest = join(root, "state");
      mkdirSync(source);
      mkdirSync(dest);
      // A real ELF. Linux does not honor set-id on scripts, and the bytes are
      // the caller's: /bin/true exits 0 if it is ever executed.
      const name = "budget-ledger.json";
      copyFileSync("/bin/true", join(source, name));
      chmodSync(join(source, name), 0o6755);

      execFileSync(
        "sudo",
        [
          "-n",
          "bash",
          "-c",
          'set -euo pipefail; source "$1"; restore_durable_tree "$2" "$3" "$4"',
          "bash",
          script,
          source,
          dest,
          currentUid(),
        ],
        { stdio: "pipe" },
      );

      const restored = lstatSync(join(dest, name));
      expect(restored.isSymbolicLink()).toBe(false);
      expect(restored.uid === 0 && (restored.mode & 0o4000) !== 0).toBe(false);
      expect(restored.gid === 0 && (restored.mode & 0o2000) !== 0).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses source symlinks, special files, symlinked source directories, and unexpected source UIDs", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-reject-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret"), "secret\n");

      // 1. Source entry is a symlink (even to an allowed target or dangling)
      const symSource = join(root, "sym-src");
      const symDest = join(root, "sym-dest");
      mkdirSync(symSource);
      mkdirSync(symDest);
      writeFileSync(join(symDest, "bookings.jsonl"), "keep-existing\n");
      writeFileSync(join(symSource, "bookings.jsonl"), "new-bookings\n");
      symlinkSync(join(outside, "secret"), join(symSource, "budget-ledger.json"));
      expect(() => restoreDurableTree(symSource, symDest)).toThrow();
      expect(readFileSync(join(symDest, "bookings.jsonl"), "utf8")).toBe("keep-existing\n");
      expect(existsSync(join(symDest, "budget-ledger.json"))).toBe(false);

      // 2. Source entry is a special file (FIFO)
      const fifoSource = join(root, "fifo-src");
      const fifoDest = join(root, "fifo-dest");
      mkdirSync(fifoSource);
      mkdirSync(fifoDest);
      execFileSync("mkfifo", [join(fifoSource, "budget-ledger.json")], { stdio: "pipe" });
      expect(() => restoreDurableTree(fifoSource, fifoDest)).toThrow();
      expect(existsSync(join(fifoDest, "budget-ledger.json"))).toBe(false);

      // 3. Source directory itself is a symlink (including trailing slash)
      const targetSource = join(root, "target-src");
      const linkSource = join(root, "link-src");
      const linkDest = join(root, "link-dest");
      mkdirSync(targetSource);
      mkdirSync(linkDest);
      writeFileSync(join(targetSource, "budget-ledger.json"), "from-backup\n");
      symlinkSync(targetSource, linkSource);
      expect(() => restoreDurableTree(`${linkSource}/`, linkDest)).toThrow();
      expect(existsSync(join(linkDest, "budget-ledger.json"))).toBe(false);

      // 4. Source entry owned by unexpected UID (direct Python CLI and root-owned file)
      const uidSource = join(root, "uid-src");
      const uidDest = join(root, "uid-dest");
      mkdirSync(uidSource);
      mkdirSync(uidDest);
      writeFileSync(join(uidSource, "bookings.jsonl"), "from-backup\n");
      const rootOwned = join(uidSource, "budget-ledger.json");
      writeFileSync(rootOwned, "root-owned\n");
      execFileSync("sudo", ["-n", "chown", "0:0", rootOwned], { stdio: "pipe" });
      expect(() =>
        execFileSync(
          "python3",
          [restorePy, "--expected-uid", currentUid(), uidSource, uidDest],
          { stdio: "pipe" },
        ),
      ).toThrow();
      expect(existsSync(join(uidDest, "bookings.jsonl"))).toBe(false);
      expect(existsSync(join(uidDest, "budget-ledger.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves scheduling-agent UID by default and fails closed when missing or invalid", () => {
    expectDefaultUidResolution(script, "restore_durable_tree");
  });

  it("refuses empty source or destination paths in restore", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-restore-empty-"));
    try {
      const validDir = join(root, "valid");
      mkdirSync(validDir);
      writeFileSync(join(validDir, "budget-ledger.json"), "ledger\n");

      expect(() =>
        execFileSync("python3", [restorePy, "--expected-uid", currentUid(), "", validDir], { stdio: "pipe" }),
      ).toThrow();
      expect(() =>
        execFileSync("python3", [restorePy, "--expected-uid", currentUid(), validDir, ""], { stdio: "pipe" }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("backup durable state", () => {
  it("copies only present known top-level durable regular files and ignores unknown entries", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-backup-allowlist-"));
    try {
      const source = join(root, "var-lib-scheduling-agent");
      const dest = join(root, "backup-state");
      mkdirSync(join(source, "subdir"), { recursive: true });
      writeFileSync(join(source, "bookings.jsonl"), "booking-row\n");
      chmodSync(join(source, "bookings.jsonl"), 0o600);
      writeFileSync(join(source, "budget-ledger.json"), "ledger\n");
      chmodSync(join(source, "budget-ledger.json"), 0o640);
      writeFileSync(join(source, "google-refresh"), "refresh\n");
      chmodSync(join(source, "google-refresh"), 0o600);
      writeFileSync(join(source, "unexpected.txt"), "ignore-me\n");
      writeFileSync(join(source, "subdir", "nested.json"), "ignore-nested\n");
      symlinkSync("/nonexistent-target", join(source, "extra-link"));

      backupDurableFiles(source, dest);

      expect(readFileSync(join(dest, "bookings.jsonl"), "utf8")).toBe("booking-row\n");
      expect(lstatSync(join(dest, "bookings.jsonl")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dest, "budget-ledger.json"), "utf8")).toBe("ledger\n");
      expect(lstatSync(join(dest, "budget-ledger.json")).mode & 0o777).toBe(0o640);
      expect(readFileSync(join(dest, "google-refresh"), "utf8")).toBe("refresh\n");
      expect(existsSync(join(dest, "unexpected.txt"))).toBe(false);
      expect(existsSync(join(dest, "subdir"))).toBe(false);
      expect(existsSync(join(dest, "extra-link"))).toBe(false);
      expect(existsSync(join(dest, "callback-salt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses backup when source dir is a symlink or a known entry is not a regular owned file", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-backup-reject-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret"), "secret\n");

      // 1. Source dir is a symlink (including trailing slash)
      const targetDir = join(root, "target-dir");
      const linkDir = join(root, "link-dir");
      mkdirSync(targetDir);
      writeFileSync(join(targetDir, "budget-ledger.json"), "ledger\n");
      symlinkSync(targetDir, linkDir);
      expect(() => backupDurableFiles(`${linkDir}/`, join(root, "out-link-dir"))).toThrow();
      expect(existsSync(join(root, "out-link-dir"))).toBe(false);

      // 2. Known entry is a symlink (including dangling symlink)
      const symEntrySrc = join(root, "sym-entry-src");
      mkdirSync(symEntrySrc);
      writeFileSync(join(symEntrySrc, "bookings.jsonl"), "ok\n");
      symlinkSync(join(outside, "secret"), join(symEntrySrc, "budget-ledger.json"));
      expect(() => backupDurableFiles(symEntrySrc, join(root, "out-sym-entry"))).toThrow();
      expect(existsSync(join(root, "out-sym-entry"))).toBe(false);

      // 3. Known entry is a directory
      const dirEntrySrc = join(root, "dir-entry-src");
      mkdirSync(join(dirEntrySrc, "bookings.jsonl"), { recursive: true });
      expect(() => backupDurableFiles(dirEntrySrc, join(root, "out-dir-entry"))).toThrow();
      expect(existsSync(join(root, "out-dir-entry"))).toBe(false);

      // 4. Known entry is a special file (FIFO)
      const fifoEntrySrc = join(root, "fifo-entry-src");
      mkdirSync(fifoEntrySrc);
      execFileSync("mkfifo", [join(fifoEntrySrc, "callback-salt")], { stdio: "pipe" });
      expect(() => backupDurableFiles(fifoEntrySrc, join(root, "out-fifo-entry"))).toThrow();
      expect(existsSync(join(root, "out-fifo-entry"))).toBe(false);

      // 5. Known entry owned by unexpected UID
      const uidEntrySrc = join(root, "uid-entry-src");
      mkdirSync(uidEntrySrc);
      writeFileSync(join(uidEntrySrc, "bookings.jsonl"), "ok\n");
      const rootOwned = join(uidEntrySrc, "google-refresh");
      writeFileSync(rootOwned, "root-owned\n");
      execFileSync("sudo", ["-n", "chown", "0:0", rootOwned], { stdio: "pipe" });
      expect(() => backupDurableFiles(uidEntrySrc, join(root, "out-uid-entry"))).toThrow();
      expect(existsSync(join(root, "out-uid-entry"))).toBe(false);

      // 6. Empty source or destination path
      expect(() =>
        execFileSync("python3", [backupPy, "--expected-uid", currentUid(), "", join(root, "out-empty-src")], {
          stdio: "pipe",
        }),
      ).toThrow();
      expect(existsSync(join(root, "out-empty-src"))).toBe(false);
      expect(() =>
        execFileSync("python3", [backupPy, "--expected-uid", currentUid(), targetDir, ""], { stdio: "pipe" }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves scheduling-agent UID by default in backup and fails closed when missing", () => {
    expectDefaultUidResolution(backupScript, "backup_durable_files");
  });

  it("creates the backup destination directory with mode 0700 before writing files", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-backup-mode-"));
    try {
      const bin = join(root, "bin");
      const etc = join(root, "etc");
      const state = join(root, "state");
      const dest = join(root, "backups", "20261116T120000Z");
      const observedModeLog = join(root, "mode.log");
      mkdirSync(bin);
      mkdirSync(etc);
      mkdirSync(state);
      writeFileSync(join(etc, "scheduling-agent.env"), "SECRET=1\n", { mode: 0o600 });
      writeFileSync(join(state, "budget-ledger.json"), "ledger\n", { mode: 0o600 });

      const cpProbe = join(bin, "cp");
      writeFileSync(
        cpProbe,
        [
          "#!/bin/sh",
          `stat -c '%a' ${JSON.stringify(dest)} > ${JSON.stringify(observedModeLog)}`,
          "exec /bin/cp \"$@\"",
        ].join("\n") + "\n",
      );
      chmodSync(cpProbe, 0o755);

      execFileSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; umask 0000; source "$1"; backup_to_dest "$2" "$3" "$4" "$5"',
          "bash",
          backupScript,
          dest,
          etc,
          state,
          currentUid(),
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdio: "pipe" },
      );

      expect(readFileSync(observedModeLog, "utf8").trim()).toBe("700");
      expect(lstatSync(dest).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(dest, "etc-scheduling-agent", "scheduling-agent.env"), "utf8")).toBe("SECRET=1\n");
      expect(readFileSync(join(dest, "var-lib-scheduling-agent", "budget-ledger.json"), "utf8")).toBe("ledger\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes incomplete backup directories on failure", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-backup-cleanup-"));
    try {
      const etc = join(root, "etc");
      const state = join(root, "state");
      const destRoot = join(root, "backups");
      const dest = join(destRoot, "20261116T120000Z");
      mkdirSync(etc);
      mkdirSync(state);
      mkdirSync(destRoot);
      writeFileSync(join(etc, "scheduling-agent.env"), "SECRET=1\n", { mode: 0o600 });
      writeFileSync(join(state, "bookings.jsonl"), "ok\n", { mode: 0o600 });
      symlinkSync("/etc/passwd", join(state, "budget-ledger.json"));

      expect(() =>
        execFileSync(
          "bash",
          [
            "-c",
            'set -euo pipefail; source "$1"; backup_to_dest "$2" "$3" "$4" "$5"',
            "bash",
            backupScript,
            dest,
            etc,
            state,
            currentUid(),
          ],
          { stdio: "pipe" },
        ),
      ).toThrow();

      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves expected service UID on backup as root and restores cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-backup-roundtrip-"));
    const dest = join(root, "backups", "20261116T120000Z");
    const restoredState = join(root, "restored-state");
    try {
      const etc = join(root, "etc");
      const state = join(root, "state");
      mkdirSync(join(root, "backups"));
      mkdirSync(etc);
      mkdirSync(state);
      mkdirSync(restoredState);
      writeFileSync(join(etc, "scheduling-agent.env"), "SECRET=1\n", { mode: 0o600 });
      writeFileSync(join(state, "budget-ledger.json"), "ledger-roundtrip\n", { mode: 0o600 });

      const uid = currentUid();
      execFileSync(
        "sudo",
        [
          "-n",
          "bash",
          "-c",
          'set -euo pipefail; source "$1"; backup_to_dest "$2" "$3" "$4" "$5"',
          "bash",
          backupScript,
          dest,
          etc,
          state,
          uid,
        ],
        { stdio: "pipe" },
      );

      const backedUpMeta = execFileSync(
        "sudo",
        ["-n", "stat", "-c", "%u:%a", join(dest, "var-lib-scheduling-agent", "budget-ledger.json")],
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      expect(backedUpMeta).toBe(`${uid}:600`);

      execFileSync(
        "sudo",
        [
          "-n",
          "bash",
          "-c",
          'set -euo pipefail; source "$1"; restore_durable_tree "$2" "$3" "$4"',
          "bash",
          script,
          join(dest, "var-lib-scheduling-agent"),
          restoredState,
          uid,
        ],
        { stdio: "pipe" },
      );
      const restoredContent = execFileSync(
        "sudo",
        ["-n", "cat", join(restoredState, "budget-ledger.json")],
        { encoding: "utf8", stdio: "pipe" },
      );
      expect(restoredContent).toBe("ledger-roundtrip\n");
    } finally {
      execFileSync("sudo", ["-n", "rm", "-rf", dest, restoredState], { stdio: "pipe" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs backup CLI entrypoint end-to-end with timestamped 0700 directory and failure cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduling-backup-cli-"));
    try {
      const bin = join(root, "bin");
      const etc = join(root, "etc", "scheduling-agent");
      const state = join(root, "var", "lib", "scheduling-agent");
      const destRoot = join(root, "backups");
      mkdirSync(bin);
      mkdirSync(etc, { recursive: true });
      mkdirSync(state, { recursive: true });
      mkdirSync(destRoot);
      writeFileSync(join(etc, "scheduling-agent.env"), "SECRET=cli\n", { mode: 0o600 });
      writeFileSync(join(state, "budget-ledger.json"), "cli-ledger\n", { mode: 0o600 });

      const sudoShim = join(bin, "sudo");
      writeFileSync(sudoShim, '#!/bin/sh\nexec "$@"\n');
      chmodSync(sudoShim, 0o755);

      const rewritten = join(root, "backup.sh");
      const sourceScript = readFileSync(backupScript, "utf8")
        .replaceAll("/etc/scheduling-agent", etc)
        .replaceAll("/var/lib/scheduling-agent", state);
      writeFileSync(rewritten, sourceScript, { mode: 0o755 });
      symlinkSync(join(opsDir, "backup_durable_files.py"), join(root, "backup_durable_files.py"));
      symlinkSync(join(opsDir, "durable_state.py"), join(root, "durable_state.py"));

      const stampOut = execFileSync("bash", [rewritten, destRoot], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SCHEDULING_AGENT_UID: currentUid() },
        encoding: "utf8",
        stdio: "pipe",
      });
      const match = /Backup written to (\S+)/.exec(stampOut);
      expect(match?.[1]).toBeDefined();
      const backupDir = match![1]!;
      expect(lstatSync(backupDir).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(backupDir, "var-lib-scheduling-agent", "budget-ledger.json"), "utf8")).toBe(
        "cli-ledger\n",
      );

      // Clean out first backup and introduce an invalid symlinked durable file; CLI must fail and leave destRoot empty.
      rmSync(backupDir, { recursive: true, force: true });
      symlinkSync("/etc/passwd", join(state, "bookings.jsonl"));
      expect(() =>
        execFileSync("bash", [rewritten, destRoot], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SCHEDULING_AGENT_UID: currentUid() },
          stdio: "pipe",
        }),
      ).toThrow();
      expect(execFileSync("ls", ["-A", destRoot], { encoding: "utf8" }).trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
