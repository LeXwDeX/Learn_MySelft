import copy
import json
import unittest
from unittest.mock import patch
import test_state_regressions as state_tests

study = state_tests.study
harness = study.harness
KEY = state_tests.KEY


def questions():
    result = [
        {'q': '哪个选项是整数加法的结果？', 'options': ['3', '4', '5', '6'], 'answer': 'A', 'type': 'choice', 'points': 10, 'explain': '验算'},
        {'q': '下列图形中哪一种只有三条边？', 'options': ['圆', '三角形', '矩形', '六边形'], 'answer': 'B', 'type': 'choice', 'points': 10, 'explain': '三条边'},
        {'q': '水在标准大气压下凝固时温度是多少？', 'options': ['10', '20', '0', '30'], 'answer': 'C', 'type': 'choice', 'points': 10, 'explain': '零摄氏度'},
        {'q': '英语单词apple的中文含义是哪项？', 'options': ['香蕉', '橘子', '西瓜', '苹果'], 'answer': 'D', 'type': 'choice', 'points': 10, 'explain': '苹果'},
        {'q': '计算一半加一半，填写数值____。', 'answer': '1', 'accepted_answers': ['1.0'], 'type': 'fill', 'points': 20, 'explain': '通分'},
        {'q': '解释实验为何需要对照，并写出思路与结论。', 'answer': '思路：控制变量；结论：排除其他因素影响。', 'type': 'short', 'points': 40, 'explain': '控制变量',
         'rubric': [{'description': '解释控制变量的方法', 'points': 20}, {'description': '说明排除其他因素影响', 'points': 20}]},
    ]
    for q in result:
        q['scoring'] = {'mode': {'choice': 'single_choice', 'short': 'rubric', 'fill': 'per_blank'}[q['type']]}
        if q['type'] == 'fill':
            q['blanks'] = [{'id': 'b1', 'answer': '1', 'accepted_answers': ['1', '1.0'], 'match': 'numeric', 'points': 20}]
    return result


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.qs = harness.validate_questions(questions(), node=True)

    def test_reference_answers_are_always_100_without_model(self):
        def no_model(_):
            self.fail('Reference answer scoring must not ask a model for a total')
        result = harness.grade(self.qs, [q['answer'] for q in self.qs], no_model)
        self.assertEqual(result['score'], 100)
        self.assertTrue(result['pass'])
        self.assertEqual(sum(q['earned'] for q in result['per_question']), 100)

    def test_model_cannot_override_total_and_only_earned_criteria_count(self):
        answers = ['wrong', 'B', 'C', 'D', '2/2', '采用控制变量的方法。']
        def judge(_):
            return {'score': 100, 'pass': True, 'questions': [{'index': 5, 'criteria': [
                {'id': 'r1', 'met': True, 'evidence': '控制变量', 'reason': '已指出方法'},
                {'id': 'r2', 'met': False, 'evidence': '', 'reason': '未说明排除干扰的结论'}]}]}
        result = harness.grade(self.qs, answers, judge)
        self.assertEqual(result['score'], 70)
        self.assertEqual(result['per_question'][5]['earned'], 20)
        self.assertEqual(result['score'], sum(p['earned'] for p in result['per_question']))

    def test_blank_is_zero_and_pass_threshold_is_programmed(self):
        result = harness.grade(self.qs, [''] * 6, lambda _: self.fail('No model for blank answers'))
        self.assertEqual(result['score'], 0)
        self.assertFalse(result['pass'])
        result = harness.grade(self.qs, [q['answer'] for q in self.qs[:5]] + [''], lambda _: None)
        self.assertEqual(result['score'], 60)
        self.assertTrue(result['pass'])

    def test_missing_duplicate_or_fabricated_evidence_is_rejected(self):
        answers = [q['answer'] for q in self.qs[:5]] + ['只写了控制变量']
        invalid = [[], [{'id': 'r1', 'met': True, 'evidence': '伪造证据', 'reason': 'x'},
                        {'id': 'r2', 'met': False, 'evidence': '', 'reason': '缺少'}],
                   [{'id': 'r1', 'met': True, 'evidence': '控制变量', 'reason': 'x'}] * 2]
        for criteria in invalid:
            with self.subTest(criteria=criteria), self.assertRaises(harness.QuizContractError):
                harness.grade(self.qs, answers, lambda _: {'questions': [{'index': 5, 'criteria': criteria}]})

    def test_repeated_questions_are_rejected_across_all_rounds(self):
        for old in [self.qs, [dict(self.qs[0], q='  ' + self.qs[0]['q'])]]:
            with self.assertRaises(harness.QuizContractError):
                harness.validate_questions(copy.deepcopy(self.qs), old, node=True)

    def test_invalid_weights_rubrics_and_verifier_are_rejected(self):
        for mutate in [lambda q: q[0].update(points=9), lambda q: q[5].update(rubric=[]),
                       lambda q: q[0].update(answer='A or B'), lambda q: q[0].update(options=['x'] * 4)]:
            qs = questions(); mutate(qs)
            with self.assertRaises(harness.QuizContractError):
                harness.validate_questions(qs, node=True)
        for response in [{'questions': []}, {'questions': [{'index': i, 'valid': 'true', 'reference_complete': True} for i in range(6)]}]:
            with self.assertRaises(harness.QuizContractError):
                harness.validate_verification(response, 6)


class HarnessIntegrationTests(unittest.TestCase):
    setUp = state_tests.StateRegressionTests.setUp
    post = state_tests.StateRegressionTests.post
    material = state_tests.StateRegressionTests.material

    def seed(self):
        qs = harness.validate_questions(questions(), node=True)
        self.initial['nodeDetail'] = {'n1': {'study_notes': 'Notes', 'quiz': study._issued_quiz(qs)}}
        study._state_write_key(KEY, json.dumps(self.initial))
        return self.initial['nodeDetail']['n1']['quiz']

    def test_drafts_are_round_scoped_ordered_and_cleared_only_on_matching_submit(self):
        quiz = self.seed()
        old_id = quiz['round_id']
        def draft(rid, seq, value):
            return self.post('/path/quiz/draft', {'key': KEY, 'node': {'id': 'n1'}, 'round_id': rid,
                'client_id': 'tab-a', 'sequence': seq, 'answers': [value] * 6})
        self.assertEqual(draft(old_id, 2, 'newer')[0], 200)
        self.assertEqual(draft(old_id, 1, 'stale')[1]['draft']['answers'], ['newer'] * 6)
        study._quiz_update(KEY, 'n1', lambda current, material: harness.add_round(current, quiz['questions']))
        new_id = study._quiz_snapshot(KEY, 'n1')['round_id']
        draft(new_id, 3, 'other round')
        rounds = self.post('/path/quiz/state', {'key': KEY, 'node': {'id': 'n1'}})[1]['rounds']
        self.assertEqual(rounds[0]['draft']['answers'], ['newer'] * 6)
        self.assertEqual(rounds[1]['draft']['answers'], ['other round'] * 6)
        answers = [q['answer'] for q in quiz['questions']]
        body = {'key': KEY, 'node': {'id': 'n1'}, 'round_id': old_id, 'answers': answers}
        self.assertEqual(self.post('/path/quiz', body)[0], 200)
        self.assertIn('draft', study._quiz_snapshot(KEY, 'n1')['rounds'][0])
        self.post('/path/quiz/draft', dict(body, client_id='tab-a', sequence=4))
        result = self.post('/path/quiz', body)[1]
        self.assertNotIn('draft', result['quiz']['rounds'][0])
        self.assertEqual(len(result['quiz']['rounds'][0]['attempts']), 1)
        self.assertEqual(result['attempt_id'], result['quiz']['rounds'][0]['attempts'][0]['id'])
        self.assertIn('draft', result['quiz']['rounds'][1])

    def test_draft_missing_round_or_client_is_rejected(self):
        quiz = self.seed()
        body = {'key': KEY, 'node': {'id': 'n1'}, 'round_id': quiz['round_id'], 'client_id': 'tab',
                'sequence': 1, 'answers': [''] * 6}
        for field in ['round_id', 'client_id']:
            invalid = dict(body); invalid.pop(field)
            self.assertEqual(self.post('/path/quiz/draft', invalid)[0], 400)

    def test_authoritative_questions_ignore_client_score_tampering(self):
        quiz = self.seed()
        code, result = self.post('/path/quiz', {'key': KEY, 'node': {'id': 'n1'}, 'round_id': quiz['round_id'],
             'questions': [{'q': 'fake', 'answer': 'fake', 'points': 100}],
             'answers': [q['answer'] for q in quiz['questions']]})
        self.assertEqual(code, 200)
        self.assertEqual(result['score'], 100)
        saved = self.material()['nodeDetail']['n1']['quiz']['rounds'][0]['attempts']
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['result']['score'], 100)
        self.assertEqual(self.material()['nodeState']['n1']['lastResult']['round_id'], quiz['round_id'])
        code, result = self.post('/path/quiz', {'questions': quiz['questions'], 'answers': ['fake'] * 6})
        self.assertEqual(code, 400)

    def test_grade_retry_preserves_one_immutable_attempt(self):
        quiz = self.seed()
        body = {'key': KEY, 'node': {'id': 'n1'}, 'round_id': quiz['round_id'], 'answers': [q['answer'] for q in quiz['questions']]}
        self.post('/path/quiz', body)
        self.post('/path/quiz', body)
        self.assertEqual(len(self.material()['nodeDetail']['n1']['quiz']['rounds'][0]['attempts']), 1)

    def test_client_cannot_overwrite_issued_questions_or_attempts(self):
        quiz = self.seed()
        malicious = copy.deepcopy(self.initial)
        malicious['nodeDetail']['n1']['quiz']['questions'][0]['answer'] = 'D'
        malicious['nodeDetail']['n1']['quiz']['rounds'] = []
        code, _ = self.post('/state/put', {'entries': {KEY: json.dumps(malicious)}})
        self.assertEqual(code, 200)
        self.assertEqual(self.material()['nodeDetail']['n1']['quiz'], quiz)

    def test_client_cannot_claim_verified_issuance_or_fake_score(self):
        proposed = copy.deepcopy(self.initial)
        proposed['nodeDetail'] = {'n1': {'quiz': study._issued_quiz(harness.validate_questions(questions(), node=True))}}
        proposed['nodeState'] = {'n1': {'score': 100, 'completed': True, 'lastResult': {'pass': True}}}
        self.post('/state/put', {'entries': {KEY: json.dumps(proposed)}})
        saved = self.material()
        self.assertNotIn('rounds', saved['nodeDetail']['n1']['quiz'])
        self.assertEqual(saved['nodeState']['n1']['score'], 30)
        self.assertFalse(saved['nodeState']['n1']['completed'])
        with patch.object(study, '_upstream_nonempty', return_value='{"questions": []}'):
            code, _ = self.post('/path/quiz', {'key': KEY, 'node': {'id': 'n1'}, 'answers': [q['answer'] for q in questions()]})
        self.assertEqual(code, 502)
        self.assertEqual(self.material()['nodeState']['n1']['score'], 30)

    def test_requiz_success_resets_latest_score_but_retains_old_attempt(self):
        quiz = self.seed()
        self.post('/path/quiz', {'key': KEY, 'node': {'id': 'n1'},
                               'answers': [q['answer'] for q in quiz['questions']]})
        with patch.object(study, '_upstream_nonempty', return_value=json.dumps({'questions': questions()})), \
             patch.object(study, '_checked_questions', return_value=questions()), \
             patch.object(study._state_store(), 'job_progress') as progress:
            code, current = self.post('/path/requiz', {'key': KEY, 'node': {'id': 'n1'}, 'round_id': quiz['round_id']})
        self.assertEqual([call.args[0] for call in progress.call_args_list], [1, 2, 3, 4])
        self.assertEqual(code, 200)
        self.assertEqual(len(current['rounds']), 2)
        self.assertEqual(current['rounds'][0]['attempts'][0]['result']['score'], 100)
        self.assertNotIn('lastResult', self.material()['nodeState']['n1'])
        self.assertNotIn('score', self.material()['nodeState']['n1'])

    def test_requiz_failure_preserves_previous_round(self):
        quiz = self.seed()
        with patch.object(study, '_upstream_nonempty', return_value=json.dumps({'questions': questions()})):
            code, _ = self.post('/path/requiz', {'key': KEY, 'node': {'id': 'n1'}, 'round_id': quiz['round_id']})
        self.assertEqual(code, 502)
        self.assertEqual(self.material()['nodeDetail']['n1']['quiz'], quiz)
        self.assertFalse(study._GEN_GATES)

    def test_round_append_retains_old_answers_and_survives_browser_snapshot(self):
        quiz = self.seed()
        self.post('/path/quiz', {'key': KEY, 'node': {'id': 'n1'}, 'answers': [q['answer'] for q in quiz['questions']]})
        new = copy.deepcopy(quiz['questions']); new[0]['q'] = 'New question for next round'
        study._quiz_update(KEY, 'n1', lambda current, material: harness.add_round(current, new))
        self.post('/state/put', {'entries': {KEY: json.dumps(self.initial)}})
        rounds = self.material()['nodeDetail']['n1']['quiz']['rounds']
        self.assertEqual(len(rounds), 2)
        self.assertEqual(rounds[0]['questions'], quiz['questions'])
        self.assertEqual(rounds[0]['attempts'][0]['result']['score'], 100)
        self.assertEqual(rounds[1]['questions'][0]['q'], 'New question for next round')


if __name__ == '__main__':
    unittest.main()
