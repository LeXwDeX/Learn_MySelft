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
from manim_service import METADATA_LIMITS, PROMPT, TEACHING_REFERENCE_CODE, TEACHING_REFERENCE_ENVELOPE, SWAP_REFERENCE_ENVELOPE, validate_relation, compile_relation, ManimService, ManimGenerationError
from manim_contracts import ManimContractError, validate_source, validate_teaching_plan
from manim_renderer import ManimUnavailable
from prompts import MATH_VISUAL_TEACHING

def png(width=240,height=135):
    import struct,zlib
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\xff\xff'*width)*height))+chunk(b'IEND',b'')

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
        if isinstance(messages[1]['content'],list): return json.dumps({'ok':True,'issues':[]})
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
        self.service=ManimService(self.repo,Model(),self.renderer,authorize,planner_model=Planner())
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
                                                                '{"ok":true,"issues":[]}']) as model, \
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
        rejected = '{"ok":false,"issues":["坐标标签在手机复核图上重叠"]}'
        with patch.object(self.service.model, 'json', side_effect=[code, rejected, code, rejected]) as model, \
             patch.object(self.renderer, 'render', return_value=rendered):
            with self.assertRaises(ManimGenerationError) as raised:
                self.generate()
        self.assertEqual(raised.exception.failure_code, 'visual_rejected')
        self.assertEqual(model.call_count, 4)
        self.assertFalse(self.service.root.exists())

    def test_generation_repair_and_review_use_separate_request_budgets(self):
        from unittest.mock import patch
        good = self.service.model.json([{}, {'content': 'generation'}])
        rejected = '{"ok":false,"issues":["对象重叠"]}'
        passed = '{"ok":true,"issues":[]}'
        with patch.object(self.service.model, 'json', side_effect=[good, rejected, good, passed]) as model:
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
        with patch.object(self.service.model, 'json', side_effect=[json.dumps(bad), json.dumps(good), '{"ok":true,"issues":[]}']) as model, \
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

    def test_invalid_fade_shift_repairs_before_container_with_previous_code(self):
        from unittest.mock import patch
        good=self.service.model.json([{}, {'content':'generation'}])
        bad=json.loads(good)
        bad['code']='class LessonScene(TeachingScene):\n def construct(self):\n  self.play(FadeIn(self.label("观察"),shift=(0,1,0)))'
        with patch.object(self.service.model,'json',side_effect=[json.dumps(bad),good,'{"ok":true,"issues":[]}']) as model, \
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
        with patch.object(self.service.model,'json',side_effect=[json.dumps(bad),good,'{"ok":true,"issues":[]}']) as model, \
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
        self.assertIn('"ok":',review[0]['content'])
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
        bad_review=json.dumps({'ok':False,'issues':['主要方程在240×135图中看不清，标题独占一步且结论重复']})
        with patch.object(self.service.model,'json',side_effect=[good,bad_review,good,bad_review]) as model,patch.object(self.renderer,'render',wraps=self.renderer.render) as render:
            with self.assertRaises(JobError) as raised:self.generate()
            self.assertEqual(raised.exception.status,502)
            self.assertEqual(render.call_count,2)
            self.assertEqual(model.call_count,4)
            repair=json.loads(model.call_args_list[2].args[0][1]['content'])
            self.assertIn('240×135',repair['repair'])
            self.assertIn('class LessonScene',repair['previous_code'])
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
        bad=json.dumps({'ok':False,'issues':['PRIVATE_FEEDBACK_TOKEN_URL']})
        with patch.object(self.service.model,'json',side_effect=[good,bad,good,bad]), \
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
        rejected = '{"ok":false,"issues":["原位置对照缺失"]}'
        passed = '{"ok":true,"issues":[]}'
        sequences = [(invalid, good, rejected, good, passed),
                     (good, rejected, invalid, good, passed)]
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
        rejected = '{"ok":false,"issues":["对象重叠"]}'
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
                                                                '{"ok":true,"issues":[]}']) as model, \
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
                 patch.object(self.service.model, 'json', side_effect=[good, '{"ok":false,"issues":["对照缺失"]}',
                                                                     json.dumps(invalid), good,
                                                                     '{"ok":true,"issues":[]}']) as model:
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
                 patch.object(self.service.model, 'json', side_effect=[json.dumps(invalid), good,
                                                                     '{"ok":true,"issues":[]}']) as model:
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
        self.assertTrue(299<limits[0]<=300)
        self.assertTrue(0<limits[1]<=.1)
        self.assertFalse(budget_active())

    def test_planner_default_uses_same_model_and_small_per_request_limit(self):
        from unittest.mock import patch
        self.service.planner_model=self.service.model
        self.service.generation_token_limit=512
        good=self.service.model.json([{}, {'content':'generation'}])
        with patch.object(self.service.model,'json',side_effect=[json.dumps(self.relation()),good,'{"ok":true,"issues":[]}']) as model:
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
        replies=[json.dumps(self.relation()),good,'{"ok":true,"issues":[]}']
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
        replies=[json.dumps(self.relation()),good,'{"ok":true,"issues":[]}']
        responses=[json.dumps({'choices':[{'message':{'content':text}}]}).encode() for text in replies]
        with patch.object(model_transport,'post',side_effect=responses) as transport:
            self.generate()
        bodies=[json.loads(call.args[1]) for call in transport.call_args_list]
        self.assertEqual([body['max_tokens'] for body in bodies],[2048,16384,8192])
        self.assertEqual([body['reasoning_effort'] for body in bodies],['none','none','low'])
        self.assertEqual([body['response_format'] for body in bodies],[{'type':'json_object'}]*3)

    def test_known_teaching_failure_native_repair_can_succeed(self):
        from unittest.mock import patch
        value=self.relation('shear_basis',{'k':1.5});expected=compile_relation(value)
        native=json.loads(json.dumps(expected))
        native['code']='class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("第一步")\n  self.next_step("第二步")'
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)),patch.object(self.service.model,'json',side_effect=['{"ok":false,"issues":["运动歧义"]}',json.dumps(native),'{"ok":true,"issues":[]}']) as model,patch.object(self.renderer,'render',return_value=self.two_step_render()) as renderer:
            self.generate()
        self.assertEqual(renderer.call_count,2)
        self.assertEqual(renderer.call_args.args[0],native['code'])
        payload=json.loads(model.call_args_list[1].args[0][1]['content'])
        self.assertEqual(payload['focus'],expected['teaching_plan']['objective'])
        self.assertEqual(payload['previous_teaching_plan'],expected['teaching_plan'])

    def test_known_repeated_technical_failure_stops_after_second_candidate(self):
        from unittest.mock import patch
        value=self.relation('shear_basis',{'k':1});expected=compile_relation(value)
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
        shear=compile_relation(validate_relation(self.relation('shear_basis',{'k':1.001}),True))
        plan=shear['teaching_plan']
        self.assertIn('A=[[1,1.001],[0,1]]',plan['objective'])
        self.assertIn('e2=(0,1)变为(1.001,1)',plan['objective'])
        self.assertNotIn('(1,1)',json.dumps(plan,ensure_ascii=False))
        call=next(n for n in ast.walk(ast.parse(shear['code'])) if isinstance(n,ast.Call))
        self.assertEqual(ast.literal_eval(call.keywords[0].value),1.001)
        swap=compile_relation(validate_relation(self.relation('swap_components',{'values':[-9,9,-9]}),True))
        call=next(n for n in ast.walk(ast.parse(swap['code'])) if isinstance(n,ast.Call))
        self.assertEqual(ast.literal_eval(call.keywords[0].value),(-9,9,-9))
        self.assertIn('使(-9,9,-9)变为(9,-9,-9)',swap['teaching_plan']['objective'])
        self.assertIn('第三分量-9',swap['teaching_plan']['observe'])
        self.assertIn('建立(-9,9,-9)',swap['teaching_plan']['steps'][0]['change'])
        self.assertIn('显示(9,-9,-9)',swap['teaching_plan']['steps'][1]['change'])

    def test_known_parameters_compile_code_and_plan_then_review_only(self):
        from unittest.mock import patch
        for value in [self.relation('shear_basis',{'k':1.001}),self.relation('swap_components',{'values':[-9,9,-9]})]:
            expected=compile_relation(validate_relation(value,True))
            with self.subTest(recipe=value['recipe']),patch.object(self.service.planner_model,'json',return_value=json.dumps(value)),patch.object(self.service.model,'json',return_value='{"ok":true,"issues":[]}') as model,patch.object(self.renderer,'render',return_value=self.two_step_render()) as renderer:
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
        value=self.relation('shear_basis',{'k':0.5});expected=compile_relation(value)
        rejected='{"ok":false,"issues":["动作不清楚"]}'
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)) as planner,patch.object(self.service.model,'json',side_effect=[rejected,json.dumps(expected),rejected]) as model,patch.object(self.renderer,'render',return_value=self.two_step_render()) as renderer:
            with self.assertRaises(ManimGenerationError):self.generate()
        self.assertEqual(planner.call_count,1);self.assertEqual(renderer.call_count,2);self.assertEqual(model.call_count,3)
        payload=json.loads(model.call_args_list[1].args[0][1]['content'])
        self.assertEqual(payload['focus'],expected['teaching_plan']['objective'])
        self.assertEqual(payload['previous_code'],expected['code'])
        self.assertEqual(payload['previous_teaching_plan'],expected['teaching_plan'])
        self.assertFalse(self.service.root.exists())

    def test_known_technical_then_teaching_failure_allows_only_third_candidate(self):
        from unittest.mock import patch
        value=self.relation('swap_components',{'values':[3,-1,4]});expected=compile_relation(value)
        rendered=self.two_step_render()
        with patch.object(self.service.planner_model,'json',return_value=json.dumps(value)) as planner,patch.object(self.renderer,'render',side_effect=[ManimContractError('render failed'),rendered,rendered]) as renderer,patch.object(self.service.model,'json',side_effect=[json.dumps(expected),'{"ok":false,"issues":["重叠"]}',json.dumps(expected),'{"ok":true,"issues":[]}']) as model:
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
            return base_model(messages, **kwargs)
        with patch.object(self.service.model, 'json', side_effect=respond), \
             patch.object(self.renderer, 'render', side_effect=renders or self.renderer.render) as render:
            self.render = render
            return self.service.generate('u1/learn-path-v1-a','n1','候选新正文',{'id':'n1'},actor='u1',cancelled=cancelled)

    def reviews(self):
        return [call for call in self.calls if isinstance(call[0][1]['content'], list)]

    def test_empty_then_pass_reuses_exact_request_and_render(self):
        result = self.run_reviews(['', '{"ok":true,"issues":[]}'])
        self.assertTrue(result['asset_id'])
        self.assertEqual(self.generated, 1)
        self.assertEqual(self.render.call_count, 1)
        reviews = self.reviews()
        self.assertEqual(len(reviews), 2)
        self.assertIs(reviews[0][0], reviews[1][0])
        self.assertEqual(reviews[0][1], reviews[1][1])
        self.assertEqual(reviews[0][1], dict(temperature=0,max_tokens=8192,reasoning_effort='low',response_format='json_object'))

    def test_all_invalid_shapes_stop_without_repair_or_publication(self):
        self.repo.doc['nodeDetail']={'n1':{'study_notes':'原正文','quiz':{'questions':[{'id':'old'}]}}}
        self.repo.doc['nodeState']={'n1':{'completed':True,'score':83}}
        original=json.dumps(self.repo.doc,sort_keys=True)
        invalid=['', '{"ok":false,"issues":[', 'prefix {"ok":true,"issues":[]}',
                 '{"ok":true,"issues":[]} trailing', '{"ok":true}', '{"ok":1,"issues":[]}',
                 '{"ok":false,"issues":[]}', '{"ok":true,"issues":["problem"]}',
                 '{"ok":false,"issues":["problem",null]}', '{"ok":false,"issues":[" "]}',
                 '{"ok":false,"issues":["problem",""]}']
        for reply in invalid:
            with self.subTest(reply=reply), self.assertRaises(ManimGenerationError) as raised:
                self.run_reviews([reply,reply])
            self.assertEqual(raised.exception.failure_code,'visual_invalid')
            self.assertEqual(self.generated,1)
            self.assertEqual(self.render.call_count,1)
            self.assertEqual(len(self.reviews()),2)
            self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)
            self.assertFalse(self.service.root.exists())

    def test_empty_then_quality_rejection_repairs_new_candidate_and_all_gates(self):
        self.run_reviews(['','{"ok":false,"issues":["PRIVATE_actual_feedback"]}','{"ok":true,"issues":[]}'])
        self.assertEqual(self.generated,2)
        self.assertEqual(self.render.call_count,2)
        self.assertEqual(len(self.reviews()),3)
        payload=json.loads([c[0][1]['content'] for c in self.calls if isinstance(c[0][1]['content'],str)][1])
        self.assertIn('PRIVATE_actual_feedback',payload['repair'])
        self.assertTrue(payload['previous_code'])
        self.assertTrue(payload['previous_teaching_plan'])
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
            self.run_reviews(['{"ok":false,"issues":["quality"]}','',''],
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
        def second(): remaining.append(remaining_timeout(1000));clock[0]+=4;return '{"ok":true,"issues":[]}'
        with patch('job_execution.time.monotonic',side_effect=lambda:clock[0]),execution_budget(10):
            self.run_reviews([first,second])
        self.assertEqual(remaining,[10,6])
        self.assertEqual(self.generated,1)

    def test_safe_review_diagnostics_and_observer_failure_do_not_change_result(self):
        from unittest.mock import patch
        self.repo.job_event=lambda *args,**kwargs: (_ for _ in ()).throw(RuntimeError('PRIVATE_observer'))
        with self.assertLogs('manim_service',level='INFO') as logs:
            self.run_reviews(['PRIVATE_empty','{"ok":true,"issues":[]}'])
        rows=[json.loads(r.getMessage().split(' ',1)[1]) for r in logs.records]
        reviews=[r for r in rows if r['stage']=='visual_review']
        self.assertEqual([r['review_attempt'] for r in reviews],[1,2])
        self.assertEqual([r['failure_code'] for r in reviews],['visual_invalid','passed'])
        self.assertTrue(all(0<r['remaining_budget_ms']<=300000 for r in reviews))
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
                   for v in (good,'','{"ok":true,"issues":[]}')]
        with patch.object(model_transport,'post',side_effect=responses) as transport, \
             patch.object(self.renderer,'render',wraps=self.renderer.render) as renderer:
            self.generate()
        bodies=[json.loads(call.args[1]) for call in transport.call_args_list]
        self.assertEqual(len(bodies),3)
        self.assertEqual(renderer.call_count,1)
        self.assertEqual(bodies[1],bodies[2])
        self.assertEqual(bodies[1]['max_tokens'],8192)

    def test_quality_repair_rechecks_source_before_rendering_new_candidate(self):
        from unittest.mock import patch
        good=self.service.model.json([{}, {'content':'generation'}])
        invalid=json.loads(good)
        invalid['code']='class LessonScene(TeachingScene):\n def construct(self):\n  line=Line(LEFT,RIGHT,thickness=6)'
        with patch.object(self.service.model,'json',side_effect=[good,'{"ok":false,"issues":["quality"]}',json.dumps(invalid),good,'{"ok":true,"issues":[]}']) as model, \
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
        def second(): remaining.append(remaining_timeout(1000));clock[0]+=7;return '{"ok":true,"issues":[]}'
        original=json.dumps(self.repo.doc,sort_keys=True)
        with patch('job_execution.time.monotonic',side_effect=lambda:clock[0]),execution_budget(10):
            with self.assertRaises(JobDeadlineExceeded):self.run_reviews([first,second])
        self.assertEqual(remaining,[10,6])
        self.assertEqual(self.generated,1)
        self.assertEqual(self.render.call_count,1)
        self.assertFalse(self.service.root.exists())
        self.assertEqual(json.dumps(self.repo.doc,sort_keys=True),original)
