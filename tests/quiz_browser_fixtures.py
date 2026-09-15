"""Emit deterministic browser fixtures. Import only into an isolated test store.

These are test-issued rounds, not evidence of successful model generation.
"""
import json
from test_structured_quiz import paper, harness


def fixtures():
    rounds = [harness.new_round(paper()), harness.new_round(paper('all_or_nothing'))]
    qs = paper()
    qs[4]['q'] = '计算结果：1+1=____，2+1=____，2+2=____。'
    qs[4]['blanks'] = [
        {'id': 'b' + str(i + 1), 'answer': str(value), 'accepted_answers': [str(value)], 'points': points}
        for i, (value, points) in enumerate([(2, 6), (3, 7), (4, 7)])
    ]
    rounds.append(harness.new_round(harness.validate_questions(qs, node=True)))
    qs = paper()
    qs[4].pop('scoring')
    qs[4].pop('blanks')
    qs[4]['accepted_answers'] = ['float64(x)；隐式']
    old = harness.new_round(qs)
    old['harness_version'] = 1
    old['draft'] = {'answers': ['', '', '', '', 'float64(x)\n隐式', '']}
    rounds.append(old)
    qs = paper()
    qs[4]['q'] = '计算 1+1=____。'
    qs[4]['blanks'] = [{'id': 'b1', 'answer': '2', 'accepted_answers': ['2'], 'points': 20}]
    rounds.append(harness.new_round(harness.validate_questions(qs, node=True)))
    quiz = {'questions': rounds[0]['questions'], 'rounds': rounds, 'round_id': rounds[0]['id']}
    key = 'u0/learn-path-v1-quiz-v2-regression'
    plan = {'title': '结构化填空测试', 'nodes': [
        {'id': 'n1', 'title': '结构化计分', 'deps': [], 'essence': '逐空计分与整题计分验证'}]}
    material = {'topic': '结构化填空测试', 'stage': 'learning',
                'spec': {'topic': 'Go', 'level': '入门', 'goal': '显式转换'}, 'plan': plan,
                'nodeState': {}, 'nodeDetail': {'n1': {'study_notes': '隔离测试', 'quiz': quiz}}}
    return {key: material, 'u0/quiz-map-v1-quiz-v2-regression': {
        **quiz, 'title': '结构化测验测试', 'sourceKey': key, 'sourceSlug': 'quiz-v2-regression'}}


if __name__ == '__main__':
    print(json.dumps(fixtures(), ensure_ascii=False))
