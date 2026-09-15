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

VERSION = 2
MAX_BLANKS = 16


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


def blank_count(question):
    """Legacy stems use underscores or empty parentheses; v2 uses ____ only."""
    return max(1, len(re.findall(r'(?<![A-Za-z0-9_])_{3,}(?![A-Za-z0-9_])|＿{3,}|[（(][ \t　]*[)）]', question['q'])))


def blank_equivalent(left, right):
    """Ignore Unicode width/whitespace, preserve case, accept equal numeric literals."""
    left, right = (re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)) for value in (left, right))
    if left == right:
        return True
    numeric = r'[-+]?\d+(?:\.\d+)?(?:/[-+]?\d+)?'
    return bool(re.fullmatch(numeric, left) and re.fullmatch(numeric, right) and equivalent(left, right))


def validate_scoring(q):
    """Validate the immutable v2 rule, before independent model verification."""
    expected = {'choice': ('single_choice',), 'fill': ('per_blank', 'all_or_nothing'),
                'short': ('rubric',)}.get(q.get('type'), ())
    scoring = q.get('scoring')
    if not isinstance(scoring, dict) or set(scoring) != {'mode'} or scoring['mode'] not in expected:
        raise QuizContractError('每题必须声明与题型一致的 scoring.mode')
    if q['type'] != 'fill':
        if 'blanks' in q:
            raise QuizContractError('只有填空题可以声明 blanks')
        return
    blanks = q.get('blanks')
    if not isinstance(blanks, list) or not 1 <= len(blanks) <= MAX_BLANKS:
        raise QuizContractError('填空题必须声明1~16个空位')
    if len(re.findall(r'(?<![A-Za-z0-9_])_{4,}(?![A-Za-z0-9_])', q['q'])) != len(blanks):
        raise QuizContractError('题干空位数量必须与 blanks 一致，使用 ____ 标记')
    for index, blank in enumerate(blanks):
        if not isinstance(blank, dict) or blank.get('id') != 'b%d' % (index + 1):
            raise QuizContractError('空位编号必须按顺序为 b1、b2…')
        if set(blank) - {'id', 'answer', 'accepted_answers', 'points'}:
            raise QuizContractError('空位包含未支持的规则字段')
        reference = blank.get('answer')
        accepted = blank.get('accepted_answers')
        if not isinstance(reference, str) or not reference.strip() or len(reference) > 1500:
            raise QuizContractError('每空必须有非空参考答案')
        if not isinstance(accepted, list) or not 1 <= len(accepted) <= 32 or any(
                not isinstance(a, str) or not a.strip() or len(a) > 1500 for a in accepted):
            raise QuizContractError('每空必须声明1~32个非空可接受答案')
        if not any(blank_equivalent(reference, a) for a in accepted):
            raise QuizContractError('每空参考答案必须属于可接受答案')
        if scoring['mode'] == 'per_blank':
            if type(blank.get('points')) is not int or not 1 <= blank['points'] <= 100:
                raise QuizContractError('按空计分必须给每空正整数分值')
        elif 'points' in blank:
            raise QuizContractError('整题计分不能同时声明每空分值')
    if scoring['mode'] == 'per_blank' and sum(b['points'] for b in blanks) != q['points']:
        raise QuizContractError('每空分值合计必须等于本题分值')
    # The structured reference is authoritative, with a readable legacy summary.
    q['answer'] = '；'.join(b['answer'] for b in blanks)


def validate_answers(questions, answers):
    if not isinstance(answers, list) or len(answers) != len(questions):
        raise QuizContractError('作答数量必须与题目数量一致')
    for q, answer in zip(questions, answers):
        if isinstance(answer, list):
            count = len(q['blanks']) if q.get('blanks') else blank_count(q)
            if q['type'] != 'fill' or len(answer) != count or count > MAX_BLANKS:
                raise QuizContractError('逐空作答数量必须与签发空位一致')
            if any(not isinstance(a, str) for a in answer) or sum(map(len, answer)) > 20000:
                raise QuizContractError('每空作答必须是文本，整题最多20000字符')
        elif not isinstance(answer, str) or len(answer) > 20000:
            raise QuizContractError('作答必须为文本或填空数组')


def split_fill_answer(answer, count):
    """Read old text without interpreting punctuation inside a structured answer."""
    if isinstance(answer, list):
        return answer
    if not answer.strip():
        return [''] * count
    if count == 1:
        return [answer]
    for separator in (r'[;；]', r'\r?\n', r'[,，]'):
        parts = re.split(separator, answer)
        if len(parts) == count:
            return parts
    return [answer] + [''] * (count - 1)


def legacy_fill_text(q, answers):
    """Adapt new controls to old whole-answer rules without inventing blank rubrics."""
    if not any(a.strip() for a in answers):
        return ''
    accepted = q.get('accepted_answers', [q['answer']])
    candidates = [separator.join(answers) for separator in ('；', ';', '\n', ',', '，')]
    for candidate in candidates:
        if any(equivalent(candidate, reference) for reference in accepted):
            return candidate
    return candidates[0]


def grade_blanks(q, answer):
    values = split_fill_answer(answer, len(q['blanks']))
    mode = q['scoring']['mode']
    rows = []
    for blank, value in zip(q['blanks'], values):
        matched = bool(value.strip()) and any(blank_equivalent(value, a) for a in blank['accepted_answers'])
        row = {'id': blank['id'], 'ok': matched, 'answer': value,
               'comment': '符合可接受答案' if matched else '未作答' if not value.strip() else '答案不符'}
        if mode == 'per_blank':
            row.update(earned=blank['points'] if matched else 0, max_points=blank['points'])
        rows.append(row)
    correct = all(b['ok'] for b in rows)
    earned = sum(b['earned'] for b in rows) if mode == 'per_blank' else q['points'] if correct else 0
    summary = '按空计分，各空得分相加' if mode == 'per_blank' else '整题计分，全部空答对才得分'
    details = '；'.join('第%d空：%s%s' % (i + 1, b['comment'],
                       '（%d/%d分）' % (b['earned'], b['max_points']) if mode == 'per_blank' else '')
                       for i, b in enumerate(rows))
    return {'ok': correct, 'earned': earned, 'max_points': q['points'], 'mode': mode,
            'blanks': rows, 'criteria': [], 'comment': summary + '。' + details}


def validate_questions(questions, previous=(), node=False, legacy=False):
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
        if not legacy or q.get('scoring'):
            validate_scoring(q)
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
    round_data['harness_version'] = 1
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
    validate_answers(questions, answers)
    per, subjective = [], []
    for index, (q, answer) in enumerate(zip(questions, answers)):
        if q['type'] == 'fill' and q.get('scoring'):
            per.append(grade_blanks(q, answer))
            continue
        if isinstance(answer, list):
            answer = legacy_fill_text(q, answer)
        maximum = q['points']
        mode = (q.get('scoring') or {}).get('mode') or {'choice': 'single_choice', 'fill': 'legacy_whole', 'short': 'rubric'}[q['type']]
        row = {'ok': False, 'earned': 0, 'max_points': maximum, 'mode': mode, 'comment': '', 'criteria': []}
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
