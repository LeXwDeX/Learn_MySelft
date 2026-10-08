"""Browser saves retain omitted root fields without bypassing server protections."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from application import create_application
from generation_contracts import _issued_quiz
from service_limits import STATE_MAX_VALUE
from state_store import StateConflict
from test_quiz_harness import questions


class MaterialRootFieldTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = create_application({'STATE_DIR': self.directory.name, 'DELETE_PASSWORD': 'test-password'})
        self.addCleanup(self.app.close)
        self.repository = self.app.repository
        self.key = 'u0/learn-path-v1-root-fields'
        self.material = {
            'topic': '根字段回归', 'title': '服务端标题', 'stage': 'learning',
            'plan': {'nodes': [{'id': 'n1', 'title': '基础', 'deps': []}], 'edges': []},
            'nodeDetail': {'n1': {'study_notes': '已保存补图正文', 'quiz': _issued_quiz(questions()),
                                  'sceneSupplement': {'version': 1, 'notes_sha256': 'saved'},
                                  'manim_review': {'status': 'passed', 'asset_id': 'a' * 32}}},
            'nodeState': {'n1': {'score': 30, 'completed': False,
                                 'lastResult': {'score': 30, 'pass': False}, 'lastAnswers': ['saved']}},
            'refinementReceipts': {'saved': {'ok': True, 'node_ids': ['n1']}},
            'materials': [], 'quizMaterials': [],
            'unknown_test_field': {'version': 2, 'nested': {'kept': True}},
            'future_null': None, 'future_false': False, 'future_list': [1, {'x': '保留'}],
        }
        self.repository.write_key(self.key, json.dumps(self.material, ensure_ascii=False))

    def save(self, incoming):
        return self.repository.put_entries({self.key: json.dumps(incoming, ensure_ascii=False)})

    def test_omitted_fields_use_latest_document_and_keep_false_null_and_lists(self):
        # The browser holds an old known-field snapshot when a server update lands.
        incoming = {'topic': self.material['topic'], 'nodeState': {'n1': {'mark': 'review'}}}
        latest = {'version': 3, 'nested': {'new_server_value': True}}
        self.repository.merge(self.key, {'unknown_test_field': latest, 'future_added': 'latest'})
        self.assertEqual(self.save(incoming), 1)
        saved = self.repository.material(self.key)
        self.assertEqual(saved['unknown_test_field'], latest)
        self.assertEqual(saved['future_added'], 'latest')
        for field in ('future_null', 'future_false', 'future_list', 'nodeDetail', 'plan'):
            self.assertEqual(saved[field], self.material[field])
        self.assertEqual(saved['nodeState']['n1']['mark'], 'review')

    def test_explicit_unknown_update_and_null_replace_the_root_value(self):
        for updated in ({'replacement': True}, None, False, [], 'updated'):
            with self.subTest(updated=updated):
                self.save({'topic': self.material['topic'], 'unknown_test_field': updated})
                self.assertEqual(self.repository.material(self.key)['unknown_test_field'], updated)
        self.assertEqual(self.repository.material(self.key)['future_list'], self.material['future_list'])

    def test_issued_quiz_scores_scene_plan_and_receipts_keep_existing_protections(self):
        incoming = {'topic': self.material['topic'], 'title': '伪造标题',
                    'unknown_test_field': 'explicit update', 'refinementReceipts': None,
                    'plan': {'nodes': [{'id': 'fake', 'title': '伪造'}]},
                    'nodeState': {'n1': {'score': 100, 'completed': True, 'mark': 'learning',
                                         'lastResult': {'score': 100, 'pass': True}, 'lastAnswers': ['fake']}},
                    'nodeDetail': copy.deepcopy(self.material['nodeDetail'])}
        detail = incoming['nodeDetail']['n1']
        detail.update(study_notes='旧标签页正文', sceneSupplement={'version': 999},
                      manim_review={'status': 'failed'})
        detail['quiz'].update(round_id='fake', rounds=[], attempts=[{'score': 100}],
                              lastResult={'score': 100}, questions=[{'q': 'fake', 'answer': 'fake'}])
        self.save(incoming)
        saved = self.repository.material(self.key)
        for field in ('title', 'refinementReceipts', 'plan', 'nodeDetail'):
            self.assertEqual(saved[field], self.material[field])
        for field in ('score', 'completed', 'lastResult', 'lastAnswers'):
            self.assertEqual(saved['nodeState']['n1'][field], self.material['nodeState']['n1'][field])
        self.assertEqual(saved['nodeState']['n1']['mark'], 'learning')
        self.assertEqual(saved['unknown_test_field'], 'explicit update')

    def test_merged_size_limit_rejects_entire_batch_without_losing_saved_fields(self):
        stored = {**self.material, 'unknown_test_field': 's' * 1_100_000}
        stored_text = json.dumps(stored, ensure_ascii=False)
        self.assertLess(len(stored_text), STATE_MAX_VALUE)
        self.repository.write_key(self.key, stored_text)
        incoming = json.dumps({'topic': self.material['topic'], 'new_field': 'i' * 900_000})
        self.assertLess(len(incoming), STATE_MAX_VALUE)
        with self.assertRaisesRegex(ValueError, 'state value too large'):
            self.repository.put_entries({'u0/metadata': 'must not commit', self.key: incoming})
        self.assertEqual(self.repository.read_key(self.key), stored_text)
        self.assertIsNone(self.repository.read_key('u0/metadata'))

    def test_tombstone_is_not_revived_or_replaced_by_legacy_alias(self):
        business = self.key.split('/', 1)[1]
        self.repository.write_key(business, json.dumps(self.material))
        self.repository.put_entries({self.key: None})
        with self.assertRaises(StateConflict):
            self.save({'topic': self.material['topic'], 'unknown_test_field': 'cannot revive'})
        self.assertIsNone(self.repository.read_key(self.key))
        self.assertIsNone(self.repository.store.record(self.key)['value'])

    def test_other_document_types_keep_their_existing_replace_semantics(self):
        quiz_key = 'u0/quiz-map-v1-root-fields'
        self.repository.write_key(quiz_key, json.dumps({'questions': [{'q': 'q'}], 'unknown_test_field': 'old'}))
        self.repository.put_entries({quiz_key: json.dumps({'questions': [{'q': 'q'}]})})
        self.assertNotIn('unknown_test_field', self.repository.material(quiz_key))
        self.repository.write_key('u0/learn-path-v1-last', 'old marker')
        self.repository.put_entries({'u0/learn-path-v1-last': 'new marker'})
        self.assertEqual(self.repository.read_key('u0/learn-path-v1-last'), 'new marker')

    def test_real_state_put_retains_extension_and_progress_on_serialized_browser_save(self):
        server = self.app.server(('127.0.0.1', 0))
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.addCleanup(close)
        _, token = self.app.accounts.login('admin', 'test-password', '127.0.0.1')
        known_fields = {'topic', 'title', 'stage', 'plan', 'nodeDetail', 'nodeState'}
        browser_save = {field: copy.deepcopy(self.material[field]) for field in known_fields}
        browser_save['nodeState']['n1']['mark'] = 'review'
        request = urllib.request.Request(
            'http://127.0.0.1:%d/state/put' % server.server_port,
            data=json.dumps({'user_id': 'u0', 'entries': {self.key: json.dumps(browser_save)}}).encode(),
            headers={'Content-Type': 'application/json', 'Cookie': 'learn_session=' + token})
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
        saved = self.repository.material(self.key)
        self.assertEqual(saved['unknown_test_field'], self.material['unknown_test_field'])
        self.assertEqual(saved['nodeDetail'], self.material['nodeDetail'])
        self.assertEqual(saved['nodeState']['n1']['score'], 30)
        self.assertEqual(saved['nodeState']['n1']['mark'], 'review')


if __name__ == '__main__':
    unittest.main()
