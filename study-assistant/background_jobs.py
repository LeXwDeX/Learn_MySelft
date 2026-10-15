"""Bounded, user-owned background work with persistent receipts and results."""
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
from job_execution import JobDeadlineExceeded, execution_budget, check_deadline
from job_details import append_event, locations, sanitize
from quiz_harness import QuizContractError
from research_sources import SourceSelectionError
from material_titles import document_title
from service_limits import QUIZMAP_EXECUTION_SECONDS

OPERATIONS = frozenset({'/path/intake', '/path/research', '/path/plan', '/path/node', '/path/node/scene',
                        '/path/requiz', '/path/quizmap', '/path/refine', '/path/gaps', '/path/quiz'})
TERMINAL = frozenset({'succeeded', 'failed', 'interrupted', 'cancelled'})
REQUEST_ID = re.compile(r'^[A-Za-z0-9:_-]{8,120}$')
LOGGER = logging.getLogger(__name__)
NODE_MAX_ATTEMPTS = 2
LEARNING_OPERATIONS = frozenset({'/path/node', '/path/node/scene'})
JOB_EXECUTION_SECONDS = 300
NODE_EXECUTION_SECONDS = JOB_EXECUTION_SECONDS
NODE_RETRY_SECONDS = 5
TRANSIENT_HTTP = frozenset({408, 429, 500, 502, 503, 504})


def record_event(connection, *args, **kwargs):
    try:
        append_event(connection, *args, **kwargs)
    except Exception:
        pass


def log_job_failure(job_id, operation, error, stage='execute'):
    """Record locations only: exception text, source lines and locals may contain secrets."""
    try:
        frames = []
        trace = error.__traceback__
        while trace is not None:
            code = trace.tb_frame.f_code
            frames.append({'file': os.path.basename(code.co_filename),
                           'function': code.co_name, 'line': trace.tb_lineno})
            trace = trace.tb_next
        record = {'job_id': job_id, 'operation': operation, 'stage': stage,
                  'exception': type(error).__name__, 'frames': frames}
        LOGGER.error('job_failure %s', json.dumps(record, ensure_ascii=True))
    except Exception:
        # Diagnostics must not alter the task outcome or prevent a retry.
        pass


class JobError(Exception):
    def __init__(self, status, message, *, error_category=None):
        self.status = status
        if error_category is not None:
            self.error_category = error_category
        super().__init__(message)


def failure_detail(error):
    """Classify at the exception boundary, never expose upstream bodies or keys."""
    if isinstance(error, JobDeadlineExceeded):
        return 'deadline', '本次后台任务超过执行时限，已有学习内容已保留。'
    if isinstance(error, urllib.error.HTTPError):
        return 'remote_api', '远程服务端错误（API %s）：模型服务暂时不可用或拒绝请求，可稍后重试。' % error.code
    if isinstance(error, (TimeoutError, urllib.error.URLError)):
        return 'network', '网络连接或超时错误：无法完成与远程模型服务的通信，可稍后重试。'
    if isinstance(error, sqlite3.Error):
        return 'storage', '学习数据存储发生错误，请稍后重试。'
    if isinstance(error, QuizContractError):
        return 'validation', '题目校验错误：生成内容未通过完整性、评分或重复题检查，请重试。'
    if isinstance(error, SourceSelectionError):
        return 'validation', '参考来源核验错误：模型返回的筛选结果无效，请重试研究；未核验来源不会使用。'
    if isinstance(error, JobError):
        return 'request', str(error)
    return 'program', '本程序错误：处理任务时发生内部异常，请重试；持续失败请联系维护人员。'


def retryable_failure(error):
    """Only known transport failures; content, permissions and conflicts stop."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code in TRANSIENT_HTTP
    if isinstance(error, JobError) and getattr(error, 'failure_code', None) == 'model_unavailable':
        cause = error.__cause__
        return cause is not None and retryable_failure(cause)
    return isinstance(error, (JobDeadlineExceeded, TimeoutError, urllib.error.URLError))


def public_job(row, include_result=True):
    result = {name: row[name] for name in ('id', 'user_id', 'operation', 'status',
                                          'created_ms', 'updated_ms', 'error', 'response_status')}
    body = json.loads(row['body'])
    result['key'] = body.get('key')
    result['node_id'] = (body.get('node') or {}).get('id')
    result['round_id'] = body.get('round_id')
    if include_result and row['status'] == 'succeeded' and row['result'] is not None:
        result['result'] = json.loads(row['result'])
    if 'result' in row.keys() and row['status'] == 'failed' and row['result']:
        result['error_category'] = json.loads(row['result']).get('error_category', 'unknown')
    return result


def _summary_title(connection, user_id, key, cache):
    """Read only the current user's document title, caching within one summary query."""
    if not isinstance(key, str):
        return document_title(None)
    if key not in cache:
        if not isinstance(user_id, str) or not key.startswith(user_id + '/'):
            cache[key] = document_title(None)
        else:
            record = connection.execute(
                'SELECT value FROM documents WHERE key=?', (key,)
            ).fetchone()
            try:
                material = json.loads(record['value']) if record and record['value'] else None
            except (ValueError, TypeError):
                material = None
            cache[key] = document_title(material)
    return cache[key]


class JobQueue:
    def __init__(self, store, execute, workers=2, limit=64, *,
                 node_timeout=NODE_EXECUTION_SECONDS, retry_delay=NODE_RETRY_SECONDS,
                 job_timeout=JOB_EXECUTION_SECONDS, quizmap_timeout=QUIZMAP_EXECUTION_SECONDS):
        self.store = store
        self.execute = execute
        self.workers = workers
        self.limit = limit
        self.node_timeout = node_timeout
        self.job_timeout = job_timeout
        self.quizmap_timeout = quizmap_timeout
        self.retry_delay = retry_delay
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.threads = []
        now = int(time.time() * 1000)
        with store.transaction() as connection:
            recovering = connection.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
            # A restarted process cannot prove an upstream request is still alive.
            # Persisted effects are already committed. Resume only a node with
            # remaining retry budget; never restart a still-live business thread.
            connection.execute('''UPDATE jobs SET status='succeeded', result=effect,
                response_status=200, error=NULL, updated_ms=?
                WHERE status='running' AND effect IS NOT NULL''', (now,))
            connection.execute('''UPDATE jobs SET status='queued', error=NULL,
                updated_ms=? WHERE status='running' AND operation='/path/node'
                AND id IN (SELECT job_id FROM job_attempts WHERE attempt<?)''',
                               (now, NODE_MAX_ATTEMPTS))
            connection.execute('''UPDATE jobs SET status='interrupted',
                error='服务已重启，输入和已有结果已保留，请重试', updated_ms=?
                WHERE status='running' ''', (now,))
            for recovered in recovering:
                state = connection.execute('SELECT status FROM jobs WHERE id=?', (recovered['id'],)).fetchone()
                attempt = connection.execute('SELECT attempt FROM job_attempts WHERE job_id=?', (recovered['id'],)).fetchone()
                record_event(connection, recovered['id'], 'restart', '服务重启后恢复任务回执',
                             attempt=attempt['attempt'] if attempt else 0, status=state['status'])
            connection.execute("DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled') AND updated_ms<?",
                               (now - 30 * 86400 * 1000,))

    def timeout_for(self, operation):
        if operation in LEARNING_OPERATIONS:
            return self.node_timeout
        return self.quizmap_timeout if operation == '/path/quizmap' else self.job_timeout

    def _public(self, connection, row, include_result=True):
        result = public_job(row, include_result=include_result)
        attempt = connection.execute('SELECT * FROM job_attempts WHERE job_id=?',
                                     (row['id'],)).fetchone()
        result.update(attempt=attempt['attempt'] if attempt else 0,
                      attempt_started_ms=attempt['started_ms'] if attempt else None,
                      retry_at_ms=attempt['retry_at_ms'] if attempt else None,
                      auto_retry=row['operation'] in LEARNING_OPERATIONS,
                      max_attempts=NODE_MAX_ATTEMPTS if row['operation'] in LEARNING_OPERATIONS else 1,
                      timeout_seconds=self.timeout_for(row['operation']))
        if 'result' in row.keys() and row['result'] and row['status'] != 'succeeded':
            failure = json.loads(row['result'])
            result['failure_phase'] = failure.get('failure_phase')
            if failure.get('error_category'):
                result['error_category'] = failure['error_category']
        return result

    def start(self):
        if self.threads:
            return
        for index in range(self.workers):
            thread = threading.Thread(target=self._worker, name='learning-job-%s' % index, daemon=True)
            self.threads.append(thread)
            thread.start()

    def stop(self, wait=True):
        self.stopping.set()
        self.wake.set()
        if wait:
            for thread in self.threads:
                thread.join(timeout=5)

    def _capacity(self, connection, user_id):
        active = connection.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        own = connection.execute("SELECT count(*) FROM jobs WHERE user_id=? AND status IN ('queued','running')",
                                 (user_id,)).fetchone()[0]
        if active >= self.limit or own >= min(self.limit, 8):
            raise JobError(429, '等待中的任务较多，请在现有任务完成后重试')

    def submit(self, user_id, request_id, operation, body):
        if operation not in OPERATIONS or not isinstance(body, dict):
            raise JobError(400, '不支持的后台操作')
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise JobError(400, '无效的任务回执标识')
        encoded = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        if len(encoded) > 2_000_000:
            raise JobError(413, '任务输入过大，请缩短内容后重试')
        fingerprint = hashlib.sha256((operation + '\n' + encoded).encode()).hexdigest()
        with self.store.transaction() as connection:
            existing = connection.execute('SELECT * FROM jobs WHERE user_id=? AND request_id=?',
                                          (user_id, request_id)).fetchone()
            if existing:
                if existing['fingerprint'] != fingerprint:
                    raise JobError(409, '同一任务回执不能用于不同内容',
                                   error_category='request_id_conflict')
                return self._public(connection, existing)
            self._capacity(connection, user_id)
            job_id = secrets.token_hex(16)
            now = int(time.time() * 1000)
            connection.execute('''INSERT INTO jobs
                (id,user_id,request_id,operation,body,fingerprint,status,created_ms,updated_ms)
                VALUES (?,?,?,?,?,?,'queued',?,?)''',
                               (job_id, user_id, request_id, operation, encoded, fingerprint, now, now))
            row = connection.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            connection.execute('INSERT INTO job_attempts(job_id) VALUES (?)', (job_id,))
            record_event(connection, job_id, 'queued', '任务已进入队列', status='queued')
            result = self._public(connection, row)
        self.wake.set()
        return result

    def details(self, job_id, user_id):
        job = self.get(job_id, user_id)
        with self.store.connection() as connection:
            row = connection.execute('SELECT value FROM job_details WHERE job_id=?', (job_id,)).fetchone()
        details = json.loads(row['value']) if row else {'available': False, 'truncated': False, 'events': []}
        return {'ok': True, 'job': job, 'details': details}

    def get(self, job_id, user_id):
        with self.store.connection() as connection:
            row = connection.execute('SELECT * FROM jobs WHERE id=? AND user_id=?', (job_id, user_id)).fetchone()
            if not row:
                raise JobError(404, '任务不存在或不属于当前用户')
            result = self._public(connection, row)
            progress = connection.execute('SELECT value FROM job_progress WHERE job_id=?', (job_id,)).fetchone()
        if progress:
            result['progress'] = json.loads(progress['value'])
        return result

    def list(self, user_id, key=None):
        result, titles = [], {}
        with self.store.connection() as connection:
            rows = connection.execute('''SELECT id,user_id,operation,status,created_ms,updated_ms,error,response_status,body
                FROM jobs WHERE user_id=? AND (? IS NULL OR json_extract(body,'$.key')=?)
                ORDER BY (status IN ('queued','running')) DESC,created_ms DESC LIMIT 100''',
                                      (user_id, key, key)).fetchall()
            for row in rows:
                job_key = json.loads(row['body']).get('key')
                if key is not None and job_key != key:
                    continue
                job = self._public(connection, row, include_result=False)
                job['title'] = _summary_title(connection, user_id, job_key, titles)
                result.append(job)
        return result

    def recent(self, user_id, limit=8):
        """One row per conversation; prefer active work, otherwise the newest call.

        Raw receipts remain available to polling and retry clients. Group before
        applying the display limit, so a long conversation cannot hide others.
        """
        result, seen, titles = [], set(), {}
        with self.store.connection() as connection:
            rows = connection.execute('''SELECT id,user_id,operation,status,created_ms,
                updated_ms,error,response_status,body FROM jobs WHERE user_id=?
                ORDER BY (status IN ('queued','running')) DESC,created_ms DESC,rowid DESC''', (user_id,))
            for row in rows:
                body = json.loads(row['body'])
                key = body.get('key') or row['id']
                if not isinstance(key, str):
                    key = row['id']
                if key in seen:
                    continue
                seen.add(key)
                job = self._public(connection, row, include_result=False)
                job['title'] = _summary_title(connection, user_id, body.get('key'), titles)
                result.append(job)
                if len(result) >= limit:
                    break
        return result

    def retry(self, job_id, user_id):
        with self.store.transaction() as connection:
            row = connection.execute('SELECT * FROM jobs WHERE id=? AND user_id=?', (job_id, user_id)).fetchone()
            if not row:
                raise JobError(404, '任务不存在或不属于当前用户')
            if row['status'] not in ('failed', 'interrupted'):
                return self._public(connection, row)
            self._capacity(connection, user_id)
            connection.execute('DELETE FROM job_progress WHERE job_id=?', (job_id,))
            # Only an explicit manual retry creates a new bounded retry cycle.
            connection.execute('''INSERT INTO job_attempts(job_id,attempt) VALUES (?,0)
                ON CONFLICT(job_id) DO UPDATE SET attempt=0,started_ms=NULL,retry_at_ms=NULL''', (job_id,))
            connection.execute("UPDATE jobs SET status='queued',error=NULL,result=NULL,response_status=NULL,updated_ms=? WHERE id=?",
                               (int(time.time() * 1000), job_id))
            record_event(connection, job_id, 'manual_retry', '用户重试，开始新一轮执行', status='queued')
            row = connection.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            result = self._public(connection, row)
        self.wake.set()
        return result

    def _claim(self):
        with self.store.transaction() as connection:
            now = int(time.time() * 1000)
            row = connection.execute('''SELECT jobs.* FROM jobs LEFT JOIN job_attempts a ON a.job_id=jobs.id
                WHERE status='queued' AND (a.retry_at_ms IS NULL OR a.retry_at_ms<=?)
                ORDER BY created_ms,id LIMIT 1''', (now,)).fetchone()
            if row:
                connection.execute("UPDATE jobs SET status='running',updated_ms=? WHERE id=?",
                                   (now, row['id']))
                connection.execute('''INSERT INTO job_attempts(job_id,attempt,started_ms) VALUES (?,1,?)
                    ON CONFLICT(job_id) DO UPDATE SET attempt=attempt+1,started_ms=excluded.started_ms,retry_at_ms=NULL''',
                                   (row['id'], now))
                attempt = connection.execute('SELECT attempt FROM job_attempts WHERE job_id=?', (row['id'],)).fetchone()[0]
                record_event(connection, row['id'], 'start', '开始执行任务', attempt=attempt, status='running')
                return {**dict(row), 'attempt': attempt}
        return None

    def _worker(self):
        while not self.stopping.is_set():
            try:
                row = self._claim()
            except Exception:
                # A temporary storage fault must not permanently lose a worker.
                self.stopping.wait(1)
                continue
            if row is None:
                self.wake.wait(1)
                self.wake.clear()
                continue
            status, result = 500, {'error': '后台任务未完成，请重试'}
            can_retry = False
            error_recorded = False
            try:
                self.store.local.job_id = row['id']
                self.store.local.job_attempt = row['attempt']
                self.store.local.phase = '准备执行任务'
                if row['effect']:
                    status, result = 200, json.loads(row['effect'])
                else:
                    budget = execution_budget(self.timeout_for(row['operation']))
                    with budget:
                        status, result = self.execute(row['user_id'], row['operation'], json.loads(row['body']))
                        check_deadline()
            except Exception as error:
                log_job_failure(row['id'], row['operation'], error)
                status = 503 if isinstance(error, sqlite3.Error) else getattr(error, 'status', 502)
                category, message = failure_detail(error)
                phase = getattr(self.store.local, 'phase', '任务处理')
                if category == 'deadline':
                    message += ' 总时限：%s 秒。' % self.timeout_for(row['operation'])
                    retrying = row['operation'] in LEARNING_OPERATIONS and row['attempt'] < NODE_MAX_ATTEMPTS
                    message += ' 阶段：%s。尝试 %s/%s。%s' % (
                        phase, row['attempt'], NODE_MAX_ATTEMPTS if row['operation'] in LEARNING_OPERATIONS else 1,
                        '等待自动重试。' if retrying else '本次执行已停止，可手动重试。')
                result = {'error': message, 'error_category': category, 'failure_phase': phase}
                result = sanitize(result, self.store.diagnostic_secrets)
                try:
                    self.store.job_event('error', message, error_category=category, frames=locations(error))
                    error_recorded = True
                except Exception:
                    pass
                can_retry = row['operation'] in LEARNING_OPERATIONS and retryable_failure(error)
            finally:
                phase = getattr(self.store.local, 'phase', '任务处理')
                del self.store.local.job_id
                for name in ('job_attempt', 'phase'):
                    if hasattr(self.store.local, name):
                        delattr(self.store.local, name)
            succeeded = 200 <= status < 300 and not result.get('error')
            if result.get('error'):
                result = {**result, 'error': sanitize(result['error'], self.store.diagnostic_secrets)}
            if not succeeded:
                result = {**result, 'failure_phase': result.get('failure_phase') or phase}
            while not self.stopping.is_set():
                try:
                    with self.store.transaction() as connection:
                        current = connection.execute('SELECT effect FROM jobs WHERE id=?', (row['id'],)).fetchone()
                        # Commit evidence outranks any post-commit exception.
                        if current and current['effect']:
                            status, result, succeeded = 200, json.loads(current['effect']), True
                        retrying = can_retry and not succeeded and row['attempt'] < NODE_MAX_ATTEMPTS
                        now = int(time.time() * 1000)
                        connection.execute('''UPDATE jobs SET status=?,result=?,error=?,response_status=?,updated_ms=?
                            WHERE id=? AND status='running' ''',
                                           ('succeeded' if succeeded else ('queued' if retrying else 'failed'),
                                            json.dumps(result, ensure_ascii=False),
                                            None if succeeded else result.get('error', '任务失败，请重试'), status, now, row['id']))
                        if retrying:
                            connection.execute('UPDATE job_attempts SET retry_at_ms=? WHERE job_id=?',
                                               (now + int(self.retry_delay * 1000), row['id']))
                            connection.execute('DELETE FROM job_progress WHERE job_id=?', (row['id'],))
                        if not succeeded and not error_recorded:
                            record_event(connection, row['id'], 'error', result.get('error', '任务失败'),
                                         attempt=row['attempt'], phase=result.get('failure_phase'),
                                         error_category=result.get('error_category', 'request'))
                        record_event(connection, row['id'], 'retry' if retrying else 'status',
                                     '等待自动重试' if retrying else ('任务已完成' if succeeded else '任务执行失败'),
                                     attempt=row['attempt'], status='queued' if retrying else ('succeeded' if succeeded else 'failed'),
                                     retry_at_ms=now + int(self.retry_delay * 1000) if retrying else None)
                    break
                except Exception:
                    # Keep the result in this worker until storage recovers;
                    # never return to the queue and leave a job silently running.
                    self.stopping.wait(1)
