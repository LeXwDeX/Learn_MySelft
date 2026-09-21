"""Versioned learning evidence derived only from saved quiz attempts."""
import hashlib
import json
import re

from path_hierarchy import hierarchy


def node_id(point, plan):
    nodes = (plan or {}).get('nodes') or []
    ids = {n.get('id') for n in nodes}
    value = str(point or '').strip()
    if value in ids:
        return value
    # Titles preserve historical flat labels when roots have since been regrouped.
    matches = [n['id'] for n in nodes if n.get('title') and n['title'] in value]
    if len(matches) == 1:
        return matches[0]
    match = re.match(r'^[Ll](\d+(?:\.\d+)*)(?:\s|$)', value)
    if match:
        label = 'L' + match[1]
        entry = next((entry for entry in hierarchy(nodes) if entry['label'] == label), None)
        if entry:
            return entry['node']['id']
        # Old comprehensive quizzes stored flat L<numeric node id> labels.
        if '.' not in match[1] and 'n' + match[1] in ids:
            return 'n' + match[1]
    return None


def current_attempt(quiz):
    """Legacy records fall back to the last saved attempt, never a draft."""
    for issued in quiz.get('rounds') or []:
        if issued['id'] != quiz.get('round_id'):
            continue
        attempts = issued.get('attempts') or []
        wanted = quiz.get('lastAttemptId')
        attempt = next((a for a in attempts if wanted and a.get('id') == wanted), None)
        if not attempt and attempts:
            attempt = attempts[-1]
        if attempt and attempt.get('id'):
            return issued, attempt
    return None, None


def binding(quiz):
    issued, attempt = current_attempt(quiz)
    return {'round_id': issued['id'], 'attempt_id': attempt['id']} if attempt else None


def matches(quiz, expected):
    return binding(quiz) == expected and expected is not None


def gap_items(quiz):
    issued, attempt = current_attempt(quiz)
    if not attempt:
        return []
    result = attempt.get('result') or attempt
    grades, answers = result.get('per_question') or [], attempt.get('answers') or []
    items = []
    for index, question in enumerate(issued.get('questions') or []):
        grade = grades[index] if index < len(grades) else {}
        earned, maximum = grade.get('earned'), grade.get('max_points')
        lost = earned < maximum if isinstance(earned, (int, float)) and isinstance(maximum, (int, float)) else grade.get('ok') is False
        if not lost:
            continue
        answer = answers[index] if index < len(answers) else ''
        if isinstance(answer, list):
            answer = '；'.join('第%d空：%s' % (i + 1, x or '未作答') for i, x in enumerate(answer))
        items.append({'unit': question.get('point', ''), 'node_id': question.get('node_id'),
                      'q': question.get('q', ''), 'mine': str(answer or ''),
                      'correct': question.get('answer', ''), 'explain': grade.get('comment', ''),
                      'earned': earned, 'max_points': maximum})
    return items


def weaknesses(quiz, plan):
    """Only current lost questions establish a weak unit; stale AI labels cannot."""
    grouped = {}
    titles = {n['id']: n.get('title', '') for n in plan.get('nodes') or []}
    for item in gap_items(quiz):
        nid = item.get('node_id') if item.get('node_id') in titles else node_id(item['unit'], plan)
        if not nid:
            raise ValueError('失分题无法关联学习单元，请重新生成测验')
        entry = grouped.setdefault(nid, {'nid': nid, 'title': titles[nid], 'reason': '', 'points': []})
        entry['reason'] = (entry['reason'] + item['q'] + ' → ' + item['explain'] + '；')[:500]
    for gap in (quiz.get('gaps') or {}).get('gaps') or []:
        nid = node_id(gap.get('unit'), plan)
        if nid in grouped:
            grouped[nid]['points'] = list(dict.fromkeys(grouped[nid]['points'] + (gap.get('points') or [])))[:6]
    return list(grouped.values())


def receipt_id(source_key, identity):
    return hashlib.sha256(json.dumps([source_key, identity], sort_keys=True).encode()).hexdigest()


def exam_evidence(entries, source_key, plan):
    """Keep comprehensive evidence separate from single-unit scores and marks."""
    exams = []
    for key, raw in entries.items():
        if not key.startswith(source_key.split('/', 1)[0] + '/quiz-map-v1-'):
            continue
        try:
            quiz = json.loads(raw) if isinstance(raw, str) else None
        except ValueError:
            continue
        if not isinstance(quiz, dict) or quiz.get('sourceKey') != source_key:
            continue
        issued, attempt = current_attempt(quiz)
        if not attempt:
            continue
        result = attempt.get('result') or attempt
        latest = []
        for question, grade in zip(issued.get('questions') or [], result.get('per_question') or []):
            nid = question.get('node_id') or node_id(question.get('point'), plan)
            if not nid:
                continue
            latest.append({'单元': nid, '题目': str(question.get('q', ''))[:800],
                           '得分': grade.get('earned'), '满分': grade.get('max_points'),
                           '正确': grade.get('ok'), '点评': str(grade.get('comment', ''))[:300]})
        prior_mistakes = []
        for previous in (issued.get('attempts') or [])[-4:]:
            if previous.get('id') == attempt['id']:
                continue
            snapshot = {**quiz, 'lastAttemptId': previous.get('id')}
            prior_mistakes.extend({'单元': x['unit'], '题目': x['q'][:500]} for x in gap_items(snapshot))
        exams.append({'测验': key, '作答': attempt['id'], '时间': attempt.get('ts', 0),
                      '得分': result.get('score'), '最近作答': latest,
                      '历史失分（不代表当前仍未掌握）': prior_mistakes[-12:]})
    return sorted(exams, key=lambda x: (x['时间'], x['测验']))[-12:]
