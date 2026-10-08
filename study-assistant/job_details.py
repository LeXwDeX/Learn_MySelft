"""Bounded, credential-free task diagnostics, separate from server logs."""
import json
import os
import re
import secrets
import time

MAX_EVENTS = 160
MAX_TEXT = 16000
MAX_BYTES = 256000
REDACTED = '[已隐藏凭据]'
_PRIVATE_KEYS = re.compile(r'^(?:authorization|cookie|set-cookie|api[_-]?key|password|passwd|token|access[_-]?token|session(?:[_-]?(?:id|token|cookie))?|secret|reasoning(?:[_-]?content)?|chain[_-]?of[_-]?thought)$', re.I)
_CREDENTIAL = re.compile(r'''(?ix)
    (\bBearer\s+)[a-z0-9._~+/=-]+
    |((?:["']?)(?:api[_-]?key|password|passwd|access[_-]?token|(?:learn[_-]?)?session(?:[_-]?(?:id|token|cookie))?|authorization|cookie|token|secret)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)
''')
_COOKIE_HEADER = re.compile(r'(?im)\b((?:set-)?cookie\s*:\s*)[^\r\n]+')
_REASONING_TAG = re.compile(r'<(think|analysis|reasoning)(?:\s[^>]*)?>.*?(?:</\1\s*>|$)', re.I | re.S)


def sanitize(value, known_secrets=()):
    """Do not collect reasoning fields; redact configured secrets and credentials."""
    if isinstance(value, str):
        value = _REASONING_TAG.sub('[内部推理未记录]', value)
        for secret in known_secrets:
            if secret:
                value = value.replace(str(secret), REDACTED)
        value = _COOKIE_HEADER.sub(lambda match: match.group(1) + REDACTED, value)
        return _CREDENTIAL.sub(lambda match: (match.group(1) or match.group(2) or '') + REDACTED, value)
    if isinstance(value, dict):
        return {key: sanitize(item, known_secrets) for key, item in value.items()
                if not _PRIVATE_KEYS.fullmatch(str(key))}
    if isinstance(value, (list, tuple)):
        return [sanitize(item, known_secrets) for item in value]
    return value


def locations(error):
    result, trace = [], error.__traceback__
    while trace is not None:
        code = trace.tb_frame.f_code
        result.append({'file': os.path.basename(code.co_filename),
                       'function': code.co_name, 'line': trace.tb_lineno})
        trace = trace.tb_next
    return result[-24:]


def append_event(connection, job_id, kind, label, *, attempt=0, known_secrets=(), **fields):
    try:
        _append_event(connection, job_id, kind, label, attempt=attempt,
                      known_secrets=known_secrets, **fields)
    except Exception:
        # Diagnostics are optional. Never replace a committed task result with
        # a logging failure, or expose a storage error containing private data.
        pass


def _append_event(connection, job_id, kind, label, *, attempt=0, known_secrets=(), **fields):
    """Append in the caller's short transaction. Keep recent errors and states."""
    row = connection.execute('SELECT value FROM job_details WHERE job_id=?', (job_id,)).fetchone()
    details = json.loads(row['value']) if row else {'available': True, 'truncated': False, 'events': []}
    event = sanitize({'id': secrets.token_hex(8), 'at_ms': int(time.time() * 1000),
                      'attempt': attempt, 'kind': kind, 'label': label, **fields}, known_secrets)
    truncated = [False]

    def bounded(value):
        if isinstance(value, str) and len(value) > MAX_TEXT:
            truncated[0] = True
            return value[:MAX_TEXT] + '\n[记录已截断]'
        if isinstance(value, list):
            if len(value) > 64:
                truncated[0] = True
            return [bounded(item) for item in value[:64]]
        if isinstance(value, dict):
            return {key: bounded(item) for key, item in value.items()}
        return value

    event = bounded(event)
    # A request with many individually small messages also needs a total cap.
    if len(json.dumps(event, ensure_ascii=False).encode('utf-8')) > MAX_BYTES // 2:
        event['messages'] = event.get('messages', [])[:8]
        while len(json.dumps(event, ensure_ascii=False).encode('utf-8')) > MAX_BYTES // 2:
            if event.get('messages'):
                event['messages'].pop(0)
            elif event.get('content'):
                event['content'] = event['content'][:len(event['content']) // 2]
            else:
                break
        truncated[0] = True
    if truncated[0]:
        event['truncated'] = True
        details['truncated'] = True
    details['events'].append(event)
    while (len(details['events']) > MAX_EVENTS or
           len(json.dumps(details, ensure_ascii=False).encode('utf-8')) > MAX_BYTES):
        details['events'].pop(0)
        details['truncated'] = True
    connection.execute('INSERT INTO job_details(job_id,value) VALUES (?,?) '
                       'ON CONFLICT(job_id) DO UPDATE SET value=excluded.value',
                       (job_id, json.dumps(details, ensure_ascii=False)))
