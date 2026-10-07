"""Create a consistent database/account/animation backup while the writer is stopped.

Holding the backend process lock keeps database references, accounts and private
Manim files in one stopped-writer snapshot. File copies never follow links.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
from state_store import StateStore


def _ordinary_file(parent_fd, name, destination):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError('backup source must be an ordinary file without hard links')
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        size = 0
        with os.fdopen(descriptor, 'wb') as target:
            os.fchmod(target.fileno(), 0o600)
            while True:
                piece = source.read(65536)
                if not piece:
                    break
                target.write(piece)
                size += len(piece)
            target.flush()
            os.fsync(target.fileno())
        after = os.fstat(source.fileno())
        if (size != before.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                != (before.st_size, before.st_mtime_ns, before.st_ctime_ns)):
            raise ValueError('backup source changed while copying')
        return size


def _copy_directory(source_fd, destination):
    destination.mkdir(mode=0o700)
    os.chmod(destination, 0o700)
    files, size = 0, 0
    for name in os.listdir(source_fd):
        info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        target = destination / name
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd)
            try:
                child_result = _copy_directory(child, target)
                files += child_result['files']
                size += child_result['bytes']
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            size += _ordinary_file(source_fd, name, target)
            files += 1
        else:
            raise ValueError('backup source contains a link or special file')
    return {'files': files, 'bytes': size}


def copy_tree(source, destination):
    descriptor = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        return _copy_directory(descriptor, destination)
    finally:
        os.close(descriptor)


def backup(state_dir, destination):
    state_dir, destination = Path(state_dir), Path(destination)
    accounts = Path(str(state_dir) + '-accounts')
    if state_dir.is_symlink() or not state_dir.is_dir():
        raise ValueError('state_dir must be an ordinary directory')
    if os.path.lexists(destination):
        raise ValueError('destination must not exist')
    resolved_destination = destination.resolve()
    if any(resolved_destination.is_relative_to(root.resolve()) for root in (state_dir, accounts)):
        raise ValueError('destination must be outside the source directories')
    state_fd = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        lock_fd = os.open('.writer.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=state_fd)
        with os.fdopen(lock_fd, 'a') as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('writer lock must be an ordinary file')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError('stop the backend before creating the paired backup') from error
            try:
                database = os.stat('state.sqlite3', dir_fd=state_fd, follow_symlinks=False)
            except FileNotFoundError:
                database = None
            if database is not None and (not stat.S_ISREG(database.st_mode) or database.st_nlink != 1):
                raise ValueError('database must be an ordinary file')
            store = StateStore(state_dir)
            if store.check() != 'ok':
                raise RuntimeError('database integrity check failed')
            destination.mkdir(parents=True, mode=0o700)
            os.chmod(destination, 0o700)
            store.backup(destination / 'state.sqlite3')
            if os.path.lexists(accounts):
                copy_tree(accounts, destination / 'accounts')
            assets = {'present': False, 'files': 0, 'bytes': 0}
            if os.path.lexists(state_dir / 'manim-assets'):
                assets = {'present': True, **copy_tree(state_dir / 'manim-assets', destination / 'manim-assets')}
            runtime = os.path.lexists(state_dir / 'manim-runtime.json')
            if runtime:
                _ordinary_file(state_fd, 'manim-runtime.json', destination / 'manim-runtime.json')
            manifest = {'schema_version': store.SCHEMA_VERSION, 'documents': len(store.records()),
                        'state_source': str(state_dir.resolve()), 'database_check': 'ok',
                        'manim_assets': assets, 'manim_runtime': runtime}
            # A success marker exists only after every paired file copy succeeds.
            temporary_manifest = destination / 'manifest.tmp'
            descriptor = os.open(temporary_manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                output.write(json.dumps(manifest, indent=2))
                output.flush()
                os.fsync(output.fileno())
            temporary_manifest.replace(destination / 'manifest.json')
            return manifest
    finally:
        os.close(state_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state_dir', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        manifest = backup(args.state_dir, args.destination)
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
