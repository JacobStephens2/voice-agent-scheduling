#!/usr/bin/env python3
"""Back up known top-level durable-state files through directory-fd relative opens.

Only present files in KNOWN_DURABLE_FILES are opened relative to the source
directory fd with O_NOFOLLOW (without recursive traversal). The source
directory and each present known file are verified to be non-symlinks, and
each source file is verified via O_NOFOLLOW + fstat to be a regular file owned
by the expected service UID.
"""

from __future__ import annotations

import os
import shutil
import sys

sys.dont_write_bytecode = True

from durable_state import (
    KNOWN_DURABLE_FILES,
    close_fds,
    open_directory_nofollow,
    open_verified_sources,
    parse_transfer_args,
    sanitized_mode,
    strip_trailing_slashes,
    write_verified_file,
)


def _open_backup_destination(dest: str) -> tuple[int, bool]:
    dest_clean = strip_trailing_slashes(dest)
    if not dest_clean:
        raise SystemExit("Refusing backup: destination cannot be empty.")
    if dest_clean == "/":
        raise SystemExit("Refusing backup: destination cannot be '/'.")
    parent_dir = os.path.dirname(dest_clean) or "."
    leaf = os.path.basename(dest_clean)
    if leaf in ("", ".", ".."):
        raise SystemExit(f"Refusing backup: invalid destination {dest}.")

    parent_fd, _ = open_directory_nofollow(parent_dir, action="backup")
    created = False
    try:
        try:
            os.mkdir(leaf, 0o700, dir_fd=parent_fd)
            created = True
        except FileExistsError:
            pass
        dest_dirfd, _ = open_directory_nofollow(leaf, action="backup", dir_fd=parent_fd)
        return dest_dirfd, created
    finally:
        os.close(parent_fd)


def backup_durable_files(src: str, dest: str, expected_uid: int) -> None:
    """Copy present known durable regular files owned by expected_uid from src to dest."""
    src_dirfd, src_dir_info = open_directory_nofollow(src, action="backup")
    opened_sources: list[tuple[str, int, os.stat_result]] = []
    dest_dirfd = -1
    created_dest = False
    succeeded = False
    try:
        opened_sources = open_verified_sources(
            src_dirfd,
            sorted(KNOWN_DURABLE_FILES),
            expected_uid,
            action="backup",
            missing_ok=True,
        )

        dir_mode = sanitized_mode(src_dir_info)
        dest_dirfd, created_dest = _open_backup_destination(dest)

        for name, src_fd, info in opened_sources:
            dest_fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                sanitized_mode(info),
                dir_fd=dest_dirfd,
            )
            try:
                write_verified_file(dest_fd, src_fd, info, preserve_owner=True)
            finally:
                os.close(dest_fd)

        if os.geteuid() == 0:
            os.fchown(dest_dirfd, src_dir_info.st_uid, src_dir_info.st_gid)
        os.fchmod(dest_dirfd, dir_mode)
        os.utime(dest_dirfd, ns=(src_dir_info.st_atime_ns, src_dir_info.st_mtime_ns))
        succeeded = True
    finally:
        close_fds(opened_sources, dest_dirfd, src_dirfd)
        if created_dest and not succeeded:
            shutil.rmtree(dest, ignore_errors=True)


def main() -> None:
    src, dest, expected_uid = parse_transfer_args(
        "Back up present known top-level durable scheduling state files.",
    )
    backup_durable_files(src, dest, expected_uid)


if __name__ == "__main__":
    main()
