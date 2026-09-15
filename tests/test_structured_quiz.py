"""Scoring policy, blank positions, persistence and compatibility acceptance."""
import copy
import json
import unittest
import test_quiz_harness as base

harness = base.harness
study = base.study


def fill(mode='per_blank'):
    blanks = [
        {'id': 'b1', 'answer': 'float64(x)', 'accepted_answers': ['float64(x)'], 'points': 8},
        {'id': 'b2', 'answer': '隐式', 'accepted_answers': ['隐式', '隐式的'], 'points': 12},
    ]
    if mode == 'all_or_nothing':
        for b in blanks:
            b.pop('points')
    return {'type': 'fill', 'q': 'int 变量 x 转换为 float64 写作 ____；Go 不允许 ____ 类型转换。',
            'answer': 'float64(x)；隐式', 'points': 20, 'explain': 'Go 需要显式转换。',
            'scoring': {'mode': mode}, 'blanks': blanks}


def paper(mode='per_blank'):
    qs = base.questions()
    qs[4] = fill(mode)
    return harness.validate_questions(qs, node=True)


class StructuredContractTests(unittest.TestCase):
    def grade(self, value, mode='per_blank'):
        qs = paper(mode)
        answers = [''] * 6
        answers[4] = value
        return harness.grade(qs, answers, lambda _: self.fail('Objective grading invoked model'))

    def test_per_blank_weights_aliases_and_positions(self):
        for value, score in [(['float64(x)', '隐式的'], 20), (['float64(x)', '错误'], 8),
                             (['', '隐式'], 12), (['隐式', 'float64(x)'], 0), (['', ''], 0),
                             (['float64(X)', '隐式'], 12), ('float64(x)\n隐式', 20)]:
            with self.subTest(value=value):
                result = self.grade(value)
                self.assertEqual(result['score'], score)
                row = result['per_question'][4]
                self.assertEqual(sum(b['earned'] for b in row['blanks']), row['earned'])
                self.assertEqual([b['max_points'] for b in row['blanks']], [8, 12])

    def test_whole_question_has_no_invented_blank_scores(self):
        for value, score in [(['float64(x)', '隐式'], 20), (['float64(x)', 'wrong'], 0), (['', ''], 0)]:
            result = self.grade(value, 'all_or_nothing')
            row = result['per_question'][4]
            self.assertEqual(row['earned'], score)
            self.assertTrue(all('earned' not in b and 'max_points' not in b for b in row['blanks']))

    def test_reference_arrays_are_full_marks_and_punctuation_is_literal(self):
        qs = paper()
        answers = [q['answer'] for q in qs]
        answers[4] = [b['answer'] for b in qs[4]['blanks']]
        self.assertEqual(harness.grade(qs, answers, lambda _: None)['score'], 100)
        qs[4]['blanks'][0].update(answer='a;b,c', accepted_answers=['a;b,c'])
        harness.validate_questions(qs, node=True)
        answers[4] = ['a;b,c', '隐式']
        self.assertEqual(harness.grade(qs, answers, lambda _: None)['score'], 100)

    def test_contract_rejects_ambiguous_or_invalid_rules(self):
        mutations = [lambda q: q.pop('scoring'), lambda q: q.update(scoring={'mode': 'rubric'}),
                     lambda q: q.update(scoring={'mode': 'per_blank', 'partial_credit': False}),
                     lambda q: q.update(q='只有一个空 ____'), lambda q: q['blanks'].pop(),
                     lambda q: q['blanks'][0].update(id='b2'), lambda q: q['blanks'][0].update(points=True),
                     lambda q: q['blanks'][0].update(points=0), lambda q: q['blanks'][0].update(points=9),
                     lambda q: q['blanks'][0].update(accepted_answers=[]),
                     lambda q: q['blanks'][0].update(accepted_answers=['different']),
                     lambda q: q['blanks'][0].update(case_sensitive=False),
                     lambda q: q.update(scoring={'mode': 'all_or_nothing'})]
        for mutate in mutations:
            qs = paper(); mutate(qs[4])
            with self.subTest(mutate=mutate), self.assertRaises(harness.QuizContractError):
                harness.validate_questions(qs, node=True)

    def test_malformed_answers_rejected_without_coercion(self):
        for answer in [['x'], ['x', 'y', 'z'], ['x', 42], {'b1': 'x'}, ['x' * 20001, '']]:
            with self.subTest(answer_type=type(answer)), self.assertRaises(harness.QuizContractError):
                self.grade(answer)
        qs = paper()
        with self.assertRaises(harness.QuizContractError):
            harness.validate_answers(qs, [['A']] + [''] * 5)

    def test_numeric_equivalence_and_case_sensitive_code(self):
        self.assertTrue(harness.blank_equivalent('2/4', '0.5'))
        self.assertTrue(harness.blank_equivalent(' float64( x ) ', 'float64(x)'))
        self.assertFalse(harness.blank_equivalent('float64(X)', 'float64(x)'))
        self.assertFalse(harness.blank_equivalent('1/0', '0'))

    def test_legacy_whole_answer_and_history_are_unchanged(self):
        qs = paper()
        qs[4].pop('scoring'); qs[4].pop('blanks')
        qs[4]['accepted_answers'] = ['float64(x)；隐式']
        quiz = {'questions': qs, 'lastAnswers': [''] * 6, 'lastResult': {'score': 60}}
        before = copy.deepcopy(quiz)
        harness.ensure_round(quiz)
        self.assertEqual(quiz['rounds'][0]['attempts'][0]['result'], before['lastResult'])
        self.assertNotIn('scoring', quiz['rounds'][0]['questions'][4])
        answers = [''] * 6
        answers[4] = ['float64(x)', '隐式']
        self.assertEqual(harness.grade(qs, answers, lambda _: None)['score'], 20)
        answers[4][1] = 'wrong'
        self.assertEqual(harness.grade(qs, answers, lambda _: None)['score'], 0)

    def test_normalization_retains_rules_and_verifier_checks_them(self):
        q = fill()
        self.assertEqual(study._norm_shq(q)['blanks'], q['blanks'])
        self.assertEqual(study._norm_shq(q)['scoring'], q['scoring'])


class StructuredIntegrationTests(unittest.TestCase):
    setUp = base.state_tests.StateRegressionTests.setUp
    post = base.state_tests.StateRegressionTests.post
    material = base.state_tests.StateRegressionTests.material

    def test_arrays_survive_drafts_grading_reload_and_retry(self):
        qs = paper()
        quiz = study._issued_quiz(qs)
        self.initial['nodeDetail'] = {'n1': {'quiz': quiz}}
        study._state_write_key(base.KEY, json.dumps(self.initial))
        answers = [''] * 6
        answers[4] = ['', '隐式']
        body = {'key': base.KEY, 'node': {'id': 'n1'}, 'round_id': quiz['round_id'], 'answers': answers}
        code, saved = self.post('/path/quiz/draft', dict(body, client_id='structured', sequence=2))
        self.assertEqual(code, 200)
        self.assertEqual(saved['draft']['answers'][4], ['', '隐式'])
        code, result = self.post('/path/quiz', dict(body, scoring={'mode': 'all_or_nothing'}, points=100))
        self.assertEqual(code, 200)
        self.assertEqual(result['score'], 12)
        self.assertEqual(result['per_question'][4]['mode'], 'per_blank')
        self.assertEqual(self.post('/path/quiz', body)[1]['attempt_id'], result['attempt_id'])
        saved = self.post('/path/quiz/state', {'key': base.KEY, 'node': {'id': 'n1'}})[1]
        attempts = saved['rounds'][0]['attempts']
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]['answers'][4], ['', '隐式'])
        self.assertNotIn('draft', saved['rounds'][0])
        for endpoint in ['/path/quiz', '/path/quiz/draft']:
            invalid = dict(body, answers=[''] * 4 + [['wrong count']] + [''], client_id='structured', sequence=3)
            self.assertGreaterEqual(self.post(endpoint, invalid)[0], 400)
