"""Two-cycle flywheel checks use isolated state and deterministic model responses."""
import copy
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import test_state_regressions as base
import test_quiz_harness as fixtures

study = base.study
KEY = base.KEY


class FlywheelTests(unittest.TestCase):
    def setUp(self):
        self.case = base.StateRegressionTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.exam = 'u0/quiz-map-v1-flywheel'
        questions = fixtures.questions()
        for question in questions:
            question.update(point='L1 Basics', node_id='n1')
        self.quiz = {'sourceKey': KEY, 'sourceSlug': 'regression', 'title': 'Exam', **study._issued_quiz(questions)}
        study._state_write_key(self.exam, json.dumps(self.quiz))

    def grade(self, correct_first=False):
        status, result = self.case.post('/path/quiz', {'key': self.exam, 'round_id': self.quiz['round_id'],
                                                     'answers': ['A' if correct_first else ''] + [''] * 5})
        self.assertEqual(status, 200)
        return {'round_id': result['round_id'], 'attempt_id': result['attempt_id']}

    def diagnose(self, identity):
        response = {'summary': '补强基础', 'gaps': [{'unit': 'L1 Basics', 'points': ['计算基础'], 'advice': '练习'}]}
        with patch.object(study, '_upstream_nonempty', return_value=json.dumps(response)):
            return self.case.post('/path/gaps', {'key': self.exam, **identity})

    def refine(self, identity, callback=None):
        response = {'units': [{'for': 'n1', 'title': '补习基础', 'essence': '补强失分', 'objectives': ['练习']}]}
        def generate(*args, **kwargs):
            if callback:
                callback()
            return json.dumps(response)
        with patch.object(study, '_upstream_nonempty', side_effect=generate) as model:
            status, result = self.case.post('/path/refine', {'key': KEY, 'quiz_key': self.exam, **identity})
        return status, result, model.call_count

    def test_two_cycles_use_current_results_and_preserve_history(self):
        first = self.grade()
        self.assertEqual(self.diagnose(first)[0], 200)
        status, result, _ = self.refine(first)
        self.assertEqual(status, 200)
        self.assertEqual(result['added'], 1)
        before = self.case.material()['nodeState']
        captured = []
        generated = [dict(self.quiz['questions'][i % 6], q='fresh %d' % i, point='L3 补习基础') for i in range(8)]
        def generate(messages, **kwargs):
            captured.append(json.loads(messages[-1]['content'].split('\n请输出')[0]))
            return json.dumps({'title': 'Exam', 'questions': generated})
        with patch.object(study, '_upstream_nonempty', side_effect=generate), patch.object(study, '_checked_questions'):
            status, next_exam = self.case.post('/path/quizmap', {'key': KEY})
        self.assertEqual(status, 200)
        self.assertEqual(captured[0]['综合测验表现'][0]['得分'], 0)
        self.assertEqual(captured[0]['综合测验表现'][0]['最近作答'][0]['单元'], 'n1')
        self.assertIn('n3', [n['id'] for n in captured[0]['学习地图']['nodes']])
        self.assertEqual(before, self.case.material()['nodeState'])
        self.assertTrue(study._state_material('u0/quiz-map-v1-' + next_exam['slug']))
        second = self.grade(True)
        self.assertNotEqual(first, second)
        self.assertNotIn('gaps', study._state_material(self.exam))
        self.assertEqual(self.diagnose(second)[0], 200)
        self.assertEqual(self.refine(second)[0], 200)
        self.assertEqual(len(self.case.material()['plan']['nodes']), 4)
        current = study._state_material(self.exam)
        self.assertEqual(len(current['rounds'][0]['attempts']), 2)
        evidence = study.flywheel.exam_evidence({self.exam: json.dumps(current)}, KEY, self.case.material()['plan'])
        self.assertEqual(evidence[0]['得分'], 10)
        self.assertTrue(evidence[0]['历史失分（不代表当前仍未掌握）'])

    def test_repeated_refinement_survives_cache_reset(self):
        identity = self.grade()
        self.diagnose(identity)
        first = self.refine(identity)[1]
        study._GEN_GATES.clear(); study._GEN_CACHE.clear()
        status, repeated, calls = self.refine(identity)
        self.assertEqual(status, 200)
        self.assertEqual(calls, 0)
        self.assertTrue(repeated['reused'])
        self.assertEqual(first['node_ids'], repeated['node_ids'])
        self.assertEqual(len(repeated['plan']['nodes']), 3)

    def test_stale_diagnosis_and_browser_snapshot_cannot_return(self):
        identity = self.grade()
        self.diagnose(identity)
        old = study._state_material(self.exam)
        self.grade(True)
        status, result = self.case.post('/path/gaps', {'key': self.exam, **identity})
        self.assertEqual(status, 409)
        status, _ = self.case.post('/state/put', {'entries': {self.exam: json.dumps(old)}})
        self.assertEqual(status, 200)
        self.assertNotIn('gaps', study._state_material(self.exam))
        self.assertNotIn('diagnosis', study._state_material(self.exam))

    def test_late_diagnosis_cannot_overwrite_new_attempt(self):
        identity = self.grade()
        def delayed(*args, **kwargs):
            self.grade(True)
            return json.dumps({'summary': 'old', 'gaps': [{'unit': 'L1 Basics', 'points': ['old']}]})
        with patch.object(study, '_upstream_nonempty', side_effect=delayed):
            status, _ = self.case.post('/path/gaps', {'key': self.exam, **identity})
        self.assertEqual(status, 409)
        self.assertNotIn('gaps', study._state_material(self.exam))

    def test_late_refinement_does_not_append_after_regrade(self):
        identity = self.grade(); self.diagnose(identity)
        status, _, _ = self.refine(identity, lambda: self.grade(True))
        self.assertEqual(status, 409)
        self.assertEqual(len(self.case.material()['plan']['nodes']), 2)

    def test_concurrent_receipt_appends_once(self):
        unit = {'for': 'n1', 'title': 'remedial', 'essence': '', 'objectives': []}
        def append(_):
            return study._append_refinement(KEY, {}, [unit], 'same-attempt')
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(append, range(8)))
        self.assertEqual(len(self.case.material()['plan']['nodes']), 3)
        self.assertEqual(len(self.case.material()['refinementReceipts']), 1)

    def test_other_maps_and_users_do_not_enter_evidence(self):
        self.grade()
        current = study._state_material(self.exam)
        other = {**current, 'sourceKey': 'u0/learn-path-v1-other'}
        entries = {'u1111111111111111/quiz-map-v1-x': json.dumps(current), 'u0/quiz-map-v1-other': json.dumps(other)}
        self.assertEqual(study.flywheel.exam_evidence(entries, KEY, self.case.material()['plan']), [])
        status, _ = self.case.post('/path/refine', {'key': KEY, 'quiz_key': 'u1111111111111111/quiz-map-v1-x'})
        self.assertIn(status, (403, 404))

    def test_full_score_has_no_remediation_even_with_old_diagnosis(self):
        identity = self.grade(); self.diagnose(identity)
        quiz = study._state_material(self.exam)
        latest = quiz['rounds'][0]['attempts'][-1]
        latest['result']['score'] = 100
        for grade in latest['result']['per_question']:
            grade.update(earned=grade['max_points'], ok=True)
        quiz['lastResult'] = latest['result']
        quiz.pop('diagnosis')
        study._state_write_key(self.exam, json.dumps(quiz))
        status, result = self.diagnose(identity)
        self.assertEqual(status, 200)
        self.assertEqual(result['gaps'], [])
        self.assertEqual(self.refine(identity)[0], 409)
