"""Bounded model HTTP transport; the isolated child handles only network bytes."""

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request


MAX_RESPONSE_BYTES = 16 * 1024 * 1024
REAP_TIMEOUT = 5


def _worker():
    # This mode imports no application module and never opens state or log files.
    envelope = json.load(sys.stdin)
    request = urllib.request.Request(envelope['url'], data=base64.b64decode(envelope['payload']),
                                     headers=envelope['headers'], method='POST')
    try:
        with urllib.request.urlopen(request, timeout=envelope['timeout']) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            result = {'error': 'response_too_large'}
        else:
            result = {'body': base64.b64encode(body).decode('ascii')}
    except urllib.error.HTTPError as error:
        result = {'error': 'http', 'status': error.code}
        error.close()
    except TimeoutError:
        result = {'error': 'timeout'}
    except urllib.error.URLError as error:
        result = {'error': 'timeout' if isinstance(error.reason, TimeoutError) else 'network'}
    except Exception:
        result = {'error': 'network'}
    sys.stdout.write(json.dumps(result))


def _stop(process):
    if process.poll() is None:
        process.kill()
    try:
        process.communicate(timeout=REAP_TIMEOUT)
    except subprocess.TimeoutExpired:
        # The child has no business code or database access, even on an OS fault.
        process.kill()
        for pipe in (process.stdin, process.stdout):
            if pipe is not None:
                pipe.close()
        raise RuntimeError('模型网络进程无法回收') from None


def post(url, payload, headers, timeout):
    from job_execution import check_deadline, remaining_timeout

    started = time.monotonic()
    limit = remaining_timeout(timeout)
    envelope = json.dumps({'url': url, 'payload': base64.b64encode(payload).decode('ascii'),
                           'headers': headers, 'timeout': limit}).encode('utf-8')
    # Do not inherit gateway credentials or application configuration through env.
    allowed = {'PATH', 'SYSTEMROOT', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
               'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'}
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    process = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve())],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=environment)
    try:
        wait = min(remaining_timeout(timeout), limit - (time.monotonic() - started))
        if wait <= 0:
            raise subprocess.TimeoutExpired('model transport', limit)
        output, _ = process.communicate(envelope, timeout=wait)
    except subprocess.TimeoutExpired:
        _stop(process)
        check_deadline()
        raise TimeoutError('模型请求超过传输时限') from None
    except BaseException:
        _stop(process)
        raise
    check_deadline()
    if time.monotonic() - started >= limit:
        raise TimeoutError('模型请求超过传输时限')
    if process.returncode:
        raise urllib.error.URLError('模型网络进程未完成请求')
    result = json.loads(output)
    category = result.get('error')
    if category == 'http':
        raise urllib.error.HTTPError(url, result['status'], '模型服务返回错误', None, None)
    if category == 'timeout':
        raise TimeoutError('模型服务等待超时')
    if category == 'network':
        raise urllib.error.URLError('模型服务网络连接失败')
    if category == 'response_too_large':
        raise ValueError('模型响应超过体积上限')
    return base64.b64decode(result['body'], validate=True)


if __name__ == '__main__':
    _worker()
