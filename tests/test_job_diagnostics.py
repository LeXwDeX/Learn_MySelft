"""Failure locations are useful without logging student content or credentials."""
import json
import tempfile
import time
import unittest
from unittest.mock import patch

import test_state_regressions
from background_jobs import JobQueue, log_job_failure
from state_store import StateStore

study = test_state_regressions.study


class JobDiagnosticsTests(unittest.TestCase):
    def test_log_contains_frames_but_no_message_source_locals_or_directory(self):
        namespace = {}
        exec(compile('def fail():\n    private_answer = "LOCAL_SECRET"\n    raise ValueError("MESSAGE_SECRET")\n',
                     '/PRIVATE_DIRECTORY/fixture.py', 'exec'), namespace)
        try:
            namespace['fail']()
        except ValueError as error:
            with self.assertLogs('background_jobs', level='ERROR') as captured:
                log_job_failure('test-job', '/path/node', error, 'verification')
        output = '\n'.join(captured.output)
        for secret in ('LOCAL_SECRET', 'MESSAGE_SECRET', 'PRIVATE_DIRECTORY', 'private_answer', 'raise ValueError'):
            self.assertNotIn(secret, output)
        record = json.loads(captured.records[0].getMessage().split(' ', 1)[1])
        self.assertEqual(record['exception'], 'ValueError')
        self.assertEqual(record['frames'][-1], {'file': 'fixture.py', 'function': 'fail', 'line': 3})
        self.assertEqual(record['stage'], 'verification')
        self.assertIsNone(captured.records[0].exc_info)

    def test_logging_failure_does_not_escape(self):
        with patch('background_jobs.LOGGER.error', side_effect=OSError('log unavailable')):
            log_job_failure('test-job', '/path/node', ValueError('secret'))

    def test_worker_keeps_failure_contract_and_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(directory)
            calls = []
            def execute(*args):
                calls.append(1)
                if len(calls) == 1:
                    raise ValueError('PRIVATE_REQUEST_BODY')
                return 200, {'done': True}
            queue = JobQueue(store, execute, workers=1)
            job = queue.submit('u0', 'request-diagnostics', '/path/node', {'key': 'u0/example'})
            try:
                with self.assertLogs('background_jobs', level='ERROR') as captured:
                    queue.start()
                    failed = self.wait_status(queue, job['id'], 'failed')
                self.assertEqual(failed['response_status'], 502)
                self.assertEqual(failed['error'], '生成暂时失败，输入已保留，请重试')
                self.assertNotIn('PRIVATE_REQUEST_BODY', '\n'.join(captured.output))
                self.assertIn(job['id'], '\n'.join(captured.output))
                queue.retry(job['id'], 'u0')
                self.assertEqual(self.wait_status(queue, job['id'], 'succeeded')['result'], {'done': True})
            finally:
                queue.stop()

    def wait_status(self, queue, job_id, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = queue.get(job_id, 'u0')
            if result['status'] == expected:
                return result
            time.sleep(.01)
        self.fail(str(result))

    def test_node_contract_retry_preserves_original_failure_location(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(study, 'STATE_DIR', directory):
            store = study._state_store()
            store.local.job_id = 'node-diagnostics'
            handler = object.__new__(study.Handler)
            def rejected_verification(*args, **kwargs):
                raise study.harness.QuizContractError('SENSITIVE_MODEL_ANSWER')
            with patch.object(study, '_upstream_nonempty', return_value='{}'), \
                 patch.object(study, '_norm_node_detail', return_value={'quiz': {'questions': []}}), \
                 patch.object(study, '_checked_questions', side_effect=rejected_verification), \
                 self.assertLogs('background_jobs', level='ERROR') as captured, \
                 self.assertRaises(study.harness.QuizContractError):
                handler._handle_path('/path/node', {'node': {'id': 'n1'}, 'spec': {}})
            records = [json.loads(r.getMessage().split(' ', 1)[1]) for r in captured.records]
            originals = [r for r in records if any(f['function'] == 'rejected_verification' for f in r['frames'])]
            self.assertEqual(len(originals), 3)
            self.assertTrue(all(r['stage'] == 'verification' and r['job_id'] == 'node-diagnostics' for r in originals))
            self.assertNotIn('SENSITIVE_MODEL_ANSWER', '\n'.join(captured.output))


if __name__ == '__main__':
    unittest.main()
