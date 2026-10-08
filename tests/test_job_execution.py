"""Execution deadlines terminate network work and prevent late lesson commits."""
import io
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
import job_execution
import model_transport
import render_review
import manim_renderer
from application import create_application
from background_jobs import JobQueue
from job_execution import JobDeadlineExceeded, execution_budget
from model_client import ModelClient
from test_quiz_harness import questions


class LocalModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.headers_seen.append(self.headers.get('Authorization'))
        if self.path.startswith('/http-error/'):
            self.send_response(503)
            self.end_headers()
            return
        body = json.dumps({'choices': [{'message': {'content': 'local test'}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            if self.path.startswith('/slow/'):
                for byte in body:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.03)
            else:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class NetworkDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), LocalModel)
        self.server.daemon_threads = True
        self.server.headers_seen = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.settings = type('Settings', (), dict(llm_model='local', max_output_tokens=1024,
                                                 upstream_timeout=2))()

    def client(self, route):
        self.settings.llm_base = 'http://127.0.0.1:%d/%s' % (self.server.server_port, route)
        return ModelClient(self.settings, 'local-test-credential', reasoning_effort='')

    def test_regular_reply_and_safe_http_error_keep_existing_client_contract(self):
        self.assertEqual(self.client('ok').json([]), 'local test')
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.client('http-error').json([])
        self.assertEqual(raised.exception.code, 503)
        self.assertNotIn('local-test-credential', str(raised.exception))
        raised.exception.close()
        self.assertEqual(self.server.headers_seen[0], 'Bearer local-test-credential')

    def test_slow_drip_is_stopped_and_reaped_before_deadline_error(self):
        processes = []
        spawn = model_transport.subprocess.Popen
        def observe(*args, **kwargs):
            self.assertNotIn('local-test-credential', repr(args))
            self.assertNotIn('LLM_KEY', kwargs['env'])
            self.assertNotIn('STATE_DIR', kwargs['env'])
            process = spawn(*args, **kwargs)
            processes.append(process)
            return process
        started = time.monotonic()
        with patch.object(model_transport.subprocess, 'Popen', side_effect=observe):
            with self.assertRaises(JobDeadlineExceeded):
                with execution_budget(0.25):
                    self.client('slow').json([])
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertFalse(job_execution.budget_active())

    def test_non_job_request_also_has_absolute_transfer_timeout(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.client('slow').json([], timeout=0.25)
        self.assertLess(time.monotonic() - started, 2)

    def test_response_limit_fails_without_exposing_body(self):
        envelope = json.dumps({'url': 'http://127.0.0.1/local', 'payload': '',
                               'headers': {}, 'timeout': 1})
        response = io.BytesIO(b'private body exceeding limit')
        output = io.StringIO()
        with patch.object(model_transport, 'MAX_RESPONSE_BYTES', 8), \
             patch.object(model_transport.sys, 'stdin', io.StringIO(envelope)), \
             patch.object(model_transport.sys, 'stdout', output), \
             patch.object(model_transport.urllib.request, 'urlopen', return_value=response):
            model_transport._worker()
        self.assertEqual(json.loads(output.getvalue()), {'error': 'response_too_large'})


class ExecutionBudgetTests(unittest.TestCase):
    def test_nested_budget_cannot_extend_outer_budget_and_context_is_cleaned(self):
        clock = [100.0]
        with patch.object(job_execution.time, 'monotonic', side_effect=lambda: clock[0]):
            with execution_budget(10):
                with execution_budget(20):
                    self.assertEqual(job_execution.remaining_timeout(30), 10)
                    clock[0] = 111
                    with self.assertRaises(JobDeadlineExceeded):
                        job_execution.check_deadline()
            self.assertFalse(job_execution.budget_active())
            job_execution.check_deadline()

    def test_budget_is_worker_local(self):
        observed = []
        with execution_budget(1):
            thread = threading.Thread(target=lambda: observed.append(job_execution.budget_active()))
            thread.start()
            thread.join()
        self.assertEqual(observed, [False])

    def test_render_review_cannot_turn_deadline_into_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}')
            def expired(*args, **kwargs):
                raise JobDeadlineExceeded()
            with patch.object(render_review, '_capture', side_effect=expired):
                with self.assertRaises(JobDeadlineExceeded):
                    render_review.review({'study_notes': '$x$'}, lambda _: {}, config)
            with patch.object(render_review, '_capture', return_value={'complete': True, 'images': ['local']}):
                with self.assertRaises(JobDeadlineExceeded):
                    render_review.review({'study_notes': '$x$'}, expired, config)

    def test_manim_cleanup_failure_cannot_mask_execution_deadline(self):
        from unittest.mock import MagicMock
        process = MagicMock()
        process.wait.side_effect = [JobDeadlineExceeded(), 0]
        process.poll.return_value = None
        process.stdout.read.return_value = b'{}'
        failed_cleanup = MagicMock(returncode=1)
        with patch.object(manim_renderer.subprocess, 'Popen', return_value=process), \
             patch.object(manim_renderer.subprocess, 'run', return_value=failed_cleanup):
            with self.assertRaises(JobDeadlineExceeded):
                manim_renderer.ManimRenderer('/unused')._phase('local', {}, 100, 180)
        process.kill.assert_called_once()


class NodeDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = create_application({'STATE_DIR': self.directory.name, 'DELETE_PASSWORD': 'test-password'})
        self.addCleanup(self.app.close)
        self.actor = self.app.accounts.get_user('u0')
        self.key = 'u0/learn-path-v1-deadline'
        self.node = {'id': 'n1', 'title': '关系', 'objectives': ['解释关系']}
        self.material = {'plan': {'nodes': [self.node]}, 'unknown': 'keep',
                         'nodeState': {'other': {'status': 'review'}}}
        self.app.repository.write_key(self.key, json.dumps(self.material))
        self.candidate = {'study_notes': '已校验的正文。', 'quiz': {'questions': questions()}}
        self.queue = JobQueue(self.app.repository.store, lambda *args: (200, {}))
        self.job = self.queue.submit('u0', 'request-node-deadline', '/path/node',
                                     {'key': self.key, 'node': self.node})
        self.queue._claim()
        self.app.repository.store.local.job_id = self.job['id']
        self.addCleanup(lambda: delattr(self.app.repository.store.local, 'job_id'))

    def generate(self, animation):
        with patch.object(self.app.model, 'nonempty', return_value=json.dumps(self.candidate)), \
             patch.object(self.app.verification, 'checked_questions', side_effect=lambda qs, **kw: qs), \
             patch.object(self.app.verification, 'review_rendered', return_value={'status': 'passed'}), \
             patch.object(self.app.manim, 'generate', side_effect=animation):
            return self.app.run_job('u0', '/path/node', {'key': self.key, 'node': self.node})

    def test_animation_deadline_is_not_optional_failure_and_never_saves(self):
        def expired(*args, **kwargs):
            raise JobDeadlineExceeded()
        with self.assertLogs('background_jobs', level=logging.ERROR):
            with self.assertRaises(JobDeadlineExceeded):
                self.generate(expired)
        self.assertNotIn('nodeDetail', self.app.repository.material(self.key))
        with self.app.repository.store.connection() as connection:
            self.assertIsNone(connection.execute('SELECT effect FROM jobs WHERE id=?', (self.job['id'],)).fetchone()[0])
        self.assertEqual(self.app.cache.gates, {})

    def test_real_manim_service_does_not_convert_model_deadline_to_optional_failure(self):
        with patch.object(self.app.model, 'json', side_effect=JobDeadlineExceeded()):
            with self.assertRaises(JobDeadlineExceeded):
                self.app.manim.generate(self.key, 'n1', '已校验正文', self.node,
                                        requested=False, actor=self.actor)

    def test_deadline_after_mutation_rolls_back_document_and_effect_together(self):
        clock = [100.0]
        merge = self.app.repository.merge
        def delayed_merge(*args, **kwargs):
            result = merge(*args, **kwargs)
            clock[0] = 111
            return result
        with patch.object(job_execution.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.app.repository, 'merge', side_effect=delayed_merge):
            with execution_budget(10):
                with self.assertRaises(JobDeadlineExceeded):
                    self.generate(lambda *args, **kwargs: None)
        self.assertNotIn('nodeDetail', self.app.repository.material(self.key))
        with self.app.repository.store.connection() as connection:
            self.assertIsNone(connection.execute('SELECT effect FROM jobs WHERE id=?', (self.job['id'],)).fetchone()[0])

    def test_committed_effect_recovers_without_reissuing_quiz_and_late_clock_is_success(self):
        clock = [100.0]
        put = self.app.cache.put
        def after_commit(*args, **kwargs):
            clock[0] = 111
            return put(*args, **kwargs)
        with patch.object(job_execution.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.app.cache, 'put', side_effect=after_commit):
            with execution_budget(10):
                status, detail = self.generate(lambda *args, **kwargs: None)
        self.assertEqual(status, 200)
        restored = JobQueue(self.app.repository.store, lambda *args: self.fail('effect must not rerun'))
        recovered = restored.get(self.job['id'], 'u0')
        self.assertEqual(recovered['status'], 'succeeded')
        self.assertEqual(recovered['result']['quiz']['round_id'], detail['quiz']['round_id'])
        material = self.app.repository.material(self.key)
        self.assertEqual(material['unknown'], 'keep')
        self.assertEqual(material['nodeState'], self.material['nodeState'])
        self.assertEqual(recovered['progress']['total'], 5)
        self.assertEqual(recovered['progress']['step'], 5)


if __name__ == '__main__':
    unittest.main()
