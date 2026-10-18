"""Fixed ManimGX image; two fresh networkless containers with no model code."""
import base64
import json
from job_execution import JobDeadlineExceeded, check_deadline, remaining_timeout
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid
from animation_contracts import validate_scene
from manim_contracts import MAX_IMAGE, MAX_TOTAL, MAX_VIDEO, ManimContractError, validate_manifest
from manim_renderer import MAX_REVIEW_IMAGE, ManimUnavailable, review_png

_SLOTS = threading.BoundedSemaphore(1)
_SLOT_WAIT_SECONDS = 300


class ManimgxRenderer:
    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)

    def render(self, scene, *, check_cancelled=None):
        def check_wait():
            check_deadline()
            if check_cancelled is not None:
                check_cancelled()
        check_wait()
        value = validate_scene(scene)
        wait_until = time.monotonic() + _SLOT_WAIT_SECONDS
        while True:
            check_wait()
            wait_left = wait_until - time.monotonic()
            if wait_left <= 0:
                raise ManimUnavailable('动画渲染等待超过时限')
            if _SLOTS.acquire(timeout=remaining_timeout(min(0.25, wait_left))):
                break
        phase = 'runtime_configuration'
        try:
            check_wait()
            config = json.loads((self.state_dir / 'manimgx-runtime.json').read_text())
            image = config['image']
            if not isinstance(image, str) or not re.fullmatch(r'(?:sha256:[0-9a-f]{64}|[a-zA-Z0-9._/:\-]+@sha256:[0-9a-f]{64})', image):
                raise ManimUnavailable('动画镜像必须固定版本')
            phase = 'rendering'
            raw = self._phase(image, {'phase': 'render', 'scene': value}, MAX_VIDEO * 4 // 3 + 65536, 360)
            check_wait()
            if isinstance(raw, dict) and raw.get('error') == 'layout_problems':
                error = ManimContractError('布局检查未通过，请删除重叠文字、穿过文字的形状和越界内容后重试')
                error.failure_code = 'layout_invalid'
                raise error
            if isinstance(raw, dict) and raw.get('error') == 'scene_render_failed':
                error = ManimContractError('真实ManimGX场景运行失败，请核对对象、动作和每步动画')
                error.failure_code = 'render_failed'
                raise error
            if not isinstance(raw, dict) or set(raw) != {'raw_video', 'steps'} or not isinstance(raw['raw_video'], str):
                raise ManimContractError('动画原始产物无效')
            if len(raw['raw_video']) > MAX_VIDEO * 4 // 3 + 8 or len(json.dumps(raw['steps'])) > 12000:
                raise ManimContractError('动画原始产物超出限制')
            # The first container is already force-removed. Only media bytes and
            # untrusted step data enter this fresh validator.
            phase = 'media_validation'
            result = self._phase(image, {'phase': 'validate', 'raw_video': raw['raw_video'], 'steps': raw['steps']},
                                 MAX_TOTAL * 4 // 3 + 65536, 120)
            if result == {'error': 'media_check_failed'}:
                raise ManimContractError('视频检查失败，请每步播放真实变化并以next_step结束，保证最后至少0.7秒静止')
            if not isinstance(result, dict) or set(result) != {'manifest', 'files', 'review_frames'}:
                raise ManimContractError('动画缺少手机复核图')
            manifest = validate_manifest(result['manifest'])
            files = result['files']
            expected = {'video.mp4', 'poster.png'} | {'step-%d.png' % index for index in range(len(manifest['steps']))}
            if not isinstance(files, dict) or set(files) != expected:
                raise ManimContractError('动画产物清单无效')
            decoded, total = {}, 0
            for filename, encoded in files.items():
                if not isinstance(encoded, str):
                    raise ManimContractError('动画产物编码无效')
                payload = base64.b64decode(encoded, validate=True)
                if not payload or len(payload) > (MAX_VIDEO if filename == 'video.mp4' else MAX_IMAGE):
                    raise ManimContractError('动画产物长度无效')
                total += len(payload)
                decoded[filename] = payload
            reviews = result['review_frames']
            if not isinstance(reviews, list) or len(reviews) != len(manifest['steps']):
                raise ManimContractError('手机复核图数量无效')
            review_frames = []
            for bundle in reviews:
                if not isinstance(bundle, dict) or set(bundle) != {'start', 'middle', 'result'}:
                    raise ManimContractError('手机复核图必须包含开始、中间和结果')
                frames = {}
                for name in ('start', 'middle', 'result'):
                    encoded = bundle[name]
                    if not isinstance(encoded, str) or len(encoded) > MAX_REVIEW_IMAGE * 4 // 3 + 8:
                        raise ManimContractError('手机复核图编码或长度无效')
                    try:
                        payload = review_png(base64.b64decode(encoded, validate=True))
                    except ValueError as error:
                        raise ManimContractError('手机复核图编码或格式无效') from error
                    total += len(payload)
                    frames[name] = payload
                review_frames.append(frames)
            if total > MAX_TOTAL:
                raise ManimContractError('动画产物总量无效')
            check_wait()
            return dict(video=decoded['video.mp4'], poster=decoded['poster.png'],
                        frames=[decoded['step-%d.png' % index] for index in range(len(manifest['steps']))],
                        review_frames=review_frames, manifest=manifest)
        except JobDeadlineExceeded:
            raise
        except ManimUnavailable as error:
            error.diagnostic_stage = phase
            raise
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            if isinstance(error, ManimContractError):
                error.diagnostic_stage = phase
                error.failure_code = getattr(
                    error, 'failure_code',
                    'media_invalid' if phase == 'media_validation' else 'render_failed')
                if error.failure_code not in ('render_failed', 'media_invalid', 'layout_invalid'):
                    error.failure_code = 'render_failed'
                raise
            unavailable = ManimUnavailable('动画渲染暂不可用')
            unavailable.diagnostic_stage = phase
            raise unavailable from error
        finally:
            _SLOTS.release()

    def _phase(self, image, envelope, limit, timeout):
        name = 'learn-manimgx-' + uuid.uuid4().hex
        command = ['docker', 'run', '--name', name, '--network', 'none', '--read-only', '--user', '10001:10001',
                   '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2',
                   '-e', 'OPENBLAS_NUM_THREADS=1', '-e', 'OMP_NUM_THREADS=1', '-e', 'LP_NUM_THREADS=2',
                   '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '--tmpfs', '/output:rw,nosuid,nodev,size=128m,mode=1777',
                   '-i', image, 'python', '/opt/learn/manimgx_worker.py']
        process = None
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            chunks, errors = [], []
            def collect():
                data = process.stdout.read(limit + 1)
                chunks.append(data)
                if len(data) > limit:
                    process.kill()
            def send():
                try:
                    process.stdin.write(json.dumps(envelope).encode())
                    process.stdin.close()
                except OSError as error:
                    errors.append(error)
            reader, writer = threading.Thread(target=collect, daemon=True), threading.Thread(target=send, daemon=True)
            reader.start()
            writer.start()
            try:
                process.wait(timeout=remaining_timeout(timeout))
            except subprocess.TimeoutExpired as error:
                process.kill()
                process.wait(timeout=5)
                check_deadline()
                raise ManimUnavailable('动画处理超时') from error
            reader.join(timeout=remaining_timeout(5))
            writer.join(timeout=remaining_timeout(5))
            check_deadline()
            if reader.is_alive() or writer.is_alive() or errors or not chunks:
                raise ManimUnavailable('动画产物收集失败')
            if len(chunks[0]) > limit:
                raise ManimContractError('动画产物超出限制')
            if process.returncode:
                raise ManimUnavailable('动画处理失败')
            return json.loads(chunks[0])
        finally:
            execution_error = sys.exc_info()[1]
            try:
                if process is not None and process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                removed = subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, timeout=15, check=False)
                if removed.returncode:
                    raise ManimUnavailable('动画容器清理失败')
            except (OSError, subprocess.SubprocessError, ManimUnavailable) as error:
                if isinstance(execution_error, JobDeadlineExceeded):
                    raise execution_error from None
                check_deadline()
                raise ManimUnavailable('动画容器清理失败') from error
