"""Only node-budget model transport failures reach the existing retry classifier."""
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from application import create_application
from background_jobs import JobQueue, retryable_failure
from job_execution import JobDeadlineExceeded, execution_budget
import render_review
from test_quiz_harness import questions


CAPTURED = {'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': []}
VERDICT = {'ok': True, 'issues': []}


class ReviewTransportBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / 'render-config.json'
        self.config.write_text('{}')
        self.candidate = {'study_notes': '$x$'}

    def http_error(self, status):
        error = urllib.error.HTTPError('https://example.invalid', status, 'private body', {}, None)
        self.addCleanup(error.close)
        return error

    def review_error(self, error, budget):
        def ask(_):
            raise error
        with patch.object(render_review, '_capture', return_value=CAPTURED), budget:
            return render_review.review(self.candidate, ask, self.config)

    def test_budget_preserves_exception_identity_and_existing_retry_classification(self):
        cases = [(self.http_error(502), True), (self.http_error(503), True),
                 (self.http_error(401), False), (self.http_error(400), False),
                 (TimeoutError('private transport'), True),
                 (urllib.error.URLError('private transport'), True)]
        for error, can_retry in cases:
            with self.subTest(error=type(error).__name__, code=getattr(error, 'code', None)):
                with self.assertRaises(type(error)) as raised:
                    self.review_error(error, execution_budget(5))
                self.assertIs(raised.exception, error)
                self.assertEqual(retryable_failure(raised.exception), can_retry)

    def test_without_budget_preserves_unavailable_reasons_and_safe_reports(self):
        cases = [(self.http_error(502), 'model_http_error'),
                 (self.http_error(401), 'model_http_error'),
                 (TimeoutError('private transport'), 'model_timeout'),
                 (urllib.error.URLError('private transport'), 'model_review_unavailable')]
        for error, reason in cases:
            with self.subTest(reason=reason):
                result = self.review_error(error, nullcontext())
                self.assertEqual(result['status'], 'unavailable')
                self.assertEqual(result['reason'], reason)
                self.assertNotIn('private', json.dumps(result))

    def test_local_capture_and_subprocess_errors_stay_unavailable_with_budget(self):
        for error in (TimeoutError('renderer busy'), OSError('local renderer'),
                      render_review.subprocess.TimeoutExpired('render worker', 75)):
            with self.subTest(error=type(error).__name__), execution_budget(5), \
                 patch.object(render_review, '_capture', side_effect=error):
                result = render_review.review(self.candidate, lambda _: self.fail('must not call model'), self.config)
                self.assertEqual(result['reason'], 'renderer_unavailable')
        result = self.review_error(render_review.subprocess.TimeoutExpired('local helper', 75), execution_budget(5))
        self.assertEqual(result['reason'], 'model_timeout')

    def test_invalid_reply_and_rejected_content_are_not_transport_errors(self):
        for answer in (None, {}, {'ok': 'true', 'issues': []}, {'ok': True, 'issues': ['']}):
            with self.subTest(answer=answer), execution_budget(5), \
                 patch.object(render_review, '_capture', return_value=CAPTURED):
                result = render_review.review(self.candidate, lambda _: answer, self.config)
                self.assertEqual(result['reason'], 'model_reply_invalid')
        with self.assertRaises(render_review.ReviewIssue) as raised, execution_budget(5), \
             patch.object(render_review, '_capture', return_value=CAPTURED):
            render_review.review(self.candidate, lambda _: {'ok': False, 'issues': ['公式错误']}, self.config)
        self.assertFalse(retryable_failure(raised.exception))
        with execution_budget(5), patch.object(render_review, '_capture', return_value={'errors': ['公式错误']}):
            with self.assertRaises(render_review.ReviewIssue):
                render_review.review(self.candidate, lambda _: self.fail('must not call model'), self.config)

    def test_deadline_always_propagates(self):
        for budget in (False, True):
            with self.subTest(budget=budget):
                context = execution_budget(5) if budget else nullcontext()
                with self.assertRaises(JobDeadlineExceeded):
                    self.review_error(JobDeadlineExceeded(), context)
                with (execution_budget(5) if budget else nullcontext()), \
                     patch.object(render_review, '_capture', side_effect=JobDeadlineExceeded()):
                    with self.assertRaises(JobDeadlineExceeded):
                        render_review.review(self.candidate, lambda _: self.fail('must not call model'), self.config)


class ReviewTransportJobTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = create_application({'STATE_DIR': self.directory.name, 'DELETE_PASSWORD': 'test-password'})
        self.addCleanup(self.app.close)
        self.config = Path(self.directory.name) / 'render-config.json'
        self.config.write_text('{}')
        self.key = 'u0/learn-path-v1-review-transport'
        self.node = {'id': 'n1', 'title': '关系', 'deps': [], 'objectives': ['解释关系']}
        self.material = {'topic': '复核回归', 'plan': {'nodes': [self.node], 'edges': []},
                         'unknown_test_field': {'keep': True}, 'nodeState': {'n1': {'mark': 'review'}}}
        self.app.repository.write_key(self.key, json.dumps(self.material))
        self.candidate = {'study_notes': '观察关系 $x$。', 'quiz': {'questions': questions()}}

    def wait(self, queue, receipt, wanted):
        until = time.monotonic() + 4
        while time.monotonic() < until:
            result = queue.get(receipt['id'], 'u0')
            if result['status'] == wanted:
                return result
            time.sleep(0.01)
        self.fail('job did not reach ' + wanted)

    def run_job(self, error, wanted, operation='/path/node', capture_error=None):
        original_review = render_review.review
        review_with_config = lambda candidate, ask: original_review(candidate, ask, self.config)
        queue = JobQueue(self.app.repository.store, self.app.run_job, workers=2, retry_delay=0.01)
        self.addCleanup(queue.stop)
        body = {'key': self.key, 'node': self.node}
        receipt = queue.submit('u0', 'stable-review-request', operation, body)
        with patch.object(self.app.model, 'nonempty', return_value=json.dumps(self.candidate)), \
             patch.object(self.app.model, 'json', side_effect=[error, json.dumps(VERDICT)]) as model, \
             patch.object(self.app.verification, 'checked_questions', side_effect=lambda qs, **kw: qs), \
             patch.object(render_review, '_capture', return_value=CAPTURED, side_effect=capture_error), \
             patch.object(render_review, 'review', side_effect=review_with_config), \
             patch.object(self.app.manim, 'generate', return_value=None):
            queue.start()
            result = self.wait(queue, receipt, wanted)
            queue.stop()
            calls = model.call_count
        with self.app.repository.store.connection() as connection:
            effect = connection.execute('SELECT effect FROM jobs WHERE id=?', (receipt['id'],)).fetchone()[0]
            count = connection.execute('SELECT count(*) FROM jobs WHERE request_id=?', ('stable-review-request',)).fetchone()[0]
        self.assertEqual(count, 1)
        self.assertEqual(queue.submit('u0', 'stable-review-request', operation, body)['id'], receipt['id'])
        return result, calls, effect

    def test_first_review_http502_recovers_once_with_same_receipt_and_atomic_effect(self):
        error = urllib.error.HTTPError('https://example.invalid', 502, 'private body', {}, None)
        self.addCleanup(error.close)
        result, calls, effect = self.run_job(error, 'succeeded')
        self.assertEqual(result['attempt'], 2)
        self.assertEqual(calls, 2)
        saved = self.app.repository.material(self.key)
        self.assertEqual(json.loads(effect), saved['nodeDetail']['n1'])
        self.assertEqual(result['result']['quiz']['round_id'], saved['nodeDetail']['n1']['quiz']['round_id'])
        self.assertEqual(saved['unknown_test_field'], self.material['unknown_test_field'])
        self.assertEqual(saved['nodeState'], self.material['nodeState'])

    def test_review_http401_fails_once_and_does_not_save_a_lesson(self):
        error = urllib.error.HTTPError('https://example.invalid', 401, 'private body', {}, None)
        self.addCleanup(error.close)
        result, calls, effect = self.run_job(error, 'failed')
        self.assertEqual(result['attempt'], 1)
        self.assertEqual(calls, 1)
        self.assertIsNone(effect)
        self.assertNotIn('nodeDetail', self.app.repository.material(self.key))
        self.assertNotIn('private', result['error'])

    def test_invalid_reply_fails_once_without_publishing_or_transport_retry(self):
        result, calls, effect = self.run_job(json.dumps({'ok': 'true', 'issues': []}), 'failed')
        self.assertEqual(result['attempt'], 1)
        self.assertEqual(result['error_category'], 'request')
        self.assertEqual(calls, 1)
        self.assertIsNone(effect)
        self.assertNotIn('nodeDetail', self.app.repository.material(self.key))

    def test_local_capture_timeout_fails_once_without_model_or_transport_retry(self):
        result, calls, effect = self.run_job(None, 'failed', capture_error=TimeoutError('renderer busy'))
        self.assertEqual(result['attempt'], 1)
        self.assertEqual(result['error_category'], 'request')
        self.assertEqual(calls, 0)
        self.assertIsNone(effect)
        self.assertNotIn('nodeDetail', self.app.repository.material(self.key))


if __name__ == '__main__':
    unittest.main()
