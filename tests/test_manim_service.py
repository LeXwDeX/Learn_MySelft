import contextlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.error
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from background_jobs import JobError
from manim_service import METADATA_LIMITS, PROMPT, ManimService, ManimGenerationError
from manim_contracts import ManimContractError
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

class Renderer:
    def __init__(self,path): self.state_dir=path; self.hook=lambda:None
    def render(self,source):
        self.hook()
        return {'video':b'video','poster':b'poster','frames':[b'image'],'review_frames':[dict(start=png(),middle=png(),result=png())],'manifest':{'steps':[{}]}}

class ManimServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.repo=Repository(); self.renderer=Renderer(self.temp.name)
        def authorize(actor,key):
            if actor != key.split('/')[0]: raise JobError(403,'denied')
        self.service=ManimService(self.repo,Model(),self.renderer,authorize)
    def generate(self): return self.service.generate('u1/learn-path-v1-a','n1','候选新正文',{'id':'n1'},actor='u1')
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
        decision=dict(needed=False,reason='术语定义用表格更清楚',title='',summary='',teaching_plan=None,code='')
        with patch.object(self.service.model,'json',return_value=json.dumps(decision)) as model,patch.object(self.renderer,'render') as render:
            self.assertIsNone(self.service.generate('u1/learn-path-v1-a','n1','正文',{},requested=False,actor='u1'))
            self.assertEqual(model.call_count,1)
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
        for row in rows:self.assertEqual(set(row),{'job_id','attempt','stage','failure_code','elapsed_ms','exception'})

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
