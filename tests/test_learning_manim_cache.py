"""Final persistence failure releases the single-flight node generation gate."""
import contextlib
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

class NodeSaveCacheTests(unittest.TestCase):
    def test_deleted_node_or_storage_failure_releases_gate(self):
        for mode in ('deleted','storage'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as path:
                app=create_application({'STATE_DIR':path,'DELETE_PASSWORD':'test-password'})
                self.addCleanup(app.close)
                key='u0/learn-path-v1-cache';node={'id':'n1','title':'角'}
                material={'topic':'角','plan':{'nodes':[node]}}
                app.repository.write_key(key,json.dumps(material))
                candidate={'study_notes':'正文','quiz':{'questions':[]},'manim_review':{'asset_id':'a'*32}}
                def review(value):
                    if mode=='deleted':app.repository.write_key(key,json.dumps({'plan':{'nodes':[]}}))
                    return {'status':'passed'}
                with patch('learning_service._norm_node_detail',return_value=candidate),patch('learning_service._issued_quiz',return_value={}), \
                     patch.object(app.model,'nonempty',return_value='{}'),patch.object(app.scenes,'enrich_candidate'), \
                     patch.object(app.verification,'checked_questions',return_value=[]),patch.object(app.verification,'review_rendered',side_effect=review), \
                     patch.object(app.cache,'finish',wraps=app.cache.finish) as finish,patch.object(app.manim,'discard') as discard, \
                     (patch.object(app.repository,'merge',side_effect=OSError('storage failed')) if mode=='storage' else contextlib.nullcontext()):
                    with self.assertRaises((JobError,OSError)):
                        app.learning.node('/path/node',{'key':key,'node':node},app.accounts.get_user('u0'))
                    finish.assert_called_once()
                    self.assertEqual(finish.call_args.kwargs['err'],'node save failed')
                    gate=finish.call_args.args[1]
                    self.assertTrue(gate['ev'].is_set())
                    self.assertNotIn(key+'#node#n1',app.cache.gates)
                    discard.assert_called_once_with('a'*32)
                app.close()
