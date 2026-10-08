"""Node retries retain receipts and stop before another execution can start."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from background_jobs import JobError, JobQueue
from job_execution import JobDeadlineExceeded, check_deadline
from quiz_harness import QuizContractError
from state_store import StateStore


class NodeJobRetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = StateStore(self.temp.name)

    def queue(self, execute, **kw):
        queue = JobQueue(self.store, execute, workers=2, retry_delay=.03, **kw)
        self.addCleanup(queue.stop)
        return queue

    def wait(self, queue, receipt, status):
        until = time.monotonic() + 4
        while time.monotonic() < until:
            result = queue.get(receipt['id'], 'u0')
            if result['status'] == status:
                return result
            time.sleep(.01)
        self.fail(str(result))

    def submit(self, queue, operation='/path/node'):
        return queue.submit('u0', 'stable-request', operation, {'key':'u0/material','node':{'id':'n1'}})

    def test_transient_retry_keeps_id_and_does_not_overlap(self):
        active = 0
        maximum = 0
        ids = []
        attempts = []
        guard = threading.Lock()

        def execute(*args):
            nonlocal active, maximum
            with guard:
                active += 1
                maximum = max(maximum, active)
                ids.append(self.store.local.job_id)
            try:
                current = queue.get(ids[-1], 'u0')
                attempts.append(current['attempt'])
                self.store.job_progress(1, '生成学习材料', total=5)
                time.sleep(.02)
                if len(ids) == 1:
                    raise urllib.error.HTTPError('https://example.invalid',503,'secret',{},None)
                return 200, {'notes':'valid'}
            finally:
                with guard:
                    active -= 1

        queue = self.queue(execute)
        receipt = self.submit(queue)
        queue.start()
        done = self.wait(queue, receipt, 'succeeded')
        self.assertEqual(ids, [receipt['id'], receipt['id']])
        self.assertEqual(attempts, [1, 2])
        self.assertEqual(maximum, 1)
        self.assertEqual(done['created_ms'], receipt['created_ms'])
        self.assertGreaterEqual(done['attempt_started_ms'], done['created_ms'])
        self.assertEqual(done['progress']['total'], 5)
        self.assertEqual(self.submit(queue)['id'], receipt['id'])

    def test_repeated_timeout_has_terminal_state_and_poll_cannot_reset_budget(self):
        calls = []
        def execute(*args):
            calls.append(1)
            raise TimeoutError('private transport')
        queue = self.queue(execute)
        receipt = self.submit(queue)
        queue.start()
        failed = self.wait(queue, receipt, 'failed')
        self.assertEqual(failed['attempt'], 2)
        self.assertEqual(failed['error_category'], 'network')
        self.assertNotIn('private', failed['error'])
        for _ in range(3):
            self.assertEqual(self.submit(queue)['status'], 'failed')
            queue.get(receipt['id'], 'u0')
        self.assertEqual(len(calls), 2)
        queue.stop()
        resumed = JobQueue(self.store, execute, retry_delay=.03)
        self.addCleanup(resumed.stop)
        resumed.start()
        self.assertEqual(resumed.get(receipt['id'], 'u0')['status'], 'failed')
        self.assertEqual(resumed.get(receipt['id'], 'u0')['attempt'], 2)
        self.assertEqual(len(calls), 2)

    def test_unsafe_failures_and_non_node_operations_do_not_auto_retry(self):
        cases = [
            ('/path/node', JobError(403,'停用')),
            ('/path/node', JobError(404,'删除')),
            ('/path/node', JobError(409,'冲突')),
            ('/path/node', JobError(503,'业务检查不可用')),
            ('/path/node', QuizContractError('invalid content')),
            ('/path/node', ValueError('program')),
            ('/path/node', urllib.error.HTTPError('https://example.invalid',401,'secret',{},None)),
            ('/path/quiz', TimeoutError()),
            ('/path/requiz', urllib.error.URLError('network')),
            ('/path/refine', TimeoutError()),
        ]
        for index, (operation, error) in enumerate(cases):
            with self.subTest(operation=operation, error=type(error).__name__):
                calls=[]
                def execute(*args):
                    calls.append(1)
                    raise error
                queue=self.queue(execute)
                receipt=queue.submit('u0', 'request-case-%d'%index, operation, {'key':'u0/material'})
                queue.start()
                failed=self.wait(queue,receipt,'failed')
                self.assertEqual(failed['attempt'],1)
                self.assertEqual(len(calls),1)
                queue.stop()

    def test_backoff_survives_restart_and_attempt_limit_is_not_reset(self):
        calls=[]
        queue=self.queue(lambda *args:(200,{}))
        receipt=self.submit(queue)
        queue._claim()
        restarted=JobQueue(self.store, lambda *args:(calls.append(1) or 200,{}), retry_delay=.03)
        self.addCleanup(restarted.stop)
        self.assertEqual(restarted.get(receipt['id'],'u0')['status'],'queued')
        self.assertEqual(restarted._claim()['attempt'],2)
        again=JobQueue(self.store, lambda *args:self.fail('budget exhausted'))
        self.addCleanup(again.stop)
        self.assertEqual(again.get(receipt['id'],'u0')['status'],'interrupted')
        self.assertEqual(again.get(receipt['id'],'u0')['attempt'],2)
        explicit=again.retry(receipt['id'],'u0')
        self.assertEqual(explicit['attempt'],0)
        self.assertIsNone(explicit['attempt_started_ms'])
        self.assertEqual(explicit['id'],receipt['id'])
        with self.assertRaises(JobError):
            again.retry(receipt['id'],'other')

    def test_deadline_exits_before_retry_and_does_not_commit_late(self):
        calls=[]
        def execute(*args):
            calls.append(1)
            time.sleep(.04)
            check_deadline()
            self.store.put('u0/late','must not commit')
            return 200,{}
        queue=self.queue(execute,node_timeout=.015)
        receipt=self.submit(queue)
        queue.start()
        failed=self.wait(queue,receipt,'failed')
        self.assertEqual(failed['error_category'],'deadline')
        self.assertEqual(failed['response_status'],504)
        self.assertEqual(len(calls),2)
        self.assertIsNone(self.store.record('u0/late'))

    def test_committed_effect_wins_even_if_execute_raises_after_commit(self):
        calls=[]
        def execute(*args):
            calls.append(1)
            with self.store.transaction():
                self.store.put('u0/committed','preserved')
                self.store.record_job_effect({'issued_round':'same'})
            raise JobDeadlineExceeded()
        queue=self.queue(execute)
        receipt=self.submit(queue)
        queue.start()
        done=self.wait(queue,receipt,'succeeded')
        self.assertEqual(done['result'],{'issued_round':'same'})
        self.assertEqual(len(calls),1)
        self.assertEqual(self.store.record('u0/committed')['value'],'preserved')

    def test_version_one_migration_preserves_documents_and_old_running_budget(self):
        queue=self.queue(lambda *args:(200,{}))
        receipt=self.submit(queue)
        self.store.put('u0/known',json.dumps({'unknown_field':17}))
        before=self.store.record('u0/known')
        with self.store.transaction() as connection:
            connection.execute('DROP TABLE job_attempts')
            connection.execute('PRAGMA user_version=1')
            connection.execute("UPDATE jobs SET status='running' WHERE id=?",(receipt['id'],))
        migrated=StateStore(self.temp.name)
        self.assertEqual(migrated.record('u0/known'),before)
        with migrated.connection() as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0],1)
            self.assertEqual(connection.execute('SELECT attempt FROM job_attempts WHERE job_id=?',(receipt['id'],)).fetchone()[0],1)
            self.assertEqual(connection.execute('PRAGMA quick_check').fetchone()[0],'ok')


if __name__=='__main__':
    unittest.main()
