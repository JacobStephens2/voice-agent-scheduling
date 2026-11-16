#!/usr/bin/env python3
"""Restore known top-level durable-state files through directory-fd relative opens.

Only the known top-level durable state filenames are accepted. Both the source
snapshot directory and destination directory are opened with O_NOFOLLOW, every
source entry is verified via O_NOFOLLOW + fstat to be a regular file owned by
the expected service UID, and any directory, symlink, special file, unexpected
filename, or unexpected owner UID fails closed before writing to the destination.
"""

from __future__ import annotations

import errno
import os
import stat
import sys

sys.dont_write_bytecode = True

from durable_state import (
    KNOWN_DURABLE_FILES,
    close_fds,
    open_directory_nofollow,
    open_verified_sources,
    parse_transfer_args,
    sanitized_mode,
    write_verified_file,
)


def open_replaced_file(dirfd: int, name: str, mode: int) -> int:
    """Open name for writing. A symlink or non-regular target fails closed."""
    nonblock = getattr(os, "O_NONBLOCK", 0)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | nonblock
    try:
        fd = os.open(name, flags, mode, dir_fd=dirfd)
    except OSError as error:
        if error.errno != errno.ELOOP:
            raise
        # O_NOFOLLOW failed the open. Replace the symlink name, then fail
        # closed if that name is a symlink again when the next open runs.
        os.unlink(name, dir_fd=dirfd)
        try:
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | nonblock,
                mode,
                dir_fd=dirfd,
            )
        except OSError as again:
            if again.errno in (errno.ELOOP, errno.EEXIST):
                raise SystemExit(f"Refusing restore: {name} is a symlink.") from again
            raise
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SystemExit(f"Refusing restore: destination {name} is not a regular file.")
        return fd
    except Exception:
        os.close(fd)
        raise


def restore_durable_files(src: str, dest: str, expected_uid: int) -> None:
    """Validate all source entries and copy them safely into dest."""
    src_dirfd, _ = open_directory_nofollow(src, action="restore")
    dest_dirfd = -1
    opened_sources: list[tuple[str, int, os.stat_result]] = []
    try:
        dest_dirfd, _ = open_directory_nofollow(dest, action="restore")
        names = sorted(os.listdir(src_dirfd))
        for name in names:
            if name not in KNOWN_DURABLE_FILES:
                raise SystemExit(f"Refusing restore: unexpected entry {name}.")
        opened_sources = open_verified_sources(
            src_dirfd,
            names,
            expected_uid,
            action="restore",
            missing_ok=False,
        )

        for name, src_fd, info in opened_sources:
            # The service user can set these bits on its own state file. This restore
            # runs as root, and copying them would install a set-id root executable.
            dest_fd = open_replaced_file(dest_dirfd, name, sanitized_mode(info))
            try:
                write_verified_file(dest_fd, src_fd, info)
            finally:
                os.close(dest_fd)
    finally:
        close_fds(opened_sources, dest_dirfd, src_dirfd)


def main() -> None:
    src, dest, expected_uid = parse_transfer_args(
        "Restore known top-level durable scheduling state files.",
    )
    restore_durable_files(src, dest, expected_uid)


if __name__ == "__main__":
    main()
