"""Container-only controller. No host mounts, network or API-side code execution."""
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

from manim_contracts import FPS, HEIGHT, MAX_IMAGE, MAX_SOURCE, MAX_TOTAL, MAX_VIDEO, WIDTH, validate_manifest, validate_source, validate_render_diagnostic

PRELUDE = '''from manimlib import *
import json as _json
from pathlib import Path as _Path
from decimal import Decimal as _Decimal
from math import ceil as _ceil, isfinite as _isfinite
class TeachingScene(Scene):
    default_camera_config = {"background_color": "#f5f5f5"}
    def label(self, text, color="#2d3142", size=96):
        return Text(text, font="Noto Sans CJK SC", font_size=size).set_color(color)
    def setup(self):
        super().setup()
        self.step_records = []
        self.step_start = 0
    def shear_basis(self, k=1):
        if type(k) not in (int, float) or not 0.5 <= k <= 1.5 or not _isfinite(k):
            raise ValueError("shear_basis requires a finite number from 0.5 to 1.5")
        if _Decimal(str(k)).normalize().as_tuple().exponent < -3:
            raise ValueError("shear_basis allows at most three decimal places")
        if any(mob is not self.camera.frame for mob in self.mobjects) or self.step_records or self.time != 0:
            raise ValueError("shear_basis requires a new empty scene")
        value = format(k, ".3f").rstrip("0").rstrip(".")
        origin = [-3, -1.5, 0]
        first = [-3, 1.5, 0]
        last = [-3 + 3*k, 1.5, 0]
        dot = Dot(origin, radius=0.1).set_color("#2d3142")
        origin_label = self.label("O").next_to(dot, DOWN, buff=0.35)
        arrow = Arrow(origin, first, buff=0, thickness=5).set_color("#245b83")
        endpoint = Dot(first, radius=0.18).set_color("#245b83")
        name = self.label("e2").next_to(arrow, LEFT, buff=0.45)
        coordinate = self.label("(0,1)").next_to(first, UP, buff=0.35)
        self.add(dot, origin_label, endpoint, name, coordinate)
        self.play(GrowArrow(arrow), run_time=1.2)
        self.next_step("先显示原点O与蓝色终点(0,1)，再从O画出e2。每1数学单位画成3画面单位")
        original = arrow.copy().set_color("#757575")
        original_name = name.copy().set_color("#757575")
        original_coordinate = coordinate.copy().set_color("#757575")
        guide = Line(first, last, stroke_width=6).set_color("#757575")
        target = Arrow(origin, last, buff=0, thickness=5).set_color("#c74f20")
        target_name = self.label("Ae2", color="#c74f20").next_to(target, RIGHT, buff=0.5)
        target_coordinate = self.label("(" + value + ",1)", color="#c74f20").next_to(last, RIGHT, buff=0.35)
        self.play(FadeOut(name), FadeOut(coordinate), FadeIn(guide), run_time=0.4)
        self.play(FadeIn(original), FadeIn(original_name), FadeIn(original_coordinate), Transform(arrow, target), endpoint.animate.move_to(last).set_color("#c74f20"), run_time=2.4)
        self.play(FadeIn(target_name), FadeIn(target_coordinate), run_time=0.4)
        self.next_step("终点沿灰色水平线从(0,1)移到(" + value + ",1)。x增加" + value + "，y仍为1，原点O不动")
    def swap_components(self, values=(3, -1, 4)):
        if type(values) not in (tuple, list) or len(values) != 3 or any(type(value) is not int or not -9 <= value <= 9 for value in values) or values[0] == values[1]:
            raise ValueError("swap_components requires three integers from -9 to 9 with distinct first two values")
        if any(mob is not self.camera.frame for mob in self.mobjects) or self.step_records or self.time != 0:
            raise ValueError("swap_components requires a new empty scene")
        original_tuple = "(" + ",".join(str(value) for value in values) + ")"
        swapped_tuple = "(" + ",".join(str(values[index]) for index in (1, 0, 2)) + ")"
        positions = [LEFT*3, ORIGIN, RIGHT*3]
        slots = VGroup(*[Rectangle(width=2.2, height=1.2).move_to(position).set_color("#757575") for position in positions])
        indices = VGroup(*[self.label(str(index+1)).move_to(position+DOWN*1.5) for index, position in enumerate(positions)])
        dimension = self.label("维度3").move_to(RIGHT*4.2+UP*2.3)
        first = self.label(str(values[0]), color="#245b83", size=120).move_to(positions[0]+UP*1.6)
        second = self.label(str(values[1]), color="#c74f20", size=120).move_to(positions[1]+UP*1.6)
        third = self.label(str(values[2]), size=120).move_to(positions[2]+UP*1.6)
        original = self.label(original_tuple).move_to(LEFT*1.5+UP*2.5)
        self.add(slots, indices, dimension, first, second, third, original)
        self.play(first.animate.move_to(positions[0]), second.animate.move_to(positions[1]), third.animate.move_to(positions[2]), run_time=1.5)
        self.next_step("数字落入第1、2、3个固定槽位，建立有序向量" + original_tuple + "，维度是3")
        original.set_color("#757575")
        upper = ArcBetweenPoints(positions[0], positions[1], angle=-PI/2)
        lower = ArcBetweenPoints(positions[1], positions[0], angle=-PI/2)
        self.play(MoveAlongPath(first, upper), MoveAlongPath(second, lower), run_time=2.4)
        result = self.label(swapped_tuple).move_to(DOWN*2.5)
        self.play(FadeIn(result), run_time=0.4)
        self.next_step("前两数字交换位置，得到" + swapped_tuple + "。第三分量" + str(values[2]) + "不动，维度仍是3")
    def next_step(self, caption):
        if len(self.step_records) >= 8:
            raise ValueError("too many steps")
        hold_start = _ceil(self.time * 30 - 1e-9)  # first frame after the animation ends, even between frames
        self.wait(0.7)
        end = hold_start + 21  # 0.7 seconds at 30 fps, without independent rounding
        self.step_records.append(dict(caption=caption, start_frame=self.step_start, end_frame=end, result_frame=end-1, hold_start_frame=hold_start))
        self.step_start = end
    def tear_down(self):
        if not self.step_records or abs(self.time * 30 - self.step_start) > 1:
            raise ValueError("end each step with next_step")
        _Path("/output/steps.json").write_text(_json.dumps(self.step_records))
        super().tear_down()
'''

MAX_RENDER_STDERR = 64 * 1024


class SceneRenderFailure(ValueError):
    def __init__(self, diagnostic=None):
        super().__init__('render failed')
        self.diagnostic = diagnostic


def render_diagnostic(tail, source_lines):
    """Parse stderr locally; omit object class names, free-form text and paths."""
    if not isinstance(tail, bytes) or len(tail) > MAX_RENDER_STDERR:
        return None
    text = tail.decode('utf-8', errors='replace')
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    matches = list(re.finditer(r'(?m)^([A-Za-z][A-Za-z0-9_]{0,63}):([^\r\n]*)$', text))
    if not matches:
        return None
    last = matches[-1]
    if last[1] not in ('TypeError', 'AttributeError', 'NameError', 'ValueError'):
        return None
    value = {'exception_type': last[1]}
    frames = re.findall(r'File "/tmp/lesson\.py", line ([0-9]{1,6}), in [A-Za-z_][A-Za-z0-9_]*', text[:last.start()])
    for number in reversed(frames):
        line = int(number) - (PRELUDE + '\n').count('\n')
        if 1 <= line <= source_lines:
            value['line'] = line
            break
    patterns = {
        'TypeError': ('keyword', r"got an unexpected keyword argument '([A-Za-z_][A-Za-z0-9_]{0,63})'"),
        'AttributeError': ('attribute', r"has no attribute '([A-Za-z_][A-Za-z0-9_]{0,63})'"),
        'NameError': ('name', r"name '([A-Za-z_][A-Za-z0-9_]{0,63})' is not defined"),
    }
    if last[1] in patterns:
        field, pattern = patterns[last[1]]
        match = re.search(pattern + r'$', last[2])
        if match:
            value[field] = match[1]
    return validate_render_diagnostic(value, source_lines)


def render_process(command, env, source_lines):
    """Continuously drain stderr into a bounded anonymous temporary tail file."""
    with tempfile.TemporaryFile() as capture:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.PIPE, env=env, start_new_session=True)
        def collect():
            try:
                while True:
                    chunk = process.stderr.read(8192)
                    if not chunk:
                        break
                    size = capture.tell()
                    if size + len(chunk) > MAX_RENDER_STDERR:
                        capture.seek(max(0, size - (MAX_RENDER_STDERR - len(chunk))))
                        retained = capture.read(MAX_RENDER_STDERR - len(chunk))
                        capture.seek(0)
                        capture.write(retained)
                        capture.truncate()
                    capture.write(chunk)
            except (OSError, ValueError):
                pass  # Capture failure never changes the sandbox or exposes raw logs.
            finally:
                process.stderr.close()
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            process.wait(timeout=120)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reader.join(timeout=5)
        if process.returncode:
            diagnostic = None
            if not reader.is_alive():
                capture.seek(0)
                diagnostic = render_diagnostic(capture.read(MAX_RENDER_STDERR), source_lines)
            raise SceneRenderFailure(diagnostic)


def run(command, timeout=30):
    if command[0] == 'ffmpeg':
        command = command[:1] + ['-threads','1','-filter_threads','1'] + command[1:]
    subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=timeout, check=True)


def regular(path, cap):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= cap:
        raise ValueError('invalid output')
    return path


def check_hold_frames(pixels, manifest):
    """Check decoded static holds with a small H264 compression tolerance."""
    frame_size = 160 * 90
    count = manifest['steps'][-1]['end_frame']
    if len(pixels) != count * frame_size:
        raise ValueError('decoded frame count differs')
    view = memoryview(pixels)
    def visibly_different(left, right):
        differences = [abs(a-b) for a,b in zip(left,right)]
        return sum(differences) / frame_size > 0.3 or sum(delta>8 for delta in differences) / frame_size > 0.003
    for step in manifest['steps']:
        first = step['hold_start_frame']
        reference = view[first*frame_size:(first+1)*frame_size]
        if not any(visibly_different(reference, view[index*frame_size:(index+1)*frame_size])
                   for index in range(step['start_frame'], first)):
            raise ValueError('step contains no visible animation')
        for index in range(first+1, step['end_frame']):
            current = view[index*frame_size:(index+1)*frame_size]
            if visibly_different(reference,current):
                raise ValueError('hold contains visible motion')


def render(envelope):
    source = validate_source(envelope['source'])
    output = Path('/output')
    lesson = Path('/tmp/lesson.py')
    lesson.write_text(PRELUDE + '\n' + source)
    env = dict(os.environ, HOME='/tmp', XDG_CACHE_HOME='/tmp/cache', LIBGL_ALWAYS_SOFTWARE='1')
    render_process(['xvfb-run', '-a', 'manimgl', str(lesson), 'LessonScene',
                                '-w', '--video_dir', '/output/raw', '--file_name', 'lesson',
                                '--resolution', '1280x720'],
                   env, len(source.splitlines()))
    step_file = regular(output / 'steps.json', 12000)
    steps = json.loads(step_file.read_text())
    videos = list((output / 'raw').rglob('*.mp4'))
    if len(videos) != 1:
        raise ValueError('missing video')
    video = regular(videos[0], MAX_VIDEO)
    if {path.name for path in output.iterdir()} != {'raw', 'steps.json'}:
        raise ValueError('unexpected output')
    for path in (output / 'raw').rglob('*'):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or path == video):
            raise ValueError('unexpected raw output')
    print(json.dumps({'raw_video':base64.b64encode(video.read_bytes()).decode(),'steps':steps}, separators=(',',':')))


def mobile_review_frame(result, destination):
    """Scale a real result PNG inside the independent validation container."""
    run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(result),
         '-vf', 'scale=240:135:flags=lanczos', '-frames:v', '1', '-y', str(destination)])
    regular(destination, 256 * 1024)
    run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(destination), '-f', 'null', '-'])
    return destination


def step_review_frames(video, step, output, index):
    """Sample the actual motion before its static hold, in a fresh validator."""
    samples = {'start': step['start_frame'],
               'middle': (step['start_frame'] + step['hold_start_frame'] - 1) // 2,
               'result': step['result_frame']}
    frames = {}
    for name, frame in samples.items():
        path = output / ('review-%d-%s.png' % (index, name))
        run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(video),
             '-vf', 'select=eq(n\\,%d),scale=240:135:flags=lanczos' % frame,
             '-frames:v', '1', '-y', str(path)])
        regular(path, 256 * 1024)
        run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'])
        frames[name] = path.read_bytes()
    return frames


def validate(envelope):
    output = Path('/output')
    if set(envelope) != {'phase','raw_video','steps'}:
        raise ValueError('invalid validation envelope')
    encoded = envelope['raw_video']
    if not isinstance(encoded,str) or len(encoded)>MAX_VIDEO*4//3+8:
        raise ValueError('oversized video')
    data = base64.b64decode(encoded,validate=True)
    if not data or len(data)>MAX_VIDEO:
        raise ValueError('invalid video')
    video = output/'raw.mp4'
    video.write_bytes(data)
    steps = envelope['steps']
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height,nb_frames,avg_frame_rate', '-of', 'json', str(video)],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
    if len(probe.stdout) > 10000:
        raise ValueError('probe oversized')
    stream = json.loads(probe.stdout)['streams'][0]
    if (stream['width'], stream['height'], stream['avg_frame_rate']) != (WIDTH, HEIGHT, '30/1'):
        raise ValueError('invalid dimensions')
    frame_count = int(stream['nb_frames'])
    manifest = validate_manifest(dict(version=1, fps=FPS, width=WIDTH, height=HEIGHT,
                                     duration=frame_count/FPS, engine={'name':'ManimGL','version':'1.7.2'}, steps=steps))
    # Independently decode the complete video, then normalize browser-compatible output.
    run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(video), '-f', 'null', '-'])
    final = output / 'video.mp4'
    run(['ffmpeg', '-v', 'error', '-i', str(video), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
         '-movflags', '+faststart', '-r', '30', '-y', str(final)])
    decoded = subprocess.run(['ffmpeg','-threads','1','-filter_threads','1','-v','error','-xerror',
                              '-i',str(final),'-vf','scale=160:90,format=gray','-frames:v','2701',
                              '-f','rawvideo','-pix_fmt','gray','-'],
                             stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30,check=True)
    check_hold_frames(decoded.stdout,manifest)
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
        total += sum(len(data) for data in bundle.values())
        review_frames.append({name: base64.b64encode(data).decode() for name,data in bundle.items()})
    if total > MAX_TOTAL:
        raise ValueError('output oversized')
    print(json.dumps({'manifest':manifest, 'files':files, 'review_frames':review_frames}, separators=(',', ':')))


def main():
    limit = MAX_VIDEO*4//3+65536
    data = sys.stdin.buffer.read(limit+1)
    if len(data)>limit:
        raise ValueError('input oversized')
    envelope = json.loads(data)
    if envelope.get('phase') == 'render' and set(envelope)=={'phase','source'}:
        try:
            render(envelope)
        except (ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
            failure = {'error':'scene_render_failed'}
            if isinstance(error, SceneRenderFailure) and error.diagnostic is not None:
                failure['diagnostic'] = error.diagnostic
            print(json.dumps(failure))
    elif envelope.get('phase') == 'validate':
        try:
            validate(envelope)
        except (ValueError, KeyError, TypeError, subprocess.CalledProcessError):
            print(json.dumps({'error':'media_check_failed'}))
    else:
        raise ValueError('invalid phase')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
