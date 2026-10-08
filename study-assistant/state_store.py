"""Transactional JSON documents in SQLite, with a one-time legacy-file import.

Legacy JSON files are retained as an upgrade snapshot. After import, all reads
and writes use the database; a tombstone must never fall back to that snapshot.
Connections are short lived and nested transactions share the calling thread's
connection. No model or network request belongs inside a write transaction.
"""
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
from material_titles import migrate_titles
from job_execution import check_deadline, remaining_timeout
from job_details import append_event


def record_event(connection, *args, **kwargs):
    try:
        append_event(connection, *args, **kwargs)
    except Exception:
        pass


def sqlite_wait(connection, enforce_deadline):
    """Refresh SQLite's millisecond wait limit before each lock boundary."""
    wait = remaining_timeout(10) if enforce_deadline else 1
    connection.execute('PRAGMA busy_timeout=%d' % max(1, math.ceil(wait * 1000)))


def require_transaction(connection):
    # SQLITE_FULL and some I/O errors can implicitly roll back the transaction.
    # Do not let a later statement autocommit an effect without its document.
    if not connection.in_transaction:
        raise sqlite3.OperationalError('State transaction was rolled back')


class StateConflict(ValueError):
    """An optional revision precondition did not match the current document."""


class StateStore:
    SCHEMA_VERSION = 1

    def __init__(self, directory, *, diagnostic_secrets=()):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / 'state.sqlite3'
        self.local = threading.local()
        self.diagnostic_secrets = tuple(value for value in diagnostic_secrets if value)
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
                CREATE TABLE IF NOT EXISTS job_attempts (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
                    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
                    started_ms INTEGER,
                    retry_at_ms INTEGER
                );
                CREATE TABLE IF NOT EXISTS job_details (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS task_titles (
                    user_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
                    PRIMARY KEY(user_id, key)
                );
            ''')
            # Existing attempts count once. Never reset a retry budget on restart.
            connection.execute('''INSERT OR IGNORE INTO job_attempts(job_id,attempt,started_ms)
                SELECT id, CASE WHEN status='queued' THEN 0 ELSE 1 END,
                    CASE WHEN status='queued' THEN NULL ELSE updated_ms END FROM jobs''')
            # Optional task metadata is additive. Older code can still read the
            # same document/job envelope during a code-only release rollback.
            connection.execute('PRAGMA user_version=1')
        self._import_legacy()
        with self.transaction() as connection:
            migrate_titles(connection)

    def job_progress(self, step, label, attempt=1, total=4):
        job_id = getattr(self.local, 'job_id', None)
        if not job_id:
            return
        check_deadline()
        self.local.phase = label
        value = json.dumps({'step': step, 'total': total, 'label': label, 'attempt': attempt}, ensure_ascii=False)
        with self.transaction() as connection:
            connection.execute('INSERT INTO job_progress(job_id,value) VALUES (?,?) '
                               'ON CONFLICT(job_id) DO UPDATE SET value=excluded.value', (job_id, value))
            record_event(connection, job_id, 'phase', label,
                         attempt=getattr(self.local, 'job_attempt', attempt), phase=label,
                         step=step, total=total, generation_attempt=attempt)

    def job_event(self, kind, label, *, known_secrets=(), **fields):
        job_id = getattr(self.local, 'job_id', None)
        if not job_id:
            return
        # Diagnostics may record an expired deadline, without business writes.
        try:
            with self.transaction(enforce_deadline=False) as connection:
                record_event(connection, job_id, kind, label,
                             attempt=getattr(self.local, 'job_attempt', 0),
                             phase=getattr(self.local, 'phase', '任务处理'),
                             known_secrets=self.diagnostic_secrets + tuple(known_secrets), **fields)
        except Exception:
            # A diagnostics storage fault must not mask an execution failure.
            pass

    @contextmanager
    def connection(self, *, enforce_deadline=True):
        active = getattr(self.local, 'connection', None)
        if active is not None:
            require_transaction(active)
            yield active
            require_transaction(active)
            return
        wait = remaining_timeout(10) if enforce_deadline else 1
        connection = None
        try:
            connection = sqlite3.connect(self.path, timeout=wait, isolation_level=None)
            connection.row_factory = sqlite3.Row
            sqlite_wait(connection, enforce_deadline)
            connection.execute('PRAGMA synchronous=FULL')
            sqlite_wait(connection, enforce_deadline)
            connection.execute('PRAGMA foreign_keys=ON')
            yield connection
        except sqlite3.OperationalError:
            if enforce_deadline:
                check_deadline()
            raise
        finally:
            if connection is not None:
                connection.close()

    @contextmanager
    def transaction(self, *, enforce_deadline=True):
        active = getattr(self.local, 'connection', None)
        if active is not None:
            if enforce_deadline:
                check_deadline()
            require_transaction(active)
            yield active
            require_transaction(active)
            return
        with self.connection(enforce_deadline=enforce_deadline) as connection:
            if enforce_deadline:
                check_deadline()
            sqlite_wait(connection, enforce_deadline)
            connection.execute('BEGIN IMMEDIATE')
            self.local.connection = connection
            try:
                yield connection
                if enforce_deadline:
                    check_deadline()
                require_transaction(connection)
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
        job_id = getattr(self.local, 'job_id', None)
        if job_id:
            self.local.phase = '保存学习资料'
        with self.transaction() as connection:
            if expected_revision is not None:
                current = connection.execute('SELECT revision FROM documents WHERE key=?', (key,)).fetchone()
                if (current['revision'] if current else 0) != expected_revision:
                    raise StateConflict('资料已更新，请刷新后重试')
            connection.execute('''INSERT INTO documents VALUES (?, ?, ?, 1)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                    updated_ms=excluded.updated_ms, revision=documents.revision+1''',
                               (key, value, int(time.time() * 1000)))
            if job_id:
                record_event(connection, job_id, 'phase', '保存学习资料', phase='保存学习资料',
                             attempt=getattr(self.local, 'job_attempt', 0))

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
