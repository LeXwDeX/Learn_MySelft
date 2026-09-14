"""Deterministic question contracts, immutable rounds and rubric-based score assembly.

The model can propose questions and judge rubric evidence. It cannot choose the
published point weights, change an issued round, or supply the final score.
"""
import copy
import hashlib
import json
import re
import time
import unicodedata
import uuid
from difflib import SequenceMatcher
from fractions import Fraction

VERSION = 1


class QuizContractError(ValueError):
    pass


def normalized(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value))).casefold()


def fingerprint(question):
    return hashlib.sha256(normalized(question['q']).encode()).hexdigest()


def equivalent(left, right):
    left, right = normalized(left), normalized(right)
    if left == right:
        return True
    # Numeric literals and fractions only; never evaluate learner-supplied code.
    numeric = r"[-+]?\d+(?:\.\d+)?(?:/[-+]?\d+)?"
    if re.fullmatch(numeric, left) and re.fullmatch(numeric, right):
        try:
            return Fraction(left) == Fraction(right)
        except (ValueError, ZeroDivisionError):
            pass
    return False


def validate_questions(questions, previous=(), node=False):
    if not isinstance(questions, list) or not (len(questions) == 6 if node else 1 <= len(questions) <= 16):
        raise QuizContractError('题目数量不符合契约')
    if node and [q.get('type') for q in questions] != ['choice'] * 4 + ['fill', 'short']:
        raise QuizContractError('单元测验必须为4选择、1填空、1简答')
    if any(type(q.get('points')) is not int or not 1 <= q['points'] <= 100 for q in questions):
        raise QuizContractError('每题必须有明确的整数分值')
    if sum(q['points'] for q in questions) != 100:
        raise QuizContractError('题目分值合计必须为100')
    seen = [normalized(q['q']) for q in previous if isinstance(q, dict) and q.get('q')]
    for q in questions:
        if not all(isinstance(q.get(k), str) and q[k].strip() for k in ('q', 'answer', 'explain')):
            raise QuizContractError('题目、答案和解析不得为空')
        text = normalized(q['q'])
        if any(text == old or SequenceMatcher(None, text, old, autojunk=False).ratio() >= 0.9 for old in seen):
            raise QuizContractError('题目与已出题目重复或过于相似')
        seen.append(text)
        if q.get('type') == 'choice':
            options = q.get('options')
            if not isinstance(options, list) or len(options) != 4 or len({normalized(o) for o in options}) != 4:
                raise QuizContractError('选择题必须有4个不同选项')
            if q['answer'].strip().upper() not in ('A', 'B', 'C', 'D'):
                raise QuizContractError('选择题答案必须为单个选项字母')
            q['answer'] = q['answer'].strip().upper()
        elif q.get('type') == 'fill':
            q['accepted_answers'] = list(dict.fromkeys(
                [q['answer']] + re.split(r'[|｜]', q['answer']) +
                [a for a in q.get('accepted_answers', []) if isinstance(a, str) and a.strip()]))
        elif q.get('type') == 'short':
            rubric = q.get('rubric')
            if not isinstance(rubric, list) or not 1 <= len(rubric) <= 8:
                raise QuizContractError('简答题必须预先给出评分点')
            for i, criterion in enumerate(rubric):
                if not isinstance(criterion, dict) or not isinstance(criterion.get('description'), str) or not criterion['description'].strip():
                    raise QuizContractError('评分点必须说明具体要求')
                if type(criterion.get('points')) is not int or criterion['points'] <= 0:
                    raise QuizContractError('评分点必须有正整数分值')
                criterion['id'] = 'r%d' % (i + 1)
            if sum(c['points'] for c in rubric) != q['points']:
                raise QuizContractError('评分点分值必须等于本题分值')
        else:
            raise QuizContractError('不支持的题型')
        q['id'] = fingerprint(q)
    return questions


def validate_verification(result, count):
    items = result.get('questions') if isinstance(result, dict) else None
    if not isinstance(items, list) or len(items) != count:
        raise QuizContractError('验题结果不完整')
    for index, item in enumerate(items):
        if not isinstance(item, dict) or item.get('index') != index or item.get('valid') is not True or item.get('reference_complete') is not True or not isinstance(item.get('reason'), str) or not item['reason'].strip():
            raise QuizContractError('验题未通过：%s' % (item.get('reason', '') if isinstance(item, dict) else '格式错误'))
    return True


def new_round(questions, verified=True):
    return {'id': uuid.uuid4().hex, 'created': int(time.time()), 'questions': copy.deepcopy(questions),
            'attempts': [], 'harness_version': VERSION, 'verified': verified}


def ensure_round(quiz):
    """Migrate legacy questions without discarding their last result or old content."""
    if quiz.get('rounds'):
        return quiz
    questions = copy.deepcopy(quiz.get('questions') or [])
    if not questions:
        raise QuizContractError('测验没有题目')
    if any(type(q.get('points')) is not int for q in questions) or sum(q.get('points', 0) for q in questions) != 100:
        base, remainder = divmod(100, len(questions))
        for i, q in enumerate(questions):
            q['points'] = base + int(i >= len(questions) - remainder)
    for q in questions:
        q.setdefault('type', 'choice' if q.get('options') else 'short')
        q['id'] = fingerprint(q)
        if q['type'] == 'short' and not q.get('rubric'):
            q['rubric'] = [{'id': 'r1', 'description': '完整覆盖参考答案所要求的思路与结论', 'points': q['points']}]
        if q['type'] == 'fill':
            q['accepted_answers'] = [q['answer']] + re.split(r'[|｜]', q['answer'])
    round_data = new_round(questions, verified=False)
    # Legacy answers were not snapshotted with every attempt. Retain what exists,
    # explicitly label unknown historical answers rather than inventing them.
    for attempt in quiz.get('attempts') or []:
        round_data['attempts'].append(copy.deepcopy(attempt))
    if quiz.get('lastResult') and not round_data['attempts']:
        round_data['attempts'].append({'id': uuid.uuid4().hex, 'legacy': True,
                                       'answers': quiz.get('lastAnswers'), 'result': quiz['lastResult']})
    quiz.update(rounds=[round_data], round_id=round_data['id'], questions=questions)
    return quiz


def active_round(quiz, round_id=None):
    ensure_round(quiz)
    wanted = round_id or quiz['round_id']
    for round_data in quiz['rounds']:
        if round_data['id'] == wanted:
            return round_data
    raise QuizContractError('题目轮次不存在，请刷新')


def add_round(quiz, questions):
    ensure_round(quiz)
    round_data = new_round(questions)
    quiz['rounds'].append(round_data)
    quiz.update(round_id=round_data['id'], questions=copy.deepcopy(questions))
    return quiz


def attempt_id(round_id, answers):
    return hashlib.sha256(json.dumps([round_id, answers], ensure_ascii=False).encode()).hexdigest()


def grade(questions, answers, judge):
    """Objective answers are deterministic; subjective points require cited evidence."""
    if not isinstance(answers, list) or len(answers) != len(questions) or not all(isinstance(a, str) for a in answers):
        raise QuizContractError('作答数量必须与题目数量一致')
    per, subjective = [], []
    for index, (q, answer) in enumerate(zip(questions, answers)):
        maximum = q['points']
        row = {'ok': False, 'earned': 0, 'max_points': maximum, 'comment': '', 'criteria': []}
        if not answer.strip():
            row['comment'] = '未作答，得0分'
        elif equivalent(answer, q['answer']):
            row.update(ok=True, earned=maximum, comment='与参考答案一致，得满分')
            row['criteria'] = [{**c, 'met': True, 'evidence': answer, 'reason': '与参考答案一致'} for c in q.get('rubric', [])]
        elif q['type'] == 'choice':
            row['comment'] = '选项不符，正确答案为 ' + q['answer']
        elif q['type'] == 'fill':
            matched = any(equivalent(answer, accepted) for accepted in q.get('accepted_answers', re.split(r'[|｜]', q['answer'])))
            row.update(ok=matched, earned=maximum if matched else 0,
                       comment='符合预设可接受答案' if matched else '不符合预设可接受答案，参考：' + q['answer'])
        else:
            subjective.append({'index': index, 'question': q['q'], 'reference': q['answer'],
                               'answer': answer, 'rubric': q['rubric']})
        per.append(row)
    if subjective:
        response = judge(subjective)
        decisions = response.get('questions') if isinstance(response, dict) else None
        if not isinstance(decisions, list) or len(decisions) != len(subjective):
            raise QuizContractError('评分点判定不完整，未保存成绩')
        by_index = {d.get('index'): d for d in decisions if isinstance(d, dict)}
        if len(by_index) != len(subjective) or set(by_index) != {s['index'] for s in subjective}:
            raise QuizContractError('判分题号不匹配')
        for item in subjective:
            decisions = by_index[item['index']].get('criteria')
            if not isinstance(decisions, list) or len(decisions) != len(item['rubric']):
                raise QuizContractError('评分点数量不匹配')
            by_id = {c.get('id'): c for c in decisions if isinstance(c, dict)}
            if len(by_id) != len(item['rubric']) or set(by_id) != {c['id'] for c in item['rubric']}:
                raise QuizContractError('评分点编号不匹配')
            row = per[item['index']]
            for criterion in item['rubric']:
                decision = by_id[criterion['id']]
                met = decision.get('met')
                evidence, reason = decision.get('evidence', ''), decision.get('reason', '')
                if type(met) is not bool or not isinstance(evidence, str) or not isinstance(reason, str) or not reason.strip():
                    raise QuizContractError('评分点缺少明确判定或理由')
                if met and (not normalized(evidence) or normalized(evidence) not in normalized(item['answer'])):
                    raise QuizContractError('得分依据必须引用学生实际作答')
                row['criteria'].append({**criterion, 'met': met, 'evidence': evidence, 'reason': reason})
                if met:
                    row['earned'] += criterion['points']
            row['ok'] = row['earned'] == row['max_points']
            row['comment'] = '；'.join('%s：%s（%d/%d分）' % (c['description'], c['reason'], c['points'] if c['met'] else 0, c['points']) for c in row['criteria'])
    score = sum(row['earned'] for row in per)
    return {'score': score, 'pass': score >= 60, 'per_question': per,
            'feedback': '逐题得分合计 %d/100；达到60分通过。' % score, 'harness_version': VERSION}
