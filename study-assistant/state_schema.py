"""Validate browser-owned state before it reaches merge and storage code.

Old records may omit fields. Present fields must have the documented type;
unknown fields remain compatible with deployed clients and generated content.
Server-owned question rounds and grades are protected by the merge layer.
"""
import json
from material_parser import validate_materials

SCHEMA_VERSION = 1
STAGES = {'intake', 'research', 'learning'}
MARKS = {'none', 'learning', 'mastered', 'review'}


def typed_fields(value, fields, location):
    for name, kind in fields.items():
        if name in value and value[name] is not None and not isinstance(value[name], kind):
            raise ValueError('%s.%s has an invalid type' % (location, name))


def messages(history, location):
    if not isinstance(history, list) or len(history) > 10000:
        raise ValueError(location + ' must be a bounded array')
    for message in history:
        if not isinstance(message, dict) or message.get('role') not in ('user', 'assistant', 'summary'):
            raise ValueError(location + ' contains an invalid message')
        # Images are represented by a separate image field; text remains a string.
        if 'content' in message and not isinstance(message['content'], str):
            raise ValueError(location + '.content must be text')


def validate_value(key, value):
    business = key.split('/', 1)[-1]
    material = business.startswith('learn-path-v1-') and business != 'learn-path-v1-last'
    quiz = business.startswith('quiz-map-v1-')
    ai = business.startswith('learn-ai-v1-')
    knowledge_ai = business.startswith('knowledge-map-ai-v1-')
    marks = business == 'knowledge-map-v1-marks'
    if not (material or quiz or ai or knowledge_ai or marks):
        return
    data = json.loads(value)
    if knowledge_ai:
        messages(data, 'discussion')
        return
    if not isinstance(data, dict):
        raise ValueError('state document must be an object')
    if 'schema_version' in data and data['schema_version'] != SCHEMA_VERSION:
        raise ValueError('unsupported state schema version')
    for field in ('materials', 'quizMaterials'):
        if field in data:
            validate_materials(data[field])
    if material:
        typed_fields(data, {'title': str, 'topic': str, 'history': list, 'spec': dict, 'queries': list,
                           'sources': list, 'brief': str, 'plan': dict, 'nodeDetail': dict,
                           'nodeState': dict, 'pending': dict}, 'material')
        if 'stage' in data and data['stage'] not in STAGES:
            raise ValueError('invalid learning stage')
        if data.get('history') is not None:
            messages(data['history'], 'history')
        plan = data.get('plan')
        if plan is not None:
            typed_fields(plan, {'nodes': list, 'edges': list, 'title': str}, 'plan')
            seen = set()
            for node in plan.get('nodes') or []:
                if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not node['id']:
                    raise ValueError('invalid plan node')
                if node['id'] in seen:
                    raise ValueError('duplicate node id')
                seen.add(node['id'])
                typed_fields(node, {'title': str, 'deps': list, 'objectives': list}, 'node')
                if not all(isinstance(dep, str) for dep in node.get('deps') or []):
                    raise ValueError('invalid node dependency')
        for node_id, detail in (data.get('nodeDetail') or {}).items():
            if not isinstance(detail, dict):
                raise ValueError('invalid node detail')
            typed_fields(detail, {'quiz': dict, 'study_notes': str, 'key_points': list,
                                  'examples': list, 'misconceptions': list}, 'nodeDetail.' + node_id)
        for state in (data.get('nodeState') or {}).values():
            if not isinstance(state, dict):
                raise ValueError('invalid node state')
            if 'completed' in state and type(state['completed']) is not bool:
                raise ValueError('completed must be boolean')
            if 'mark' in state and state['mark'] not in MARKS:
                raise ValueError('invalid learning mark')
    if quiz:
        typed_fields(data, {'questions': list, 'title': str, 'sourceKey': str}, 'quiz')
        if not data.get('questions') or not all(isinstance(q, dict) for q in data['questions']):
            raise ValueError('quiz must contain questions')
    if ai:
        for history in data.values():
            messages(history, 'discussion')
    if marks:
        for mark in data.values():
            if not isinstance(mark, dict) or mark.get('s') not in {'todo', 'doing', 'done', 'again'}:
                raise ValueError('invalid knowledge mark')
            if 't' in mark and (type(mark['t']) not in (int, float) or mark['t'] < 0):
                raise ValueError('invalid mark timestamp')
