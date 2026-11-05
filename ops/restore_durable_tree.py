#!/usr/bin/env python3
"""Copy a durable-state tree through directory-fd relative opens.

Each restored name is opened relative to its parent directory fd with
O_NOFOLLOW. When that final name is a symlink, the open fails closed and the
backup is not written through the link. Names the backup does not restore are
left in place. The caller creates dest.
"""

from __future__ import annotations

import errno
import os
import stat
import sys


def read_all(fd: int) -> bytes:
    chunks: list[bytes] = []
    while True:
        block = os.read(fd, 1024 * 1024)
        if not block:
            return b"".join(chunks)
        chunks.append(block)


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def open_replaced_file(dirfd: int, name: str, mode: int) -> int:
    """Open name for writing. A symlink final component fails closed."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    try:
        return os.open(name, flags, mode, dir_fd=dirfd)
    except OSError as error:
        if error.errno != errno.ELOOP:
            raise
        # O_NOFOLLOW failed the open. Replace the symlink name, then fail
        # closed if that name is a symlink again when the next open runs.
        os.unlink(name, dir_fd=dirfd)
        try:
            return os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                mode,
                dir_fd=dirfd,
            )
        except OSError as again:
            if again.errno in (errno.ELOOP, errno.EEXIST):
                raise SystemExit(f"Refusing restore: {name} is a symlink.") from again
            raise


def ensure_directory(dirfd: int, name: str, mode: int) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        fd = os.open(name, flags, dir_fd=dirfd)
    except FileNotFoundError:
        os.mkdir(name, mode, dir_fd=dirfd)
        fd = os.open(name, flags, dir_fd=dirfd)
    except OSError as error:
        if error.errno not in (errno.ELOOP, errno.ENOTDIR):
            raise
        # O_DIRECTORY|O_NOFOLLOW returns ENOTDIR for a symlink on Linux, and
        # ELOOP for O_NOFOLLOW alone. Do not follow either result.
        info = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
        if not stat.S_ISLNK(info.st_mode):
            raise
        os.unlink(name, dir_fd=dirfd)
        os.mkdir(name, mode, dir_fd=dirfd)
        try:
            fd = os.open(name, flags, dir_fd=dirfd)
        except OSError as again:
            if again.errno in (errno.ELOOP, errno.ENOTDIR):
                raise SystemExit(f"Refusing restore: {name} is a symlink.") from again
            raise
    os.fchmod(fd, mode)
    return fd


def restore_symlink(dirfd: int, name: str, target: str) -> None:
    try:
        os.symlink(target, name, dir_fd=dirfd)
        return
    except FileExistsError:
        info = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            raise
        os.unlink(name, dir_fd=dirfd)
        os.symlink(target, name, dir_fd=dirfd)


def copy_file(src: str, dirfd: int, name: str) -> None:
    src_fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(src_fd)
        data = read_all(src_fd)
    finally:
        os.close(src_fd)
    # The service user can set these bits on its own state file. This restore
    # runs as root, and copying them would install a set-id root executable.
    mode = stat.S_IMODE(info.st_mode) & ~(stat.S_ISUID | stat.S_ISGID)
    dest_fd = open_replaced_file(dirfd, name, mode)
    try:
        write_all(dest_fd, data)
        os.fchmod(dest_fd, mode)
        os.utime(dest_fd, ns=(info.st_atime_ns, info.st_mtime_ns))
    finally:
        os.close(dest_fd)


def restore_tree(src: str, dirfd: int) -> None:
    records: list[tuple[str, str, os.stat_result]] = []
    with os.scandir(src) as entries:
        for entry in entries:
            records.append((entry.name, entry.path, entry.stat(follow_symlinks=False)))
    records.sort(key=lambda record: record[0])
    for name, path, info in records:
        if stat.S_ISDIR(info.st_mode):
            child = ensure_directory(dirfd, name, stat.S_IMODE(info.st_mode))
            try:
                restore_tree(path, child)
                os.utime(child, ns=(info.st_atime_ns, info.st_mtime_ns))
            finally:
                os.close(child)
        elif stat.S_ISLNK(info.st_mode):
            restore_symlink(dirfd, name, os.readlink(path))
        elif stat.S_ISREG(info.st_mode):
            copy_file(path, dirfd, name)
        else:
            raise SystemExit(f"Refusing restore: unsupported file type {name}.")


def open_root(dest: str) -> int:
    try:
        return os.open(dest, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR) and stat.S_ISLNK(os.lstat(dest).st_mode):
            print(f"Refusing restore: {dest} is a symlink.", file=sys.stderr)
            raise SystemExit(1) from error
        raise


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: restore_durable_tree.py SRC DEST", file=sys.stderr)
        raise SystemExit(2)
    src, dest = sys.argv[1], sys.argv[2]
    if os.path.islink(src) or not os.path.isdir(src):
        print(f"Refusing restore: {src} is not a directory.", file=sys.stderr)
        raise SystemExit(1)
    root = open_root(dest)
    try:
        restore_tree(src, root)
    finally:
        os.close(root)


if __name__ == "__main__":
    main()
