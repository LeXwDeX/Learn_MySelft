import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from manim_contracts import ManimContractError
from manim_renderer import ManimRenderer, ManimUnavailable

SOURCE='class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("观察")'

def png(width=240,height=135):
    import struct,zlib
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\xff\xff'*width)*height))+chunk(b'IEND',b'')

class FakeRenderer(ManimRenderer):
    def __init__(self,path): super().__init__(path); self.inputs=[]; self.bad=False
    def _phase(self,image,envelope,limit,timeout):
        self.inputs.append(envelope)
        if envelope['phase']=='render': return {'raw_video':base64.b64encode(b'untrusted').decode(),'steps':[]}
        files={'video.mp4':base64.b64encode(b'normalized').decode(),'poster.png':base64.b64encode(b'png').decode(),'step-0.png':base64.b64encode(b'png').decode()}
        if self.bad: files['../../escape']=files['poster.png']
        return {'manifest':dict(version=1,fps=30,width=1280,height=720,duration=1,engine={'name':'ManimGL','version':'1.7.2'},steps=[dict(caption='观察',start_frame=0,end_frame=30,result_frame=29,hold_start_frame=9)]),'files':files,'review_frames':[{name:base64.b64encode(png()).decode() for name in ('start','middle','result')}]}

class RendererTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)
        (self.path/'manim-runtime.json').write_text(json.dumps({'image':'sha256:'+'a'*64}))
    def test_second_phase_contains_media_only(self):
        renderer=FakeRenderer(self.path)
        self.assertEqual(renderer.render(SOURCE)['video'],b'normalized')
        self.assertEqual(set(renderer.inputs[1]),{'phase','raw_video','steps'})
        self.assertNotIn('source',renderer.inputs[1])
    def test_mutable_image_and_extra_output_fail_closed(self):
        renderer=FakeRenderer(self.path); renderer.bad=True
        with self.assertRaises(ManimContractError): renderer.render(SOURCE)
        (self.path/'manim-runtime.json').write_text(json.dumps({'image':'learn-manim:latest'}))
        with self.assertRaises(ManimUnavailable): renderer.render(SOURCE)
        self.assertEqual(len(renderer.inputs),2)
    def test_worker_content_failure_is_repairable(self):
        from unittest.mock import patch
        renderer=FakeRenderer(self.path)
        with patch.object(renderer,'_phase',return_value={'error':'scene_render_failed'}):
            with self.assertRaises(ManimContractError) as raised:renderer.render(SOURCE)
            self.assertEqual(raised.exception.diagnostic_stage,'rendering')
            self.assertEqual(raised.exception.failure_code,'render_failed')
        with patch.object(renderer,'_phase',side_effect=[{'raw_video':'AAAA','steps':[]},{'error':'media_check_failed'}]):
            with self.assertRaises(ManimContractError) as raised:renderer.render(SOURCE)
            self.assertEqual(raised.exception.diagnostic_stage,'media_validation')
            self.assertEqual(raised.exception.failure_code,'media_invalid')

    def test_review_frames_fail_closed_without_original_frame_fallback(self):
        from unittest.mock import patch
        renderer=FakeRenderer(self.path)
        result=renderer._phase('',{'phase':'validate'},0,0)
        encoded=lambda value:base64.b64encode(value).decode()
        corrupt=bytearray(png());corrupt[-5]^=1
        for reviews in (None,[],[encoded(png()),encoded(png())],[encoded(png(1280,720))],['%%%'],[encoded(b'bad')],[encoded(png()[:-1])],[encoded(bytes(corrupt))],[encoded(b'x'*(256*1024+1))],[{'start':encoded(png()),'result':encoded(png())}],[{name:encoded(png(1280,720) if name=='middle' else png()) for name in ('start','middle','result')}]):
            with self.subTest(value=type(reviews).__name__):
                broken=dict(result)
                if reviews is None:broken.pop('review_frames')
                else:broken['review_frames']=reviews
                with patch.object(renderer,'_phase',side_effect=[{'raw_video':'AAAA','steps':[]},broken]):
                    with self.assertRaises(ManimContractError):renderer.render(SOURCE)


class RendererQueueTests(unittest.TestCase):
    setUp = RendererTests.setUp
    def test_real_threads_wait_over_one_second_without_parallel_rendering(self):
        import threading,time
        from unittest.mock import patch
        import manim_renderer
        entered=threading.Event();release=threading.Event();waiting=threading.Event()
        state={'active':0,'max_active':0};lock=threading.Lock();errors=[];results=[]
        class BlockingRenderer(FakeRenderer):
            def _phase(inner,image,envelope,limit,timeout):
                with lock:
                    state['active']+=1;state['max_active']=max(state['max_active'],state['active'])
                try:
                    if inner is first and envelope['phase']=='render':
                        entered.set()
                        if not release.wait(4):raise RuntimeError('test release missing')
                    return super()._phase(image,envelope,limit,timeout)
                finally:
                    with lock:state['active']-=1
        first=BlockingRenderer(self.path);second=BlockingRenderer(self.path)
        def run(renderer,callback=None):
            try:results.append(renderer.render(SOURCE,check_cancelled=callback))
            except BaseException as error:errors.append(error)
        with patch.object(manim_renderer,'_SLOTS',threading.BoundedSemaphore(1)):
            a=threading.Thread(target=run,args=(first,));b=threading.Thread(target=run,args=(second,waiting.set))
            a.start()
            self.assertTrue(entered.wait(2));b.start()
            self.assertTrue(waiting.wait(2))
            try:
                time.sleep(1.1)
                self.assertTrue(b.is_alive());self.assertEqual(second.inputs,[])
            finally:
                release.set();a.join(3);b.join(3)
            self.assertFalse(a.is_alive());self.assertFalse(b.is_alive())
        self.assertEqual(errors,[]);self.assertEqual(len(results),2);self.assertEqual(state['max_active'],1)

    def test_wait_cancel_deadline_and_wait_limit_do_not_release_unowned_slot(self):
        import threading
        from unittest.mock import patch
        import manim_renderer
        from background_jobs import JobError
        from job_execution import execution_budget,JobDeadlineExceeded
        for mode in ('cancel','deadline','wait_limit'):
            semaphore=threading.BoundedSemaphore(1);semaphore.acquire()
            renderer=FakeRenderer(self.path);checked=threading.Event();cancel=threading.Event();errors=[]
            def check():
                checked.set()
                if cancel.is_set():raise JobError(409,'cancelled')
            def run():
                try:
                    if mode=='deadline':
                        with execution_budget(.08):renderer.render(SOURCE)
                    else:renderer.render(SOURCE,check_cancelled=check)
                except BaseException as error:errors.append(error)
            with self.subTest(mode=mode),patch.object(manim_renderer,'_SLOTS',semaphore),patch.object(manim_renderer,'_SLOT_WAIT_SECONDS',.1 if mode=='wait_limit' else 300):
                thread=threading.Thread(target=run);thread.start()
                if mode=='cancel':
                    self.assertTrue(checked.wait(1));cancel.set()
                thread.join(2);self.assertFalse(thread.is_alive())
                self.assertEqual(renderer.inputs,[])
                self.assertFalse(semaphore.acquire(blocking=False),'waiter must not release holder slot')
                semaphore.release()
                self.assertEqual(renderer.render(SOURCE)['video'],b'normalized')
            self.assertEqual(len(errors),1)
            self.assertIsInstance(errors[0],JobError if mode=='cancel' else JobDeadlineExceeded if mode=='deadline' else ManimUnavailable)

    def test_acquired_slot_released_on_cancel_and_phase_deadline(self):
        import threading,time
        from unittest.mock import patch
        import manim_renderer
        from background_jobs import JobError
        from job_execution import execution_budget,JobDeadlineExceeded
        semaphore=threading.BoundedSemaphore(1);renderer=FakeRenderer(self.path);checks=[0]
        def cancel_after_acquire():
            checks[0]+=1
            if checks[0]==3:raise JobError(409,'cancelled')
        with patch.object(manim_renderer,'_SLOTS',semaphore):
            with self.assertRaises(JobError):renderer.render(SOURCE,check_cancelled=cancel_after_acquire)
            self.assertEqual(renderer.inputs,[])
            self.assertTrue(semaphore.acquire(blocking=False));semaphore.release()
            original=renderer._phase
            def expire(*args):
                time.sleep(.04)
                return original(*args)
            with patch.object(renderer,'_phase',side_effect=expire),execution_budget(.02):
                with self.assertRaises(JobDeadlineExceeded):renderer.render(SOURCE)
            self.assertTrue(semaphore.acquire(blocking=False));semaphore.release()
            renderer.bad=True
            with self.assertRaises(ManimContractError):renderer.render(SOURCE)
            self.assertTrue(semaphore.acquire(blocking=False));semaphore.release()
            renderer.bad=False
            self.assertEqual(renderer.render(SOURCE)['video'],b'normalized')
