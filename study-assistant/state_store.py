"""Transactional JSON documents in SQLite, with a one-time legacy-file import.

Legacy JSON files are retained as an upgrade snapshot. After import, all reads
and writes use the database; a tombstone must never fall back to that snapshot.
Connections are short lived and nested transactions share the calling thread's
connection. No model or network request belongs inside a write transaction.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from material_titles import migrate_titles


class StateConflict(ValueError):
    """An optional revision precondition did not match the current document."""


class StateStore:
    SCHEMA_VERSION = 1

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / 'state.sqlite3'
        self.local = threading.local()
        with self.connection() as connection:
            os.chmod(self.path, 0o600)
            connection.execute('PRAGMA journal_mode=WAL')
            version = connection.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, self.SCHEMA_VERSION):
                raise RuntimeError('Unsupported state database version: %s' % version)
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS metadata (
                    name TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    key TEXT PRIMARY KEY, value TEXT, updated_ms INTEGER NOT NULL,
                    revision INTEGER NOT NULL CHECK (revision > 0)
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                    request_id TEXT NOT NULL, operation TEXT NOT NULL,
                    body TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN
                        ('queued','running','succeeded','failed','interrupted','cancelled')),
                    created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
                    result TEXT, error TEXT, response_status INTEGER, effect TEXT,
                    UNIQUE(user_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_ms);
                CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, updated_ms);
                CREATE TABLE IF NOT EXISTS job_progress (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS task_titles (
                    user_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
                    PRIMARY KEY(user_id, key)
                );
            ''')
            connection.execute('PRAGMA user_version=1')
        self._import_legacy()
        with self.transaction() as connection:
            migrate_titles(connection)

    def job_progress(self, step, label, attempt=1):
        job_id = getattr(self.local, 'job_id', None)
        if not job_id:
            return
        value = json.dumps({'step': step, 'total': 4, 'label': label, 'attempt': attempt}, ensure_ascii=False)
        with self.transaction() as connection:
            connection.execute('INSERT INTO job_progress(job_id,value) VALUES (?,?) '
                               'ON CONFLICT(job_id) DO UPDATE SET value=excluded.value', (job_id, value))

    @contextmanager
    def connection(self):
        active = getattr(self.local, 'connection', None)
        if active is not None:
            yield active
            return
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self):
        active = getattr(self.local, 'connection', None)
        if active is not None:
            yield active
            return
        with self.connection() as connection:
            connection.execute('BEGIN IMMEDIATE')
            self.local.connection = connection
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            finally:
                del self.local.connection

    def _import_legacy(self):
        with self.transaction() as connection:
            if connection.execute("SELECT 1 FROM metadata WHERE name='legacy_import'").fetchone():
                return
            imported = []
            for path in sorted(self.directory.glob('*.json')):
                raw = path.read_bytes()
                try:
                    record = json.loads(raw)
                    if not isinstance(record, dict) or not isinstance(record.get('key'), str):
                        raise ValueError('invalid document envelope')
                    value = record.get('v')
                    if value is not None and not isinstance(value, str):
                        raise ValueError('invalid document value')
                    timestamp = int(record.get('ts') or 0)
                except (ValueError, TypeError) as error:
                    raise ValueError('Cannot import legacy state file: ' + path.name) from error
                connection.execute('INSERT INTO documents VALUES (?, ?, ?, 1)',
                                   (record['key'], value, timestamp))
                imported.append({'file': path.name, 'sha256': hashlib.sha256(raw).hexdigest()})
            connection.execute('INSERT INTO metadata VALUES (?, ?)',
                               ('legacy_import', json.dumps(imported, ensure_ascii=False)))

    def record(self, key):
        with self.connection() as connection:
            row = connection.execute('SELECT * FROM documents WHERE key=?', (key,)).fetchone()
            return dict(row) if row else None

    def records(self):
        with self.connection() as connection:
            return [dict(row) for row in connection.execute('SELECT * FROM documents ORDER BY key')]

    def put(self, key, value, expected_revision=None):
        with self.transaction() as connection:
            if expected_revision is not None:
                current = connection.execute('SELECT revision FROM documents WHERE key=?', (key,)).fetchone()
                if (current['revision'] if current else 0) != expected_revision:
                    raise StateConflict('资料已更新，请刷新后重试')
            connection.execute('''INSERT INTO documents VALUES (?, ?, ?, 1)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                    updated_ms=excluded.updated_ms, revision=documents.revision+1''',
                               (key, value, int(time.time() * 1000)))

    def check(self):
        with self.connection() as connection:
            return connection.execute('PRAGMA quick_check').fetchone()[0]

    def backup(self, destination):
        """Use SQLite's online backup API so committed WAL data is included."""
        with self.connection() as source, sqlite3.connect(destination) as target:
            source.backup(target)
        os.chmod(destination, 0o600)

    def record_job_effect(self, result):
        """Commit an operation's result with its final document mutation.

        Used for operations such as appending refinement nodes and creating an
        exam, where replaying after a process crash would create duplicates.
        """
        job_id = getattr(self.local, 'job_id', None)
        if job_id:
            with self.transaction() as connection:
                connection.execute('UPDATE jobs SET effect=? WHERE id=?',
                                   (json.dumps(result, ensure_ascii=False), job_id))
