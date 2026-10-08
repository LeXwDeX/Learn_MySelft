"""Opt-in real-model staged node/Manim recovery regression for regression_bot."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid


UIDS = {'test': 'u370119af344c603c', 'production': 'ub3fd33db1b3e5638'}
PORTS = {'test': 8111, 'production': 8101}
SITES = {'test': 8112, 'production': 8100}
REQUEST_TIMEOUT = 25
JOB_TIMEOUT = 660


class RegressionFailure(AssertionError):
    def __init__(self, case):
        super().__init__(case)
        self.case = case


def require(condition, case):
    if not condition:
        raise RegressionFailure(case)


def run(environment, output):
    uid = UIDS[environment]
    base = 'http://192.168.33.146:' + str(PORTS[environment])
    source_url = f'http://192.168.33.146:{SITES[environment]}/learn/u/{uid}/learning-path.html'
    # Credentials remain in memory and are never added to reports or errors.
    credentials = json.loads(subprocess.check_output([
        'ssh', '-o', 'BatchMode=yes', 'root@192.168.33.146',
        'cat /opt/study-assistant/regression-credentials/' + environment + '.json'], timeout=REQUEST_TIMEOUT))
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def request(path, body=None, headers=None, raw=False):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        req = urllib.request.Request(base + path, data=data,
            headers={'Content-Type': 'application/json', 'X-Learn-User': uid, **(headers or {})})
        try:
            response = opener.open(req, timeout=REQUEST_TIMEOUT)
        except urllib.error.HTTPError as error:
            if raw:
                return error.code, dict(error.headers), error.read()
            raise RegressionFailure('http_' + str(error.code)) from None
        with response:
            content = response.read()
            return (response.status, dict(response.headers), content) if raw else json.loads(content)

    login = request('/auth/login', {'username': 'regression_bot', 'password': credentials['password']})
    require((login.get('user') or {}).get('id') == uid, 'fixed_account_uid')

    fixture_id = 'generation-recovery-' + uuid.uuid4().hex[:12]
    key = uid + '/learn-path-v1-' + fixture_id
    node = {
        'id': 'n1', 'title': '矩阵如何把正方形变成平行四边形',
        'essence': 'A=[[1,1],[0,1]] 是横向剪切。它保持 e1=(1,0)，把 e2=(0,1) 映到 (1,1)，并把 (x,y) 映到 (x+y,y)。平行四边形面积不变。',
        'objectives': ['说明 e1 不变，e2 映到 (1,1)，坐标变为 (x+y,y)。', '解释横向剪切为什么保持面积。'],
        'deps': [],
    }
    spec = {'topic': node['title'], 'level': '高中到本科起步',
            'goal': '理解横向剪切怎样把正方形变成平行四边形，并解释面积不变。'}
    material = {
        'stage': 'learning', 'topic': node['title'], 'pending': None,
        'spec': spec,
        'plan': {'title': fixture_id, 'summary': spec['goal'], 'nodes': [node]},
        'nodeDetail': {},
        'nodeState': {'n1': {'status': 'review'}},
    }
    request('/state/put', {'entries': {key: json.dumps(material, ensure_ascii=False)}})

    output.mkdir(parents=True, exist_ok=True)
    report = {'fixture_id': fixture_id, 'sourceURL': source_url + '?t=' + fixture_id,
              'assets': {}, 'jobs': [], 'cases': []}

    def save():
        (output / 'runtime-generation-recovery.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2))

    def case(name, condition):
        require(condition, name)
        report['cases'].append(name)
        save()

    def wait_job(operation, body, request_id, label):
        receipt = request('/jobs', {'operation': operation, 'body': body, 'request_id': request_id})['job']
        job_id = receipt['id']
        started = time.monotonic()
        deadline = started + JOB_TIMEOUT
        while receipt['status'] in ('queued', 'running'):
            require(time.monotonic() < deadline, label + '_deadline')
            time.sleep(3)
            receipt = request('/jobs/' + job_id)['job']
        elapsed = round(time.monotonic() - started, 2)
        record = {'name': label, 'status': receipt.get('status'),
                  'attempt': receipt.get('attempt'), 'max_attempts': receipt.get('max_attempts'),
                  'timeout_seconds': receipt.get('timeout_seconds'),
                  'phase': receipt.get('failure_phase') or receipt.get('progress', {}).get('label'),
                  'elapsed_seconds': elapsed}
        try:
            details = request('/jobs/' + job_id + '/details').get('details', {})
            phases = [event.get('phase') for event in details.get('events', [])
                      if event.get('kind') == 'phase' and isinstance(event.get('phase'), str)]
            if phases:
                record['phase'] = phases[-1]
        except RegressionFailure:
            pass
        report['jobs'].append(record)
        save()
        require(receipt.get('status') == 'succeeded', label + '_failed')
        require(type(receipt.get('attempt')) is int and 1 <= receipt['attempt'] <= 2,
                label + '_attempt_limit')
        require(receipt.get('max_attempts') == 2, label + '_configured_attempt_limit')
        require(receipt.get('timeout_seconds') == 300, label + '_execution_budget')
        return job_id, receipt['result']

    def resubmit_same(operation, body, request_id, original_id, expected_result, label):
        duplicate = request('/jobs', {'operation': operation, 'body': body, 'request_id': request_id})['job']
        require(duplicate.get('id') == original_id, label + '_receipt_reused')
        completed = request('/jobs/' + original_id)['job']
        require(completed.get('result') == expected_result, label + '_result_equal')
        report['cases'].extend([label + '_receipt_reused', label + '_result_equal'])
        save()

    def read_material():
        entries = request('/state/all')['entries']
        require(key in entries, 'fixture_state_exists')
        return json.loads(entries[key])

    node_body = {'key': key, 'node': node, 'spec': spec, 'dep_titles': [], 'defer_visual': True}
    node_request_id = uuid.uuid4().hex
    save()
    node_job_id, generated = wait_job('/path/node', node_body, node_request_id, 'node_generation')
    require(isinstance(generated.get('study_notes'), str) and generated['study_notes'].strip(),
            'node_body_present')
    require(generated.get('manim_review') == {'status': 'pending', 'retryable': True},
            'animation_pending_after_core_generation')
    require(isinstance(generated.get('quiz'), dict) and generated['quiz'].get('round_id')
            and len(generated['quiz'].get('questions', [])) == 6,
            'quiz_round_issued')
    require('learn-manim' not in generated['study_notes'], 'no_animation_in_core_response')
    report['cases'].extend(['core_body_saved_before_animation', 'quiz_round_issued',
                            'no_animation_in_core_response'])
    save()

    stored_before = read_material()
    original_detail = stored_before['nodeDetail']['n1']
    core_notes = original_detail['study_notes']
    quiz_before = original_detail['quiz']
    normalized_notes = re.sub(r'[\s{}]+', '', core_notes).lower()
    core_facts = (
        ('剪切' in core_notes)
        and ('面积' in core_notes and ('不变' in core_notes or '保持' in core_notes))
        and any(token in normalized_notes for token in ('e_1', 'e₁', 'e1', '基向量'))
        and 'x+y' in normalized_notes
    )
    case('core_math_summary_present', core_facts)
    require(original_detail.get('manim_review', {}).get('status') == 'pending',
            'pending_state_persisted')
    require(quiz_before == generated['quiz'], 'issued_quiz_persisted')
    require(core_notes == generated['study_notes'], 'generated_core_matches_saved')
    report['cases'].append('core_summary_persisted_before_scene')
    save()
    resubmit_same('/path/node', node_body, node_request_id, node_job_id, generated,
                  'node_generation_duplicate')
    _, cached_node = wait_job('/path/node', node_body, uuid.uuid4().hex, 'node_cache')
    case('node_cache_result_equal', cached_node == generated)

    scene_body = {'key': key, 'node': {'id': 'n1'}, 'automatic': True}
    scene_request_id = uuid.uuid4().hex
    scene_job_id, supplemented = wait_job('/path/node/scene', scene_body, scene_request_id,
                                          'automatic_scene')
    notes_after = supplemented.get('study_notes', '')
    matches = re.findall(r'```learn-manim\s*\n(.*?)\n```', notes_after, re.S)
    require(len(matches) == 1, 'one_public_manim_fence')
    public_spec = json.loads(matches[0])
    asset_id = public_spec.get('asset_id')
    require(isinstance(asset_id, str) and re.fullmatch(r'[0-9a-f]{32}', asset_id),
            'public_asset_id')
    require('观察' in public_spec.get('summary', ''), 'public_summary_has_observation_task')

    manifest = request('/manim/assets/' + asset_id + '/manifest')
    require(manifest.get('engine') == {'name': 'ManimGL', 'version': '1.7.2'},
            'real_manimgl_172')
    require((manifest.get('width'), manifest.get('height'), manifest.get('fps')) == (1280, 720, 30),
            'video_manifest_dimensions')
    steps = manifest.get('steps') or []
    require(1 <= len(steps) <= 8, 'video_manifest_steps')
    require(all(step.get('end_frame', 0) - step.get('hold_start_frame', 0) >= 21
                for step in steps), 'step_result_hold_at_least_07_seconds')
    report['assets'][asset_id] = {
        'engine': manifest['engine'], 'width': manifest['width'], 'height': manifest['height'],
        'fps': manifest['fps'], 'duration': manifest['duration'], 'steps': len(steps),
    }
    report['cases'].extend(['real_manimgl_172', 'step_result_hold_at_least_07_seconds',
                            'public_summary_has_observation_task'])
    save()

    status, headers, data = request('/manim/assets/' + asset_id + '/video.mp4',
                                    headers={'Range': 'bytes=0-31'}, raw=True)
    case('authenticated_video_range_206', status == 206 and len(data) == 32
         and headers.get('Content-Range', '').startswith('bytes 0-31/'))
    for private_name in ('scene.py', 'teaching-plan.json'):
        private_status, _, _ = request('/manim/assets/' + asset_id + '/' + private_name, raw=True)
        case('private_' + private_name.replace('.', '_') + '_unreadable', private_status == 404)

    stored_after = read_material()
    final_detail = stored_after['nodeDetail']['n1']
    case('core_body_prefix_unchanged', final_detail.get('study_notes', '').startswith(core_notes))
    case('issued_quiz_unchanged', final_detail.get('quiz') == quiz_before)
    case('scene_asset_persisted', final_detail.get('manim_review', {}).get('asset_id') == asset_id)
    case('scene_appended_to_body', notes_after.startswith(core_notes))
    require(supplemented.get('manim_review', {}).get('status') == 'passed', 'scene_passed')

    # A new id invokes the service cache/read path. It must reuse the published asset.
    _, cached_scene = wait_job('/path/node/scene', scene_body, uuid.uuid4().hex, 'scene_cache')
    case('scene_cache_reused', cached_scene.get('reused') is True
         and cached_scene.get('manim_review', {}).get('asset_id') == asset_id)
    case('scene_cache_result_equal', cached_scene.get('study_notes') == notes_after)
    # Resubmit the original receipt explicitly to verify request-id deduplication.
    duplicate_scene = request('/jobs', {'operation': '/path/node/scene', 'body': scene_body,
                                        'request_id': scene_request_id})['job']
    require(duplicate_scene.get('id') == scene_job_id, 'scene_generation_receipt_reused')
    require(request('/jobs/' + scene_job_id)['job'].get('result') == supplemented,
            'scene_generation_result_equal')
    report['cases'].extend(['scene_generation_receipt_reused', 'scene_generation_result_equal'])
    save()

    print(json.dumps({'fixture_id': fixture_id, 'cases': report['cases']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=['test', 'production'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.environment, args.output)
    except RegressionFailure as error:
        # Failure output uses only a fixed assertion label, never response or model text.
        print(json.dumps({'status': 'failed', 'case': error.case}, ensure_ascii=False), flush=True)
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / 'runtime-generation-recovery-failure.json').write_text(
            json.dumps({'status': 'failed', 'case': error.case}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    except Exception as error:
        # Keep unexpected diagnostics to a type name; exception text can contain API data.
        diagnostic = {'status': 'failed', 'diagnostic': type(error).__name__}
        print(json.dumps(diagnostic, ensure_ascii=False), flush=True)
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / 'runtime-generation-recovery-failure.json').write_text(
            json.dumps(diagnostic, ensure_ascii=False, indent=2))
        raise SystemExit(1)
