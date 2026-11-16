#!/usr/bin/env python3
"""Shared durable-state file verification and transfer primitives.

Both backup and restore restrict /var/lib/scheduling-agent operations to the
known top-level durable state filenames and verify via directory-fd-relative
O_NOFOLLOW opens and fstat that each source entry is a regular file owned by
the expected service UID.
"""

from __future__ import annotations

import argparse
import errno
import os
import stat
import subprocess
import sys
from collections.abc import Iterable

KNOWN_DURABLE_FILES: frozenset[str] = frozenset(
    {
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
    }
)

SERVICE_USER = "scheduling-agent"
UID_OVERRIDE_ENV = "SCHEDULING_AGENT_UID"


def parse_uid(raw: str) -> int:
    """Parse a non-negative numeric UID string."""
    if not raw or not raw.isascii() or not raw.isdigit():
        raise SystemExit(f"Refusing: invalid expected UID {raw!r}.")
    return int(raw)


def resolve_expected_uid(explicit_uid: str | None = None) -> int:
    """Resolve the expected service UID from an explicit arg, env override, or passwd lookup."""
    if explicit_uid is not None:
        return parse_uid(explicit_uid)
    if UID_OVERRIDE_ENV in os.environ:
        return parse_uid(os.environ[UID_OVERRIDE_ENV])
    result = subprocess.run(
        ["id", "-u", SERVICE_USER],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"Refusing: cannot resolve {SERVICE_USER} UID "
            f"(pass --expected-uid or set {UID_OVERRIDE_ENV})."
        )
    return parse_uid(result.stdout.strip())


def strip_trailing_slashes(path: str) -> str:
    """Strip trailing slashes without turning an empty path into '/'."""
    if not path:
        return ""
    trimmed = path.rstrip("/")
    return trimmed or "/"


def open_directory_nofollow(
    path: str,
    *,
    action: str,
    dir_fd: int | None = None,
) -> tuple[int, os.stat_result]:
    """Open an existing directory without following a trailing symlink."""
    if not path:
        raise SystemExit(f"Refusing {action}: directory path cannot be empty.")
    target = strip_trailing_slashes(path) if dir_fd is None else path
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        fd = os.open(target, flags, dir_fd=dir_fd)
    except FileNotFoundError as error:
        raise SystemExit(f"Refusing {action}: {path} does not exist.") from error
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            try:
                info = os.stat(target, dir_fd=dir_fd, follow_symlinks=False)
            except OSError:
                info = None
            if info is not None and stat.S_ISLNK(info.st_mode):
                raise SystemExit(f"Refusing {action}: {path} is a symlink.") from error
            raise SystemExit(f"Refusing {action}: {path} is not a directory.") from error
        raise
    try:
        return fd, os.fstat(fd)
    except Exception:
        os.close(fd)
        raise


def _verify_regular_owned(
    info: os.stat_result,
    name: str,
    expected_uid: int,
    *,
    action: str,
) -> None:
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"Refusing {action}: {name} is a symlink.")
    if stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"Refusing {action}: {name} is a directory.")
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit(f"Refusing {action}: unsupported file type {name}.")
    if info.st_uid != expected_uid:
        raise SystemExit(
            f"Refusing {action}: {name} is owned by uid {info.st_uid}, expected {expected_uid}."
        )


def open_verified_source_file(
    dirfd: int,
    name: str,
    expected_uid: int,
    *,
    action: str,
    missing_ok: bool = False,
) -> tuple[int, os.stat_result] | None:
    """Open a known top-level durable file with O_NOFOLLOW and verify type and UID."""
    if name not in KNOWN_DURABLE_FILES:
        raise SystemExit(f"Refusing {action}: unexpected filename {name}.")

    try:
        linfo = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
    except FileNotFoundError as error:
        if missing_ok:
            return None
        raise SystemExit(f"Refusing {action}: {name} disappeared.") from error

    _verify_regular_owned(linfo, name, expected_uid, action=action)

    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(name, flags, dir_fd=dirfd)
    except FileNotFoundError as error:
        if missing_ok:
            return None
        raise SystemExit(f"Refusing {action}: {name} disappeared.") from error
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise SystemExit(f"Refusing {action}: {name} is a symlink.") from error
        raise SystemExit(f"Refusing {action}: cannot open {name}: {error.strerror}.") from error

    try:
        info = os.fstat(fd)
        _verify_regular_owned(info, name, expected_uid, action=action)
        return fd, info
    except Exception:
        os.close(fd)
        raise


def close_fds(
    opened_sources: Iterable[tuple[str, int, os.stat_result]],
    *fds: int,
) -> None:
    """Close opened source descriptors and any non-negative directory descriptors."""
    for _, src_fd, _ in opened_sources:
        os.close(src_fd)
    for fd in fds:
        if fd != -1:
            os.close(fd)


def open_verified_sources(
    src_dirfd: int,
    names: Iterable[str],
    expected_uid: int,
    *,
    action: str,
    missing_ok: bool,
) -> list[tuple[str, int, os.stat_result]]:
    """Open and verify every requested source entry, closing opened fds on failure."""
    opened_sources: list[tuple[str, int, os.stat_result]] = []
    try:
        for name in names:
            opened = open_verified_source_file(
                src_dirfd,
                name,
                expected_uid,
                action=action,
                missing_ok=missing_ok,
            )
            if opened is not None:
                opened_sources.append((name, opened[0], opened[1]))
        return opened_sources
    except Exception:
        close_fds(opened_sources)
        raise


def sanitized_mode(info: os.stat_result) -> int:
    """Return permission bits with setuid and setgid cleared."""
    return stat.S_IMODE(info.st_mode) & ~(stat.S_ISUID | stat.S_ISGID)


def copy_fd_bytes(src_fd: int, dest_fd: int) -> None:
    """Copy all bytes from src_fd to dest_fd."""
    while True:
        chunk = os.read(src_fd, 1024 * 1024)
        if not chunk:
            return
        view = memoryview(chunk)
        while view:
            written = os.write(dest_fd, view)
            view = view[written:]


def write_verified_file(
    dest_fd: int,
    src_fd: int,
    info: os.stat_result,
    *,
    preserve_owner: bool = False,
) -> None:
    """Copy bytes from src_fd to dest_fd and apply sanitized mode and timestamps."""
    copy_fd_bytes(src_fd, dest_fd)
    if preserve_owner and os.geteuid() == 0:
        os.fchown(dest_fd, info.st_uid, info.st_gid)
    os.fchmod(dest_fd, sanitized_mode(info))
    os.utime(dest_fd, ns=(info.st_atime_ns, info.st_mtime_ns))


def parse_transfer_args(description: str, argv: list[str] | None = None) -> tuple[str, str, int]:
    """Parse SRC, DEST, and optional --expected-uid for durable transfer CLIs."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--expected-uid", dest="expected_uid", default=None)
    parser.add_argument("src")
    parser.add_argument("dest")
    args = parser.parse_args(argv)
    return args.src, args.dest, resolve_expected_uid(args.expected_uid)


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (1, 2) or args[0] != "resolve-uid":
        print("usage: durable_state.py resolve-uid [UID]", file=sys.stderr)
        raise SystemExit(2)
    explicit = args[1] if len(args) == 2 else None
    print(resolve_expected_uid(explicit))


if __name__ == "__main__":
    main()
