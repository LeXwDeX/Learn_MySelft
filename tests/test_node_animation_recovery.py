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
        with patch.object(self.app.model,'nonempty',side_effect=[json.dumps(self.candidate),json.dumps(self.candidate['quiz']),json.dumps(self.candidate['quiz'])]), \
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
        current=self.app.repository.material(self.key)
        self.assertEqual(current['nodeDetail']['n1']['study_notes'],before['nodeDetail']['n1']['study_notes'])
        self.assertEqual(current['nodeDetail']['n1']['quiz'],before['nodeDetail']['n1']['quiz'])
        self.assertEqual(current['nodeDetail']['n1']['manim_review']['failure_code'],'model_unavailable')
        before=current
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

    def test_deferred_lesson_saves_before_animation_and_repairs_only_questions(self):
        valid=harness.validate_questions(questions(),node=True)
        calls=[json.dumps(self.candidate),json.dumps({'questions':questions()})]
        with patch.object(self.app.model,'nonempty',side_effect=calls) as model, \
             patch.object(self.app.verification,'checked_questions',side_effect=[harness.QuizContractError('bad answer'),valid]) as verify, \
             patch.object(self.app.verification,'review_rendered',return_value={'status':'passed'}), \
             patch.object(self.app.manim,'generate') as animation:
            code,detail=self.app.learning.node('/path/node',{'key':self.key,'node':self.node,'defer_visual':True},self.actor)
        self.assertEqual(code,200)
        self.assertEqual(model.call_count,2)
        self.assertEqual(verify.call_count,2)
        animation.assert_not_called()
        self.assertEqual(detail['study_notes'],'已校验正文。\n')
        self.assertEqual(detail['manim_review'],{'status':'pending','retryable':True})
        self.assertIn('仅修复测验',model.call_args_list[1].args[0][0]['content'])
        self.assertNotIn('上次验题失败',model.call_args_list[1].args[0][1]['content'])

    def test_automatic_not_needed_persists_and_explicit_request_can_supplement(self):
        self.generate(self.failure)
        body={'key':self.key,'node':self.node,'automatic':True}
        with patch.object(self.app.manim,'generate',return_value=None) as generate:
            code,result=self.app.scenes.supplement('/path/node/scene',body,self.actor)
            self.assertFalse(generate.call_args.kwargs['requested'])
            self.assertEqual(result['manim_review'],{'status':'not_needed'})
            self.assertEqual(self.app.scenes.supplement('/path/node/scene',body,self.actor)[1]['reused'],True)
            self.assertEqual(generate.call_count,1)
        spec={'version':1,'asset_id':'c'*32,'title':'图','summary':'关系'}
        with patch.object(self.app.manim,'generate',return_value=spec) as generate:
            self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':self.node},self.actor)
            self.assertTrue(generate.call_args.kwargs['requested'])

    def test_deadline_metadata_does_not_create_effect_or_overwrite_new_result(self):
        from job_execution import JobDeadlineExceeded
        self.generate(self.failure)
        with patch.object(self.app.manim,'generate',side_effect=JobDeadlineExceeded()), \
             patch.object(self.app.repository.store,'record_job_effect') as effect:
            with self.assertRaises(JobDeadlineExceeded):
                self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':self.node,'automatic':True},self.actor)
            effect.assert_not_called()
        self.assertEqual(self.app.repository.node_detail(self.key,'n1')['manim_review']['failure_code'],'deadline')
        def newer(*args,**kwargs):
            material=self.app.repository.material(self.key)
            material['nodeDetail']['n1']['manim_review']={'status':'not_needed'}
            self.app.repository.write_key(self.key,json.dumps(material))
            raise ManimGenerationError(502,'visual_rejected')
        with patch.object(self.app.manim,'generate',side_effect=newer):
            with self.assertRaises(ManimGenerationError):
                self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':self.node},self.actor)
        self.assertEqual(self.app.repository.node_detail(self.key,'n1')['manim_review'],{'status':'not_needed'})

    def test_animation_failure_is_a_failed_receipt_with_no_success_effect(self):
        import time
        from background_jobs import JobQueue
        self.generate(self.failure)
        queue=JobQueue(self.app.repository.store,
                       lambda uid,path,body:self.app.scenes.supplement(path,body,self.actor),workers=1)
        self.addCleanup(queue.stop)
        with patch.object(self.app.manim,'generate',side_effect=ManimGenerationError(502,'visual_rejected')):
            receipt=queue.submit('u0','scene-failed-receipt','/path/node/scene',
                                 {'key':self.key,'node':self.node,'automatic':True})
            queue.start()
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                result=queue.get(receipt['id'],'u0')
                if result['status']=='failed':break
                time.sleep(.01)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(result['attempt'],1)
        with self.app.repository.store.connection() as connection:
            self.assertIsNone(connection.execute('SELECT effect FROM jobs WHERE id=?',(receipt['id'],)).fetchone()[0])
        self.assertEqual(self.app.repository.node_detail(self.key,'n1')['manim_review']['failure_code'],'visual_rejected')

    def test_animation_failure_metadata_respects_node_notes_and_permission_guards(self):
        for mode in ('delete','node','notes','permission'):
            with self.subTest(mode=mode):
                self.app.repository.write_key(self.key,json.dumps(self.material));self.app.cache.results.clear()
                self.generate(self.failure)
                authorize=self.app.scenes.authorize
                def failure(*args,**kwargs):
                    material=self.app.repository.material(self.key)
                    if mode=='delete':material['plan']['nodes']=[]
                    elif mode=='node':material['plan']['nodes'][0]['title']='changed'
                    elif mode=='notes':material['nodeDetail']['n1']['study_notes']='new notes'
                    else:self.app.scenes.authorize=lambda *args:(_ for _ in ()).throw(JobError(403,'denied'))
                    self.app.repository.write_key(self.key,json.dumps(material))
                    raise ManimGenerationError(503,'model_unavailable')
                try:
                    with patch.object(self.app.manim,'generate',side_effect=failure):
                        with self.assertRaises(ManimGenerationError):
                            self.app.scenes.supplement('/path/node/scene',{'key':self.key,'node':self.node},self.actor)
                    self.assertEqual(self.app.repository.node_detail(self.key,'n1')['manim_review']['failure_code'],'visual_rejected')
                finally:self.app.scenes.authorize=authorize

    def test_invalid_prose_render_does_not_trigger_question_repair_or_issue_round(self):
        with patch.object(self.app.model,'nonempty',return_value=json.dumps(self.candidate)) as model, \
             patch.object(self.app.verification,'checked_questions',return_value=harness.validate_questions(questions(),node=True)), \
             patch.object(self.app.verification,'review_rendered',side_effect=harness.QuizContractError('invalid prose')), \
             patch('learning_service._issued_quiz') as issue:
            with self.assertRaises(harness.QuizContractError):
                self.app.learning.node('/path/node',{'key':self.key,'node':self.node,'defer_visual':True},self.actor)
        self.assertEqual(model.call_count,1)
        issue.assert_not_called()
        self.assertNotIn('nodeDetail',self.app.repository.material(self.key))
