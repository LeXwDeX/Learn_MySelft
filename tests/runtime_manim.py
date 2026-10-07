"""Opt-in real model/renderer regression. Writes only the fixed regression account."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import uuid


def run(environment, output):
    uid = {'test': 'u370119af344c603c', 'production': 'ub3fd33db1b3e5638'}[environment]
    port = {'test': 8111, 'production': 8101}[environment]
    site = {'test': 8112, 'production': 8100}[environment]
    base = 'http://192.168.33.146:' + str(port)
    credentials = json.loads(subprocess.check_output([
        'ssh', '-o', 'BatchMode=yes', 'root@192.168.33.146',
        'cat /opt/study-assistant/regression-credentials/' + environment + '.json']))
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def request(path, body=None, headers=None, raw=False):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=data,
            headers={'Content-Type': 'application/json', 'X-Learn-User': uid, **(headers or {})})
        with opener.open(req, timeout=1200) as response:
            content = response.read()
            return (response.status, dict(response.headers), content) if raw else json.loads(content)

    login = request('/auth/login', {'username': 'regression_bot', 'password': credentials['password']})
    assert login['user']['id'] == uid
    slug = 'manim-runtime-' + uuid.uuid4().hex[:10]
    key = uid + '/learn-path-v1-' + slug
    node = {'id': 'n1', 'title': '向量的分量与下标', 'essence': '向量是一组有顺序的数字。下标从1开始。维度等于分量个数。',
        'objectives': ['用(3,-1,4)对应三个分量和下标。', '解释换位改变向量但不改变维度。'], 'deps': []}
    second = {**node, 'id': 'n2', 'title': '向量顺序与维度'}
    notes = '# 向量的一排数字\n\n向量 x=(3,-1,4) 有3个分量。x₁=3，x₂=-1，x₃=4。下标是位置，维度是3。\n\n把前两个位置交换为(-1,3,4)，向量改变，维度仍然是3。'
    legacy = '\n\n```learn-scene\n{"version":1,"type":"diagram","title":"旧图示","summary":"三个分量","viewport":{"x_min":-4,"x_max":4,"y_min":-3,"y_max":3},"objects":[{"id":"a","type":"text","position":[0,0],"text":"(3,-1,4)"}]}\n```'
    material = {'stage': 'learning', 'topic': 'Manim 教学回归', 'pending': None,
        'spec': {'topic': '向量的分量与下标', 'level': '初中生', 'goal': '通过分步动画理解顺序、下标与维度'},
        'plan': {'title': 'Manim 教学回归', 'summary': '真实动画、分步停顿和恢复验证', 'nodes': [node, second]},
        'nodeDetail': {'n2': {'study_notes': notes + legacy, 'key_points': ['维度等于分量个数。'], 'examples': [], 'traps': []}},
        'nodeState': {'n2': {'score': 88, 'status': 'review'}}}
    request('/state/put', {'entries': {key: json.dumps(material, ensure_ascii=False)}})
    report = {'environment': environment, 'sourceKey': key,
        'sourceURL': f'http://192.168.33.146:{site}/learn/u/{uid}/learning-path.html?t={slug}', 'assets': {}, 'cases': []}
    output.mkdir(parents=True, exist_ok=True)

    def save():
        (output / 'runtime-report.json').write_text(json.dumps(report, indent=2))

    def job(operation, body):
        print('Checking ' + operation, flush=True)
        receipt = request('/jobs', {'operation': operation, 'body': body, 'request_id': uuid.uuid4().hex})['job']
        deadline = time.monotonic() + 1200
        while receipt['status'] in ('queued', 'running'):
            assert time.monotonic() < deadline, 'job deadline exceeded'
            time.sleep(3)
            receipt = request('/jobs/' + receipt['id'])['job']
        assert receipt['status'] == 'succeeded', operation + ': ' + receipt['status']
        return receipt['result']

    def verify(name, text):
        matches = re.findall(r'```learn-manim\s*\n(.*?)\n```', text, re.S)
        assert len(matches) == 1, name + ': missing real Manim asset'
        spec = json.loads(matches[0]); asset = spec['asset_id']
        manifest = request('/manim/assets/' + asset + '/manifest')
        assert manifest['engine'] == {'name': 'ManimGL', 'version': '1.7.2'}
        assert manifest['width'] == 1280 and manifest['height'] == 720 and manifest['fps'] == 30
        assert 1 <= len(manifest['steps']) <= 8
        assert all(step['end_frame'] - step['hold_start_frame'] >= 21 for step in manifest['steps'])
        status, headers, data = request('/manim/assets/' + asset + '/video.mp4', headers={'Range': 'bytes=0-31'}, raw=True)
        assert status == 206 and len(data) == 32 and b'ftyp' in data
        report['assets'][name] = {'asset_id': asset, 'steps': len(manifest['steps']), 'duration': manifest['duration']}
        report['cases'].append(name + '_real_manim_and_authenticated_range')
        save()

    save()
    generated = job('/path/node', {'key': key, 'node': node, 'spec': material['spec'], 'dep_titles': []})
    verify('new_material', generated['study_notes'])
    supplemented = job('/path/node/scene', {'key': key, 'node': {'id': 'n2'}})
    verify('upgrade', supplemented['study_notes'])
    stored = json.loads(request('/state/all')['entries'][key])
    assert stored['nodeState'] == material['nodeState']
    assert 'learn-scene' not in stored['nodeDetail']['n2']['study_notes']
    report['cases'].append('upgrade_preserves_learning_state_and_prose')
    print('Checking /ask real animation', flush=True)
    _, _, stream = request('/ask', {'key': key, 'node': {'id': 'n2'},
        'unit': {'unit_id': 'n2', 'title': second['title'], 'topic': material['topic'], 'study_notes': notes},
        'question': '请用分步动画演示(3,-1,4)前三个位置和下标，再交换前两个分量，最后说明维度仍是3。', 'history': []}, raw=True)
    events = [json.loads(line[5:].strip()) for line in stream.decode().splitlines() if line.startswith('data:')]
    assert any(event.get('done') for event in events)
    assert not any(event.get('error') for event in events)
    answer = ''.join(event.get('delta', '') for event in events)
    verify('tutor', answer)
    report['cases'].append('tutor_generation_heartbeat') if any(event.get('status') for event in events) else None
    save()
    print(json.dumps({'environment': environment, 'cases': report['cases']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=['test', 'production'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.environment, args.output)
