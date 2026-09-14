"""Create a consistent database/account backup while the writer is stopped.

The account file and SQLite cannot share a transaction. Holding the same process
lock as the backend ensures the two snapshots describe one stopped writer.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
from state_store import StateStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state_dir', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    if not args.state_dir.is_dir():
        parser.error('state_dir must exist')
    if args.destination.exists():
        parser.error('destination must not exist')
    with (args.state_dir / '.writer.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('stop the backend before creating the paired backup')
        store = StateStore(args.state_dir)
        if store.check() != 'ok':
            raise RuntimeError('database integrity check failed')
        args.destination.mkdir(parents=True, mode=0o700)
        store.backup(args.destination / 'state.sqlite3')
        accounts = Path(str(args.state_dir) + '-accounts')
        if accounts.exists():
            shutil.copytree(accounts, args.destination / 'accounts')
        manifest = {'schema_version': store.SCHEMA_VERSION, 'documents': len(store.records()),
                    'state_source': str(args.state_dir.resolve()), 'database_check': 'ok'}
        (args.destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        os.chmod(args.destination / 'manifest.json', 0o600)
        print(json.dumps(manifest))


if __name__ == '__main__':
    main()
