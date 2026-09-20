"""Canonical document names. Legacy naming rules are used only by migration."""
import json
import re

DEFAULT_TITLE = '学习资料'


def document_title(material):
    value = material.get('title') if isinstance(material, dict) else None
    return value.strip() if isinstance(value, str) and value.strip() else DEFAULT_TITLE


def short_title(value):
    """Normalize the intake model's one-line name, at most ten Unicode characters."""
    if not isinstance(value, str):
        return ''
    value = re.sub(r'[\s*#`<>"\[\]【】]+', '', value)
    return value[:10] if _legacy_name(value) else ''


def quiz_title(material):
    return document_title(material) + '综合测验'


def _legacy_name(value):
    if not isinstance(value, str):
        return ''
    value = value.strip()
    if re.match(r'^(请|帮我|我想|我希望|你能|能不能)', value) or re.search(r'\.(zip|pdf|docx?)(?:[/\\]|$)', value, re.I):
        return ''
    return value[:120]


def migrate_titles(connection):
    """Backfill top-level title once, preserving every other document field."""
    marker = 'canonical_document_titles_v1'
    if connection.execute('SELECT 1 FROM metadata WHERE name=?', (marker,)).fetchone():
        return
    legacy = {(row['user_id'], row['key']): row['title'] for row in connection.execute('SELECT * FROM task_titles')}
    documents, changed = {}, {}
    for row in connection.execute('SELECT key,value FROM documents WHERE value IS NOT NULL'):
        key = row['key']
        user, _, business = key.partition('/')
        if not business:
            user, business = 'u0', key
        if not (business.startswith(('learn-path-v1-', 'quiz-map-v1-'))) or business == 'learn-path-v1-last':
            continue
        try:
            value = json.loads(row['value'])
        except (ValueError, TypeError):
            continue
        if not isinstance(value, dict):
            continue
        documents[key] = value
        if business.startswith('learn-path-v1-') and not (isinstance(value.get('title'), str) and value['title'].strip()):
            plan, spec = value.get('plan'), value.get('spec')
            value['title'] = (_legacy_name(legacy.get((user, key)))
                              or _legacy_name(plan.get('title') if isinstance(plan, dict) else None)
                              or _legacy_name(spec.get('topic') if isinstance(spec, dict) else None)
                              or _legacy_name(value.get('topic')) or DEFAULT_TITLE)
            changed[key] = value
    for key, value in documents.items():
        if not key.split('/', 1)[-1].startswith('quiz-map-v1-'):
            continue
        # Preserve valid existing exam names; repair only absent/request-shaped names.
        if not _legacy_name(value.get('title')):
            source = documents.get(value.get('sourceKey')) or {}
            value['title'] = quiz_title(source)
            changed[key] = value
    for key, value in changed.items():
        connection.execute('UPDATE documents SET value=?,revision=revision+1 WHERE key=?',
                           (json.dumps(value, ensure_ascii=False), key))
    connection.execute('INSERT INTO metadata VALUES (?,?)', (marker, json.dumps({'updated': len(changed)})))
