"""Final persistence failure releases the single-flight node generation gate."""
import contextlib
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from application import create_application
from background_jobs import JobError
from job_execution import JobDeadlineExceeded, execution_budget
import job_execution
import quiz_harness as harness
from test_quiz_harness import questions


class NodeContentRepairTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.app = create_application({'STATE_DIR': directory.name, 'DELETE_PASSWORD': 'test-password'})
        self.addCleanup(self.app.close)
        self.key = 'u0/learn-path-v1-content-repair'
        self.node = {'id': 'n1', 'title': '交换分量'}
        self.material = {'plan': {'nodes': [self.node, {'id': 'n2', 'title': '旧单元'}]},
                         'unknown': {'keep': True}, 'nodeState': {'n2': {'status': 'review'}},
                         'nodeDetail': {'n2': {'study_notes': '保留旧正文', 'quiz': {'rounds': [{'id': 'old'}]}}}}
        self.app.repository.write_key(self.key, json.dumps(self.material))
        self.before = self.app.repository.material(self.key)
        self.actor = self.app.accounts.get_user('u0')

    def candidate(self, notes):
        return json.dumps({'study_notes': notes, 'quiz': {'questions': questions()}})

    def generate(self, **kwargs):
        return self.app.learning.node('/path/node', {'key': self.key, 'node': self.node, 'defer_visual': True},
                                      self.actor, **kwargs)

    def checked(self, qs, **kwargs):
        return harness.validate_questions(qs, **kwargs)

    def test_rejected_lesson_regenerates_and_rechecks_before_issuing(self):
        checked_notes = []
        def review(candidate):
            checked_notes.append(candidate['study_notes'])
            if len(checked_notes) == 1:
                raise harness.QuizContractError('第一个向量顺序错误')
            return {'status': 'passed'}
        with patch.object(self.app.model, 'nonempty', side_effect=[self.candidate('被拒绝正文'), self.candidate('修正后的正文')]) as model, \
             patch.object(self.app.verification, 'checked_questions', side_effect=self.checked) as verify, \
             patch.object(self.app.verification, 'review_rendered', side_effect=review), \
             patch.object(self.app.learning, 'log_node_failure') as log:
            status, result = self.generate()
        self.assertEqual(status, 200)
        self.assertEqual(checked_notes, ['被拒绝正文', '修正后的正文'])
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(model.call_count, 2)
        self.assertIn('第一个向量顺序错误', model.call_args.args[0][-1]['content'])
        log.assert_called_once()
        self.assertEqual(log.call_args.args[1], 'render_review')
        saved = self.app.repository.material(self.key)
        self.assertEqual(saved['nodeDetail']['n1']['study_notes'], '修正后的正文')
        self.assertEqual(len(result['quiz']['questions']), 6)
        self.assertEqual(saved['nodeDetail']['n2'], self.before['nodeDetail']['n2'])
        self.assertEqual(saved['nodeState'], self.before['nodeState'])
        self.assertEqual(saved['unknown'], self.before['unknown'])
        self.assertEqual(self.app.cache.gates, {})

    def test_three_rejections_stop_without_publishing_or_changing_old_rounds(self):
        with patch.object(self.app.model, 'nonempty', side_effect=[self.candidate(str(index)) for index in range(3)]) as model, \
             patch.object(self.app.verification, 'checked_questions', side_effect=self.checked) as verify, \
             patch.object(self.app.verification, 'review_rendered', side_effect=harness.QuizContractError('显示错误')) as render:
            with self.assertRaisesRegex(harness.QuizContractError, '正文渲染复核失败'):
                self.generate()
        self.assertEqual((model.call_count, verify.call_count, render.call_count), (3, 3, 3))
        self.assertEqual(self.app.repository.material(self.key), self.before)
        self.assertEqual(self.app.cache.gates, {})

    def test_unavailable_or_external_errors_do_not_regenerate_content(self):
        for failure in ({'status': 'unavailable'}, JobError(403, '无权限'), OSError('storage unavailable'), JobDeadlineExceeded()):
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(self.app.model, 'nonempty', return_value=self.candidate('候选正文')) as model, \
                 patch.object(self.app.verification, 'checked_questions', side_effect=self.checked), \
                 patch.object(self.app.verification, 'review_rendered', **({'return_value': failure} if isinstance(failure, dict) else {'side_effect': failure})):
                with self.assertRaises((JobError, OSError, JobDeadlineExceeded)):
                    self.generate()
            self.assertEqual(model.call_count, 1)
            self.assertEqual(self.app.repository.material(self.key), self.before)
            self.assertEqual(self.app.cache.gates, {})

    def test_cancel_or_original_deadline_stops_before_next_candidate(self):
        for mode in ('cancel', 'deadline'):
            stopped = [False]
            clock = [100.0]
            def reject(candidate):
                stopped[0] = True
                clock[0] = 111.0
                raise harness.QuizContractError('需要修复')
            with self.subTest(mode=mode), \
                 patch.object(job_execution.time, 'monotonic', side_effect=lambda: clock[0]), \
                 patch.object(self.app.model, 'nonempty', return_value=self.candidate('候选正文')) as model, \
                 patch.object(self.app.verification, 'checked_questions', side_effect=self.checked), \
                 patch.object(self.app.verification, 'review_rendered', side_effect=reject), \
                 (execution_budget(10) if mode == 'deadline' else contextlib.nullcontext()):
                with self.assertRaises(JobDeadlineExceeded if mode == 'deadline' else JobError):
                    self.generate(cancelled=lambda: stopped[0] and mode == 'cancel')
            self.assertEqual(model.call_count, 1)
            self.assertEqual(self.app.repository.material(self.key), self.before)
            self.assertEqual(self.app.cache.gates, {})

class NodeSaveCacheTests(unittest.TestCase):
    def test_deleted_node_or_storage_failure_releases_gate(self):
        for mode in ('deleted','storage'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as path:
                app=create_application({'STATE_DIR':path,'DELETE_PASSWORD':'test-password'})
                self.addCleanup(app.close)
                key='u0/learn-path-v1-cache';node={'id':'n1','title':'角'}
                material={'topic':'角','plan':{'nodes':[node]}}
                app.repository.write_key(key,json.dumps(material))
                candidate={'study_notes':'正文','quiz':{'questions':[]},'manim_review':{'asset_id':'a'*32}}
                def review(value):
                    if mode=='deleted':app.repository.write_key(key,json.dumps({'plan':{'nodes':[]}}))
                    return {'status':'passed'}
                def enriched(value,*args,**kwargs):
                    value['manim_review']={'status':'passed','asset_id':'a'*32}
                with patch('learning_service._norm_node_detail',return_value=candidate),patch('learning_service._issued_quiz',return_value={}), \
                     patch.object(app.model,'nonempty',return_value='{}'),patch.object(app.scenes,'enrich_candidate',side_effect=enriched), \
                     patch.object(app.verification,'checked_questions',return_value=[]),patch.object(app.verification,'review_rendered',side_effect=review), \
                     patch.object(app.cache,'finish',wraps=app.cache.finish) as finish,patch.object(app.manim,'discard') as discard, \
                     (patch.object(app.repository,'merge',side_effect=OSError('storage failed')) if mode=='storage' else contextlib.nullcontext()):
                    with self.assertRaises((JobError,OSError)):
                        app.learning.node('/path/node',{'key':key,'node':node},app.accounts.get_user('u0'))
                    finish.assert_called_once()
                    self.assertEqual(finish.call_args.kwargs['err'],'node save failed')
                    gate=finish.call_args.args[1]
                    self.assertTrue(gate['ev'].is_set())
                    self.assertNotIn(key+'#node#n1',app.cache.gates)
                    discard.assert_called_once_with('a'*32)
                app.close()
