"""Two fresh networkless containers separate model execution from media validation."""
import base64
import json
from pathlib import Path
import re
import subprocess
import threading
import uuid
from manim_contracts import MAX_IMAGE, MAX_TOTAL, MAX_VIDEO, ManimContractError, validate_manifest, validate_source

_SLOTS = threading.BoundedSemaphore(1)

class ManimUnavailable(RuntimeError):
    pass

class ManimRenderer:
    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)

    def render(self, source):
        validate_source(source)
        if not _SLOTS.acquire(timeout=1):
            raise ManimUnavailable('动画渲染繁忙')
        try:
            config = json.loads((self.state_dir / 'manim-runtime.json').read_text())
            image = config['image']
            if not isinstance(image,str) or not re.fullmatch(r'(?:sha256:[0-9a-f]{64}|[a-zA-Z0-9._/:\-]+@sha256:[0-9a-f]{64})',image):
                raise ManimUnavailable('动画镜像必须固定版本')
            raw = self._phase(image, {'phase':'render','source':source}, MAX_VIDEO*4//3+65536, 180)
            if raw == {'error':'scene_render_failed'}:
                raise ManimContractError('真实ManimGL场景运行失败，请核对API、对象和每步动画')
            if not isinstance(raw,dict) or set(raw) != {'raw_video','steps'} or not isinstance(raw['raw_video'],str):
                raise ManimContractError('动画原始产物无效')
            if len(raw['raw_video']) > MAX_VIDEO*4//3+8 or len(json.dumps(raw['steps'])) > 12000:
                raise ManimContractError('动画原始产物超出限制')
            # The first container has already been force-removed. Only media bytes and
            # untrusted step data enter this fresh container; no model code enters it.
            result = self._phase(image, {'phase':'validate','raw_video':raw['raw_video'],'steps':raw['steps']}, MAX_TOTAL*4//3+65536,120)
            if result == {'error':'media_check_failed'}:
                raise ManimContractError('视频检查失败，请每步播放真实变化并以next_step结束，保证最后至少0.7秒静止')
            manifest = validate_manifest(result['manifest'])
            files = result['files']
            expected = {'video.mp4','poster.png'} | {'step-%d.png'%i for i in range(len(manifest['steps']))}
            if not isinstance(files,dict) or set(files) != expected:
                raise ManimContractError('动画产物清单无效')
            decoded,total = {},0
            for filename,encoded in files.items():
                if not isinstance(encoded,str):
                    raise ManimContractError('动画产物编码无效')
                value = base64.b64decode(encoded,validate=True)
                if not value or len(value) > (MAX_VIDEO if filename=='video.mp4' else MAX_IMAGE):
                    raise ManimContractError('动画产物长度无效')
                total += len(value)
                decoded[filename] = value
            if total > MAX_TOTAL:
                raise ManimContractError('动画产物总量无效')
            return dict(video=decoded['video.mp4'],poster=decoded['poster.png'],
                        frames=[decoded['step-%d.png'%i] for i in range(len(manifest['steps']))],manifest=manifest)
        except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as error:
            if isinstance(error,ManimContractError): raise
            raise ManimUnavailable('动画渲染暂不可用') from error
        finally:
            _SLOTS.release()

    def _phase(self,image,envelope,limit,timeout):
        name = 'learn-manim-'+uuid.uuid4().hex
        command = ['docker','run','--name',name,'--network','none','--read-only','--user','10001:10001',
                   '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','512','--memory','2g','--cpus','2',
                   '-e','OPENBLAS_NUM_THREADS=1','-e','OMP_NUM_THREADS=1','-e','LP_NUM_THREADS=2',
                   '--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777','--tmpfs','/output:rw,nosuid,nodev,size=128m,mode=1777',
                   '-i',image,'python','/opt/learn/manim_worker.py']
        process = None
        try:
            process = subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            chunks, errors = [],[]
            def collect():
                data = process.stdout.read(limit+1)
                chunks.append(data)
                if len(data)>limit: process.kill()
            def send():
                try:
                    process.stdin.write(json.dumps(envelope).encode())
                    process.stdin.close()
                except OSError as error: errors.append(error)
            reader,writer = threading.Thread(target=collect,daemon=True),threading.Thread(target=send,daemon=True)
            reader.start(); writer.start()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                process.kill(); process.wait()
                raise ManimUnavailable('动画处理超时') from error
            reader.join(timeout=5); writer.join(timeout=5)
            if reader.is_alive() or writer.is_alive() or errors or not chunks:
                raise ManimUnavailable('动画产物收集失败')
            if len(chunks[0])>limit: raise ManimContractError('动画产物超出限制')
            if process.returncode: raise ManimUnavailable('动画处理失败')
            return json.loads(chunks[0])
        finally:
            if process is not None and process.poll() is None:
                process.kill(); process.wait()
            try:
                removed = subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
                if removed.returncode:
                    raise ManimUnavailable('动画容器清理失败')
            except (OSError,subprocess.SubprocessError) as error:
                raise ManimUnavailable('动画容器清理失败') from error
