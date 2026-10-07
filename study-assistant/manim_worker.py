"""Container-only controller. No host mounts, network or API-side code execution."""
import base64
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys

from manim_contracts import FPS, HEIGHT, MAX_IMAGE, MAX_SOURCE, MAX_TOTAL, MAX_VIDEO, WIDTH, validate_manifest, validate_source

PRELUDE = '''from manimlib import *
import json as _json
from pathlib import Path as _Path
class TeachingScene(Scene):
    default_camera_config = {"background_color": "#f5f5f5"}
    def label(self, text, color="#2d3142", size=96):
        return Text(text, font="Noto Sans CJK SC", font_size=size).set_color(color)
    def setup(self):
        super().setup()
        self.step_records = []
        self.step_start = 0
    def next_step(self, caption):
        if len(self.step_records) >= 8:
            raise ValueError("too many steps")
        hold_start = round(self.time * 30)
        self.wait(0.7)
        end = round(self.time * 30)
        self.step_records.append(dict(caption=caption, start_frame=self.step_start, end_frame=end, result_frame=end-1, hold_start_frame=hold_start))
        self.step_start = end
    def tear_down(self):
        if not self.step_records or abs(self.time * 30 - self.step_start) > 1:
            raise ValueError("end each step with next_step")
        _Path("/output/steps.json").write_text(_json.dumps(self.step_records))
        super().tear_down()
'''


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
    process = subprocess.Popen(['xvfb-run', '-a', 'manimgl', str(lesson), 'LessonScene',
                                '-w', '--video_dir', '/output/raw', '--file_name', 'lesson',
                                '--resolution', '1280x720'],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    try:
        process.wait(timeout=120)
        if process.returncode:
            raise ValueError('render failed')
    finally:
        # End the entire Scene process group before independent decoding and collection.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
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
    review_paths = []
    for index, step in enumerate(steps):
        filename = 'step-%d.png' % index
        run(['ffmpeg', '-v', 'error', '-i', str(final), '-vf', 'select=eq(n\\,%d)' % step['result_frame'],
             '-frames:v', '1', '-y', str(output / filename)])
        filenames.append(filename)
        review_path = output / ('review-%d.png' % index)
        mobile_review_frame(output / filename, review_path)
        review_paths.append(review_path)
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
    for path in review_paths:
        regular(path, 256 * 1024)
        run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'])
        data = path.read_bytes()
        total += len(data)
        review_frames.append(base64.b64encode(data).decode())
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
        except (ValueError, KeyError, TypeError, subprocess.CalledProcessError):
            print(json.dumps({'error':'scene_render_failed'}))
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
