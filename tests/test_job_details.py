"""Task budgets, bounded diagnostics, secret removal and owner authorization."""
import json
import sqlite3
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from background_jobs import JobQueue, JobError, OPERATIONS
from job_execution import JobDeadlineExceeded, execution_budget
from job_details import MAX_BYTES, MAX_EVENTS
from model_client import ModelClient
from state_store import StateStore
import model_transport
import test_user_isolation as isolation


class JobDetailsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = StateStore(self.directory.name)

    def receipt(self, queue, operation='/path/plan', request='details-request'):
        return queue.submit('u0', request, operation, {'key': 'u0/example'})

    def wait(self, queue, receipt, expected):
        until = time.monotonic() + 4
        while time.monotonic() < until:
            job = queue.get(receipt['id'], 'u0')
            if job['status'] == expected:
                return job
            time.sleep(.005)
        self.fail(str(job))

    def test_operation_budgets_keep_quizmap_and_scene_at_ten_minutes(self):
        queue = JobQueue(self.store, lambda *args: (200, {}), limit=64)
        for index, operation in enumerate(sorted(OPERATIONS)):
            # Spread owners to respect the existing per-user queue bound.
            receipt = queue.submit('u%d' % index, 'request-budget-%d' % index,
                                   operation, {'key': 'u%d/example' % index})
            self.assertEqual(receipt['timeout_seconds'], 600 if operation in ('/path/quizmap','/path/node/scene') else 300)
            learning = operation in ('/path/node', '/path/node/scene')
            self.assertEqual(receipt['auto_retry'], learning)
            self.assertEqual(receipt['max_attempts'], 2 if learning else 1)

    def test_each_operation_rolls_back_when_budget_expires_before_commit(self):
        advance = [0.0]
        clock = SimpleNamespace(monotonic=lambda: time.monotonic() + advance[0])

        def execute(user_id, operation, body):
            self.store.job_progress(3, '独立验题')
            with self.store.transaction():
                self.store.put(body['key'], 'late result')
                self.store.record_job_effect({'saved': True})
                advance[0] += 301
            return 200, {'saved': True}

        queue = JobQueue(self.store, execute, workers=1, job_timeout=300,
                         node_timeout=300, quizmap_timeout=300, scene_timeout=300, retry_delay=.005)
        # Replace only job_execution's clock. Queue waits and this test's wait
        # helper continue to use the real wall clock.
        with patch('job_execution.time', clock):
            try:
                queue.start()
                for index, operation in enumerate(sorted(OPERATIONS)):
                    with self.subTest(operation=operation), self.assertLogs('background_jobs', level='ERROR'):
                        job = self.receipt(queue, operation, 'request-rollback-%d' % index)
                        failed = self.wait(queue, job, 'failed')
                        self.assertEqual(failed['error_category'], 'deadline')
                        self.assertEqual(failed['failure_phase'], '保存学习资料')
                        self.assertIn('执行时限', failed['error'])
                        self.assertIsNone(self.store.record('u0/example'))
                        details = queue.details(job['id'], 'u0')['details']
                        self.assertEqual(details['events'][-1]['status'], 'failed')
                        errors = [item for item in details['events'] if item['kind'] == 'error']
                        self.assertEqual(errors[-1]['error_category'], 'deadline')
                        self.assertTrue(errors[-1]['frames'])
            finally:
                queue.stop()

    def test_non_node_committed_effect_wins_after_deadline(self):
        calls = []
        def execute(*args):
            calls.append(1)
            with self.store.transaction():
                self.store.put('u0/committed', 'valid')
                self.store.record_job_effect({'saved': True})
            time.sleep(.03)
            return 200, {'wrong': 'late'}
        queue = JobQueue(self.store, execute, workers=1, job_timeout=.02)
        self.addCleanup(queue.stop)
        receipt = self.receipt(queue)
        with self.assertLogs('background_jobs', level='ERROR'):
            queue.start()
            done = self.wait(queue, receipt, 'succeeded')
        self.assertEqual(done['result'], {'saved': True})
        self.assertEqual(calls, [1])
        self.assertEqual(self.store.record('u0/committed')['value'], 'valid')

    def test_sqlite_write_lock_wait_becomes_deadline_and_node_retries(self):
        def execute(*args):
            blocker = sqlite3.connect(self.store.path, isolation_level=None)
            try:
                blocker.execute('BEGIN IMMEDIATE')
                self.store.put('u0/locked', 'must not save')
            finally:
                blocker.rollback()
                blocker.close()
            return 200, {'saved': True}
        queue = JobQueue(self.store, execute, workers=1, node_timeout=.05, retry_delay=.005)
        self.addCleanup(queue.stop)
        receipt = self.receipt(queue, operation='/path/node', request='request-sqlite-lock')
        with self.assertLogs('background_jobs', level='ERROR'):
            queue.start()
            failed = self.wait(queue, receipt, 'failed')
        self.assertEqual(failed['error_category'], 'deadline')
        self.assertEqual(failed['response_status'], 504)
        self.assertEqual(failed['attempt'], 2)
        self.assertIsNone(self.store.record('u0/locked'))

    def test_sqlite_error_before_deadline_is_not_reported_as_deadline(self):
        blocker = sqlite3.connect(self.store.path, isolation_level=None)
        try:
            blocker.execute('BEGIN IMMEDIATE')
            with self.assertRaises(sqlite3.OperationalError) as raised:
                with execution_budget(1), self.store.connection() as connection:
                    connection.execute('PRAGMA busy_timeout=1')
                    connection.execute('BEGIN IMMEDIATE')
            self.assertEqual(raised.exception.sqlite_errorcode, sqlite3.SQLITE_BUSY)
        finally:
            blocker.rollback()
            blocker.close()
        self.assertIsNone(self.store.record('u0/locked'))

    def test_expired_sqlite_setup_errors_are_deadlines_and_connections_close(self):
        import job_execution
        clock = [100.0]
        error = sqlite3.OperationalError('database is locked')
        def expired(*args, **kwargs):
            clock[0] = 102.0
            raise error
        for boundary in ('connect', 'pragma'):
            with self.subTest(boundary=boundary):
                clock[0] = 100.0
                connection = MagicMock()
                connection.execute.side_effect = expired
                with patch.object(job_execution.time, 'monotonic', side_effect=lambda: clock[0]), \
                     patch('state_store.sqlite3.connect', side_effect=expired if boundary == 'connect' else None,
                           return_value=connection):
                    with execution_budget(1), self.assertRaises(JobDeadlineExceeded):
                        with self.store.connection():
                            self.fail('expired setup must not yield a connection')
                if boundary == 'pragma':
                    connection.close.assert_called_once()
                self.assertFalse(hasattr(self.store.local, 'connection'))

    def test_real_sqlite_full_diagnostic_cannot_autocommit_effect_or_report_success(self):
        from job_details import append_event
        calls, rolled_back = [], []
        def execute(*args):
            calls.append(1)
            with self.store.transaction() as connection:
                pages = connection.execute('PRAGMA page_count').fetchone()[0]
                connection.execute('PRAGMA max_page_count=%d' % (pages + 1))
                self.store.put('u0/full', 'small document')
                self.assertTrue(connection.in_transaction)
                append_event(connection, self.store.local.job_id, 'model_response', '最终回复', content='x' * 16000)
                rolled_back.append(not connection.in_transaction)
                # A nested write must refuse to autocommit after implicit rollback.
                self.store.record_job_effect({'must_not_commit': True})
            return 200, {'must_not_succeed': True}
        queue = JobQueue(self.store, execute, workers=1, retry_delay=.005)
        self.addCleanup(queue.stop)
        receipt = self.receipt(queue, operation='/path/node', request='request-sqlite-full')
        with self.assertLogs('background_jobs', level='ERROR'):
            queue.start()
            failed = self.wait(queue, receipt, 'failed')
        self.assertEqual(rolled_back, [True])
        self.assertEqual(failed['error_category'], 'storage')
        self.assertEqual(failed['response_status'], 503)
        self.assertEqual(failed['attempt'], 1)
        self.assertEqual(calls, [1])
        self.assertIsNone(self.store.record('u0/full'))
        with self.store.connection() as connection:
            self.assertIsNone(connection.execute('SELECT effect FROM jobs WHERE id=?', (receipt['id'],)).fetchone()[0])

    def test_put_diagnostic_sqlite_full_invalidates_all_connection_reuse_and_commit(self):
        from job_details import append_event
        queue = JobQueue(self.store, lambda *args: (200, {}))
        receipt = self.receipt(queue, request='request-put-full')
        self.store.local.job_id = receipt['id']
        self.addCleanup(lambda: delattr(self.store.local, 'job_id'))
        def oversized(connection, job_id, kind, label, **fields):
            # Trigger a real SQLITE_FULL inside put's optional diagnostic write.
            append_event(connection, job_id, kind, label, content='x' * 16000, **fields)
        with self.assertRaises(sqlite3.OperationalError):
            with self.store.transaction() as connection:
                pages = connection.execute('PRAGMA page_count').fetchone()[0]
                connection.execute('PRAGMA max_page_count=%d' % (pages + 1))
                with patch('state_store.append_event', side_effect=oversized):
                    with self.assertRaises(sqlite3.OperationalError):
                        self.store.put('u0/full-put', 'small document')
                self.assertFalse(connection.in_transaction)
                with self.assertRaises(sqlite3.OperationalError):
                    self.store.record_job_effect({'must_not_commit': True})
                with self.assertRaises(sqlite3.OperationalError):
                    with self.store.connection():
                        self.fail('rolled-back connection must not be reused')
        self.assertFalse(hasattr(self.store.local, 'connection'))
        self.assertIsNone(self.store.record('u0/full-put'))
        with self.store.connection() as connection:
            self.assertIsNone(connection.execute('SELECT effect FROM jobs WHERE id=?', (receipt['id'],)).fetchone()[0])

    def test_request_reasoning_override_does_not_change_following_default_payload(self):
        settings = type('Settings', (), {'llm_model': 'test', 'llm_base': 'http://127.0.0.1',
                                        'max_output_tokens': 393216, 'upstream_timeout': 1})()
        client = ModelClient(settings, reasoning_effort='max')
        messages = [{'role': 'user', 'content': 'test'}]
        raw = b'{"choices":[{"message":{"content":"result"}}]}'
        with patch.object(model_transport, 'post', return_value=raw) as transport:
            client.json(messages, max_tokens=16384, reasoning_effort='none', response_format='json_object')
            client.json(messages)
        override, default = [json.loads(call.args[1]) for call in transport.call_args_list]
        self.assertEqual((override['reasoning_effort'], override['max_tokens']), ('none', 16384))
        self.assertEqual(override['response_format'], {'type': 'json_object'})
        self.assertNotIn('response_format', default)
        self.assertEqual((default['reasoning_effort'], default['max_tokens']), ('max', 393216))
        self.assertEqual(client.think, {'reasoning_effort': 'max'})
        self.assertEqual(client.reasoning_effort, 'max')
        self.assertEqual(settings.max_output_tokens, 393216)

    def test_invalid_request_reasoning_never_reaches_transport(self):
        settings = type('Settings', (), {'llm_model': 'test', 'llm_base': 'http://127.0.0.1',
                                        'max_output_tokens': 100, 'upstream_timeout': 1})()
        client = ModelClient(settings)
        with patch.object(model_transport, 'post') as transport:
            for value in ('', 'ultra', True, 1, [], {}):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    client.json([], reasoning_effort=value)
            transport.assert_not_called()

    def test_invalid_response_format_never_reaches_transport(self):
        settings = type('Settings', (), {'llm_model': 'test', 'llm_base': 'http://127.0.0.1',
                                        'max_output_tokens': 100, 'upstream_timeout': 1})()
        client = ModelClient(settings)
        with patch.object(model_transport, 'post') as transport:
            for value in ('', 'json_schema', True, 1, [], {'type': 'json_object'}):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    client.json([], response_format=value)
            transport.assert_not_called()

    def test_actual_model_messages_and_final_reply_are_redacted_before_save(self):
        queue = JobQueue(self.store, lambda *args: (200, {}))
        receipt = self.receipt(queue)
        self.store.local.job_id = receipt['id']
        self.store.local.job_attempt = 1
        self.addCleanup(lambda: delattr(self.store.local, 'job_id'))
        settings = type('Settings', (), {'llm_model': 'test', 'llm_base': 'http://127.0.0.1',
                                         'max_output_tokens': 100, 'upstream_timeout': 1})()
        client = ModelClient(settings, 'configured-private-key', detail_store=self.store)
        source = '<img src=x onerror=alert(1)> configured-private-key Bearer private-token\n' + \
                 'api_key="key-secret" password=pass-secret session=ses-secret learn_session=cookie-secret\n' + \
                 'Cookie: learn_session=first-secret; second=second-secret'
        messages = [{'role': 'system', 'content': 'instruction'}, {'role': 'user', 'content': source}]
        reply = '<think>HIDDEN_THOUGHT</think>final code configured-private-key'
        raw = json.dumps({'choices': [{'message': {'content': reply, 'reasoning_content': 'PRIVATE_REASONING'}}]}).encode()
        with patch.object(model_transport, 'post', return_value=raw) as transport:
            self.assertEqual(client.json(messages), reply)
        sent = json.loads(transport.call_args.args[1])['messages']
        self.assertEqual(sent, messages)
        details = queue.details(receipt['id'], 'u0')['details']
        serialized = json.dumps(details)
        for secret in ('configured-private-key', 'private-token', 'key-secret', 'pass-secret',
                       'ses-secret', 'cookie-secret', 'first-secret', 'second-secret',
                       'PRIVATE_REASONING', 'HIDDEN_THOUGHT'):
            self.assertNotIn(secret, serialized)
        request = next(event for event in details['events'] if event['kind'] == 'model_request')
        response = next(event for event in details['events'] if event['kind'] == 'model_response')
        self.assertEqual(request['call_id'], response['call_id'])
        self.assertIn('<img src=x onerror=alert(1)>', request['messages'][1]['content'])
        self.assertIn('final code', response['content'])
        with self.store.connection() as connection:
            stored = connection.execute('SELECT value FROM job_details WHERE job_id=?', (receipt['id'],)).fetchone()[0]
        self.assertNotIn('configured-private-key', stored)

    def test_details_are_bounded_and_keep_last_failure_and_status(self):
        queue = JobQueue(self.store, lambda *args: (200, {}))
        receipt = self.receipt(queue)
        self.store.local.job_id = receipt['id']
        self.addCleanup(lambda: delattr(self.store.local, 'job_id'))
        for _ in range(MAX_EVENTS + 10):
            self.store.job_event('phase', '处理阶段')
        self.store.job_event('model_request', '请求', messages=[{'role': 'user', 'content': '字' * 50000}] * 64)
        self.store.job_event('error', '最后一次失败', error_category='validation')
        self.store.job_event('status', '任务执行失败', status='failed')
        details = queue.details(receipt['id'], 'u0')['details']
        self.assertTrue(details['truncated'])
        self.assertLessEqual(len(details['events']), MAX_EVENTS)
        self.assertLessEqual(len(json.dumps(details, ensure_ascii=False).encode()), MAX_BYTES)
        self.assertEqual(details['events'][-2]['label'], '最后一次失败')
        self.assertEqual(details['events'][-1]['status'], 'failed')
        self.assertTrue(next(event for event in details['events'] if event['kind'] == 'model_request')['truncated'])

    def test_restart_manual_retry_old_record_and_cleanup(self):
        queue = JobQueue(self.store, lambda *args: (200, {}))
        receipt = self.receipt(queue)
        queue._claim()
        restarted = JobQueue(StateStore(self.directory.name), lambda *args: (200, {}))
        self.assertEqual(restarted.details(receipt['id'], 'u0')['details']['events'][-1]['kind'], 'restart')
        self.assertEqual(restarted.get(receipt['id'], 'u0')['status'], 'interrupted')
        restarted.retry(receipt['id'], 'u0')
        self.assertEqual(restarted.details(receipt['id'], 'u0')['details']['events'][-1]['kind'], 'manual_retry')
        with self.assertRaises(JobError):
            restarted.details(receipt['id'], 'other')
        with self.store.transaction() as connection:
            connection.execute('DELETE FROM job_details WHERE job_id=?', (receipt['id'],))
        self.assertEqual(restarted.details(receipt['id'], 'u0')['details'],
                         {'available': False, 'truncated': False, 'events': []})
        self.store.local.job_id = receipt['id']
        self.store.job_event('status', '旧回执新增记录', status='failed')
        del self.store.local.job_id
        with self.store.transaction() as connection:
            connection.execute("UPDATE jobs SET status='failed',updated_ms=0 WHERE id=?", (receipt['id'],))
        JobQueue(self.store, lambda *args: (200, {}))
        with self.store.connection() as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM job_details').fetchone()[0], 0)

    def test_gaps_does_not_swallow_typed_deadline(self):
        from application import create_application
        app = create_application({'STATE_DIR': str(Path(self.directory.name) / 'app'), 'DELETE_PASSWORD': 'test'})
        self.addCleanup(app.close)
        with patch.object(app.model, 'nonempty', side_effect=JobDeadlineExceeded()):
            with self.assertRaises(JobDeadlineExceeded):
                app.flywheel.gaps('/path/gaps', {'items': [{'q': 'question'}]}, {'id': 'u0'})

    def test_diagnostics_failure_does_not_change_task_result(self):
        queue = JobQueue(self.store, lambda *args: (200, {'done': True}), workers=1)
        self.addCleanup(queue.stop)
        with patch('job_details._append_event', side_effect=RuntimeError('private diagnostic failure')):
            receipt = self.receipt(queue)
            queue.start()
            done = self.wait(queue, receipt, 'succeeded')
        self.assertEqual(done['result'], {'done': True})

    def test_error_and_terminal_diagnostic_failures_keep_worker_and_effect(self):
        calls = []
        def execute(*args):
            calls.append(1)
            if len(calls) == 1:
                raise ValueError('private program error')
            if len(calls) == 2:
                with self.store.transaction():
                    self.store.put('u0/committed', 'valid')
                    self.store.record_job_effect({'saved': True})
                raise JobDeadlineExceeded()
            return 200, {'done': True}
        queue = JobQueue(self.store, execute, workers=1)
        self.addCleanup(queue.stop)
        with patch.object(self.store, 'job_event', side_effect=OSError('private diagnostics failure')), \
             patch('background_jobs.append_event', side_effect=OSError('private append failure')), \
             patch('state_store.append_event', side_effect=OSError('private phase failure')):
            with self.assertLogs('background_jobs', level='ERROR'):
                first = self.receipt(queue, request='request-diag-failed')
                queue.start()
                self.assertEqual(self.wait(queue, first, 'failed')['error_category'], 'program')
                second = self.receipt(queue, request='request-diag-effect')
                self.assertEqual(self.wait(queue, second, 'succeeded')['result'], {'saved': True})
            third = self.receipt(queue, request='request-diag-next')
            self.assertEqual(self.wait(queue, third, 'succeeded')['result'], {'done': True})
        self.assertTrue(queue.threads[0].is_alive())

    def test_model_diagnostics_failure_does_not_change_final_reply(self):
        settings = type('Settings', (), {'llm_model': 'test', 'llm_base': 'http://127.0.0.1',
                                         'max_output_tokens': 100, 'upstream_timeout': 1})()
        client = ModelClient(settings, detail_store=self.store)
        raw = json.dumps({'choices': [{'message': {'content': 'final'}}]}).encode()
        with patch.object(self.store, 'job_event', side_effect=OSError('diagnostics failure')), \
             patch.object(model_transport, 'post', return_value=raw):
            self.assertEqual(client.json([{'role': 'user', 'content': 'question'}]), 'final')


class SlowSearch(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        payload = json.dumps({'results': [{'url': 'https://example.org', 'content': 'source'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            for byte in payload:
                self.wfile.write(bytes([byte]))
                self.wfile.flush()
                time.sleep(.025)
        except (BrokenPipeError, ConnectionResetError):
            pass


class SearchDeadlineTests(unittest.TestCase):
    def test_real_search_slow_drip_is_terminated_by_task_budget(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), SlowSearch)
        server.daemon_threads = True
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        settings = type('Settings', (), {'searxng_base': 'http://127.0.0.1:%s' % server.server_port})()
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(directory)
            client = ModelClient(settings, detail_store=store)
            queue = JobQueue(store, lambda *args: (200, {'sources': client.search('local')}), workers=1, job_timeout=.2)
            receipt = queue.submit('u0', 'slow-search-request', '/path/research', {'key': 'u0/example'})
            processes = []
            spawn = model_transport.subprocess.Popen
            def observe(*args, **kwargs):
                process = spawn(*args, **kwargs)
                processes.append(process)
                return process
            started = time.monotonic()
            try:
                with patch.object(model_transport.subprocess, 'Popen', side_effect=observe), self.assertLogs('background_jobs', level='ERROR'):
                    queue.start()
                    job = JobDetailsTests.wait(self, queue, receipt, 'failed')
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(job['error_category'], 'deadline')
                self.assertEqual(job['failure_phase'], '请求搜索服务')
                self.assertEqual(len(processes), 1)
                self.assertIsNotNone(processes[0].poll())
                self.assertTrue(processes[0].stdout.closed)
            finally:
                queue.stop()


class DetailsHttpTests(unittest.TestCase):
    setUp = isolation.UserIsolationTests.setUp
    stop_server = isolation.UserIsolationTests.stop_server
    request = isolation.UserIsolationTests.request
    login = isolation.UserIsolationTests.login
    create = isolation.UserIsolationTests.create

    def test_task_details_use_session_owner_and_admin_read_only_target(self):
        receipt = self.app.jobs().submit(self.alice, 'request-http-details', '/path/plan',
                                         {'key': self.alice + '/missing'})
        path = '/jobs/%s/details' % receipt['id']
        self.assertEqual(self.request(path)[0], 401)
        self.assertEqual(self.request(path, cookie=self.bob_cookie)[0], 404)
        self.assertEqual(self.request(path, cookie=self.bob_cookie, target=self.alice)[0], 403)
        own = self.request(path, cookie=self.alice_cookie)
        self.assertEqual(own[0], 200)
        self.assertTrue(own[1]['details']['available'])
        admin = self.request(path, cookie=self.admin, target=self.alice)
        self.assertEqual(admin[0], 200)
        self.assertEqual(admin[1]['job']['user_id'], self.alice)
        retry = '/jobs/%s/retry' % receipt['id']
        self.assertEqual(self.request(retry, {}, cookie=self.admin, target=self.alice)[0], 403)


if __name__ == '__main__':
    unittest.main()
