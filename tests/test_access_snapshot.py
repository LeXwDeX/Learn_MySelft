"""Access refresh reads one authorized document and returns only gating facts."""
import http.client
import json
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import test_state_regressions as state_fixture


class AccessSnapshotTests(unittest.TestCase):
    setUp = state_fixture.StateRegressionTests.setUp

    def get(self, key=state_fixture.KEY, headers=None, user=None):
        query = {} if key is None else {'key': key}
        if user:
            query['user'] = user
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            connection.request('GET', '/state/access?' + urlencode(query), headers=self.headers if headers is None else headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_snapshot_is_small_and_reads_current_document_once(self):
        material = {**self.initial,
                    'nodeAccess': {'n2': 'locked'},
                    'nodeState': {'n1': {'completed': True, 'score': 100, 'lastAnswers': ['private']},
                                  'n2': {'completed': False, 'draft': 'private'}},
                    'nodeDetail': {'n1': {'study_notes': 'private' * 10000}},
                    'history': [{'role': 'user', 'content': 'private' * 10000}]}
        self.app.repository.write_key(state_fixture.KEY, json.dumps(material))
        revision = self.app.repository.store.record(state_fixture.KEY)['revision']
        with patch.object(self.app.repository, 'all', side_effect=AssertionError('full scan')), \
             patch.object(self.app.repository.store, 'records', side_effect=AssertionError('full scan')), \
             patch.object(self.app.repository.store, 'record', wraps=self.app.repository.store.record) as record:
            status, snapshot = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(record.call_args_list, [unittest.mock.call(state_fixture.KEY)])
        self.assertEqual(snapshot, {'ok': True, 'key': state_fixture.KEY, 'revision': revision,
                                  'plan': {'nodes': [{'id': 'n1'}, {'id': 'n2'}]},
                                  'nodeAccess': {'n2': 'locked'},
                                  'nodeState': {'n1': {'completed': True}, 'n2': {'completed': False}}})
        self.app.repository.write_key('u0/learn-path-v1-unrelated', json.dumps({'topic': 'private' * 10000}))
        self.assertEqual(self.get(), (status, snapshot))
        self.assertLess(len(json.dumps(snapshot)), 500)

    def test_snapshot_revision_and_value_come_from_same_read(self):
        original = self.app.repository.store.record
        def changing_record(key):
            record = original(key)
            self.app.repository.write_key(key, json.dumps({**self.initial, 'nodeAccess': {'n1': 'locked'}}))
            return record
        before = original(state_fixture.KEY)
        with patch.object(self.app.repository.store, 'record', side_effect=changing_record) as record:
            status, snapshot = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(record.call_count, 1)
        self.assertEqual(snapshot['revision'], before['revision'])
        self.assertEqual(snapshot['nodeAccess'], {})

    def test_missing_deleted_nonmaterial_and_unplanned_keys_return_404(self):
        cases = {'u0/learn-path-v1-unknown': None,
                 'u0/learn-path-v1-deleted': None,
                 'u0/learn-path-v1-unplanned': {'topic': 'draft'},
                 'u0/learn-path-v1-empty': {'plan': {'nodes': []}},
                 'u0/learn-path-v1-last': {'plan': state_fixture.PLAN},
                 'u0/quiz-map-v1-example': {'plan': state_fixture.PLAN}}
        for key, value in cases.items():
            if not key.endswith('unknown'):
                self.app.repository.write_key(key, None if value is None else json.dumps(value))
            with self.subTest(key=key):
                self.assertEqual(self.get(key)[0], 404)

    def test_legacy_alias_uses_legacy_revision_but_canonical_tombstone_wins(self):
        key = 'u0/learn-path-v1-legacy'
        legacy = key[3:]
        self.app.repository.write_key(legacy, json.dumps(self.initial))
        self.app.repository.write_key(legacy, json.dumps(self.initial))
        revision = self.app.repository.store.record(legacy)['revision']
        status, snapshot = self.get(key)
        self.assertEqual(status, 200)
        self.assertEqual(snapshot['key'], key)
        self.assertEqual(snapshot['revision'], revision)
        self.app.repository.write_key(key, None)
        self.assertEqual(self.get(key)[0], 404)
        self.assertIsNone(self.app.repository.store.record(key)['value'])
        self.assertIsNotNone(self.app.repository.store.record(legacy)['value'])

    def test_authentication_and_key_validation(self):
        self.assertEqual(self.get(headers={})[0], 401)
        for key in [None, '', 'learn-path-v1-regression', 'u0/a/b', 'u0/' + 'x' * 512]:
            with self.subTest(key=key):
                self.assertEqual(self.get(key)[0], 400)
        admin = self.app.accounts.authenticate(self.token)
        other = self.app.accounts.create_user(admin, 'other_user', 'Other', 'other-password')
        _, token = self.app.accounts.login('other_user', 'other-password', '127.0.0.1')
        user_headers = {'Cookie': 'learn_session=' + token}
        key = other['id'] + '/learn-path-v1-example'
        self.app.repository.write_key(key, json.dumps(self.initial))
        self.assertEqual(self.get(headers=user_headers)[0], 403)
        self.assertEqual(self.get(key, headers=user_headers)[0], 200)
        self.assertEqual(self.get(key)[0], 403)
        self.assertEqual(self.get(key, user=other['id'])[0], 200)
        # The admin's target selection grants reads only, including this endpoint.
        self.assertEqual(self.post('/state/node-access?user=' + other['id'],
                                   {'key': key, 'node_id': 'n1', 'access': 'locked', 'password': 'test-password'})[0], 403)

    post = state_fixture.StateRegressionTests.post
