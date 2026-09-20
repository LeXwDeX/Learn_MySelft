"""Bounded, user-owned background work with persistent receipts and results."""
import hashlib
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
from quiz_harness import QuizContractError
from research_sources import SourceSelectionError

OPERATIONS = frozenset({'/path/intake', '/path/research', '/path/plan', '/path/node',
                        '/path/requiz', '/path/quizmap', '/path/refine', '/path/gaps', '/path/quiz'})
TERMINAL = frozenset({'succeeded', 'failed', 'interrupted', 'cancelled'})
REQUEST_ID = re.compile(r'^[A-Za-z0-9:_-]{8,120}$')
LOGGER = logging.getLogger(__name__)


def short_title(value):
    """Keep model titles plain, single-line and at most ten Unicode characters."""
    if not isinstance(value, str):
        return ''
    return re.sub(r'[\s*#`<>"\[\]【】]+', '', value)[:10]


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
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def failure_detail(error):
    """Classify at the exception boundary, never expose upstream bodies or keys."""
    if isinstance(error, urllib.error.HTTPError):
        return 'remote_api', '远程服务端错误（API %s）：模型服务暂时不可用或拒绝请求，可稍后重试。' % error.code
    if isinstance(error, (TimeoutError, urllib.error.URLError)):
        return 'network', '网络连接或超时错误：无法完成与远程模型服务的通信，可稍后重试。'
    if isinstance(error, QuizContractError):
        return 'validation', '题目校验错误：生成内容未通过完整性、评分或重复题检查，请重试。'
    if isinstance(error, SourceSelectionError):
        return 'validation', '参考来源核验错误：模型返回的筛选结果无效，请重试研究；未核验来源不会使用。'
    if isinstance(error, JobError):
        return 'request', str(error)
    return 'program', '本程序错误：处理任务时发生内部异常，请重试；持续失败请联系维护人员。'


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


class JobQueue:
    def __init__(self, store, execute, workers=2, limit=64):
        self.store = store
        self.execute = execute
        self.workers = workers
        self.limit = limit
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.threads = []
        now = int(time.time() * 1000)
        with store.transaction() as connection:
            # A restarted process cannot prove an upstream request is still alive.
            # Persisted effects are already committed; other running jobs need an
            # explicit retry, which keeps their stable idempotency receipt.
            connection.execute('''UPDATE jobs SET status='succeeded', result=effect,
                response_status=200, error=NULL, updated_ms=?
                WHERE status='running' AND effect IS NOT NULL''', (now,))
            connection.execute('''UPDATE jobs SET status='interrupted',
                error='服务已重启，输入和已有结果已保留，请重试', updated_ms=?
                WHERE status='running' ''', (now,))
            connection.execute("DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled') AND updated_ms<?",
                               (now - 30 * 86400 * 1000,))

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
                    raise JobError(409, '同一任务回执不能用于不同内容')
                return public_job(existing)
            self._capacity(connection, user_id)
            job_id = secrets.token_hex(16)
            now = int(time.time() * 1000)
            connection.execute('''INSERT INTO jobs
                (id,user_id,request_id,operation,body,fingerprint,status,created_ms,updated_ms)
                VALUES (?,?,?,?,?,?,'queued',?,?)''',
                               (job_id, user_id, request_id, operation, encoded, fingerprint, now, now))
            row = connection.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        self.wake.set()
        return public_job(row)

    def get(self, job_id, user_id):
        with self.store.connection() as connection:
            row = connection.execute('SELECT * FROM jobs WHERE id=? AND user_id=?', (job_id, user_id)).fetchone()
        if not row:
            raise JobError(404, '任务不存在或不属于当前用户')
        result = public_job(row)
        with self.store.connection() as connection:
            progress = connection.execute('SELECT value FROM job_progress WHERE job_id=?', (job_id,)).fetchone()
        if progress:
            result['progress'] = json.loads(progress['value'])
        return result

    def list(self, user_id, key=None):
        with self.store.connection() as connection:
            rows = connection.execute('''SELECT id,user_id,operation,status,created_ms,updated_ms,error,response_status,body
                FROM jobs WHERE user_id=? AND (? IS NULL OR json_extract(body,'$.key')=?)
                ORDER BY (status IN ('queued','running')) DESC,created_ms DESC LIMIT 100''',
                                      (user_id, key, key)).fetchall()
        return [public_job(row, include_result=False) for row in rows if key is None or json.loads(row['body']).get('key') == key]

    def recent(self, user_id, limit=8):
        """One row per conversation; prefer active work, otherwise the newest call.

        Raw receipts remain available to polling and retry clients. Group before
        applying the display limit, so a long conversation cannot hide others.
        """
        result, seen = [], set()
        with self.store.connection() as connection:
            titles = {row['key']: row['title'] for row in connection.execute(
                'SELECT key,title FROM task_titles WHERE user_id=?', (user_id,))}
            rows = connection.execute('''SELECT id,user_id,operation,status,created_ms,
                updated_ms,error,response_status,body FROM jobs WHERE user_id=?
                ORDER BY (status IN ('queued','running')) DESC,created_ms DESC,rowid DESC''', (user_id,))
            for row in rows:
                body = json.loads(row['body'])
                key = body.get('key') or row['id']
                if key in seen:
                    continue
                seen.add(key)
                job = public_job(row, include_result=False)
                job['title'] = short_title(titles.get(key)) or short_title(body.get('topic')) or '学习任务'
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
                return public_job(row)
            self._capacity(connection, user_id)
            connection.execute('DELETE FROM job_progress WHERE job_id=?', (job_id,))
            connection.execute("UPDATE jobs SET status='queued',error=NULL,result=NULL,response_status=NULL,updated_ms=? WHERE id=?",
                               (int(time.time() * 1000), job_id))
            row = connection.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        self.wake.set()
        return public_job(row)

    def _claim(self):
        with self.store.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_ms,id LIMIT 1").fetchone()
            if row:
                connection.execute("UPDATE jobs SET status='running',updated_ms=? WHERE id=?",
                                   (int(time.time() * 1000), row['id']))
                return dict(row)
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
            try:
                self.store.local.job_id = row['id']
                if row['effect']:
                    status, result = 200, json.loads(row['effect'])
                else:
                    status, result = self.execute(row['user_id'], row['operation'], json.loads(row['body']))
            except Exception as error:
                log_job_failure(row['id'], row['operation'], error)
                status = getattr(error, 'status', 502)
                category, message = failure_detail(error)
                result = {'error': message, 'error_category': category}
            finally:
                del self.store.local.job_id
            succeeded = 200 <= status < 300 and not result.get('error')
            while not self.stopping.is_set():
                try:
                    with self.store.transaction() as connection:
                        title = short_title(result.get('task_title')) if succeeded else ''
                        key = json.loads(row['body']).get('key')
                        if title and key:
                            connection.execute('''INSERT INTO task_titles(user_id,key,title) VALUES (?,?,?)
                                ON CONFLICT(user_id,key) DO UPDATE SET title=excluded.title''',
                                               (row['user_id'], key, title))
                        connection.execute('''UPDATE jobs SET status=?,result=?,error=?,response_status=?,updated_ms=?
                            WHERE id=? AND status='running' ''',
                                           ('succeeded' if succeeded else 'failed', json.dumps(result, ensure_ascii=False),
                                            None if succeeded else result.get('error', '任务失败，请重试'), status,
                                            int(time.time() * 1000), row['id']))
                    break
                except Exception:
                    # Keep the result in this worker until storage recovers;
                    # never return to the queue and leave a job silently running.
                    self.stopping.wait(1)
