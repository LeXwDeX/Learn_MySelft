"""Apply explicitly reviewed quiz editions without rewriting historical rounds.

Run against a stopped service. The default is a read-only preview. Plans contain
document hashes, exact source-round hashes and complete reviewed v2 questions;
this tool never guesses how to split an answer or distribute points.
"""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

import quiz_harness as harness


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def convert_document(document, entries, migration_id):
    result = copy.deepcopy(document)
    added = 0
    seen = set()
    for entry in entries:
        identity = (tuple(entry['path']), entry['source_round_id'])
        if identity in seen:
            raise ValueError('Duplicate source round in plan')
        seen.add(identity)
        quiz = result
        for segment in entry['path']:
            quiz = quiz[segment]
        tag = {'id': migration_id, 'source_round_id': entry['source_round_id'],
               'source_sha256': entry['source_sha256'],
               'questions_sha256': digest(entry['questions'])}
        migrated = [r for r in quiz['rounds'] if r.get('migration') == tag]
        if migrated:
            if len(migrated) != 1 or digest(migrated[0]['questions']) != tag['questions_sha256']:
                raise ValueError('Migrated edition changed unexpectedly')
            continue
        source = next(r for r in quiz['rounds'] if r['id'] == entry['source_round_id'])
        if digest(source) != entry['source_sha256']:
            raise ValueError('Source round changed; review a fresh plan')
        if source.get('harness_version', 1) >= 2:
            raise ValueError('Only legacy rounds can be migrated')
        if any(isinstance(r.get('migration'), dict) and
               r['migration'].get('source_round_id') == entry['source_round_id']
               for r in quiz['rounds']):
            raise ValueError('Source round already has a migrated edition')
        questions = copy.deepcopy(entry['questions'])
        harness.validate_questions(questions, node=bool(entry['path']))
        if questions != entry['questions']:
            raise ValueError('Plan must contain canonical validated questions')
        if len(questions) != len(source['questions']) or any(
                (old['type'], old['points']) != (new['type'], new['points'])
                for old, new in zip(source['questions'], questions)):
            raise ValueError('Migration must preserve question types and total points')
        if not isinstance(entry.get('review'), str) or not entry['review'].strip():
            raise ValueError('An explicit content review is required')
        edition = harness.new_round(questions)
        edition.update(migration=tag, verification={'method': 'reviewed_migration',
                                                   'reason': entry['review']})
        quiz['rounds'].append(edition)
        if quiz['round_id'] == source['id']:
            quiz.update(round_id=edition['id'], questions=copy.deepcopy(questions))
        added += 1
    return result, added


def prepare(connection, plan):
    if plan.get('version') != 1 or not isinstance(plan.get('id'), str) or not plan['id']:
        raise ValueError('Invalid migration plan')
    changes, count, seen = [], 0, set()
    for item in plan['documents']:
        key = item['key']
        if key in seen:
            raise ValueError('Duplicate document in plan')
        seen.add(key)
        row = connection.execute('SELECT value,revision FROM documents WHERE key=?', (key,)).fetchone()
        if not row or row[0] is None:
            raise ValueError('Selected document is missing')
        document = json.loads(row[0])
        updated, added = convert_document(document, item['editions'], plan['id'])
        if added:
            if digest(document) != item['source_sha256']:
                raise ValueError('Document changed; review a fresh plan')
            changes.append((key, json.dumps(updated, ensure_ascii=False), row[1]))
            count += added
    return changes, count


def migrate(database, plan, backup=None):
    """Preview without writes, or atomically apply with an exclusive service lock."""
    database = Path(database).resolve(strict=True)
    lock_fd = None
    try:
        if backup is not None:
            lock_fd = os.open(database.parent / '.writer.lock', os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as source:
            if source.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity check failed')
            changes, count = prepare(source, plan)
            if not changes or backup is None:
                return {'applied': False, 'documents': len(changes), 'editions': count}
            if source.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]:
                raise ValueError('Active jobs must finish before migration')
            backup = Path(backup)
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            with sqlite3.connect(backup) as target:
                source.backup(target)
        with sqlite3.connect(database, isolation_level=None) as connection:
            connection.execute('PRAGMA synchronous=FULL')
            connection.execute('BEGIN IMMEDIATE')
            try:
                # Recheck after backup, before any mutation.
                changes, count = prepare(connection, plan)
                for key, value, revision in changes:
                    cursor = connection.execute(
                        'UPDATE documents SET value=?,updated_ms=?,revision=revision+1 WHERE key=? AND revision=?',
                        (value, int(time.time() * 1000), key, revision))
                    if cursor.rowcount != 1:
                        raise ValueError('Concurrent document modification')
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return {'applied': True, 'documents': len(changes), 'editions': count, 'backup': str(backup)}
    finally:
        if lock_fd is not None:
            os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup', help='New private SQLite backup path; required for --apply')
    args = parser.parse_args()
    if args.apply != bool(args.backup):
        parser.error('--apply and --backup must be supplied together')
    plan = json.loads(Path(args.plan).read_text())
    print(json.dumps(migrate(args.database, plan, args.backup), ensure_ascii=False))


if __name__ == '__main__':
    main()
