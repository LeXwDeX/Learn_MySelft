import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from manim_contracts import ManimContractError, references_in, strip_generated_scenes, validate_manifest, validate_source

class ManimContractsTests(unittest.TestCase):
    def manifest(self):
        return dict(version=1,fps=30,width=1280,height=720,duration=2,
                    engine={'name':'ManimGL','version':'1.7.2'},
                    steps=[dict(caption='观察变化',start_frame=0,end_frame=60,result_frame=59,hold_start_frame=39)])
    def test_real_scene_contract(self):
        self.assertTrue(validate_source('class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("观察")'))
        self.assertEqual(validate_manifest(self.manifest())['steps'][0]['result_frame'],59)
    def test_frame_ranges_and_hold_are_checked(self):
        for field,value in [('start_frame',1),('result_frame',60),('end_frame',0),('hold_start_frame',40)]:
            manifest=self.manifest()
            manifest['steps'][0][field]=value
            with self.assertRaises(ManimContractError): validate_manifest(manifest)
    def test_dynamic_execution_imports_and_wrong_base_rejected(self):
        for source in ['import os','class LessonScene(Scene):\n pass','class LessonScene(TeachingScene):\n def construct(self):\n  eval("1")','class LessonScene(TeachingScene):\n def construct(self):\n  self.__class__']:
            with self.assertRaises(ManimContractError): validate_source(source)
    def test_only_top_level_references_are_live(self):
        fence = '```learn-manim\n{"version":1,"asset_id":"' + 'a'*32 + '","title":"角","summary":"观察"}\n```\n'
        example = '````text\n' + fence + '````\n'
        self.assertEqual(references_in(example), [])
        self.assertEqual(len(references_in('正文\n'+fence+example)), 1)
        self.assertEqual(strip_generated_scenes('正文\n'+fence+example), '正文\n'+example)
        with self.assertRaises(ManimContractError): references_in('```learn-manim\n{}\n```')
    def test_real_fade_shift_requires_vector_but_positions_accept_tuples(self):
        for expression in ('FadeIn(label,shift=(0,1,0))','FadeOut(label,shift=[0,1,0])','FadeIn(label,(0,1,0))'):
            source='class LessonScene(TeachingScene):\n def construct(self):\n  self.play('+expression+')'
            with self.subTest(expression=expression),self.assertRaisesRegex(ManimContractError,'shift.*方向向量'):
                validate_source(source)
        for expression in ('FadeIn(label,shift=0.3*UP)','FadeOut(label,shift=LEFT)','label.move_to((0,1,0))','label.move_to([0,1,0])'):
            source='class LessonScene(TeachingScene):\n def construct(self):\n  '+expression
            self.assertEqual(validate_source(source),source)
