"""Production composition uses Manim; legacy SVG remains read compatibility only."""
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
from manim_contracts import references_in
from user_accounts import AccountError

class ManimIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.app=create_application({'STATE_DIR':self.temp.name,'DELETE_PASSWORD':'test-password'});self.addCleanup(self.app.close)
        self.actor=self.app.accounts.get_user('u0');self.key='u0/learn-path-v1-manim'
        self.legacy='```learn-scene\n{"version":1,"type":"diagram"}\n```\n'
        self.notes='保留开头。\n'+self.legacy+'保留结尾。\n````text\n'+self.legacy+'````\n'
        self.material={'topic':'角','plan':{'nodes':[{'id':'n1','title':'角'}]},'nodeDetail':{'n1':{'study_notes':self.notes,'quiz':{'round_id':'old','rounds':[]}}},'nodeState':{'n1':{'score':88}}}
        self.app.repository.write_key(self.key,json.dumps(self.material))
        self.spec=dict(version=1,asset_id='a'*32,title='角',summary='观察')
    def invoke(self): return self.app.run_job('u0','/path/node/scene',{'key':self.key,'node':{'id':'n1'}})
    def test_composition_candidate_and_supplement_share_real_service(self):
        self.assertIs(self.app.scenes.manim,self.app.manim)
        self.assertIs(self.app.learning.scenes,self.app.scenes)
        with patch.object(self.app.manim,'generate',return_value=self.spec) as generate,patch.object(self.app.scenes,'_addition') as legacy:
            candidate={'study_notes':self.notes}
            self.app.scenes.enrich_candidate(candidate,{'id':'n1'},key=self.key,actor=self.actor)
            self.assertEqual(len(references_in(candidate['study_notes'])),1)
            self.assertFalse(generate.call_args.kwargs['requested'])
            status,result=self.invoke()
            self.assertEqual(status,200)
            self.assertIn('保留开头。',result['study_notes']);self.assertIn('保留结尾。',result['study_notes'])
            self.assertIn('````text\n'+self.legacy,result['study_notes'])
            self.assertEqual(len(references_in(result['study_notes'])),1)
            saved=self.app.repository.material(self.key)
            self.assertEqual(saved['nodeState'],self.material['nodeState'])
            self.assertEqual(saved['nodeDetail']['n1']['quiz'],self.material['nodeDetail']['n1']['quiz'])
            legacy.assert_not_called()
    def test_manim_failure_preserves_old_notes_without_svg_fallback(self):
        with patch.object(self.app.manim,'generate',side_effect=JobError(503,'unavailable')),patch.object(self.app.scenes,'_addition') as legacy:
            with self.assertRaises(JobError):self.invoke()
            self.assertEqual(self.app.repository.material(self.key),self.material)
            legacy.assert_not_called()
    def test_admin_cannot_write_other_user_animation(self):
        learner=self.app.accounts.create_user(self.actor,'manimlearner','Learner','learner-password')
        key=learner['id']+'/learn-path-v1-manim'
        self.app.repository.write_key(key,json.dumps(self.material))
        with patch.object(self.app.manim,'generate') as generate:
            with self.assertRaises(AccountError):self.app.run_job('u0','/path/node/scene',{'key':key,'node':{'id':'n1'}})
            generate.assert_not_called()
    def test_concurrent_progress_survives_and_changed_notes_discard_new_asset(self):
        def progress(*args,**kwargs):
            material=self.app.repository.material(self.key);material['nodeState']['n1']['score']=99
            self.app.repository.write_key(self.key,json.dumps(material));return self.spec
        with patch.object(self.app.manim,'generate',side_effect=progress):self.invoke()
        self.assertEqual(self.app.repository.material(self.key)['nodeState']['n1']['score'],99)
        self.app.repository.write_key(self.key,json.dumps(self.material))
        def notes(*args,**kwargs):
            material=self.app.repository.material(self.key);material['nodeDetail']['n1']['study_notes']='新正文'
            self.app.repository.write_key(self.key,json.dumps(material));return self.spec
        with patch.object(self.app.manim,'generate',side_effect=notes),patch.object(self.app.manim,'discard') as discard:
            with self.assertRaises(JobError) as raised:self.invoke()
            self.assertEqual(raised.exception.status,409);discard.assert_called_once_with(self.spec['asset_id'])
            self.assertEqual(self.app.repository.material(self.key)['nodeDetail']['n1']['study_notes'],'新正文')
