import contextlib
import ast
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.error
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from background_jobs import JobError
from manim_service import METADATA_LIMITS, PROMPT_MANIMGL as PROMPT, PROMPT_MANIMGX, REVIEW_FALLBACK_REMINDER, TEACHING_REFERENCE_CODE, TEACHING_REFERENCE_ENVELOPE, SWAP_REFERENCE_ENVELOPE, VECTOR_REFERENCE_ENVELOPE, validate_relation, compile_relation, ManimService, ManimGenerationError
from manim_contracts import ManimContractError, validate_source, validate_teaching_plan
from animation_contracts import validate_scene
from manim_renderer import ManimUnavailable
from prompts import MATH_VISUAL_TEACHING

def png(width=240,height=135,shade=255):
    import struct,zlib
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+bytes([shade,shade,shade])*width)*height))+chunk(b'IEND',b'')

def visual_report(ok=True, issues=None, count=1):
    """A deliberately complete valid fixture; malformed cases use explicit raw reports."""
    return json.dumps({'ok':ok,'issues':[] if issues is None else issues,
                       'steps':[{'step':i+1,'start_matches_plan':True,
                                 'change_explains_relation':True,'issues':[]} for i in range(count)]})


def corrected_plan_json(envelope, why='以起始边为固定比较基准，只解释画面实际呈现的夹角变化'):
    """A repaired candidate changes review evidence, not merely code or metadata."""
    value=json.loads(envelope) if isinstance(envelope,str) else json.loads(json.dumps(envelope))
    value['teaching_plan']['steps'][0]['why']=why
    return json.dumps(value,ensure_ascii=False)


class Repository:
    def __init__(self):
        self.lock=threading.RLock()
        self.store=self
        self.doc={'plan':{'nodes':[{'id':'n1','title':'角'}]}}
    def transaction(self): return contextlib.nullcontext()
    def material(self,key): return self.doc
    def job_progress(self,*args,**kwargs): pass

class Model:
    def json(self,messages,**kwargs):
        if isinstance(messages[1]['content'],list):
            context=json.loads(messages[1]['content'][0]['text'])
            return visual_report(count=len(context['teaching_plan']['steps']))
        return json.dumps({'needed':True,'reason':'展示变化','title':'角的变化','summary':'观察角旋转后两边的关系','teaching_plan':{'objective':'理解角度表示两条边的张开程度','visual_reason':'旋转一条边能表现角的大小变化','observe':'一边转动时两边张开的程度如何变化','steps':[{'change':'旋转一条边，使夹角变大','why':'角的大小取决于两条边的相对方向'}]},'code':'class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("观察")'})

class Planner:
    def __init__(self, objective='理解角度表示两条边的张开程度'):
        self.objective = objective
    def json(self, messages, **kwargs):
        return json.dumps({'needed':True,'reason':'选择单一关系','objective':self.objective,
                           'recipe':'native','parameters':{}})

class Renderer:
    def __init__(self,path): self.state_dir=path; self.hook=lambda:None
    def render(self,source,*,check_cancelled=None):
        if check_cancelled is not None: check_cancelled()
        self.hook()
        return {'video':b'video','poster':b'poster','frames':[b'image'],'review_frames':[dict(start=png(),middle=png(),result=png())],'manifest':{'steps':[{}]}}

class ManimServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.repo=Repository(); self.renderer=Renderer(self.temp.name)
        def authorize(actor,key):
            if actor != key.split('/')[0]: raise JobError(403,'denied')
        self.service=ManimService(self.repo,Model(),self.renderer,authorize,planner_model=Planner(),engine='manimgl')
    def generate(self): return self.service.generate('u1/learn-path-v1-a','n1','候选新正文',{'id':'n1'},actor='u1')
    def test_short_reference_passes_source_and_two_step_plan_contract(self):
        self.assertEqual(validate_source(TEACHING_REFERENCE_CODE), TEACHING_REFERENCE_CODE)
        self.assertLessEqual(len(TEACHING_REFERENCE_CODE.splitlines()), 30)
        example = json.loads(PROMPT.splitlines()[-1])
        self.assertEqual(example, TEACHING_REFERENCE_ENVELOPE)
        self.assertEqual(set(example), {'needed', 'reason', 'title', 'summary', 'teaching_plan', 'code'})
        self.assertIs(example['needed'], True)
        self.assertEqual(example['code'], TEACHING_REFERENCE_CODE)
        self.assertEqual(set(example['teaching_plan']), {'objective', 'visual_reason', 'observe', 'steps'})
        for name, limit in METADATA_LIMITS.items():
            self.assertIsInstance(example[name], str)
            self.assertTrue(example[name].strip())
            self.assertLessEqual(len(example[name]), limit)
        plan = example['teaching_plan']
        self.assertEqual(validate_teaching_plan(plan, step_count=2), plan)
        calls = [node for node in ast.walk(ast.parse(example['code']))
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        self.assertEqual([node.func.attr for node in calls], ['shear_basis'])
        self.assertEqual(len(calls[0].keywords), 1)
        self.assertEqual(calls[0].keywords[0].arg, 'k')
        self.assertEqual(ast.literal_eval(calls[0].keywords[0].value), 1)
        self.assertTrue(all(set(step) == {'change', 'why'} for step in plan['steps']))
        self.assertIn('蓝色终点Dot', plan['steps'][0]['change'])
        self.assertIn('固定原点O', plan['steps'][0]['change'])
        self.assertIn('固定灰色粗水平参照线连续右移', plan['steps'][1]['change'])
        self.assertIn('同原点Transform', plan['steps'][1]['change'])
        self.assertIn('灰色原态留存', plan['steps'][1]['change'])
        self.assertIn('y仍为1', plan['steps'][1]['why'])
        self.assertIn('终点Dot沿线连续右移', PROMPT)
        self.assertIn('结束后显示Ae2和目标坐标', PROMPT)

    def test_swap_reference_has_valid_envelope_source_and_two_step_plan(self):
        example = SWAP_REFERENCE_ENVELOPE
        self.assertEqual(set(example), {'needed', 'reason', 'title', 'summary', 'teaching_plan', 'code'})
        self.assertIs(example['needed'], True)
        for name, limit in METADATA_LIMITS.items():
            self.assertTrue(example[name].strip())
            self.assertLessEqual(len(example[name]), limit)
        self.assertEqual(validate_source(example['code']), example['code'])
        self.assertEqual(validate_teaching_plan(example['teaching_plan'], step_count=2), example['teaching_plan'])
        calls = [node for node in ast.walk(ast.parse(example['code'])) if isinstance(node, ast.Call)]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].func.attr, 'swap_components')
        self.assertEqual(calls[0].keywords[0].arg, 'values')
        self.assertEqual(ast.literal_eval(calls[0].keywords[0].value), (3, -1, 4))
        prompt_examples = [json.loads(line) for line in PROMPT.splitlines() if line.startswith('{"needed":')]
        self.assertEqual(prompt_examples, [SWAP_REFERENCE_ENVELOPE, TEACHING_REFERENCE_ENVELOPE])

    def test_generation_receives_reference_without_changing_user_topic(self):
        from unittest.mock import patch
        with patch.object(self.service.model, 'json', wraps=self.service.model.json) as model:
            self.generate()
        messages = model.call_args_list[0].args[0]
        example = json.loads(messages[0]['content'].splitlines()[-1])
        self.assertEqual(example, TEACHING_REFERENCE_ENVELOPE)
        self.assertEqual(example['code'], TEACHING_REFERENCE_CODE)
        self.assertIn('不得给无关单元照抄', messages[0]['content'])
        self.assertIn('每个短片只选一个最有教学价值的关系', messages[0]['content'])
        payload = json.loads(messages[1]['content'])
        self.assertEqual(payload['node']['title'], '角')
        self.assertEqual(payload['study_notes'], '候选新正文')

    def test_native_shear_reference_still_requires_two_media_steps_and_strict_review(self):
        self.service.planner_model = Planner(TEACHING_REFERENCE_ENVELOPE['teaching_plan']['objective'])
        from unittest.mock import patch
        rendered = self.renderer.render('ignored')
        rendered['manifest']['steps'] = [{}, {}]
        rendered['review_frames'] = [dict(start=png(), middle=png(), result=png()) for _ in range(2)]
        with patch.object(self.service.model, 'json', side_effect=[json.dumps(TEACHING_REFERENCE_ENVELOPE),
                                                                visual_report(count=2)]) as model, \
             patch.object(self.renderer, 'render', return_value=rendered) as renderer:
            result = self.generate()
        self.assertTrue(result['asset_id'])
        self.assertEqual(renderer.call_args.args[0], TEACHING_REFERENCE_CODE)
        self.assertEqual(model.call_count, 2)
        self.assertEqual(model.call_args_list[1].kwargs, {'temperature': 0, 'max_tokens': 8192, 'reasoning_effort': 'low', 'response_format': 'json_object'})
        context = json.loads(model.call_args_list[1].args[0][1]['content'][0]['text'])
        self.assertEqual(context['teaching_plan'], TEACHING_REFERENCE_ENVELOPE['teaching_plan'])
        self.assertEqual(len(context['manifest']['steps']), 2)
        self.assertIn('其他课程禁止套用', PROMPT)
        self.assertIn('空场景且尚无步骤', PROMPT)
        self.assertIn('最多三位小数', PROMPT)

    def test_native_shear_reference_is_not_published_when_teaching_review_rejects(self):
        self.service.planner_model = Planner(TEACHING_REFERENCE_ENVELOPE['teaching_plan']['objective'])
        from unittest.mock import patch
        rendered = self.renderer.render('ignored')
        rendered['manifest']['steps'] = [{}, {}]
        rendered['review_frames'] = [dict(start=png(), middle=png(), result=png()) for _ in range(2)]
        code = json.dumps(TEACHING_REFERENCE_ENVELOPE)
        rejected = visual_report(ok=False,issues=['坐标标签在手机复核图上重叠'],count=2)
        with patch.object(self.service.model, 'json', side_effect=[code, rejected, corrected_plan_json(code), rejected]) as model, \
             patch.object(self.renderer, 'render', return_value=rendered):
            with self.assertRaises(ManimGenerationError) as raised:
                self.generate()
        self.assertEqual(raised.exception.failure_code, 'visual_rejected')
        self.assertEqual(model.call_count, 4)
        self.assertFalse(self.service.root.exists())

    def test_generation_repair_and_review_use_separate_request_budgets(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        rejected = visual_report(ok=False,issues=['对象重叠'])
        passed = visual_report()
        with patch.object(self.service.model, 'json', side_effect=[good, rejected, corrected_plan_json(good), passed]) as model:
            self.generate()
        self.assertEqual(model.call_count, 4)
        for index in (0, 2):
            self.assertEqual(model.call_args_list[index].kwargs,
                             {'temperature': 0.3, 'max_tokens': 16384, 'reasoning_effort': 'none', 'response_format': 'json_object'})
        for index in (1, 3):
            self.assertEqual(model.call_args_list[index].kwargs, {'temperature': 0, 'max_tokens': 8192, 'reasoning_effort': 'low', 'response_format': 'json_object'})

    def test_application_injects_admin_cap_without_changing_model_defaults(self):
        from application import create_application
        from unittest.mock import patch
        for configured, expected in ((4096, 4096), (393216, 16384)):
            with tempfile.TemporaryDirectory() as directory:
                app = create_application({'STATE_DIR': directory, 'DELETE_PASSWORD': 'test-password',
                                          'MAX_OUTPUT_TOKENS': str(configured)})
                self.addCleanup(app.close)
                self.assertEqual(app.manim.generation_token_limit, expected)
                self.assertEqual(app.settings.max_output_tokens, configured)
                self.assertEqual(app.model.think, {'reasoning_effort': 'max'})
        self.service.generation_token_limit = 4096
        with patch.object(self.service.model, 'json', wraps=self.service.model.json) as model:
            self.generate()
        self.assertEqual(model.call_args_list[0].kwargs['max_tokens'], 4096)
        self.assertEqual(model.call_args_list[1].kwargs, {'temperature': 0, 'max_tokens': 4096, 'reasoning_effort': 'low', 'response_format': 'json_object'})

    def test_candidate_can_publish_before_notes_and_access_checks_live_owner(self):
        spec=self.generate()
        path,kind=self.service.asset('u1','u1',spec['asset_id'],'video.mp4')
        self.assertEqual(path.read_bytes(),b'video'); self.assertEqual(kind,'video/mp4')
        self.assertTrue((path.parent/'scene.py').read_text().startswith('class LessonScene'))
        metadata=json.loads((path.parent/'metadata.json').read_text())
        self.assertEqual(len(metadata['code_sha256']),64)
        self.assertEqual(metadata['engine'],{'name':'ManimGL','version':'1.7.2'})
        with self.assertRaises(JobError): self.service.asset('u1','u1',spec['asset_id'],'scene.py')
        with self.assertRaises(JobError): self.service.asset('u1','u1',spec['asset_id'],'teaching-plan.json')
        plan=json.loads((path.parent/'teaching-plan.json').read_text())
        self.assertIn(plan['observe'],spec['summary'])
        self.assertEqual((path.parent/'teaching-plan.json').stat().st_mode & 0o777,0o600)
        with self.assertRaises(JobError): self.service.asset('u2','u1',spec['asset_id'],'video.mp4')
        self.repo.doc=None
        with self.assertRaises(JobError): self.service.asset('u1','u1',spec['asset_id'],'video.mp4')
    def test_concurrent_notes_reject_publication_and_remove_files(self):
        self.renderer.hook=lambda:self.repo.doc.update(nodeDetail={'n1':{'study_notes':'另一个请求'}})
        with self.assertRaises(JobError) as raised: self.generate()
        self.assertEqual(raised.exception.status,409)
        self.assertEqual(list((Path(self.temp.name)/'manim-assets').glob('*/*')),[])
    def test_delete_during_render_rejects_publication(self):
        self.renderer.hook=lambda:setattr(self.repo,'doc',None)
        with self.assertRaises(JobError): self.generate()
        self.assertEqual(list((Path(self.temp.name)/'manim-assets').glob('*/*')),[])
    def test_cancel_after_render_does_not_publish(self):
        cancelled = [False]
        self.renderer.hook=lambda:cancelled.__setitem__(0,True)
        with self.assertRaises(JobError):
            self.service.generate('u1/learn-path-v1-a','n1','正文',{'id':'n1'},actor='u1',cancelled=lambda:cancelled[0])
        self.assertFalse((Path(self.temp.name)/'manim-assets').exists())
    def test_upstream_errors_are_generic_and_do_not_publish(self):
        from unittest.mock import patch
        with patch.object(self.service.model,'json',side_effect=urllib.error.URLError('secret upstream details')):
            with self.assertRaises(JobError) as raised:self.generate()
            self.assertEqual(raised.exception.status,503)
            self.assertNotIn('secret',str(raised.exception))
        self.assertFalse((Path(self.temp.name)/'manim-assets').exists())
    def test_content_failure_repairs_once_but_environment_failure_does_not_retry(self):
        from unittest.mock import patch
        original=self.renderer.render
        good=original('ignored')
        with patch.object(self.renderer,'render',side_effect=[ManimContractError('场景运行失败'),good]) as render, \
             patch.object(self.service.model,'json',wraps=self.service.model.json) as model:
            self.generate()
            self.assertEqual(render.call_count,2)
            repair_payload=json.loads(model.call_args_list[1].args[0][1]['content'])
            self.assertIn('场景运行失败',repair_payload['repair'])
            self.assertIn('class LessonScene',repair_payload['previous_code'])
        with patch.object(self.renderer,'render',side_effect=ManimUnavailable('环境失败')) as render:
            with self.assertRaises(JobError) as raised:self.generate()
            self.assertEqual(raised.exception.status,503)
            self.assertEqual(render.call_count,1)
    def test_ttl_removes_only_old_unpublished_or_inaccessible_crash_leftovers(self):
        import os
        root=self.service.root/'u1'
        cases=[('a'*32,{'published':False,'created_at':1}),('b'*32,{'published':True}),
               ('c'*32,{'published':False,'created_at':100000}),('d'*32,{'unknown':True}),('e'*32,None)]
        for asset_id,metadata in cases:
            directory=root/asset_id;directory.mkdir(parents=True)
            if metadata is not None:(directory/'metadata.json').write_text(json.dumps(metadata))
            os.utime(directory,(1,1))
        self.assertEqual(self.service.collect_expired(now=100000),2)
        for asset_id in ('b'*32,'c'*32,'d'*32):self.assertTrue((root/asset_id).exists())
    def test_line_thickness_repairs_before_fake_renderer_with_previous_code(self):
        # The fake renderer proves orchestration only, not actual media quality.
        from unittest.mock import patch
        envelope = json.loads(self.service.model.json([{}, {'content':'generation'}]))
        bad = dict(envelope, code='class LessonScene(TeachingScene):\n def construct(self):\n  line=Line(LEFT,RIGHT,thickness=6)\n  self.play(FadeIn(line))\n  self.next_step("观察线段")')
        good = dict(bad, code=bad['code'].replace('thickness=6', 'stroke_width=6'))
        with patch.object(self.service.model, 'json', side_effect=[json.dumps(bad), json.dumps(good), visual_report()]) as model, \
             patch.object(self.renderer, 'render', wraps=self.renderer.render) as render:
            spec = self.generate()
            self.assertTrue(spec['asset_id'])
            self.assertEqual(render.call_args.args, (good['code'],))
            self.assertEqual(render.call_count,1)
            self.assertTrue(callable(render.call_args.kwargs['check_cancelled']))
            payload = json.loads(model.call_args_list[1].args[0][1]['content'])
            self.assertEqual(payload['previous_code'], bad['code'])
            self.assertIn('第3行', payload['repair'])
            self.assertIn('Line', payload['repair'])
            self.assertIn('stroke_width', payload['repair'])
            self.assertEqual(model.call_count, 3)

    def test_first_frame_claim_requires_add_before_play_and_repairs_before_render(self):
        from unittest.mock import patch
        good=self.service.model.json([{}, {'content':'generation'}])
        bad=json.loads(good)
        bad['teaching_plan']['steps'][0]['change']='首帧显示原点O和箭头，再展示变化'
        bad['code']='class LessonScene(TeachingScene):\n def construct(self):\n  self.play(FadeIn(self.label("O")),run_time=1.0)\n  self.next_step("观察")'
        repaired=json.loads(good)
        repaired['teaching_plan']['steps'][0]['change']='先建立原点O和箭头，再展示变化'
        with patch.object(self.service.model,'json',side_effect=[json.dumps(bad),json.dumps(repaired),visual_report()]) as model, \
             patch.object(self.renderer,'render',wraps=self.renderer.render) as render:
            spec=self.generate()
            self.assertTrue(spec['asset_id'])
            self.assertEqual(render.call_count,1)
            self.assertEqual(render.call_args.args[0],repaired['code'])
            repair=json.loads(model.call_args_list[1].args[0][1]['content'])
            self.assertIn('首帧',repair['repair'])
            self.assertIn('self.add',repair['repair'])
            self.assertIn('先建立',repair['repair'])
            self.assertEqual(repair['previous_code'],bad['code'])

    def test_invalid_fade_shift_repairs_before_container_with_previous_code(self):
        from unittest.mock import patch
        good=self.service.model.json([{}, {'content':'generation'}])
        bad=json.loads(good)
        bad['code']='class LessonScene(TeachingScene):\n def construct(self):\n  self.play(FadeIn(self.label("观察"),shift=(0,1,0)))'
        with patch.object(self.service.model,'json',side_effect=[json.dumps(bad),good,visual_report()]) as model, \
             patch.object(self.renderer,'render',wraps=self.renderer.render) as render:
            self.generate()
            self.assertEqual(render.call_count,1)
            payload=json.loads(model.call_args_list[1].args[0][1]['content'])
            self.assertIn('方向向量',payload['repair'])
            self.assertEqual(payload['previous_code'],bad['code'])
    def test_oversized_reason_repairs_before_render_and_still_requires_visual_review(self):
        from unittest.mock import patch
        good=self.service.model.json([{}, {'content':'generation'}])
        bad=json.loads(good);bad['reason']='修复说明'*74
        with patch.object(self.service.model,'json',side_effect=[json.dumps(bad),good,visual_report()]) as model, \
             patch.object(self.renderer,'render',wraps=self.renderer.render) as render:
            spec=self.generate()
            self.assertTrue(spec['asset_id'])
            self.assertEqual(render.call_count,1)
            self.assertEqual(model.call_count,3)
            repair=json.loads(model.call_args_list[1].args[0][1]['content'])
            self.assertIn('reason',repair['repair'])
            self.assertIn(str(METADATA_LIMITS['reason']),repair['repair'])
            self.assertIn(str(len(bad['reason'])),repair['repair'])
            self.assertNotIn(bad['reason'],repair['repair'])
            self.assertEqual(repair['previous_code'],bad['code'])
            self.assertIsInstance(model.call_args_list[2].args[0][1]['content'],list)
            for name,cap in METADATA_LIMITS.items():self.assertIn('%s≤%d字符'%(name,cap),PROMPT)
    def test_repeated_oversized_metadata_preserves_notes_without_render_or_publish(self):
        from unittest.mock import patch
        self.repo.doc['nodeDetail']={'n1':{'study_notes':'原正文'}}
        original=json.dumps(self.repo.doc,sort_keys=True)
        good=self.service.model.json([{}, {'content':'generation'}])
        for name,cap in METADATA_LIMITS.items():
            with self.subTest(field=name):
                bad=json.loads(good);bad[name]='私密'*(cap//2+1)
                with patch.object(self.service.model,'json',return_value=json.dumps(bad)) as model,patch.object(self.renderer,'render') as render:
                    with self.assertRaises(JobError) as raised:self.generate()
                    self.assertEqual(raised.exception.status,502)
                    self.assertEqual(model.call_count,2)
                    render.assert_not_called()
                    repair=json.loads(model.call_args_list[1].args[0][1]['content'])['repair']
                    self.assertIn(name,repair);self.assertIn(str(cap),repair)
                    self.assertNotIn('私密',repair)
                    self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)
                    self.assertFalse(self.service.root.exists())
    def test_shared_math_guide_and_own_material_level_reach_builder_and_independent_review(self):
        from unittest.mock import patch
        self.repo.doc['spec']={'level':'初中生','goal':'用图形解释等价变形'}
        with patch.object(self.service.model,'json',wraps=self.service.model.json) as model:
            self.generate()
        self.assertEqual(model.call_count,2)
        generation,review=[call.args[0] for call in model.call_args_list]
        for messages in (generation,review):self.assertIn(MATH_VISUAL_TEACHING,messages[0]['content'])
        first=json.loads(generation[1]['content'])
        second=json.loads(review[1]['content'][0]['text'])
        for payload in (first,second):
            self.assertEqual(payload['level'],'初中生')
            self.assertEqual(payload['goal'],'用图形解释等价变形')
            self.assertEqual(payload['node']['title'],'角')
        self.assertIn('JSON',generation[0]['content'])
        self.assertIn('start_matches_plan',review[0]['content'])
        self.assertNotIn('needed(bool)',review[0]['content'])
        self.assertIn('约240像素',review[0]['content'])
        self.assertNotIn('"ok":',MATH_VISUAL_TEACHING)
    def test_level_and_goal_are_bounded_and_missing_level_is_not_inferred(self):
        from unittest.mock import patch
        for specification,expected_level,expected_goal in [({'level':'级'*201,'goal':'目'*401},'级'*200,'目'*400),({},'','')]:
            with self.subTest(specification=bool(specification)):
                self.repo.doc['spec']=specification
                with patch.object(self.service.model,'json',wraps=self.service.model.json) as model:self.generate()
                generation,review=[call.args[0] for call in model.call_args_list]
                for payload in (json.loads(generation[1]['content']),json.loads(review[1]['content'][0]['text'])):
                    self.assertEqual(payload['level'],expected_level)
                    self.assertEqual(payload['goal'],expected_goal)

    def test_independent_review_receives_only_mobile_frames(self):
        import base64
        from unittest.mock import patch
        with patch.object(self.service.model,'json',wraps=self.service.model.json) as model:
            spec=self.generate()
        content=model.call_args_list[1].args[0][1]['content']
        images=[item for item in content if item['type']=='image_url']
        self.assertEqual(len(images),3)
        labels=[item['text'] for item in content[1:] if item['type']=='text']
        self.assertEqual(labels,['步骤1 · 开始','步骤1 · 变化中','步骤1 · 结果'])
        self.assertIn('teaching_plan',json.loads(content[0]['text']))
        self.assertEqual(base64.b64decode(images[0]['image_url']['url'].split(',',1)[1]),png())
        directory=self.service.root/'u1'/spec['asset_id']
        self.assertEqual((directory/'step-0.png').read_bytes(),b'image')
        self.assertFalse(any(path.name.startswith('review-') for path in directory.iterdir()))

    def test_missing_or_invalid_mobile_frames_preserve_notes(self):
        from unittest.mock import patch
        self.repo.doc['nodeDetail']={'n1':{'study_notes':'原正文'}}
        original=json.dumps(self.repo.doc,sort_keys=True)
        good=self.renderer.render('ignored')
        for reviews in (None,[],[png(1280,720)],[b'bad'],[b'x'*(256*1024+1)],[dict(start=png(),result=png())],[dict(start=png(),middle=b'bad',result=png())]):
            with self.subTest(reviews=type(reviews).__name__):
                broken=dict(good)
                if reviews is None:broken.pop('review_frames')
                else:broken['review_frames']=reviews
                with patch.object(self.renderer,'render',return_value=broken),patch.object(self.service.model,'json',wraps=self.service.model.json) as model:
                    with self.assertRaises(JobError) as raised:self.generate()
                    self.assertEqual(raised.exception.status,502)
                    self.assertEqual(model.call_count,2)
                self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)
                self.assertFalse(self.service.root.exists())

    def test_mobile_legibility_review_rejection_repairs_once_and_preserves_notes(self):
        from unittest.mock import patch
        self.repo.doc['nodeDetail']={'n1':{'study_notes':'原正文'}}
        original=json.dumps(self.repo.doc,sort_keys=True)
        good=self.service.model.json([{}, {'content':'generation'}])
        bad_review=visual_report(ok=False,issues=['主要方程在240×135图中看不清，标题独占一步且结论重复'])
        with patch.object(self.service.model,'json',side_effect=[good,bad_review,corrected_plan_json(good),bad_review]) as model,patch.object(self.renderer,'render',wraps=self.renderer.render) as render:
            with self.assertRaises(JobError) as raised:self.generate()
            self.assertEqual(raised.exception.status,502)
            self.assertEqual(render.call_count,2)
            self.assertEqual(model.call_count,4)
            repair=json.loads(model.call_args_list[2].args[0][-1]['content'])
            snapshot=json.loads(model.call_args_list[2].args[0][2]['content'])
            self.assertIn('240×135',repair['repair'])
            self.assertIn('class LessonScene',snapshot['code'])
            self.assertIn('纯标题或装饰',model.call_args_list[1].args[0][0]['content'])
        self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)
        self.assertFalse(self.service.root.exists())

    def test_plan_validation_precedes_render_and_matches_actual_steps(self):
        from unittest.mock import patch
        good=json.loads(self.service.model.json([{}, {'content':'generation'}]))
        missing=dict(good,teaching_plan=None)
        with patch.object(self.service.model,'json',return_value=json.dumps(missing)),patch.object(self.renderer,'render') as render:
            with self.assertRaises(ManimGenerationError):self.generate()
            render.assert_not_called()
        mismatch=dict(good)
        mismatch['teaching_plan']=dict(good['teaching_plan'],steps=good['teaching_plan']['steps']*2)
        with patch.object(self.service.model,'json',return_value=json.dumps(mismatch)) as model:
            with self.assertRaises(ManimGenerationError):self.generate()
            self.assertEqual(model.call_count,2)
        self.assertFalse(self.service.root.exists())

    def test_automatic_animation_can_decline_without_render_or_review(self):
        from unittest.mock import patch
        decision=dict(needed=False,reason='术语定义用表格更清楚',objective='',recipe=None,parameters={})
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(decision)) as model,patch.object(self.service.model,'json') as code_model,patch.object(self.renderer,'render') as render:
            self.assertIsNone(self.service.generate('u1/learn-path-v1-a','n1','正文',{},requested=False,actor='u1'))
            self.assertEqual(model.call_count,1)
            code_model.assert_not_called()
            render.assert_not_called()

    def test_attempt_diagnostics_contain_only_categories_without_private_feedback(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        self.repo.local=SimpleNamespace(job_id='a'*32)
        good=self.service.model.json([{}, {'content':'generation'}])
        bad=visual_report(ok=False,issues=['PRIVATE_FEEDBACK_TOKEN_URL'])
        with patch.object(self.service.model,'json',side_effect=[good,bad,corrected_plan_json(good),bad]), \
             self.assertLogs('manim_service',level='INFO') as captured:
            with self.assertRaises(ManimGenerationError) as raised:self.generate()
        self.assertEqual(raised.exception.failure_code,'visual_rejected')
        rows=[json.loads(item.getMessage().split(' ',1)[1]) for item in captured.records]
        self.assertEqual([row['attempt'] for row in rows],[1,2])
        self.assertTrue(all(row['stage']=='visual_review' and row['failure_code']=='visual_rejected' for row in rows))
        self.assertTrue(all(row['job_id']=='a'*32 and type(row['elapsed_ms']) is int for row in rows))
        self.assertNotIn('PRIVATE_FEEDBACK_TOKEN_URL','\n'.join(captured.output))
        self.assertNotIn('候选新正文','\n'.join(captured.output))
        for row in rows:self.assertEqual(set(row),{'job_id','attempt','stage','failure_code','elapsed_ms','exception','review_attempt','remaining_budget_ms'})

    def test_distinct_failure_types_allow_third_draft_with_at_most_two_reviews(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        invalid = json.loads(good)
        invalid['teaching_plan']['steps_count'] = 1
        invalid = json.dumps(invalid)
        rejected = visual_report(ok=False,issues=['原位置对照缺失'])
        passed = visual_report()
        sequences = [(invalid, good, rejected, corrected_plan_json(good), passed),
                     (good, rejected, invalid, corrected_plan_json(good), passed)]
        for sequence in sequences:
            with self.subTest(sequence=sequence[0] == invalid), \
                 patch.object(self.service.model, 'json', side_effect=sequence) as model, \
                 patch.object(self.renderer, 'render', wraps=self.renderer.render) as render, \
                 self.assertLogs('manim_service', level='INFO') as logs:
                result = self.generate()
            self.assertTrue(result['asset_id'])
            self.assertEqual(render.call_count, 2)
            generation = [call for call in model.call_args_list if isinstance(call.args[0][1]['content'], str)]
            review = [call for call in model.call_args_list if isinstance(call.args[0][1]['content'], list)]
            self.assertEqual(len(generation), 3)
            self.assertEqual(len(review), 2)
            self.assertTrue(all(call.kwargs['reasoning_effort'] == 'none' for call in generation))
            self.assertTrue(all(call.kwargs == {'temperature': 0, 'max_tokens': 8192, 'reasoning_effort': 'low', 'response_format': 'json_object'} for call in review))
            records = [json.loads(item.getMessage().split(' ', 1)[1]) for item in logs.records]
            records = [item for item in records if item['stage'] != 'publish']
            self.assertEqual([item['attempt'] for item in records], [1, 2, 3])
            self.assertEqual(records[-1]['failure_code'], 'passed')
            self.assertEqual(records[-1]['stage'], 'visual_review')
            self.assertIn('steps_count', PROMPT)

    def test_third_draft_failure_never_generates_fourth_or_publishes(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        invalid = json.loads(good)
        invalid['teaching_plan']['steps_count'] = 1
        invalid = json.dumps(invalid)
        rejected = visual_report(ok=False,issues=['对象重叠'])
        with patch.object(self.service.model, 'json', side_effect=[invalid, good, rejected, invalid]) as model:
            with self.assertRaises(ManimGenerationError): self.generate()
        self.assertEqual(model.call_count, 4)
        self.assertFalse(self.service.root.exists())

    def test_transport_failure_has_no_inner_retry(self):
        from unittest.mock import patch
        for error in (TimeoutError('transport'), urllib.error.URLError('transport')):
            with self.subTest(error=type(error).__name__), \
                 patch.object(self.service.model, 'json', side_effect=error) as model:
                with self.assertRaises(ManimGenerationError) as raised: self.generate()
                self.assertIs(raised.exception.__cause__, error)
                self.assertEqual(model.call_count, 1)
        self.assertFalse(self.service.root.exists())

    def test_real_expiry_between_drafts_stops_before_another_model_call(self):
        import time
        from unittest.mock import patch
        from job_execution import execution_budget, JobDeadlineExceeded
        good = self.service.model.json([{}, {'content': 'generation'}])
        invalid = json.loads(good)
        invalid['teaching_plan']['steps_count'] = 1
        with patch.object(self.service.model, 'json', return_value=json.dumps(invalid)) as model, \
             patch.object(self.service, '_diagnostic', side_effect=lambda *a, **k: time.sleep(.08)), \
             execution_budget(.05):
            with self.assertRaises(JobDeadlineExceeded): self.generate()
        self.assertEqual(model.call_count, 1)
        self.assertFalse(self.service.root.exists())

    def test_cancel_between_drafts_stops_before_another_model_call(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        invalid = json.loads(good)
        invalid['teaching_plan']['steps_count'] = 1
        cancelled = [False]
        with patch.object(self.service.model, 'json', return_value=json.dumps(invalid)) as model, \
             patch.object(self.service, '_diagnostic', side_effect=lambda *a, **k: cancelled.__setitem__(0, True)):
            with self.assertRaises(JobError) as raised:
                self.service.generate('u1/learn-path-v1-a', 'n1', '正文', {'id': 'n1'},
                                      actor='u1', cancelled=lambda: cancelled[0])
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(model.call_count, 1)
        self.assertFalse(self.service.root.exists())

    def test_rendered_manifest_count_mismatch_repairs_with_matching_private_plan(self):
        from unittest.mock import patch
        first = json.loads(self.service.model.json([{}, {'content': 'generation'}]))
        step = first['teaching_plan']['steps'][0]
        first['teaching_plan']['steps'] = [dict(step) for _ in range(2)]
        fixed = json.loads(json.dumps(first))
        fixed['teaching_plan']['steps'] = [dict(step) for _ in range(5)]
        rendered = self.renderer.render('ignored')
        rendered['manifest']['steps'] = [{} for _ in range(5)]
        rendered['review_frames'] = [dict(start=png(), middle=png(), result=png()) for _ in range(5)]
        with patch.object(self.service.model, 'json', side_effect=[json.dumps(first), json.dumps(fixed),
                                                                visual_report(count=5)]) as model, \
             patch.object(self.renderer, 'render', return_value=rendered) as render:
            self.generate()
        initial = json.loads(model.call_args_list[0].args[0][1]['content'])
        repair = json.loads(model.call_args_list[1].args[0][1]['content'])
        self.assertIsNone(initial['previous_teaching_plan'])
        self.assertEqual(repair['previous_teaching_plan'], first['teaching_plan'])
        self.assertEqual(repair['previous_code'], first['code'])
        self.assertIn('教学计划2步，实际视频5步', repair['repair'])
        self.assertIn('一一对应', repair['repair'])
        self.assertEqual(render.call_count, 2)
        self.assertEqual(model.call_count, 3)
        self.assertIsInstance(model.call_args_list[2].args[0][1]['content'], list)
        self.assertEqual(model.call_args_list[2].kwargs, {'temperature': 0, 'max_tokens': 8192, 'reasoning_effort': 'low', 'response_format': 'json_object'})

    def test_new_invalid_draft_never_reuses_previous_valid_teaching_plan(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        for invalid_kind in ('root', 'extra_plan_field', 'oversized', 'missing'):
            invalid = json.loads(good)
            invalid['code'] += '\n  self.next_step("新稿")'
            if invalid_kind == 'root': invalid['extra_root'] = True
            elif invalid_kind == 'extra_plan_field': invalid['teaching_plan']['steps_count'] = 1
            elif invalid_kind == 'oversized': invalid['teaching_plan']['objective'] = 'x' * 121
            else: invalid['teaching_plan'] = None
            with self.subTest(kind=invalid_kind), \
                 patch.object(self.service.model, 'json', side_effect=[good, visual_report(ok=False,issues=['对照缺失']),
                                                                     json.dumps(invalid), corrected_plan_json(good),
                                                                     visual_report()]) as model:
                self.generate()
            third = json.loads(model.call_args_list[3].args[0][1]['content'])
            self.assertIsNone(third['previous_teaching_plan'])
            if invalid_kind != 'root': self.assertEqual(third['previous_code'], invalid['code'])

    def test_unvalidated_or_missing_first_plan_is_not_sent_back_to_model(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        for plan in (None, {'objective': 'x' * 20000}, {'steps_count': 9}):
            invalid = json.loads(good)
            invalid['teaching_plan'] = plan
            with self.subTest(plan=type(plan).__name__), \
                 patch.object(self.service.model, 'json', side_effect=[json.dumps(invalid), corrected_plan_json(good),
                                                                     visual_report()]) as model:
                self.generate()
            repair = json.loads(model.call_args_list[1].args[0][1]['content'])
            self.assertIsNone(repair['previous_teaching_plan'])

    def test_upstream_http_diagnostics_keep_status_but_not_url_or_body(self):
        from unittest.mock import patch
        error=urllib.error.HTTPError('https://PRIVATE_URL_TOKEN',429,'PRIVATE_BODY_TOKEN',{},None)
        with patch.object(self.service.model,'json',side_effect=error),self.assertLogs('manim_service',level='INFO') as captured:
            with self.assertRaises(ManimGenerationError) as raised:self.generate()
        self.assertEqual(raised.exception.failure_code,'model_unavailable')
        row=json.loads(captured.records[0].getMessage().split(' ',1)[1])
        self.assertEqual(row['upstream_http_status'],429)
        self.assertEqual(row['stage'],'model_generation')
        self.assertNotIn('PRIVATE_','\n'.join(captured.output))


class RelationPlannerTests(unittest.TestCase):
    # Renderer is a fake: these tests prove orchestration, not media quality.
    setUp = ManimServiceTests.setUp
    generate = ManimServiceTests.generate
    def relation(self, recipe='native', parameters=None):
        return dict(needed=True, reason='单一关系', objective='理解角度表示两条边的张开程度',
                    recipe=recipe, parameters={} if parameters is None else parameters)

    def two_step_render(self):
        value=self.renderer.render('ignored')
        value['manifest']['steps']=[{},{}]
        value['review_frames']=[dict(start=png(),middle=png(),result=png()) for _ in range(2)]
        return value

    def test_public_generate_installs_budget_without_extending_outer_deadline(self):
        from unittest.mock import patch
        from job_execution import budget_active,execution_budget,remaining_timeout
        limits=[]
        def inspect(*args):
            self.assertTrue(budget_active())
            limits.append(remaining_timeout(1000))
            return None
        with patch.object(self.service,'_generate',side_effect=inspect):
            self.generate()
            with execution_budget(.1):self.generate()
        self.assertTrue(599<limits[0]<=600)
        self.assertTrue(0<limits[1]<=.1)
        self.assertFalse(budget_active())

    def test_planner_default_uses_same_model_and_small_per_request_limit(self):
        from unittest.mock import patch
        self.service.planner_model=self.service.model
        self.service.generation_token_limit=512
        good=self.service.model.json([{}, {'content':'generation'}])
        with patch.object(self.service.model,'json',side_effect=[json.dumps(self.relation()),good,visual_report()]) as model:
            self.generate()
        self.assertEqual(model.call_count,3)
        first=model.call_args_list[0]
        self.assertEqual(first.kwargs,dict(temperature=0,max_tokens=512,reasoning_effort='none',response_format='json_object'))
        payload=json.loads(first.args[0][1]['content'])
        self.assertEqual(payload['node'],self.repo.doc['plan']['nodes'][0])
        self.assertEqual(payload['study_notes'],'候选新正文')
        code_payload=json.loads(model.call_args_list[1].args[0][1]['content'])
        self.assertEqual(code_payload['focus'],self.relation()['objective'])
        self.assertEqual(model.call_args_list[2].kwargs,dict(temperature=0,max_tokens=512,reasoning_effort='low',response_format='json_object'))

    def test_real_model_client_transport_planning_generation_review_payloads(self):
        from unittest.mock import patch
        from model_client import ModelClient
        import model_transport
        settings=type('Settings',(),dict(llm_model='fixture',llm_base='http://127.0.0.1',max_output_tokens=800,upstream_timeout=1))()
        good=self.service.model.json([{}, {'content':'generation'}])
        self.service.model=ModelClient(settings)
        self.service.planner_model=self.service.model
        self.service.generation_token_limit=800
        replies=[json.dumps(self.relation()),good,visual_report()]
        responses=[json.dumps({'choices':[{'message':{'content':text}}]}).encode() for text in replies]
        with patch.object(model_transport,'post',side_effect=responses) as transport:
            self.generate()
        bodies=[json.loads(call.args[1]) for call in transport.call_args_list]
        self.assertEqual([(b['max_tokens'],b['reasoning_effort']) for b in bodies],[(800,'none'),(800,'none'),(800,'low')])
        self.assertEqual([b['response_format'] for b in bodies],[{'type':'json_object'}]*3)
        planning=json.loads(bodies[0]['messages'][1]['content'])
        native=json.loads(bodies[1]['messages'][1]['content'])
        self.assertEqual(planning['node'],self.repo.doc['plan']['nodes'][0])
        self.assertEqual(planning['study_notes'],'候选新正文')
        self.assertEqual(native['focus'],self.relation()['objective'])
        self.assertIsInstance(bodies[2]['messages'][1]['content'],list)
        self.assertEqual(self.service.model.think,{'reasoning_effort':'max'})

    def test_real_model_client_transport_uses_8192_for_visual_review(self):
        from unittest.mock import patch
        from model_client import ModelClient
        import model_transport
        settings=type('Settings',(),dict(llm_model='fixture',llm_base='http://127.0.0.1',max_output_tokens=16384,upstream_timeout=1))()
        good=self.service.model.json([{}, {'content':'generation'}])
        self.service.model=ModelClient(settings)
        self.service.planner_model=self.service.model
        self.service.generation_token_limit=16384
        replies=[json.dumps(self.relation()),good,visual_report()]
        responses=[json.dumps({'choices':[{'message':{'content':text}}]}).encode() for text in replies]
        with patch.object(model_transport,'post',side_effect=responses) as transport:
            self.generate()
        bodies=[json.loads(call.args[1]) for call in transport.call_args_list]
        self.assertEqual([body['max_tokens'] for body in bodies],[2048,16384,8192])
        self.assertEqual([body['reasoning_effort'] for body in bodies],['none','none','low'])
        self.assertEqual([body['response_format'] for body in bodies],[{'type':'json_object'}]*3)

    def test_known_teaching_failure_native_repair_can_succeed(self):
        from unittest.mock import patch
        value=self.relation('shear_basis',{'k':1.5});expected=compile_relation(value, 'manimgl')
        native=json.loads(json.dumps(expected))
        native['code']='class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("第一步")\n  self.next_step("第二步")'
        native['teaching_plan']['steps'][0]['change']='先建立原点O与e2基准，再展示固定原点的终点变化'
        native=json.loads(corrected_plan_json(native))
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)),patch.object(self.service.model,'json',side_effect=[visual_report(ok=False,issues=['运动歧义'],count=2),json.dumps(native),visual_report(count=2)]) as model,patch.object(self.renderer,'render',return_value=self.two_step_render()) as renderer:
            self.generate()
        self.assertEqual(renderer.call_count,2)
        self.assertEqual(renderer.call_args.args[0],native['code'])
        payload=json.loads(model.call_args_list[1].args[0][1]['content'])
        self.assertEqual(payload['focus'],expected['teaching_plan']['objective'])
        self.assertEqual(json.loads(model.call_args_list[1].args[0][2]['content'])['teaching_plan'],expected['teaching_plan'])

    def test_known_repeated_technical_failure_stops_after_second_candidate(self):
        from unittest.mock import patch
        value=self.relation('shear_basis',{'k':1});expected=compile_relation(value, 'manimgl')
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)) as planner,patch.object(self.service.model,'json',return_value=json.dumps(expected)) as model,patch.object(self.renderer,'render',side_effect=ManimContractError('render failed')) as renderer:
            with self.assertRaises(ManimGenerationError):self.generate()
        self.assertEqual(planner.call_count,1);self.assertEqual(model.call_count,1);self.assertEqual(renderer.call_count,2)
        self.assertFalse(self.service.root.exists())

    def test_planner_token_limit_and_authorization_before_any_call(self):
        from unittest.mock import patch
        with patch.object(self.service.planner_model,'json',wraps=self.service.planner_model.json) as planner:
            self.generate()
        self.assertEqual(planner.call_args.kwargs['max_tokens'],2048)
        with patch.object(self.service.planner_model,'json') as planner,patch.object(self.renderer,'render') as renderer:
            with self.assertRaises(JobError) as raised:
                self.service.generate('u1/learn-path-v1-a','n1','正文',{},actor='u2')
            self.assertEqual(raised.exception.status,403)
            planner.assert_not_called();renderer.assert_not_called()

    def test_planner_invalid_fails_once_without_code_or_render(self):
        from unittest.mock import patch
        invalid=[dict(self.relation(),extra=True),dict(self.relation(),objective='x'*121),
                 dict(self.relation(),recipe='unknown'),dict(self.relation(),parameters={'extra':1}),
                 self.relation('shear_basis',{'k':True}),self.relation('shear_basis',{'k':float('nan')}),
                 self.relation('shear_basis',{'k':float('inf')}),self.relation('shear_basis',{'k':1.0001}),
                 self.relation('shear_basis',{'k':10**400}),self.relation('shear_basis',{'k':1,'extra':0}),
                 self.relation('swap_components',{'values':[True,2,3]}),
                 self.relation('swap_components',{'values':[1,1,3]}),
                 self.relation('swap_components',{'values':[-10,9,0]}),
                 dict(needed=False,reason='静态',objective='',recipe=None,parameters={})]
        for value in invalid:
            with self.subTest(value=value),patch.object(self.service.planner_model,'json',return_value=json.dumps(value)) as planner,patch.object(self.service.model,'json') as model,patch.object(self.renderer,'render') as renderer:
                with self.assertRaises(ManimGenerationError):self.generate()
                self.assertEqual(planner.call_count,1)
                model.assert_not_called();renderer.assert_not_called()
        self.assertFalse(self.service.root.exists())

    def test_compiled_parameters_have_independent_mathematical_expectations(self):
        shear=compile_relation(validate_relation(self.relation('shear_basis',{'k':1.001}),True,'manimgl'),'manimgl')
        plan=shear['teaching_plan']
        self.assertIn('A=[[1,1.001],[0,1]]',plan['objective'])
        self.assertIn('e2=(0,1)变为(1.001,1)',plan['objective'])
        self.assertNotIn('(1,1)',json.dumps(plan,ensure_ascii=False))
        call=next(n for n in ast.walk(ast.parse(shear['code'])) if isinstance(n,ast.Call))
        self.assertEqual(ast.literal_eval(call.keywords[0].value),1.001)
        swap=compile_relation(validate_relation(self.relation('swap_components',{'values':[-9,9,-9]}),True,'manimgl'),'manimgl')
        call=next(n for n in ast.walk(ast.parse(swap['code'])) if isinstance(n,ast.Call))
        self.assertEqual(ast.literal_eval(call.keywords[0].value),(-9,9,-9))
        self.assertIn('使(-9,9,-9)变为(9,-9,-9)',swap['teaching_plan']['objective'])
        self.assertIn('第三分量-9',swap['teaching_plan']['observe'])
        self.assertIn('建立(-9,9,-9)',swap['teaching_plan']['steps'][0]['change'])
        self.assertIn('显示(9,-9,-9)',swap['teaching_plan']['steps'][1]['change'])

    def test_known_parameters_compile_code_and_plan_then_review_only(self):
        from unittest.mock import patch
        for value in [self.relation('shear_basis',{'k':1.001}),self.relation('swap_components',{'values':[-9,9,-9]})]:
            expected=compile_relation(validate_relation(value,True,'manimgl'),'manimgl')
            with self.subTest(recipe=value['recipe']),patch.object(self.service.planner_model,'json',return_value=json.dumps(value)),patch.object(self.service.model,'json',return_value=visual_report(count=2)) as model,patch.object(self.renderer,'render',return_value=self.two_step_render()) as renderer:
                self.generate()
                self.assertEqual(renderer.call_args.args, (expected['code'],))
                self.assertEqual(renderer.call_count,1)
                self.assertTrue(callable(renderer.call_args.kwargs['check_cancelled']))
                self.assertEqual(model.call_count,1)
                review=json.loads(model.call_args.args[0][1]['content'][0]['text'])
                self.assertEqual(review['teaching_plan'],expected['teaching_plan'])
                self.assertEqual(len(review['manifest']['steps']),2)
                self.assertNotEqual(expected['teaching_plan']['objective'],value['objective'])

    def test_known_teaching_repair_falls_back_with_same_focus_and_stops_on_repeat(self):
        from unittest.mock import patch
        value=self.relation('shear_basis',{'k':0.5});expected=compile_relation(value, 'manimgl')
        rejected=visual_report(ok=False,issues=['动作不清楚'],count=2)
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)) as planner,patch.object(self.service.model,'json',side_effect=[rejected,corrected_plan_json(expected),rejected]) as model,patch.object(self.renderer,'render',return_value=self.two_step_render()) as renderer:
            with self.assertRaises(ManimGenerationError):self.generate()
        self.assertEqual(planner.call_count,1);self.assertEqual(renderer.call_count,2);self.assertEqual(model.call_count,3)
        payload=json.loads(model.call_args_list[1].args[0][1]['content'])
        self.assertEqual(payload['focus'],expected['teaching_plan']['objective'])
        snapshot=json.loads(model.call_args_list[1].args[0][2]['content'])
        self.assertEqual(snapshot['code'],expected['code'])
        self.assertEqual(snapshot['teaching_plan'],expected['teaching_plan'])
        self.assertFalse(self.service.root.exists())

    def test_known_technical_then_teaching_failure_allows_only_third_candidate(self):
        from unittest.mock import patch
        value=self.relation('swap_components',{'values':[3,-1,4]});expected=compile_relation(value, 'manimgl')
        rendered=self.two_step_render()
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)) as planner,patch.object(self.renderer,'render',side_effect=[ManimContractError('render failed'),rendered,rendered]) as renderer,patch.object(self.service.model,'json',side_effect=[json.dumps(expected),visual_report(ok=False,issues=['重叠'],count=2),corrected_plan_json(expected),visual_report(count=2)]) as model:
            self.generate()
        self.assertEqual(planner.call_count,1);self.assertEqual(renderer.call_count,3);self.assertEqual(model.call_count,4)
        for index in [0,2]:
            payload=json.loads(model.call_args_list[index].args[0][1]['content'])
            self.assertEqual(payload['focus'],expected['teaching_plan']['objective'])

    def test_changed_native_focus_is_rejected_before_render(self):
        from unittest.mock import patch
        good=json.loads(self.service.model.json([{}, {'content':'generation'}]))
        good['teaching_plan']['objective']='额外目标'
        with patch.object(self.service.model,'json',return_value=json.dumps(good)) as model,patch.object(self.renderer,'render') as renderer:
            with self.assertRaises(ManimGenerationError):self.generate()
        self.assertEqual(model.call_count,2);renderer.assert_not_called()

    def test_planning_transport_deadline_and_cancel_stop_without_candidate(self):
        from unittest.mock import patch
        import time
        from job_execution import execution_budget,JobDeadlineExceeded
        with patch.object(self.service.planner_model,'json',side_effect=TimeoutError()) as planner,patch.object(self.service.model,'json') as model:
            with self.assertRaises(ManimGenerationError) as raised:self.generate()
            self.assertEqual(raised.exception.failure_code,'model_unavailable');self.assertEqual(planner.call_count,1);model.assert_not_called()
        def expire(*args,**kwargs):
            time.sleep(.04)
            return json.dumps(self.relation())
        with patch.object(self.service.planner_model,'json',side_effect=expire),patch.object(self.service.model,'json') as model,execution_budget(.02):
            with self.assertRaises(JobDeadlineExceeded):self.generate()
            model.assert_not_called()
        cancelled=[False]
        def cancel(*args,**kwargs):
            cancelled[0]=True
            return json.dumps(self.relation())
        with patch.object(self.service.planner_model,'json',side_effect=cancel),patch.object(self.service.model,'json') as model:
            with self.assertRaises(JobError) as raised:self.service.generate('u1/learn-path-v1-a','n1','正文',{},actor='u1',cancelled=lambda:cancelled[0])
            self.assertEqual(raised.exception.status,409);model.assert_not_called()


class VisualReviewRecoveryTests(unittest.TestCase):
    setUp = ManimServiceTests.setUp
    generate = ManimServiceTests.generate

    def run_reviews(self, replies, *, renders=None, cancelled=lambda: False):
        from unittest.mock import patch
        self.calls = []
        self.generated = 0
        base_model = self.service.model.json
        iterator = iter(replies)
        def respond(messages, **kwargs):
            self.calls.append((messages, kwargs))
            if isinstance(messages[1]['content'], list):
                value = next(iterator)
                if isinstance(value, BaseException): raise value
                return value() if callable(value) else value
            self.generated += 1
            value=base_model(messages, **kwargs)
            if self.generated>1:
                why=('以起始边为固定比较基准，只解释画面实际呈现的夹角变化' if self.generated==2
                     else '只比较两边相对方向，不以未展示的长度关系解释夹角')
                value=corrected_plan_json(value,why)
            return value
        with patch.object(self.service.model, 'json', side_effect=respond), \
             patch.object(self.renderer, 'render', side_effect=renders or self.renderer.render) as render:
            self.render = render
            return self.service.generate('u1/learn-path-v1-a','n1','候选新正文',{'id':'n1'},actor='u1',cancelled=cancelled)

    def reviews(self):
        return [call for call in self.calls if isinstance(call[0][1]['content'], list)]

    def test_empty_then_pass_reuses_candidate_and_render_with_no_reasoning_fallback(self):
        result = self.run_reviews(['', visual_report()])
        self.assertTrue(result['asset_id'])
        self.assertEqual(self.generated, 1)
        self.assertEqual(self.render.call_count, 1)
        reviews = self.reviews()
        self.assertEqual(len(reviews), 2)
        first,second=reviews
        self.assertIs(first[0][0],second[0][0])
        first_content=first[0][1]['content'];second_content=second[0][1]['content']
        self.assertEqual(second_content[0],first_content[0])
        self.assertEqual(second_content[1],{'type':'text','text':REVIEW_FALLBACK_REMINDER})
        self.assertEqual(second_content[2:],first_content[1:])
        self.assertIs(second_content[2],first_content[1])
        self.assertEqual(first[1], dict(temperature=0,max_tokens=8192,reasoning_effort='low',response_format='json_object'))
        self.assertEqual(second[1], dict(temperature=0,max_tokens=8192,reasoning_effort='none',response_format='json_object'))

    def assert_terminal_review(self, reply, prefix):
        self.setUp()
        self.repo.doc['nodeDetail']={'n1':{'study_notes':'原正文','quiz':{'questions':[{'id':'old'}]}}}
        self.repo.doc['nodeState']={'n1':{'completed':True,'score':83}}
        original=json.dumps(self.repo.doc,sort_keys=True)
        with self.assertRaises(ManimGenerationError) as raised:
            self.run_reviews(prefix+[reply,visual_report()])
        self.assertEqual(raised.exception.failure_code,'visual_invalid')
        self.assertEqual(self.generated,1)
        self.assertEqual(self.render.call_count,1)
        self.assertEqual(len(self.reviews()),len(prefix)+1)
        self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)
        self.assertFalse(self.service.root.exists())

    def test_wrapped_negative_reports_never_reask_with_queued_pass(self):
        negative=visual_report(ok=False,issues=['quality problem'])
        for reply in ('```json\n'+negative+'\n```','review: '+negative,negative+' trailing'):
            for prefix in ([],['']):
                with self.subTest(reply=reply,prefix=bool(prefix)):
                    self.assert_terminal_review(reply,prefix)

    def test_all_nonempty_invalid_reports_and_nonstrings_are_terminal(self):
        invalid=['```json\n{"ok":true,"issues":[]}\n```','prefix {"ok":true,"issues":[]}',
                 '{"ok":true,"issues":[]} trailing','{"ok":false,"issues":[',
                 'not a report','""','true','null','0','[]','[{}]',
                 '{}','{"ok":true}','{"issues":[]}',
                 '{"ok":1,"issues":[]}','{"ok":"invalid","issues":[]}',
                 '{"ok":true,"issues":null}','{"ok":true,"issues":"problem"}',
                 '{"ok":true,"issues":[null]}','{"ok":true,"issues":[""]}',
                 '{"ok":false,"issues":["quality"," "]}',
                 None,b'{"ok":true,"issues":[]}',b'',{},[],0,False]
        for reply in invalid:
            for prefix in ([],['']):
                with self.subTest(reply=repr(reply),prefix=bool(prefix)):
                    self.assert_terminal_review(reply,prefix)

    def test_only_whitespace_strings_can_reask_and_two_blanks_stop(self):
        for blank in ('',' \n\t','\u3000'):
            with self.subTest(blank=repr(blank)):
                self.run_reviews([blank,visual_report()])
                self.assertEqual(self.generated,1)
                self.assertEqual(self.render.call_count,1)
                reviews=self.reviews()
                self.assertEqual(len(reviews),2)
                self.assertEqual([r[1]['reasoning_effort'] for r in reviews],['low','none'])
                fallback=reviews[1][0][1]['content']
                self.assertEqual(fallback[1],{'type':'text','text':REVIEW_FALLBACK_REMINDER})
                self.assertEqual(fallback[:1]+fallback[2:],reviews[0][0][1]['content'])
        self.assert_terminal_review(' \n\t',[''])

    def test_empty_then_quality_rejection_repairs_new_candidate_and_all_gates(self):
        self.run_reviews(['',visual_report(ok=False,issues=['PRIVATE_actual_feedback']),visual_report()])
        self.assertEqual(self.generated,2)
        self.assertEqual(self.render.call_count,2)
        self.assertEqual(len(self.reviews()),3)
        self.assertEqual([r[1]['reasoning_effort'] for r in self.reviews()],['low','none','low'])
        messages=[c[0] for c in self.calls if isinstance(c[0][1]['content'],str)][1]
        payload=json.loads(messages[-1]['content']);snapshot=json.loads(messages[2]['content'])
        self.assertIn('PRIVATE_actual_feedback',payload['repair'])
        self.assertTrue(snapshot['code'])
        self.assertTrue(snapshot['teaching_plan'])
        self.assertIsNot(self.reviews()[1][0],self.reviews()[2][0])

    def test_technical_failure_then_invalid_stops_without_third_candidate(self):
        rendered=self.renderer.render('ignored')
        with self.assertRaises(ManimGenerationError) as raised:
            self.run_reviews(['',''],renders=[ManimContractError('technical'),rendered])
        self.assertEqual(raised.exception.failure_code,'visual_invalid')
        self.assertEqual(self.generated,2)
        self.assertEqual(self.render.call_count,2)
        self.assertFalse(self.service.root.exists())

    def test_third_candidate_invalid_never_generates_fourth(self):
        rendered=self.renderer.render('ignored')
        with self.assertRaises(ManimGenerationError) as raised:
            self.run_reviews([visual_report(ok=False,issues=['quality']),'',''],
                             renders=[ManimContractError('technical'),rendered,rendered])
        self.assertEqual(raised.exception.failure_code,'visual_invalid')
        self.assertEqual(self.generated,3)
        self.assertEqual(self.render.call_count,3)
        self.assertFalse(self.service.root.exists())

    def test_transport_cancel_and_deadline_exit_without_more_calls(self):
        from unittest.mock import patch
        from job_execution import execution_budget, JobDeadlineExceeded
        for error in (urllib.error.URLError('PRIVATE_network'),TimeoutError()):
            with self.subTest(error=type(error).__name__),self.assertRaises(ManimGenerationError) as raised:
                self.run_reviews(['',error])
            self.assertEqual(raised.exception.failure_code,'model_unavailable')
            self.assertEqual(len(self.reviews()),2)
            self.assertEqual(self.generated,1)
        cancelled=[False]
        def cancel(): cancelled[0]=True; return ''
        with self.assertRaises(JobError) as raised:
            self.run_reviews([cancel],cancelled=lambda:cancelled[0])
        self.assertEqual(raised.exception.status,409)
        self.assertEqual(len(self.reviews()),1)
        clock=[0.0]
        def expire(): clock[0]+=11; return ''
        with patch('job_execution.time.monotonic',side_effect=lambda:clock[0]),execution_budget(10):
            with self.assertRaises(JobDeadlineExceeded):self.run_reviews([expire])
        self.assertEqual(len(self.reviews()),1)
        self.assertFalse(self.service.root.exists())

    def test_outer_budget_decreases_across_same_candidate_reviews(self):
        from unittest.mock import patch
        from job_execution import execution_budget,remaining_timeout
        clock=[0.0];remaining=[]
        def first(): remaining.append(remaining_timeout(1000));clock[0]+=4;return ''
        def second(): remaining.append(remaining_timeout(1000));clock[0]+=4;return visual_report()
        with patch('job_execution.time.monotonic',side_effect=lambda:clock[0]),execution_budget(10):
            self.run_reviews([first,second])
        self.assertEqual(remaining,[10,6])
        self.assertEqual(self.generated,1)

    def test_safe_review_diagnostics_and_observer_failure_do_not_change_result(self):
        from unittest.mock import patch
        self.repo.job_event=lambda *args,**kwargs: (_ for _ in ()).throw(RuntimeError('PRIVATE_observer'))
        with self.assertLogs('manim_service',level='INFO') as logs:
            self.run_reviews([' \n\t',visual_report()])
        rows=[json.loads(r.getMessage().split(' ',1)[1]) for r in logs.records]
        reviews=[r for r in rows if r['stage']=='visual_review']
        self.assertEqual([r['review_attempt'] for r in reviews],[1,2])
        self.assertEqual([r['failure_code'] for r in reviews],['visual_invalid','passed'])
        self.assertTrue(all(0<r['remaining_budget_ms']<=600000 for r in reviews))
        self.assertNotIn('PRIVATE_','\n'.join(logs.output))
        self.assertNotIn('候选新正文','\n'.join(logs.output))
        self.assertIn('开始帧',PROMPT)
        self.assertIn('必要组成部分',PROMPT)

    def test_real_client_empty_response_uses_two_actual_review_requests(self):
        from unittest.mock import patch
        from model_client import ModelClient
        import model_transport
        settings=type('Settings',(),dict(llm_model='fixture',llm_base='http://127.0.0.1',max_output_tokens=16384,upstream_timeout=1))()
        good=self.service.model.json([{}, {'content':'generation'}])
        self.service.model=ModelClient(settings)
        responses=[json.dumps({'choices':[{'message':{'content':v}}]}).encode()
                   for v in (good,'',visual_report())]
        with patch.object(model_transport,'post',side_effect=responses) as transport, \
             patch.object(self.renderer,'render',wraps=self.renderer.render) as renderer:
            self.generate()
        bodies=[json.loads(call.args[1]) for call in transport.call_args_list]
        self.assertEqual(len(bodies),3)
        self.assertEqual(renderer.call_count,1)
        self.assertEqual(bodies[1]['reasoning_effort'],'low')
        self.assertEqual(bodies[2]['reasoning_effort'],'none')
        self.assertEqual([b['max_tokens'] for b in bodies[1:]],[8192,8192])
        self.assertEqual(bodies[1]['messages'][0],bodies[2]['messages'][0])
        first_content=bodies[1]['messages'][1]['content'];second_content=bodies[2]['messages'][1]['content']
        self.assertEqual(second_content[1],{'type':'text','text':REVIEW_FALLBACK_REMINDER})
        self.assertEqual(second_content[:1]+second_content[2:],first_content)

    def test_quality_repair_rechecks_source_before_rendering_new_candidate(self):
        from unittest.mock import patch
        good=self.service.model.json([{}, {'content':'generation'}])
        invalid=json.loads(good)
        invalid['code']='class LessonScene(TeachingScene):\n def construct(self):\n  line=Line(LEFT,RIGHT,thickness=6)'
        with patch.object(self.service.model,'json',side_effect=[good,visual_report(ok=False,issues=['quality']),json.dumps(invalid),corrected_plan_json(good),visual_report()]) as model, \
             patch.object(self.renderer,'render',wraps=self.renderer.render) as renderer:
            self.generate()
        self.assertEqual(model.call_count,5)
        self.assertEqual(renderer.call_count,2)
        repair=json.loads(model.call_args_list[3].args[0][1]['content'])
        self.assertIn('stroke_width',repair['repair'])
        self.assertEqual(repair['previous_code'],invalid['code'])

    def test_second_review_cannot_publish_after_outer_deadline(self):
        from unittest.mock import patch
        from job_execution import execution_budget,JobDeadlineExceeded,remaining_timeout
        clock=[0.0];remaining=[]
        def first(): remaining.append(remaining_timeout(1000));clock[0]+=4;return ''
        def second(): remaining.append(remaining_timeout(1000));clock[0]+=7;return visual_report()
        original=json.dumps(self.repo.doc,sort_keys=True)
        with patch('job_execution.time.monotonic',side_effect=lambda:clock[0]),execution_budget(10):
            with self.assertRaises(JobDeadlineExceeded):self.run_reviews([first,second])
        self.assertEqual(remaining,[10,6])
        self.assertEqual(self.generated,1)
        self.assertEqual(self.render.call_count,1)
        self.assertFalse(self.service.root.exists())
        self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)

    def test_every_well_formed_negative_requires_new_candidate_before_pass(self):
        passed=visual_report()
        for negative in (visual_report(issues=['actual quality issue']), visual_report(ok=False)):
            for prefix in ([],['']):
                with self.subTest(negative=negative,prefix=bool(prefix)):
                    self.run_reviews(prefix+[negative,passed])
                    self.assertEqual(self.generated,2)
                    self.assertEqual(self.render.call_count,2)
                    self.assertEqual(len(self.reviews()),len(prefix)+2)
                    self.assertIsNot(self.reviews()[-2][0],self.reviews()[-1][0])
                    repair=json.loads([c[0][-1]['content'] for c in self.calls if isinstance(c[0][1]['content'],str)][1])
                    self.assertTrue(repair['repair'].strip())
                    if 'actual quality issue' in negative:self.assertIn('actual quality issue',repair['repair'])

    def test_malformed_negative_never_reasks_or_repairs_even_with_queued_pass(self):
        self.repo.doc['nodeDetail']={'n1':{'study_notes':'原正文','quiz':{'questions':[{'id':'old'}]}}}
        self.repo.doc['nodeState']={'n1':{'completed':True,'score':83}}
        original=json.dumps(self.repo.doc,sort_keys=True)
        negatives=[{'ok':False}, {'ok':False,'issues':None}, {'ok':False,'issues':'issue'},
                   {'issues':['quality']}, {'ok':1,'issues':['quality']},
                   {'ok':True,'issues':[None]}, {'ok':False,'issues':['quality','']},
                   {'ok':False,'issues':['quality',None]}, {'ok':False,'issues':[' ']}]
        for negative in negatives:
            for prefix in ([],['']):
                with self.subTest(negative=negative,prefix=bool(prefix)),self.assertRaises(ManimGenerationError) as raised:
                    self.run_reviews(prefix+[json.dumps(negative),visual_report()])
                self.assertEqual(raised.exception.failure_code,'visual_invalid')
                self.assertEqual(self.generated,1)
                self.assertEqual(self.render.call_count,1)
                self.assertEqual(len(self.reviews()),len(prefix)+1)
                self.assertFalse(self.service.root.exists())
                self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)

    def test_duplicate_verdict_keys_in_both_orders_are_terminal(self):
        steps=json.loads(visual_report())['steps']
        suffix=',"steps":'+json.dumps(steps)+'}'
        invalid=['{"ok":false,"ok":true,"issues":[]'+suffix,
                 '{"ok":true,"ok":false,"issues":[]'+suffix,
                 '{"ok":true,"issues":["quality"],"issues":[]'+suffix,
                 '{"ok":true,"issues":[],"issues":["quality"]'+suffix,
                 '{"ok":true,"issues":[],"steps":[{"step":1,"start_matches_plan":false,"start_matches_plan":true,"change_explains_relation":true,"issues":[]}]}']
        for reply in invalid:
            for prefix in ([],['']):
                with self.subTest(reply=reply,prefix=bool(prefix)):
                    self.assert_terminal_review(reply,prefix)

    def test_nonstandard_json_constants_in_any_field_are_terminal(self):
        for constant in ('NaN','Infinity','-Infinity'):
            for reply in ('{"ok":'+constant+',"issues":[]}',
                          '{"ok":true,"issues":[],"extra":'+constant+'}',
                          '{"ok":true,"issues":[],"extra":{"values":['+constant+']}}'):
                for prefix in ([],['']):
                    with self.subTest(reply=reply,prefix=bool(prefix)):
                        self.assert_terminal_review(reply,prefix)

    def run_timed_quality_repair(self, final_review_seconds):
        from unittest.mock import patch
        from types import SimpleNamespace
        import time
        clock=[0.0]
        fake=SimpleNamespace(monotonic=lambda:clock[0],time=time.time)
        model=self.service.model.json
        planner=self.service.planner_model.json
        renderer=self.renderer.render
        durations=iter((16,113,10,final_review_seconds))
        render_times=iter((15,19))
        self.timed_reviews=[]
        generation_count=[0]
        def plan(*args,**kwargs):clock[0]+=25;return planner(*args,**kwargs)
        def respond(messages,**kwargs):
            from job_execution import remaining_timeout
            review=isinstance(messages[1]['content'],list)
            if review:self.timed_reviews.append(remaining_timeout(1000))
            clock[0]+=next(durations)
            if review:return visual_report(ok=False,issues=['quality']) if len(self.timed_reviews)==1 else visual_report()
            generation_count[0]+=1
            value=model(messages,**kwargs)
            return corrected_plan_json(value) if generation_count[0]>1 else value
        def render(*args,**kwargs):clock[0]+=next(render_times);return renderer(*args,**kwargs)
        with patch('job_execution.time',fake),patch('manim_service.time',fake), \
             patch.object(self.service.planner_model,'json',side_effect=plan), \
             patch.object(self.service.model,'json',side_effect=respond) as generation, \
             patch.object(self.renderer,'render',side_effect=render) as rendering:
            self.timed_generation=generation
            self.timed_rendering=rendering
            return self.generate(),clock[0]

    def test_standalone_quality_repair_can_finish_after_300_before_600(self):
        result,elapsed=self.run_timed_quality_repair(115)
        self.assertEqual(elapsed,313)
        self.assertTrue(result['asset_id'])
        self.assertEqual(self.timed_generation.call_count,4)
        self.assertEqual(self.timed_rendering.call_count,2)
        self.assertEqual(self.timed_reviews,[544,402])
        self.assertTrue((self.service.root/'u1'/result['asset_id']/'video.mp4').exists())

    def test_600_deadline_and_late_positive_never_publish(self):
        from job_execution import JobDeadlineExceeded
        for duration in (402,410):
            self.setUp()
            original=json.dumps(self.repo.doc,sort_keys=True)
            with self.subTest(duration=duration),self.assertRaises(JobDeadlineExceeded):
                self.run_timed_quality_repair(duration)
            self.assertEqual(self.timed_generation.call_count,4)
            self.assertEqual(self.timed_rendering.call_count,2)
            self.assertFalse(self.service.root.exists())
            self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)


class RejectedEvidenceTests(unittest.TestCase):
    setUp=ManimServiceTests.setUp
    generate=ManimServiceTests.generate

    def envelope(self):
        return json.loads(Model().json([{}, {'content':'generation'}]))

    def corrected_plan(self, envelope):
        result=json.loads(json.dumps(envelope))
        result['teaching_plan']['steps'][0]['why']='比较变化前后的夹角，纠正原先过度承诺的观察任务'
        return result

    def invoke(self, envelopes, verdicts, renders=None):
        from unittest.mock import patch
        generations=iter(envelopes);reviews=iter(verdicts)
        def respond(messages,**kwargs):
            return next(reviews) if isinstance(messages[1]['content'],list) else json.dumps(next(generations),ensure_ascii=False)
        with patch.object(self.service.model,'json',side_effect=respond) as model, \
             patch.object(self.renderer,'render',side_effect=renders or self.renderer.render) as renderer:
            self.model=model;self.render=renderer
            return self.generate()

    def test_rejected_identical_evidence_never_consumes_queued_pass(self):
        for verdict in (visual_report(ok=False,issues=['quality']), visual_report(issues=['quality']), visual_report(ok=False)):
            for change in ('metadata','code_whitespace','dictionary_order'):
                self.setUp()
                first=self.envelope();second=json.loads(json.dumps(first))
                if change=='metadata':second.update(reason='新的原因',title='新的标题',summary='新的摘要')
                elif change=='code_whitespace':second['code']+='\n'
                else:
                    second={k:second[k] for k in reversed(second)}
                    second['teaching_plan']={k:v for k,v in reversed(list(second['teaching_plan'].items()))}
                original=json.dumps(self.repo.doc,sort_keys=True)
                with self.subTest(verdict=verdict,change=change),self.assertRaises(ManimGenerationError) as raised:
                    self.invoke([first,second],[verdict,visual_report()])
                self.assertEqual(raised.exception.failure_code,'visual_rejected')
                self.assertEqual(self.model.call_count,3)
                self.assertEqual(self.render.call_count,2)
                self.assertFalse(self.service.root.exists())
                self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)

    def test_same_code_corrected_plan_or_changed_images_or_manifest_can_be_reviewed(self):
        for change in ('plan','image','manifest','frame_order'):
            self.setUp();first=self.envelope();second=json.loads(json.dumps(first))
            a=self.renderer.render('ignored');b=self.renderer.render('ignored')
            if change=='plan':second=self.corrected_plan(first)
            elif change=='image':b['review_frames'][0]['result']=png(shade=120)
            elif change=='manifest':b['manifest']['steps'][0]['result_frame']=60
            else:
                a['review_frames'][0]['start']=png(shade=120)
                b['review_frames'][0]['result']=png(shade=120)
            with self.subTest(change=change):
                result=self.invoke([first,second],[visual_report(ok=False,issues=['quality']),visual_report()],[a,b])
                self.assertTrue(result['asset_id'])
                self.assertEqual(self.model.call_count,4)
                self.assertEqual(self.render.call_count,2)

    def test_teaching_repair_has_exact_rejected_snapshot_and_bounded_feedback(self):
        first=self.envelope();second=self.corrected_plan(first)
        issue='PRIVATE_feedback_'*80
        self.invoke([first,second],[visual_report(ok=False,issues=[issue]),visual_report()])
        messages=self.model.call_args_list[2].args[0]
        self.assertEqual([m['role'] for m in messages],['system','user','assistant','user'])
        self.assertEqual(json.loads(messages[2]['content']),first)
        context=json.loads(messages[1]['content']);repair=json.loads(messages[3]['content'])
        self.assertEqual(context['study_notes'],'候选新正文')
        self.assertEqual(context['node'],self.repo.doc['plan']['nodes'][0])
        self.assertEqual(context['focus'],first['teaching_plan']['objective'])
        self.assertEqual(repair['focus'],context['focus'])
        self.assertLessEqual(len(repair['repair']),800)
        self.assertIn('整体',repair['repair'])
        self.assertIn(issue[:100],repair['repair'])
        self.assertNotIn('previous_code',context)
        self.assertNotIn('repair',context)

    def test_teaching_then_technical_uses_new_failure_not_stale_snapshot(self):
        first=self.envelope();bad=self.corrected_plan(first)
        bad['code']='class LessonScene(TeachingScene):\n def construct(self):\n  line=Line(LEFT,RIGHT,thickness=6)'
        fixed=self.corrected_plan(first)
        self.invoke([first,bad,fixed],[visual_report(ok=False,issues=['PRIVATE_teaching']),visual_report()])
        teaching=self.model.call_args_list[2].args[0];technical=self.model.call_args_list[3].args[0]
        self.assertEqual(json.loads(teaching[2]['content']),first)
        self.assertEqual(len(teaching),4)
        self.assertEqual(len(technical),2)
        payload=json.loads(technical[1]['content'])
        self.assertEqual(payload['previous_code'],bad['code'])
        self.assertEqual(payload['previous_teaching_plan'],bad['teaching_plan'])
        self.assertIn('stroke_width',payload['repair'])
        self.assertNotIn('PRIVATE_teaching',payload['repair'])

    def test_technical_then_teaching_uses_immediately_rejected_candidate(self):
        first=self.envelope();second=self.envelope();second['title']='技术修正后的候选'
        third=self.corrected_plan(second)
        rendered=self.renderer.render('ignored')
        self.invoke([first,second,third],[visual_report(ok=False,issues=['new teaching feedback']),visual_report()],
                    [ManimContractError('PRIVATE_technical'),rendered,rendered])
        technical=self.model.call_args_list[1].args[0];teaching=self.model.call_args_list[3].args[0]
        self.assertEqual(len(technical),2)
        self.assertEqual(len(teaching),4)
        self.assertEqual(json.loads(teaching[2]['content']),second)
        feedback=json.loads(teaching[3]['content'])['repair']
        self.assertIn('new teaching feedback',feedback)
        self.assertNotIn('PRIVATE_technical',feedback)


class StepReviewTests(unittest.TestCase):
    setUp=ManimServiceTests.setUp
    generate=ManimServiceTests.generate

    def report(self,count):
        return {'ok':True,'issues':[],'steps':[{'step':i+1,'start_matches_plan':True,
                'change_explains_relation':True,'issues':[]} for i in range(count)]}

    def invoke(self,report,count):
        from unittest.mock import patch
        envelope=json.loads(Model().json([{}, {'content':'generation'}]))
        envelope['teaching_plan']['steps']=[dict(envelope['teaching_plan']['steps'][0]) for _ in range(count)]
        rendered=self.renderer.render('ignored')
        rendered['manifest']['steps']=[{} for _ in range(count)]
        rendered['review_frames']=[dict(start=png(),middle=png(),result=png()) for _ in range(count)]
        with patch.object(self.service.model,'json',side_effect=[json.dumps(envelope),json.dumps(report),
                         json.dumps(envelope),json.dumps(self.report(count))]) as model, \
             patch.object(self.renderer,'render',return_value=rendered) as renderer:
            self.model=model;self.render=renderer
            return self.generate()

    def test_overall_true_cannot_override_step_failure_or_step_issues(self):
        for field in ('start_matches_plan','change_explains_relation','issues'):
            self.setUp();report=self.report(3)
            report['steps'][0 if field=='start_matches_plan' else 2][field]=['定位问题'] if field=='issues' else False
            with self.subTest(field=field),self.assertRaises(ManimGenerationError) as raised:
                self.invoke(report,3)
            self.assertEqual(raised.exception.failure_code,'visual_rejected')
            self.assertEqual(self.model.call_count,3) # identical evidence never gets a second verdict
            self.assertFalse(self.service.root.exists())
            feedback=json.loads(self.model.call_args_list[2].args[0][-1]['content'])['repair']
            self.assertIn('步骤1' if field=='start_matches_plan' else '步骤3',feedback)
            self.assertIn(field,feedback)

    def test_root_false_and_empty_issues_retains_fixed_localization(self):
        report=self.report(1);report['ok']=False
        with self.assertRaises(ManimGenerationError) as raised:self.invoke(report,1)
        self.assertEqual(raised.exception.failure_code,'visual_rejected')
        feedback=json.loads(self.model.call_args_list[2].args[0][-1]['content'])['repair']
        self.assertIn('整体',feedback)
        self.assertIn('ok=false',feedback)
        self.assertFalse(self.service.root.exists())

    def test_all_failed_step_locations_precede_long_issues_under_800_limit(self):
        report=self.report(8);report['ok']=False
        for step in report['steps']:
            step['start_matches_plan']=False;step['change_explains_relation']=False
            step['issues']=['PRIVATE_detail_'*100]
        with self.assertRaises(ManimGenerationError):self.invoke(report,8)
        feedback=json.loads(self.model.call_args_list[2].args[0][-1]['content'])['repair']
        self.assertLessEqual(len(feedback),800)
        self.assertIn('整体',feedback)
        for i in range(1,9):
            self.assertIn('步骤%d'%i,feedback)
            self.assertLess(feedback.index('步骤%d'%i),feedback.index('PRIVATE_detail'))
        self.assertIn('start_matches_plan',feedback)
        self.assertIn('change_explains_relation',feedback)

    def test_entire_step_structure_is_validated_before_any_quality_repair(self):
        base=self.report(2);invalid=[]
        for field in ('ok','issues','steps'):
            value=json.loads(json.dumps(base));value.pop(field);invalid.append(value)
        for field in ('step','start_matches_plan','change_explains_relation','issues'):
            value=json.loads(json.dumps(base));value['steps'][1].pop(field);value['steps'][0]['start_matches_plan']=False;invalid.append(value)
        for path,bad in [('root_extra',1),('steps',None),('steps',{}),('steps',[]),
                         ('ok',1),('issues','bad'),('issues',['']),('issues',[None]),
                         ('step',True),('step',1.0),('step',0),('step',3),
                         ('start_matches_plan',1),('change_explains_relation',None),
                         ('step_issues','bad'),('step_issues',[' ']),('step_issues',[False]),('step_extra',1)]:
            value=json.loads(json.dumps(base))
            if path=='root_extra':value['extra']=bad
            elif path in ('steps','ok','issues'):value[path]=bad
            elif path=='step_extra':value['steps'][0]['extra']=bad
            else:value['steps'][0]['issues' if path=='step_issues' else path]=bad
            invalid.append(value)
        invalid += [dict(base,steps=base['steps'][:1]),dict(base,steps=base['steps']+[dict(base['steps'][0])]),
                    dict(base,steps=list(reversed(base['steps']))),dict(base,steps=[base['steps'][0],base['steps'][0]])]
        for report in invalid:
            self.setUp()
            with self.subTest(report=report),self.assertRaises(ManimGenerationError) as raised:self.invoke(report,2)
            self.assertEqual(raised.exception.failure_code,'visual_invalid')
            self.assertEqual(self.model.call_count,2)
            self.assertEqual(self.render.call_count,1)
            self.assertFalse(self.service.root.exists())

    def test_complete_all_true_report_publishes(self):
        result=self.invoke(self.report(3),3)
        self.assertTrue(result['asset_id'])
        self.assertEqual(self.model.call_count,2)


def spec_envelope(change='旋转一条边，使夹角变大'):
    return {
        'needed': True, 'reason': '展示变化', 'title': '角的变化', 'summary': '观察角旋转后两边的关系',
        'teaching_plan': {
            'objective': '理解角度表示两条边的张开程度',
            'visual_reason': '旋转一条边能表现角的大小变化',
            'observe': '一边转动时两边张开的程度如何变化',
            'steps': [{'change': change, 'why': '角的大小取决于两条边的相对方向'}],
        },
        'scene': {
            'version': 1, 'kind': 'spec',
            'initial': [{'id': 'edge', 'type': 'line', 'start': [0, 0], 'end': [3, 0]}],
            'steps': [{'caption': change, 'actions': [
                {'op': 'rotate', 'target': 'edge', 'angle_deg': 45, 'about': [0, 0], 'run_time': 1.5}]}],
        },
    }


class SpecModel:
    def __init__(self, *envelopes):
        self.envelopes = list(envelopes)
        self.calls = 0
        self.messages = []

    def json(self, messages, **kwargs):
        self.messages.append(messages)
        if isinstance(messages[1]['content'], list):
            context = json.loads(messages[1]['content'][0]['text'])
            return visual_report(count=len(context['teaching_plan']['steps']))
        self.calls += 1
        return json.dumps(self.envelopes.pop(0))


class SpecRenderer(Renderer):
    def __init__(self, path, steps=1):
        super().__init__(path)
        self.steps = steps

    def render(self, source, *, check_cancelled=None):
        value = super().render(source, check_cancelled=check_cancelled)
        value['manifest'] = {'steps': [{}] * self.steps, 'engine': {'name': 'ManimGX', 'version': '0.1.1'}}
        value['frames'] = [b'image'] * self.steps
        value['review_frames'] = [dict(start=png(), middle=png(), result=png()) for _ in range(self.steps)]
        return value


class ManimgxServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.repo=Repository(); self.renderer=SpecRenderer(self.temp.name)
        def authorize(actor,key):
            if actor != key.split('/')[0]: raise JobError(403,'denied')
        self.authorize=authorize
        self.envelope=spec_envelope()
        self.model=SpecModel(self.envelope)
        self.service=ManimService(self.repo,self.model,self.renderer,authorize,planner_model=Planner(),engine='manimgx')

    def generate(self): return self.service.generate('u1/learn-path-v1-a','n1','候选新正文',{'id':'n1'},actor='u1')

    def test_spec_scene_is_normalized_and_published_as_manimgx(self):
        from unittest.mock import patch
        from animation_contracts import validate_scene
        with patch.object(self.renderer,'render',wraps=self.renderer.render) as renderer:
            spec=self.generate()
        self.assertEqual(renderer.call_count,1)
        self.assertEqual(renderer.call_args.args[0],validate_scene(self.envelope['scene']))
        directory=next((Path(self.temp.name)/'manim-assets'/'u1').iterdir())
        metadata=json.loads((directory/'metadata.json').read_text())
        self.assertEqual(metadata['engine'],{'name':'ManimGX','version':'0.1.1'})
        self.assertIn('spec_sha256',metadata);self.assertNotIn('code_sha256',metadata)
        self.assertTrue((directory/'scene-spec.json').exists());self.assertFalse((directory/'scene.py').exists())
        self.assertEqual(json.loads((directory/'manifest').read_text())['engine'],
                         {'name':'ManimGX','version':'0.1.1'})
        self.assertEqual(spec['title'],'角的变化')

    def test_caption_must_match_plan_change_and_repair_sees_previous_scene(self):
        from unittest.mock import patch
        bad=spec_envelope();bad['scene']['steps'][0]['caption']='只写关键词'
        self.model.envelopes=[bad,bad]
        with patch.object(self.renderer,'render') as renderer:
            with self.assertRaises(ManimGenerationError) as raised:self.generate()
        self.assertEqual(raised.exception.failure_code,'spec_invalid')
        renderer.assert_not_called();self.assertEqual(self.model.calls,2)
        payload=json.loads(self.model.messages[1][1]['content'])
        self.assertEqual(payload['repair'],'每步caption必须与该步教学计划的change逐字完全一致，不得改写或缩写')
        self.assertIn('只写关键词',payload['previous_scene'])
        self.assertEqual(payload['focus'],'理解角度表示两条边的张开程度')

    def test_compiled_vector_recipe_passes_scene_and_skips_generation_model(self):
        from unittest.mock import patch
        relation=dict(needed=True,reason='单一关系',objective='理解角度表示两条边的张开程度',
                      recipe='vector_rotation',parameters={'vector':[2,1],'angle_deg':90})
        planner=type('P',(),{'json':staticmethod(lambda *args,**kwargs: json.dumps(relation))})()
        self.renderer.steps=3
        self.model.envelopes=[]
        self.service=ManimService(self.repo,self.model,self.renderer,self.authorize,planner_model=planner,engine='manimgx')
        with patch.object(self.renderer,'render',wraps=self.renderer.render) as renderer:
            self.generate()
        source=renderer.call_args.args[0]
        self.assertEqual(source['kind'],'recipe');self.assertEqual(source['recipe'],'vector_rotation')
        self.assertEqual(len(source['steps']),3)
        self.assertEqual(self.model.calls,0)

    def test_manimgx_rejects_bad_engine_and_vector_bounds(self):
        with self.assertRaises(ValueError):
            ManimService(self.repo,self.model,self.renderer,self.authorize,engine='svg')
        value=dict(needed=True,reason='单一关系',objective='理解向量旋转',
                   recipe='vector_rotation',parameters={'vector':[2,1],'angle_deg':90})
        self.assertEqual(validate_relation(value,True,'manimgx'),value)
        with self.assertRaises(ManimContractError):
            validate_relation(value,True,'manimgl')
        for parameters in ({'vector':[2,1],'angle_deg':45},{'vector':[2,2],'angle_deg':90},
                           {'vector':[0,0],'angle_deg':90},{'vector':[True,1],'angle_deg':90}):
            with self.subTest(parameters=parameters),self.assertRaises(ManimContractError):
                validate_relation(dict(value,parameters=parameters),True,'manimgx')

    def test_generation_prompt_example_is_a_valid_closed_scene(self):
        examples=[json.loads(line) for line in PROMPT_MANIMGX.splitlines() if line.startswith('{"needed":')]
        self.assertEqual(len(examples),1)
        example=examples[0]
        value=validate_scene(example['scene'])
        self.assertEqual(value['kind'],'spec')
        self.assertEqual([step['caption'] for step in value['steps']],
                         [step['change'] for step in example['teaching_plan']['steps']])
