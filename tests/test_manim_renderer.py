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

class FakeRenderer(ManimRenderer):
    def __init__(self,path): super().__init__(path); self.inputs=[]; self.bad=False
    def _phase(self,image,envelope,limit,timeout):
        self.inputs.append(envelope)
        if envelope['phase']=='render': return {'raw_video':base64.b64encode(b'untrusted').decode(),'steps':[]}
        files={'video.mp4':base64.b64encode(b'normalized').decode(),'poster.png':base64.b64encode(b'png').decode(),'step-0.png':base64.b64encode(b'png').decode()}
        if self.bad: files['../../escape']=files['poster.png']
        return {'manifest':dict(version=1,fps=30,width=1280,height=720,duration=1,engine={'name':'ManimGL','version':'1.7.2'},steps=[dict(caption='观察',start_frame=0,end_frame=30,result_frame=29,hold_start_frame=9)]),'files':files}

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
            with self.assertRaises(ManimContractError):renderer.render(SOURCE)
        with patch.object(renderer,'_phase',side_effect=[{'raw_video':'AAAA','steps':[]},{'error':'media_check_failed'}]):
            with self.assertRaises(ManimContractError):renderer.render(SOURCE)
