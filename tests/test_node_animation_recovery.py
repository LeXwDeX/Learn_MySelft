"""Only checked lessons survive optional animation failures; control failures do not."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from application import create_application
from background_jobs import JobError
from manim_service import ManimGenerationError
from manim_contracts import references_in
import quiz_harness as harness
from test_quiz_harness import questions


class NodeAnimationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.app=create_application({'STATE_DIR':self.directory.name,'DELETE_PASSWORD':'test-password'})
        self.addCleanup(self.app.close)
        self.actor=self.app.accounts.get_user('u0');self.key='u0/learn-path-v1-animation-recovery'
        self.node={'id':'n1','title':'等价变形','objectives':['解释变形']}
        self.material={'topic':'数学','plan':{'nodes':[self.node]},'nodeState':{'other':{'status':'review'}},'unknown':'keep'}
        self.app.repository.write_key(self.key,json.dumps(self.material))
        fake='```learn-manim\n{"version":1,"asset_id":"'+'a'*32+'","title":"fake","summary":"fake"}\n```'
        self.candidate={'study_notes':'已校验正文。\n'+fake+'\n```learn-scene\n{}\n```','quiz':{'questions':questions()},
                        'manim_review':{'status':'passed','asset_id':'a'*32}}
        self.events=[]

    def generate(self,animation,review=None,cancelled=lambda:False):
        def verify(qs,**kwargs):
            self.events.append('quiz')
            return harness.validate_questions(qs,node=True)
        def capture(candidate):
            self.events.append('prose')
            self.assertEqual(references_in(candidate['study_notes']),[])
            self.assertNotIn('learn-scene',candidate['study_notes'])
            self.assertNotIn('manim_review',candidate)
            return review(candidate) if review else {'status':'passed'}
        def render(*args,**kwargs):
            self.events.append('animation')
            return animation(*args,**kwargs)
        with patch.object(self.app.model,'nonempty',return_value=json.dumps(self.candidate)), \
             patch.object(self.app.verification,'checked_questions',side_effect=verify), \
             patch.object(self.app.verification,'review_rendered',side_effect=capture), \
             patch.object(self.app.manim,'generate',side_effect=render):
            return self.app.learning.node('/path/node',{'key':self.key,'node':{'id':'n1','title':'stale client'}},self.actor,cancelled=cancelled)

    def failure(self,*args,**kwargs):
        raise ManimGenerationError(502,'visual_rejected')

    def test_checked_lesson_is_saved_once_without_fake_assets_after_animation_failure(self):
        code,detail=self.generate(self.failure)
        self.assertEqual(code,200)
        self.assertEqual(self.events,['quiz','prose','animation'])
        self.assertEqual(detail['manim_review'],{'status':'failed','retryable':True,'failure_code':'visual_rejected'})
        self.assertEqual(references_in(detail['study_notes']),[])
        harness.validate_questions(detail['quiz']['questions'],node=True)
        self.assertTrue(detail['quiz']['round_id'])
        stored=self.app.repository.material(self.key)
        self.assertEqual(stored['nodeDetail']['n1'],detail)
        self.assertEqual(stored['nodeState'],self.material['nodeState'])
        self.assertEqual(stored['unknown'],'keep')
        with patch.object(self.app.model,'nonempty') as model:
            self.assertEqual(self.app.learning.node('/path/node',{'key':self.key,'node':self.node},self.actor),(200,detail))
            model.assert_not_called()
        self.assertEqual(self.app.cache.gates,{})

    def test_unavailable_animation_is_recoverable_but_generic_job_error_is_not(self):
        def unavailable(*args,**kwargs):raise ManimGenerationError(503,'renderer_unavailable')
        self.assertEqual(self.generate(unavailable)[1]['manim_review']['failure_code'],'renderer_unavailable')
        self.app.repository.write_key(self.key,json.dumps(self.material));self.app.cache.results.clear()
        def generic(*args,**kwargs):raise JobError(503,'non-animation failure')
        with self.assertRaises(JobError):self.generate(generic)
        self.assertNotIn('nodeDetail',self.app.repository.material(self.key))
        self.assertEqual(self.app.cache.gates,{})

    def test_failed_question_or_unavailable_prose_never_runs_animation_or_saves(self):
        with patch.object(self.app.model,'nonempty',return_value=json.dumps(self.candidate)), \
             patch.object(self.app.verification,'checked_questions',side_effect=harness.QuizContractError('invalid question')) as verify, \
             patch.object(self.app.manim,'generate') as animation:
            with self.assertRaises(harness.QuizContractError):
                self.app.learning.node('/path/node',{'key':self.key,'node':self.node},self.actor)
            self.assertEqual(verify.call_count,3);animation.assert_not_called()
        with self.assertRaises(JobError) as raised:
            self.generate(self.failure,review=lambda candidate:{'status':'unavailable'})
        self.assertEqual(raised.exception.status,503)
        self.assertNotIn('animation',self.events)
        self.assertNotIn('nodeDetail',self.app.repository.material(self.key))
        self.assertEqual(self.app.cache.gates,{})

    def test_cancel_delete_revoke_and_stale_data_never_become_partial_success(self):
        for mode in ('cancel','delete','node_changed','notes_changed','permission'):
            with self.subTest(mode=mode):
                self.app.repository.write_key(self.key,json.dumps(self.material));self.app.cache.results.clear()
                cancelled=[False]
                authorization=self.app.scenes.authorize
                def animation(*args,**kwargs):
                    changed=copy.deepcopy(self.material)
                    if mode=='cancel':cancelled[0]=True
                    elif mode=='delete':changed['plan']['nodes']=[]
                    elif mode=='node_changed':changed['plan']['nodes'][0]['title']='new canonical title'
                    elif mode=='notes_changed':changed['nodeDetail']={'n1':{'study_notes':'new notes'}}
                    elif mode=='permission':
                        self.app.scenes.authorize=lambda *args:(_ for _ in ()).throw(JobError(403,'denied'))
                    self.app.repository.write_key(self.key,json.dumps(changed))
                    raise ManimGenerationError(503,'model_unavailable')
                try:
                    with self.assertRaises(JobError) as raised:self.generate(animation,cancelled=lambda:cancelled[0])
                    self.assertIn(raised.exception.status,(403,404,409))
                    current=self.app.repository.material(self.key)
                    self.assertNotIn('quiz',((current.get('nodeDetail') or {}).get('n1') or {}))
                    self.assertEqual(self.app.cache.gates,{})
                finally:self.app.scenes.authorize=authorization

    def test_new_asset_is_discarded_on_final_stale_snapshot(self):
        def animation(*args,**kwargs):
            changed=copy.deepcopy(self.material);changed['plan']['nodes'][0]['title']='changed'
            self.app.repository.write_key(self.key,json.dumps(changed))
            return {'version':1,'asset_id':'b'*32,'title':'图','summary':'关系'}
        with patch.object(self.app.manim,'discard') as discard:
            with self.assertRaises(JobError) as raised:self.generate(animation)
            self.assertEqual(raised.exception.status,409)
            discard.assert_called_once_with('b'*32)
        self.assertEqual(self.app.cache.gates,{})

    def test_supplement_replaces_failure_status_atomically_and_keeps_issued_quiz(self):
        _,detail=self.generate(self.failure)
        before=self.app.repository.material(self.key)
        spec={'version':1,'asset_id':'c'*32,'title':'图','summary':'关系'}
        with patch.object(self.app.manim,'generate',return_value=spec):
            code,result=self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':{'id':'n1'}},self.actor)
        self.assertEqual(code,200)
        self.assertEqual(result['source_notes'],detail['study_notes'])
        self.assertEqual(result['manim_review'],{'status':'passed','asset_id':'c'*32})
        after=self.app.repository.material(self.key)
        self.assertEqual(after['nodeDetail']['n1']['manim_review'],result['manim_review'])
        self.assertEqual(after['nodeDetail']['n1']['quiz'],before['nodeDetail']['n1']['quiz'])
        self.assertEqual(after['nodeState'],before['nodeState'])
        self.assertEqual(len(references_in(result['study_notes'])),1)

    def test_animation_status_is_server_owned_across_stale_client_saves(self):
        _,detail=self.generate(self.failure)
        stale=copy.deepcopy(self.app.repository.material(self.key))
        stale['nodeDetail']['n1']['manim_review']={'status':'passed','asset_id':'d'*32}
        self.app.repository.put_entries({self.key:json.dumps(stale)})
        self.assertEqual(self.app.repository.node_detail(self.key,'n1')['manim_review'],detail['manim_review'])
        fresh='u0/learn-path-v1-client-forgery'
        self.app.repository.put_entries({fresh:json.dumps(stale)})
        self.assertNotIn('manim_review',self.app.repository.node_detail(fresh,'n1'))

    def test_failed_supplement_retains_checked_lesson_and_stale_supplement_discards_asset(self):
        self.generate(self.failure)
        before=self.app.repository.material(self.key)
        with patch.object(self.app.manim,'generate',side_effect=ManimGenerationError(503,'model_unavailable')):
            with self.assertRaises(ManimGenerationError):
                self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':{'id':'n1'}},self.actor)
        self.assertEqual(self.app.repository.material(self.key),before)
        def changed(*args,**kwargs):
            material=self.app.repository.material(self.key);material['plan']['nodes'][0]['title']='changed'
            self.app.repository.write_key(self.key,json.dumps(material))
            return {'version':1,'asset_id':'e'*32,'title':'图','summary':'关系'}
        with patch.object(self.app.manim,'generate',side_effect=changed),patch.object(self.app.manim,'discard') as discard:
            with self.assertRaises(JobError) as raised:
                self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':{'id':'n1'}},self.actor)
            self.assertEqual(raised.exception.status,409);discard.assert_called_once_with('e'*32)
        after=self.app.repository.material(self.key)
        self.assertEqual(after['nodeDetail'],before['nodeDetail'])
