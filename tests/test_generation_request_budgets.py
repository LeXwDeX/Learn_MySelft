"""Exercise bounded generation through the real client, verification and save gates."""
import copy
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from application import create_application
from background_jobs import JobError
import model_transport
import quiz_harness as harness
import render_review
from test_quiz_harness import questions


class GenerationRequestBudgetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = create_application({'STATE_DIR': self.directory.name,
                                       'DELETE_PASSWORD': 'synthetic-password',
                                       'MAX_OUTPUT_TOKENS': '393216', 'REASONING_EFFORT': 'max'})
        self.addCleanup(self.app.close)
        self.actor = self.app.accounts.get_user('u0')
        self.key = 'u0/learn-path-v1-request-budgets'
        self.node = {'id': 'n1', 'title': '合成单元', 'objectives': ['解释概念']}
        self.material = {'topic': '合成主题', 'plan': {'nodes': [self.node]},
                         'nodeState': {'n2': {'mark': 'review'}}, 'unknown': 'keep'}
        self.app.repository.write_key(self.key, json.dumps(self.material))
        self.candidate = {'study_notes': r'合成公式：$\frac{1}{2}$。',
                          'quiz': {'questions': questions()}}
        self.records = []
        self.replies = {}
        self.config = Path(self.directory.name) / 'renderer-config.json'
        self.config.write_text('{}')
        real_review = render_review.review
        patches = [patch.object(render_review, 'review',
                   side_effect=lambda candidate, ask: real_review(candidate, ask, self.config)),
                   patch.object(render_review, '_capture', return_value={
                       'complete': True, 'images': ['data:image/jpeg;base64,AA=='], 'errors': []}),
                   patch.object(model_transport, 'post', side_effect=self.transport)]
        for mock in patches:
            mock.start()
            self.addCleanup(mock.stop)

    def transport(self, url, payload, headers, timeout):
        body = json.loads(payload)
        if body.get('response_format') == {'type': 'json_object'}:
            # The deployed gateway rejects JSON mode before inference when no
            # message explicitly names JSON. Enforce that observed HTTP contract.
            self.assertRegex(json.dumps(body['messages'], ensure_ascii=False), r'(?i)json',
                             'JSON mode requires a JSON instruction in messages')
        system = body['messages'][0]['content']
        stage = ('repair' if '仅修复测验' in system else
                 'verification' if '独立验题员' in system else
                 'render' if '输出复核老师' in system else
                 'generation' if '为一个学习节点写学习材料' in system else 'default')
        self.records.append({'stage': stage, 'body': body, 'timeout': timeout})
        if stage in self.replies:
            selected = self.replies[stage]
            content = selected.pop(0) if isinstance(selected, list) else selected
        elif stage == 'generation':
            content = json.dumps(self.candidate, ensure_ascii=False)
        elif stage == 'repair':
            content = json.dumps(self.candidate['quiz'], ensure_ascii=False)
        elif stage == 'verification':
            content = json.dumps({'questions': [
                {'index': i, 'valid': True, 'reference_complete': True, 'reason': '合成验题依据'}
                for i in range(6)]})
        else:
            content = json.dumps({'ok': True, 'issues': []})
        return json.dumps({'choices': [{'message': {'content': content}}]}).encode()

    def generate(self):
        return self.app.learning.node('/path/node', {'key': self.key, 'node': self.node,
                                                    'defer_visual': True}, self.actor)

    def assert_not_saved(self):
        self.assertEqual(self.app.repository.material(self.key), self.material)
        self.assertEqual(self.app.cache.gates, {})

    def test_checked_math_lesson_uses_separate_budgets_without_changing_default_calls(self):
        code, detail = self.generate()
        self.assertEqual(code, 200)
        self.assertEqual(detail['study_notes'], self.candidate['study_notes'])
        self.assertTrue(detail['quiz']['round_id'])
        self.assertEqual(detail['render_review']['status'], 'passed')
        self.assertEqual(detail['manim_review']['status'], 'pending')
        self.assertEqual(self.app.repository.material(self.key)['nodeDetail']['n1'], detail)
        self.assertEqual([(r['stage'], r['body']['max_tokens'], r['body']['reasoning_effort'])
                          for r in self.records],
                         [('generation', 16384, 'medium'), ('verification', 4096, 'medium'),
                          ('render', 2048, 'low')])
        self.assertTrue(all(r['body']['response_format'] == {'type': 'json_object'} for r in self.records))
        self.assertEqual(self.records[-1]['timeout'], 120)
        self.app.model.json([{'role': 'system', 'content': '合成默认请求'}])
        default = self.records[-1]['body']
        self.assertEqual(default['max_tokens'], 393216)
        self.assertEqual(default['reasoning_effort'], 'max')
        self.assertNotIn('response_format', default)
        self.assertEqual(self.app.model.settings.max_output_tokens, 393216)

    def test_empty_and_nonempty_invalid_json_have_only_three_candidate_requests(self):
        malformed = '{"study_notes":"synthetic","quiz":{"questions":[{"type":"choice"}}}'
        for reply in ('', malformed):
            with self.subTest(empty=not reply):
                self.records.clear()
                self.replies = {'generation': reply}
                with self.assertRaises(harness.QuizContractError):
                    self.generate()
                self.assertEqual([r['stage'] for r in self.records], ['generation'] * 3)
                self.assert_not_saved()

    def test_real_question_rejection_repairs_only_quiz_then_requires_new_checks(self):
        reject = {'questions': [
            {'index': i, 'valid': i != 4, 'reference_complete': True, 'reason': '合成验题依据'}
            for i in range(6)]}
        self.replies['verification'] = [json.dumps(reject), json.dumps({'questions': [
            {'index': i, 'valid': True, 'reference_complete': True, 'reason': '合成重新验题依据'}
            for i in range(6)]})]
        code, detail = self.generate()
        self.assertEqual(code, 200)
        self.assertEqual(detail['study_notes'], self.candidate['study_notes'])
        self.assertEqual([r['stage'] for r in self.records],
                         ['generation', 'verification', 'repair', 'verification', 'render'])
        repair = next(r['body'] for r in self.records if r['stage'] == 'repair')
        self.assertEqual((repair['max_tokens'], repair['reasoning_effort'], repair['response_format']),
                         (8192, 'medium', {'type': 'json_object'}))
        self.assertEqual(self.app.model.settings.max_output_tokens, 393216)

    def test_empty_quiz_repairs_do_not_repeat_requests_or_save_rejected_material(self):
        self.replies['verification'] = json.dumps({'questions': [
            {'index': i, 'valid': False, 'reference_complete': False, 'reason': '合成拒绝理由'}
            for i in range(6)]})
        self.replies['repair'] = ''
        with self.assertRaises(harness.QuizContractError):
            self.generate()
        self.assertEqual([r['stage'] for r in self.records],
                         ['generation', 'verification', 'repair', 'repair'])
        self.assert_not_saved()

    def test_render_rejection_still_requires_regeneration_and_never_saves(self):
        self.replies['render'] = json.dumps({'ok': False, 'issues': ['合成公式显示错误']})
        with self.assertRaises(harness.QuizContractError):
            self.generate()
        self.assertEqual([r['stage'] for r in self.records],
                         ['generation', 'verification', 'render'] * 3)
        self.assert_not_saved()

    def test_unavailable_render_verdict_is_not_counted_as_a_pass(self):
        self.replies['render'] = json.dumps({'ok': 'true', 'issues': []})
        with self.assertRaises(JobError) as error:
            self.generate()
        self.assertEqual(error.exception.status, 503)
        self.assert_not_saved()

    def test_lower_global_limit_is_respected_by_every_stage(self):
        self.app.model.settings = replace(self.app.model.settings, max_output_tokens=1024)
        self.replies['verification'] = [json.dumps({'questions': [
            {'index': i, 'valid': False, 'reference_complete': True, 'reason': '合成拒绝理由'}
            for i in range(6)]}), json.dumps({'questions': [
            {'index': i, 'valid': True, 'reference_complete': True, 'reason': '合成验题依据'}
            for i in range(6)]})]
        code, _ = self.generate()
        self.assertEqual(code, 200)
        self.assertEqual([r['stage'] for r in self.records],
                         ['generation', 'verification', 'repair', 'verification', 'render'])
        self.assertTrue(all(r['body']['max_tokens'] == 1024 for r in self.records))
        self.assertEqual(self.app.model.settings.max_output_tokens, 1024)

    def test_non_node_and_legacy_verification_keep_strict_rejection(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                self.records.clear()
                qs = copy.deepcopy(questions())
                self.replies['verification'] = json.dumps({'questions': [
                    {'index': i, 'valid': False, 'reference_complete': True, 'reason': '合成拒绝理由'}
                    for i in range(6)]})
                with self.assertRaises(harness.QuizContractError):
                    self.app.verification.checked_questions(qs, node=False, legacy=legacy)
                self.assertEqual(len(self.records), 1)
                self.assertEqual(self.records[0]['body']['max_tokens'], 4096)
                self.assertEqual(self.records[0]['body']['response_format'], {'type': 'json_object'})
                self.assert_not_saved()

    def test_sixteen_question_map_requires_a_verdict_for_every_question(self):
        qs = [copy.deepcopy(questions()[0]) for _ in range(16)]
        for i, question in enumerate(qs):
            question.update(q='问题' + chr(65 + i), points=6 if i < 12 else 7)
        self.replies['verification'] = json.dumps({'questions': [
            {'index': i, 'valid': True, 'reference_complete': True, 'reason': '合成验题依据'}
            for i in range(16)]})
        checked = self.app.verification.checked_questions(qs)
        self.assertEqual(len(checked), 16)
        self.assertEqual(len(self.records), 1)
        self.assertEqual(len(json.loads(self.records[0]['body']['messages'][1]['content'])), 16)
        self.assertEqual(self.records[0]['body']['max_tokens'], 4096)
        self.replies['verification'] = json.dumps({'questions': [
            {'index': i, 'valid': True, 'reference_complete': True, 'reason': '合成验题依据'}
            for i in range(15)]})
        with self.assertRaises(harness.QuizContractError):
            self.app.verification.checked_questions(qs)


if __name__ == '__main__':
    unittest.main()
