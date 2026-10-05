import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
import render_review as review


class RenderReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / 'config.json'
        self.config.write_text(json.dumps({'python': 'python3', 'site': '/test'}))
        self.candidate = {'study_notes': '$2^n$'}

    def run_review(self, captured, verdict):
        def ask(messages):
            self.assertIn('原文', messages[1]['content'][0]['text'])
            self.assertEqual(messages[1]['content'][1]['type'], 'image_url')
            return verdict
        with patch.object(review, '_capture', return_value=captured):
            return review.review(self.candidate, ask, self.config)

    def test_pass_requires_screenshots_and_strict_verdict(self):
        captured = {'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': []}
        self.assertEqual(self.run_review(captured, {'ok': True, 'issues': []})['status'], 'passed')
        self.assertEqual(self.run_review(captured, {'ok': 'true', 'issues': []})['status'], 'unavailable')
        with self.assertRaises(review.ReviewIssue):
            self.run_review(captured, {'ok': False, 'issues': ['错误的箭头']})
        with self.assertRaises(review.ReviewIssue):
            self.run_review(captured, {'ok': True, 'issues': ['公式错误']})

    def test_incomplete_or_unavailable_never_passes(self):
        self.assertEqual(self.run_review({'complete': False, 'images': []}, {})['reason'], 'capture_incomplete')
        with patch.object(review, '_capture', side_effect=OSError('missing')):
            self.assertEqual(review.review(self.candidate, lambda _: self.fail(), self.config)['reason'], 'renderer_unavailable')
        self.assertEqual(review.review(self.candidate, lambda _: self.fail(), self.config.with_name('missing'))['status'], 'unavailable')

    def test_syntax_error_returns_repair_feedback_before_model(self):
        with self.assertRaisesRegex(review.ReviewIssue, '公式'):
            self.run_review({'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': ['公式无效']}, {})

    def test_learning_scene_alone_requires_visual_review(self):
        for fence in ('```', '~~~', '````'):
            with self.subTest(fence=fence):
                self.candidate = {'study_notes': fence + 'learn-scene\n{}\n' + fence}
                self.assertEqual(self.run_review({'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': []},
                                                {'ok': True, 'issues': []})['status'], 'passed')
                with self.assertRaisesRegex(review.ReviewIssue, '场景'):
                    self.run_review({'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': ['场景参数无效']}, {})

    def test_model_failures_keep_distinct_diagnostics(self):
        captured = {'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': []}
        for error, reason in [(TimeoutError(), 'model_timeout'), (ValueError(), 'model_reply_invalid'),
                              (review.urllib.error.HTTPError('local', 400, 'bad', {}, None), 'model_http_error')]:
            with self.subTest(reason=reason), patch.object(review, '_capture', return_value=captured):
                def ask(_):
                    raise error
                self.assertEqual(review.review(self.candidate, ask, self.config)['reason'], reason)

    def test_capture_timeout_cleans_up_browser_process_group(self):
        from unittest.mock import Mock
        process = Mock(pid=123)
        process.communicate.side_effect = [review.subprocess.TimeoutExpired('worker', 75), ('', '')]
        with patch.object(review.subprocess, 'Popen', return_value=process), patch.object(review.os, 'killpg') as kill:
            with self.assertRaises(review.subprocess.TimeoutExpired):
                review._capture({'python': 'python3'}, self.config, 'text')
            kill.assert_called_once_with(123, review.signal.SIGKILL)
            self.assertEqual(process.communicate.call_count, 2)

    def test_plain_text_needs_no_image_and_answers_stay_separate(self):
        self.assertEqual(review.review({'study_notes': '普通文字'}, lambda _: self.fail())['status'], 'not_needed')
        text = review.markdown({'questions': [{'q':'问题', 'answer':'答案', 'explain':'思路'}]})
        self.assertIn('学生可见', text)
        self.assertIn('提交后答案', text)


if __name__ == '__main__':
    unittest.main()
