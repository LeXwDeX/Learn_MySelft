import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from manim_contracts import ManimContractError, references_in, strip_generated_scenes, validate_first_frame_plan, validate_manifest, validate_source, validate_teaching_plan

class TeachingPlanTests(unittest.TestCase):
    def plan(self):
        return dict(objective='理解矩阵对基向量的作用',visual_reason='连续变换能连接输入与输出',
                    observe='单位正方形怎样变成平行四边形',
                    steps=[dict(change='拉伸横向基向量',why='矩阵第一列是横向基向量的输出')])
    def test_missing_purpose_or_change_cannot_reach_renderer(self):
        plan=self.plan()
        self.assertEqual(validate_teaching_plan(plan,1),plan)
        for bad in (None,{},dict(plan,observe=''),dict(plan,objective='字'*121),dict(plan,steps=[]),
                    dict(plan,steps=plan['steps']*9),dict(plan,steps=[{'change':'旋转'}]),dict(plan,unknown='x')):
            with self.subTest(plan=bad),self.assertRaises(ManimContractError):validate_teaching_plan(bad)
        with self.assertRaisesRegex(ManimContractError,'步骤不一致'):validate_teaching_plan(plan,2)

class FirstFramePlanTests(unittest.TestCase):
    def plan(self, change):
        return dict(objective='理解变化',visual_reason='连续变化连接关系',observe='观察首帧和变化',
                    steps=[dict(change=change,why='展示关系')])
    def source(self,*lines):
        return 'class LessonScene(TeachingScene):\n def construct(self):\n' + ''.join('  '+line+'\n' for line in lines)
    def test_first_frame_claim_requires_add_before_any_play_or_wait(self):
        claim=self.plan('首帧显示原点O和箭头，再展示旋转')
        for first in ('self.play(FadeIn(dot),run_time=1.0)','self.wait(0.5)'):
            with self.subTest(first=first),self.assertRaisesRegex(ManimContractError,r'self\.add'):
                validate_first_frame_plan(claim,self.source(first,'self.add(dot)'))
    def test_add_or_builtin_helper_before_play_satisfies_first_frame_claim(self):
        claim=self.plan('首帧显示原点O和箭头')
        for source in (self.source('self.add(dot)','self.play(FadeIn(arrow),run_time=1.0)'),
                       self.source('self.shear_basis(k=1)'),
                       self.source('self.swap_components(values=(3,-1,4))')):
            with self.subTest(source=source):
                self.assertEqual(validate_first_frame_plan(claim,source),claim)
    def test_buildup_wording_and_negated_claim_do_not_require_populated_start(self):
        for change in ('先建立原点O，再用GrowArrow画出箭头','正常建立过程不要求首帧已有最终对象'):
            plan=self.plan(change)
            with self.subTest(change=change):
                self.assertEqual(validate_first_frame_plan(plan,self.source('self.play(FadeIn(dot),run_time=1.0)')),plan)

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
    def test_line_width_parameter_is_distinct_from_arrow_thickness(self):
        bad = 'class LessonScene(TeachingScene):\n def construct(self):\n  line=Line(LEFT,RIGHT,thickness=6)'
        with self.assertRaisesRegex(ManimContractError, '第3行.*Line.*thickness.*stroke_width'):
            validate_source(bad)
        for expression in ('Line(LEFT,RIGHT,stroke_width=6)', 'Arrow(LEFT,RIGHT,buff=0,thickness=5)'):
            source = 'class LessonScene(TeachingScene):\n def construct(self):\n  line='+expression
            with self.subTest(expression=expression):
                self.assertEqual(validate_source(source), source)

    def test_real_fade_shift_requires_vector_but_positions_accept_tuples(self):
        for expression in ('FadeIn(label,shift=(0,1,0))','FadeOut(label,shift=[0,1,0])','FadeIn(label,(0,1,0))'):
            source='class LessonScene(TeachingScene):\n def construct(self):\n  self.play('+expression+')'
            with self.subTest(expression=expression),self.assertRaisesRegex(ManimContractError,'shift.*方向向量'):
                validate_source(source)
        for expression in ('FadeIn(label,shift=0.3*UP)','FadeOut(label,shift=LEFT)','label.move_to((0,1,0))','label.move_to([0,1,0])'):
            source='class LessonScene(TeachingScene):\n def construct(self):\n  '+expression
            self.assertEqual(validate_source(source),source)
