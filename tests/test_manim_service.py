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
from manim_service import METADATA_LIMITS, PROMPT, ManimService
from manim_contracts import ManimContractError
from manim_renderer import ManimUnavailable

class Repository:
    def __init__(self):
        self.lock=threading.RLock()
        self.store=self
        self.doc={'plan':{'nodes':[{'id':'n1','title':'角'}]}}
    def transaction(self): return contextlib.nullcontext()
    def material(self,key): return self.doc

class Model:
    def json(self,messages,**kwargs):
        if isinstance(messages[1]['content'],list): return json.dumps({'ok':True,'issues':[]})
        return json.dumps({'needed':True,'reason':'展示变化','title':'角的变化','summary':'分步观察','code':'class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("观察")'})

class Renderer:
    def __init__(self,path): self.state_dir=path; self.hook=lambda:None
    def render(self,source):
        self.hook()
        return {'video':b'video','poster':b'poster','frames':[b'image'],'manifest':{'steps':[{}]}}

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
