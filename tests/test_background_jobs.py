"""Durable receipts, bounded queues, recovery, ownership and unlocked upstream IO."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch
import test_state_regressions
from state_store import StateStore
from background_jobs import JobQueue, JobError, short_title, failure_detail
import test_user_isolation as isolation

study = test_state_regressions.study


class QueueTests(unittest.TestCase):
    def test_progress_persists_with_owner_isolation_and_retry_reset(self):
        entered, release = threading.Event(), threading.Event()
        def execute(*args):
            self.store.job_progress(3, '校验题目与评分标准', 2)
            entered.set(); release.wait(3)
            raise urllib.error.HTTPError('https://model.invalid', 503, 'private body', {}, None)
        queue = JobQueue(self.store, execute, workers=1)
        self.addCleanup(queue.stop)
        job = queue.submit('u0', 'progress-test', '/path/requiz', {'key': 'u0/test'})
        queue.start(); self.assertTrue(entered.wait(3))
        pending = queue.get(job['id'], 'u0')
        self.assertEqual(pending['progress'], {'step': 3, 'total': 4, 'label': '校验题目与评分标准', 'attempt': 2})
        with self.assertRaises(JobError): queue.get(job['id'], 'other')
        release.set()
        failed = self.wait_status(queue, job['id'], 'failed')
        self.assertEqual(failed['error_category'], 'remote_api')
        self.assertIn('API 503', failed['error'])
        self.assertNotIn('private body', failed['error'])
        queue.stop()
        restarted = JobQueue(StateStore(self.temp.name), lambda *args: (200, {}))
        self.assertEqual(restarted.get(job['id'], 'u0')['progress']['step'], 3)
        restarted.retry(job['id'], 'u0')
        self.assertNotIn('progress', restarted.get(job['id'], 'u0'))

    def test_error_categories_do_not_leak_exception_text(self):
        for error, category in [(TimeoutError('secret'), 'network'),
                                (urllib.error.URLError('secret'), 'network'),
                                (study.harness.QuizContractError('secret'), 'validation'),
                                (ValueError('secret'), 'program')]:
            with self.subTest(category=category):
                actual, message = failure_detail(error)
                self.assertEqual(actual, category)
                self.assertNotIn('secret', message)

    def test_recent_groups_conversations_and_keeps_raw_receipts(self):
        queue = JobQueue(self.store, lambda *args: (200, {}))
        for index in range(105):
            key = 'u0/other' if index == 0 else 'u0/conversation'
            job = queue.submit('u0', 'request-%04d' % index, '/path/intake', {'key': key, 'topic': '原始输入'})
            with self.store.transaction() as connection:
                connection.execute("UPDATE jobs SET status='succeeded',created_ms=? WHERE id=?", (index, job['id']))
        with self.store.transaction() as connection:
            connection.execute('INSERT INTO task_titles VALUES (?,?,?)', ('u0', 'u0/conversation', '日语基础语法'))
        self.assertEqual(len(queue.list('u0', 'u0/other')), 1, 'filter by material before limiting job history')
        rows = queue.recent('u0')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['id'], job['id'])
        self.assertEqual(rows[0]['title'], '日语基础语法')
        self.assertEqual(queue.recent('other'), [])
        self.assertEqual(len(queue.list('u0')), 100)
        active = queue.submit('u0', 'request-active-new', '/path/node', {'key': 'u0/other'})
        self.assertEqual(queue.recent('u0')[0]['id'], active['id'])
        with self.store.transaction() as connection:
            connection.execute("UPDATE jobs SET status='failed' WHERE id=?", (active['id'],))
        retry = queue.retry(active['id'], 'u0')
        self.assertEqual(queue.recent('u0')[0]['id'], retry['id'])

    def test_model_title_persists_across_queue_restart(self):
        queue = JobQueue(self.store, lambda *args: (200, {'task_title': '**日语基础语法系统学习目标**'}), workers=1)
        self.addCleanup(queue.stop)
        job = queue.submit('u0', 'request-title', '/path/intake', {'key': 'u0/conversation'})
        queue.start()
        self.wait_status(queue, job['id'])
        queue.stop()
        restarted = JobQueue(StateStore(self.temp.name), lambda *args: (200, {}))
        title = restarted.recent('u0')[0]['title']
        self.assertEqual(title, '日语基础语法系统学习')
        self.assertLessEqual(len(title), 10)
        self.assertEqual(short_title(None), '')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = StateStore(self.temp.name)

    def wait_status(self, queue, job_id, expected='succeeded'):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = queue.get(job_id, 'u0')
            if job['status'] == expected:
                return job
            time.sleep(.01)
        self.fail(str(job))

    def test_duplicate_receipt_runs_once_and_capacity_is_bounded(self):
        count = []
        queue = JobQueue(self.store, lambda *args: (count.append(args) or 200, {'done': True}), workers=1, limit=1)
        self.addCleanup(queue.stop)
        first = queue.submit('u0', 'request-one', '/path/intake', {'key': 'u0/topic'})
        self.assertEqual(queue.submit('u0', 'request-one', '/path/intake', {'key': 'u0/topic'})['id'], first['id'])
        with self.assertRaises(JobError) as conflict:
            queue.submit('u0', 'request-one', '/path/intake', {'key': 'u0/other'})
        self.assertEqual(conflict.exception.status, 409)
        with self.assertRaises(JobError) as full:
            queue.submit('u0', 'request-two', '/path/intake', {'key': 'u0/other'})
        self.assertEqual(full.exception.status, 429)
        queue.start()
        self.wait_status(queue, first['id'])
        self.assertEqual(len(count), 1)
        with self.assertRaises(JobError):
            queue.get(first['id'], 'someone-else')

    def test_active_work_stays_visible_without_loading_large_results(self):
        queue = JobQueue(self.store, lambda *args: (200, {}), limit=2)
        active = queue.submit('u0', 'request-active', '/path/intake', {'key': 'u0/active'})
        done = queue.submit('u0', 'request-done', '/path/intake', {'key': 'u0/done'})
        with self.store.transaction() as connection:
            connection.execute("UPDATE jobs SET status='succeeded',created_ms=created_ms+1000,result=? WHERE id=?",
                               ('not-loaded-by-summary', done['id']))
        rows = queue.list('u0')
        self.assertEqual(rows[0]['id'], active['id'])
        self.assertNotIn('result', rows[1])

    def test_restart_marks_unfinished_work_and_preserves_queued_work(self):
        queue = JobQueue(self.store, lambda *args: (200, {'answer': 'done'}), workers=1)
        interrupted = queue.submit('u0', 'request-first', '/path/intake', {'key': 'u0/one'})
        queue._claim()
        queued = queue.submit('u0', 'request-second', '/path/intake', {'key': 'u0/two'})
        restarted = JobQueue(self.store, lambda *args: (200, {'answer': 'recovered'}), workers=1)
        self.addCleanup(restarted.stop)
        self.assertEqual(restarted.get(interrupted['id'], 'u0')['status'], 'interrupted')
        self.assertEqual(restarted.get(queued['id'], 'u0')['status'], 'queued')
        restarted.retry(interrupted['id'], 'u0')
        restarted.start()
        self.wait_status(restarted, interrupted['id'])
        self.wait_status(restarted, queued['id'])

    def test_effect_and_document_commit_together_and_survive_crash(self):
        queue = JobQueue(self.store, lambda *args: self.fail('Committed effect must not rerun'))
        job = queue.submit('u0', 'request-effect', '/path/refine', {'key': 'u0/one'})
        queue._claim()
        self.store.local.job_id = job['id']
        with self.assertRaises(OSError):
            with self.store.transaction():
                self.store.put('u0/one', 'new')
                self.store.record_job_effect({'plan': 'new'})
                raise OSError('failure before commit')
        self.assertIsNone(self.store.record('u0/one'))
        with self.store.transaction():
            self.store.put('u0/one', 'new')
            self.store.record_job_effect({'plan': 'new'})
        del self.store.local.job_id
        restarted = JobQueue(StateStore(self.temp.name), lambda *args: self.fail('Must not execute again'))
        result = restarted.get(job['id'], 'u0')
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['result'], {'plan': 'new'})


class JobHttpTests(unittest.TestCase):
    # Reuse only the fixture/request helpers, without rerunning inherited tests.
    setUp = isolation.UserIsolationTests.setUp
    stop_server = isolation.UserIsolationTests.stop_server
    request = isolation.UserIsolationTests.request
    login = isolation.UserIsolationTests.login
    create = isolation.UserIsolationTests.create
    put = isolation.UserIsolationTests.put

    def stop_jobs(self):
        queue = study._JOB_QUEUES.pop(str(Path(study.STATE_DIR).absolute()), None)
        if queue:
            queue.stop()

    def test_http_receipt_ownership_and_io_does_not_block_saving(self):
        self.addCleanup(self.stop_jobs)
        key = self.put(self.alice, self.alice_cookie)
        waiting, release = threading.Event(), threading.Event()
        def upstream(*args, **kwargs):
            waiting.set()
            if not release.wait(5):
                raise TimeoutError('test upstream not released')
            return 'ASK: 你现在的基础如何？'
        with patch.object(study, '_upstream_nonempty', side_effect=upstream):
            status, accepted, _ = self.request('/jobs', {'request_id': 'test-http-job', 'operation': '/path/intake',
                'body': {'key': key, 'topic': '数学', 'history': []}}, self.alice_cookie)
            self.assertEqual(status, 202, accepted)
            job_id = accepted['job']['id']
            self.assertTrue(waiting.wait(2))
            try:
                begin = time.monotonic()
                self.assertEqual(self.request('/state/put', {'entries': {self.bob + '/metadata': 'saved'}}, self.bob_cookie)[0], 200)
                self.assertLess(time.monotonic() - begin, 1)
                self.assertEqual(self.request('/jobs/' + job_id, cookie=self.bob_cookie)[0], 404)
                self.assertEqual(self.request('/jobs/' + job_id, cookie=self.admin, target=self.alice)[0], 200)
                self.assertEqual(self.request('/jobs', {'request_id': 'foreign-http-job', 'operation': '/path/intake',
                    'body': {'key': key, 'topic': 'x'}}, self.bob_cookie)[0], 403)
            finally:
                release.set()
            for _ in range(100):
                result = self.request('/jobs/' + job_id, cookie=self.alice_cookie)[1]['job']
                if result['status'] == 'succeeded':
                    break
                time.sleep(.01)
            self.assertEqual(result['result']['question'], '你现在的基础如何？')

    def test_deleted_material_rejects_new_jobs_and_stale_save(self):
        self.addCleanup(self.stop_jobs)
        key = self.put(self.alice, self.alice_cookie)
        self.request('/state/delete', {'keys': [key], 'password': 'learner-password'}, self.alice_cookie)
        self.assertEqual(self.request('/state/put', {'entries': {key: '{"topic":"stale"}'}}, self.alice_cookie)[0], 409)
        self.assertEqual(self.request('/jobs', {'request_id': 'deleted-job', 'operation': '/path/node',
            'body': {'key': key, 'node': {'id': 'n1'}}}, self.alice_cookie)[0], 404)
