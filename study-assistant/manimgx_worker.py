"""Container-only ManimGX controller. Model data is closed JSON; no model code runs."""
import base64
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

from animation_contracts import validate_scene
from manim_contracts import (FPS, HEIGHT, MAX_IMAGE, MAX_TOTAL, MAX_VIDEO, MANIMGX_ENGINE,
                             WIDTH, validate_manifest)
from manim_worker import check_hold_frames, regular, run, step_review_frames

RUNTIME = Path('/opt/learn/manimgx_runtime.py')
WRAPPER = '''

class LessonScene(TeachingScene):
    def construct(self):
        run_scene(self, json.loads(Path('/tmp/scene.json').read_text(encoding='utf-8')))
'''
MAX_CAPTURE = 256 * 1024
RENDER_BUDGET = 345.0

LAYOUT = re.compile(r'(?m)^layout: (?:(no problems)(?: in [0-9]+ samples?)?|([0-9]+) problems?)\s*$')


class SceneRenderFailure(ValueError):
    pass


class LayoutFailure(ValueError):
    pass


def capture(command, env, timeout):
    """Run one ManimGX command and keep only a bounded tail of its output.

    Returns the exit status with the cleaned output. ``inspect`` reports layout
    problems through a nonzero status, so the caller parses the report first.
    """
    with tempfile.TemporaryFile() as capture_file:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, env=env, start_new_session=True)
        def collect():
            try:
                while True:
                    chunk = process.stdout.read(8192)
                    if not chunk:
                        break
                    size = capture_file.tell()
                    if size + len(chunk) > MAX_CAPTURE:
                        capture_file.seek(max(0, size - (MAX_CAPTURE - len(chunk))))
                        retained = capture_file.read(MAX_CAPTURE - len(chunk))
                        capture_file.seek(0)
                        capture_file.write(retained)
                        capture_file.truncate()
                    capture_file.write(chunk)
            except (OSError, ValueError):
                pass
            finally:
                process.stdout.close()
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            process.wait(timeout=max(1.0, timeout))
        except subprocess.TimeoutExpired as error:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reader.join(timeout=5)
            raise SceneRenderFailure('scene render timed out') from error
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reader.join(timeout=5)
        if reader.is_alive():
            raise SceneRenderFailure('scene output read failed')
        capture_file.seek(0)
        text = capture_file.read(MAX_CAPTURE).decode('utf-8', errors='replace')
        return process.returncode, re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


def layout_detail(text):
    """Return a short, path-free reason from the last layout report."""
    matches = list(LAYOUT.finditer(text))
    if not matches:
        return ''
    lines = []
    for line in text[matches[-1].end():].splitlines():
        line = re.sub(r'\s+', ' ', line).strip()
        if re.match(r'^\[[0-9]+\]', line):
            lines.append(line)
        elif lines:
            break
    detail = '；'.join(lines[:3])
    detail = re.sub(r'\S*lesson\.py:[0-9]+', 'scene', detail)
    detail = re.sub(r'[\x00-\x1f\x7f]', ' ', detail)
    return detail[:400]


def require_clean_layout(text):
    matches = LAYOUT.findall(text)
    if not matches:
        raise LayoutFailure('layout report missing')
    clean, problems = matches[-1]
    if not clean or int(problems or 0):
        raise LayoutFailure(layout_detail(text) or 'layout problems reported')


def inspect_failed(code, text):
    """True when a nonzero inspect exit is not explained by layout problems."""
    if not code:
        return False
    matches = LAYOUT.findall(text)
    if not matches:
        return True
    clean, problems = matches[-1]
    return bool(clean) or not int(problems or 0)


def render(envelope):
    if set(envelope) != {'phase', 'scene'}:
        raise ValueError('invalid render envelope')
    scene = validate_scene(envelope['scene'])
    output = Path('/output')
    raw = output / 'raw'
    raw.mkdir(mode=0o700)
    Path('/tmp/scene.json').write_text(json.dumps(scene, ensure_ascii=False))
    Path('/tmp/lesson.py').write_text(RUNTIME.read_text(encoding='utf-8') + WRAPPER)
    env = dict(os.environ, HOME='/tmp', XDG_CACHE_HOME='/tmp/.cache',
               STEP_MANIFEST=str(raw / 'steps.json'))
    started = time.monotonic()
    code, text = capture(['manimgx', 'render', '/tmp/lesson.py', 'LessonScene',
                          '-o', str(raw / 'raw.mp4'), '-r', '1280x720', '--fps', '30'],
                         env, 260)
    if code:
        raise SceneRenderFailure('scene render failed')
    require_clean_layout(text)
    step_file = regular(raw / 'steps.json', 12000)
    steps = json.loads(step_file.read_text(encoding='utf-8'))
    if not isinstance(steps, list) or not 1 <= len(steps) <= 8:
        raise ValueError('invalid step records')
    video = regular(raw / 'raw.mp4', MAX_VIDEO)
    command = ['manimgx', 'inspect', '/tmp/lesson.py', 'LessonScene', '-o', str(raw / 'inspect.png')]
    for step in steps:
        frame = step.get('hold_start_frame') if isinstance(step, dict) else None
        if type(frame) is not int or frame < 0:
            raise ValueError('invalid step hold')
        command += ['-t', format(frame / FPS, '.3f')]
    code, text = capture(command, env, RENDER_BUDGET - (time.monotonic() - started))
    # inspect exits nonzero when it finds layout problems, so its report decides.
    if inspect_failed(code, text):
        raise SceneRenderFailure('inspect failed')
    require_clean_layout(text)
    for path in raw.rglob('*'):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError('unexpected raw output')
    print(json.dumps({'raw_video': base64.b64encode(video.read_bytes()).decode(), 'steps': steps},
                     separators=(',', ':')))


def validate(envelope):
    output = Path('/output')
    if set(envelope) != {'phase', 'raw_video', 'steps'}:
        raise ValueError('invalid validation envelope')
    encoded = envelope['raw_video']
    if not isinstance(encoded, str) or len(encoded) > MAX_VIDEO * 4 // 3 + 8:
        raise ValueError('oversized video')
    data = base64.b64decode(encoded, validate=True)
    if not data or len(data) > MAX_VIDEO:
        raise ValueError('invalid video')
    source = output / 'raw.mp4'
    source.write_bytes(data)
    steps = envelope['steps']
    if not isinstance(steps, list) or not 1 <= len(steps) <= 8:
        raise ValueError('invalid steps')
    last = steps[-1].get('end_frame') if isinstance(steps[-1], dict) else None
    if type(last) is not int or not 0 < last <= 2700:
        raise ValueError('invalid frame count')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height', '-of', 'json', str(source)],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
    if len(probe.stdout) > 10000:
        raise ValueError('probe oversized')
    stream = json.loads(probe.stdout)['streams'][0]
    if (stream['width'], stream['height']) != (WIDTH, HEIGHT):
        raise ValueError('invalid dimensions')
    manifest = validate_manifest(dict(version=1, fps=FPS, width=WIDTH, height=HEIGHT,
                                     duration=last / FPS, engine=MANIMGX_ENGINE, steps=steps))
    final = output / 'video.mp4'
    # ManimGX coalesces static holds into variable-rate output. Clone the final
    # frame, resample to 30fps, then cut at the logical final frame.
    run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(source), '-an',
         '-vf', 'tpad=stop_mode=clone:stop_duration=1,fps=30', '-frames:v', str(last),
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', str(final)], timeout=90)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height,nb_frames,avg_frame_rate', '-of', 'json', str(final)],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
    if len(probe.stdout) > 10000:
        raise ValueError('probe oversized')
    stream = json.loads(probe.stdout)['streams'][0]
    if (stream['width'], stream['height'], stream['avg_frame_rate']) != (WIDTH, HEIGHT, '30/1'):
        raise ValueError('invalid normalized dimensions')
    if int(stream['nb_frames']) != last:
        raise ValueError('invalid normalized frame count')
    decoded = subprocess.run(['ffmpeg', '-threads', '1', '-filter_threads', '1', '-v', 'error',
                              '-xerror', '-i', str(final), '-vf', 'scale=160:90,format=gray',
                              '-frames:v', '2701', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
    check_hold_frames(decoded.stdout, manifest)
    filenames = ['video.mp4']
    review_bundles = []
    for index, step in enumerate(steps):
        filename = 'step-%d.png' % index
        run(['ffmpeg', '-v', 'error', '-i', str(final), '-vf', 'select=eq(n\\,%d)' % step['result_frame'],
             '-frames:v', '1', '-y', str(output / filename)])
        filenames.append(filename)
        review_bundles.append(step_review_frames(final, step, output, index))
    (output / 'poster.png').write_bytes((output / 'step-0.png').read_bytes())
    filenames.append('poster.png')
    files = {}
    total = 0
    for filename in filenames:
        path = regular(output / filename, MAX_VIDEO if filename.endswith('.mp4') else MAX_IMAGE)
        if filename.endswith('.png'):
            # FFmpeg decodes PNG in this same networkless container.
            run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'])
        data = path.read_bytes()
        total += len(data)
        files[filename] = base64.b64encode(data).decode()
    review_frames = []
    for bundle in review_bundles:
        total += sum(len(value) for value in bundle.values())
        review_frames.append({name: base64.b64encode(value).decode() for name, value in bundle.items()})
    if total > MAX_TOTAL:
        raise ValueError('output oversized')
    print(json.dumps({'manifest': manifest, 'files': files, 'review_frames': review_frames},
                     separators=(',', ':')))


def main():
    limit = MAX_VIDEO * 4 // 3 + 65536
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        raise ValueError('input oversized')
    envelope = json.loads(data)
    if envelope.get('phase') == 'render' and set(envelope) == {'phase', 'scene'}:
        try:
            render(envelope)
        except LayoutFailure as error:
            message = {'error': 'layout_problems'}
            if str(error):
                message['detail'] = str(error)[:400]
            print(json.dumps(message, ensure_ascii=False))
        except (ValueError, KeyError, TypeError, subprocess.CalledProcessError, OSError):
            print(json.dumps({'error': 'scene_render_failed'}))
    elif envelope.get('phase') == 'validate':
        try:
            validate(envelope)
        except (ValueError, KeyError, TypeError, subprocess.CalledProcessError, OSError):
            print(json.dumps({'error': 'media_check_failed'}))
    else:
        raise ValueError('invalid phase')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
