"""Animation cleanup must retain the stage of the original failure."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from application import create_application
from background_jobs import JobQueue
from manim_service import ManimGenerationError


class SceneFailurePhaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = create_application({'STATE_DIR': self.directory.name, 'DELETE_PASSWORD': 'test-password'})
        self.addCleanup(self.app.close)
        self.store = self.app.repository.store
        self.actor = self.app.accounts.get_user('u0')
        self.key = 'u0/learn-path-v1-phase-recovery'
        self.node = {'id': 'n1', 'title': '教学变化'}
        self.detail = {'study_notes': '已通过检查的正文。', 'quiz': {'round_id': 'original-round'},
                       'manim_review': {'status': 'pending', 'retryable': True}, 'unknown': 17}
        self.app.repository.write_key(self.key, json.dumps({
            'plan': {'nodes': [self.node]}, 'nodeDetail': {'n1': self.detail}}))
        self.body = {'key': self.key, 'node': self.node, 'automatic': True}
        self.phase = '规划教学变化与动画代码'

    def supplement(self):
        return self.app.scenes.supplement('/path/node/scene', self.body, self.actor)

    def test_real_receipt_and_error_event_retain_generation_phase(self):
        error = ManimGenerationError(503, 'model_unavailable')
        def generation(*args, **kwargs):
            self.store.job_progress(1, self.phase, total=5)
            raise error
        queue = JobQueue(self.store, lambda *args: self.supplement(), workers=1)
        self.addCleanup(queue.stop)
        receipt = queue.submit('u0', 'scene-phase-receipt', '/path/node/scene', self.body)
        with patch.object(self.app.manim, 'generate', side_effect=generation):
            queue.start()
            until = time.monotonic() + 3
            while time.monotonic() < until:
                result = queue.get(receipt['id'], 'u0')
                if result['status'] == 'failed':
                    break
                time.sleep(.01)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['failure_phase'], self.phase)
        errors = [event for event in queue.details(receipt['id'], 'u0')['details']['events']
                  if event['kind'] == 'error']
        self.assertTrue(errors)
        self.assertEqual(errors[-1]['phase'], self.phase)
        with self.store.connection() as connection:
            self.assertIsNone(connection.execute('SELECT effect FROM jobs WHERE id=?', (receipt['id'],)).fetchone()[0])
        saved = self.app.repository.node_detail(self.key, 'n1')
        self.assertEqual(saved['manim_review']['status'], 'failed')
        for field in ('study_notes', 'quiz', 'unknown'):
            self.assertEqual(saved[field], self.detail[field])

    def test_metadata_storage_failure_restores_phase_and_original_exception(self):
        self.store.local.phase = self.phase
        error = ManimGenerationError(502, 'visual_rejected')
        def metadata_failure(*args, **kwargs):
            self.store.local.phase = '保存学习资料'
            raise sqlite3.OperationalError('storage unavailable')
        with patch.object(self.app.manim, 'generate', side_effect=error), \
             patch.object(self.app.repository, 'update_scene_review', side_effect=metadata_failure), \
             patch.object(self.store, 'record_job_effect') as effect:
            with self.assertRaises(ManimGenerationError) as raised:
                self.supplement()
            self.assertIs(raised.exception, error)
            self.assertEqual(self.store.local.phase, self.phase)
            effect.assert_not_called()
        self.assertEqual(self.app.repository.node_detail(self.key, 'n1'), self.detail)

    def test_cleanup_does_not_create_phase_without_existing_context(self):
        self.assertFalse(hasattr(self.store.local, 'phase'))
        def metadata_failure(*args, **kwargs):
            self.store.local.phase = '保存学习资料'
            raise sqlite3.OperationalError('storage unavailable')
        with patch.object(self.app.manim, 'generate', side_effect=ManimGenerationError(502, 'visual_rejected')), \
             patch.object(self.app.repository, 'update_scene_review', side_effect=metadata_failure):
            with self.assertRaises(ManimGenerationError):
                self.supplement()
        self.assertFalse(hasattr(self.store.local, 'phase'))

    def test_successful_not_needed_still_reports_real_save_phase(self):
        receipt = JobQueue(self.store, lambda *args: (200, {})).submit(
            'u0', 'scene-success-phase', '/path/node/scene', self.body)
        self.store.local.job_id = receipt['id']
        self.store.local.phase = self.phase
        try:
            with patch.object(self.app.manim, 'generate', return_value=None):
                self.assertEqual(self.supplement()[1]['manim_review']['status'], 'not_needed')
            self.assertEqual(self.store.local.phase, '保存学习资料')
        finally:
            del self.store.local.job_id
            del self.store.local.phase


if __name__ == '__main__':
    unittest.main()
