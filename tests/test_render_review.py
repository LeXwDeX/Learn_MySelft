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


    def test_tutor_check_uses_renderer_contract_without_model_or_images(self):
        source = 'flowchart TD\n A["向量<br/>坐标"] --> B["表示"]\n'
        with patch.object(review, '_capture', return_value={'complete': True, 'diagrams': 2, 'errors': []}) as capture:
            result = review.validate_mermaid(source, self.config)
        self.assertEqual(result, {'status': 'passed', 'source': source.replace('<br/>', ' ')})
        self.assertEqual(capture.call_args.kwargs, {'check_only': True})
        self.assertNotIn('<br/>', capture.call_args.args[2])

    def test_tutor_unavailable_or_partial_capture_never_passes(self):
        source = 'flowchart TD\n A-->B'
        for captured in ({'complete': False, 'diagrams': 2, 'errors': []},
                         {'complete': True, 'diagrams': 1, 'errors': []},
                         {'complete': True, 'images': ['image'], 'errors': []}):
            with self.subTest(captured=captured), patch.object(review, '_capture', return_value=captured):
                self.assertEqual(review.validate_mermaid(source, self.config)['status'], 'unavailable')
        with patch.object(review, '_capture', return_value={'errors': ['synthetic private source']}):
            self.assertEqual(review.validate_mermaid(source, self.config), {'status': 'failed', 'reason': 'diagram_render_failed'})
        with patch.object(review, '_capture', side_effect=TimeoutError('renderer busy')):
            self.assertEqual(review.validate_mermaid(source, self.config)['status'], 'unavailable')
        self.assertEqual(review.validate_mermaid(source, self.config.with_name('missing'))['status'], 'unavailable')

    def test_tutor_guards_raw_size_and_unsafe_syntax_before_worker(self):
        for source in ('flowchart TD\n A["坏<br onclick=x>标签"] --> B',
                       'flowchart TD\n A<br/> --> B',
                       'flowchart TD\n click A "https://invalid.example"',
                       'flowchart TD\n %%{init: {}}',
                       'pie\n "示例": 1',
                       'sequenceDiagram\n participant A\n participant B\n' + ' A->>B: 消息\n' * 101,
                       'flowchart TD\n A["' + 'x<br/>' * 1400 + '"] --> B'):
            with self.subTest(source=source[:20]), patch.object(review, '_capture') as capture:
                self.assertEqual(review.validate_mermaid(source, self.config)['status'], 'failed')
                capture.assert_not_called()

    def test_tutor_sequence_edge_limit_accepts_100_and_rejects_101(self):
        source = 'sequenceDiagram\n participant A\n participant B\n' + ' A->>B: 消息\n' * 100
        with patch.object(review, '_capture', return_value={'complete': True, 'diagrams': 2, 'errors': []}) as capture:
            self.assertEqual(review.validate_mermaid(source, self.config)['status'], 'passed')
            capture.assert_called_once()
            capture.reset_mock()
            self.assertEqual(review.validate_mermaid(source + ' A->>B: 消息\n', self.config),
                             {'status': 'failed', 'reason': 'diagram_too_many_edges'})
            capture.assert_not_called()


if __name__ == '__main__':
    unittest.main()
