"""Password-confirmed overrides preserve authoritative learning documents."""
import concurrent.futures
import json
import sqlite3
import unittest
from unittest.mock import patch

import test_state_regressions as state_fixture
KEY = state_fixture.KEY
from user_accounts import AccountError
from state_schema import validate_value


class NodeAccessTests(unittest.TestCase):
    setUp = state_fixture.StateRegressionTests.setUp
    post = state_fixture.StateRegressionTests.post
    material = state_fixture.StateRegressionTests.material

    def change(self, **changes):
        return self.post('/state/node-access', {'key': KEY, 'node_id': 'n2',
                         'access': 'unlocked', 'password': 'test-password', **changes})

    def test_password_and_validation_fail_without_writes(self):
        before = self.app.repository.read_key(KEY)
        for password in (None, 'wrong', 3, {}):
            self.assertEqual(self.change(password=password)[0], 403)
        self.assertEqual(self.change(node_id='missing')[0], 404)
        self.assertEqual(self.change(access='default')[0], 400)
        self.assertEqual(self.app.repository.read_key(KEY), before)
        status, result = self.change()
        self.assertEqual(status, 200)
        self.assertEqual(set(result), {'ok', 'nodeAccess', 'revision'})
        self.assertEqual(result['nodeAccess'], {'n2': 'unlocked'})
        self.assertEqual(self.change()[1]['revision'], result['revision'])
        self.assertEqual(self.material()['nodeState'], self.initial['nodeState'])
        self.assertNotIn('password', self.app.repository.read_key(KEY))

    def test_limits_are_independent_and_expire(self):
        for _ in range(10):
            self.assertEqual(self.change(password='wrong')[0], 403)
        self.assertEqual(self.change()[0], 429)
        # Confirmation failure must not lock out login.
        self.store.login('admin', 'test-password', '127.0.0.1')
        import time
        with patch('user_accounts.time.time', return_value=time.time() + 301):
            self.assertEqual(self.change()[0], 200)

    def test_limit_uses_both_account_and_ip(self):
        actor = self.store.get_user('u0')
        other = self.store.create_user(actor, 'other', 'Other', 'other-password')
        for _ in range(10):
            with self.assertRaises(AccountError):
                self.store.confirm_password(actor, 'wrong', 'source-a')
        for user, address in ((actor, 'source-b'), (other, 'source-a')):
            with self.assertRaises(AccountError) as error:
                self.store.confirm_password(user, 'test-password', address)
            self.assertEqual(error.exception.status, 429)

    def test_authorization(self):
        admin_headers = self.headers.copy()
        self.headers.pop('Cookie')
        self.assertEqual(self.change()[0], 401)
        self.headers = admin_headers
        other = self.store.create_user(self.store.get_user('u0'), 'other', 'Other', 'other-password')
        key = other['id'] + '/learn-path-v1-other'
        self.app.repository.write_key(key, json.dumps(self.initial))
        self.assertEqual(self.change(key=key)[0], 403)  # Administrator view is read-only.
        _, token = self.store.login('other', 'other-password', 'another-ip')
        self.headers['Cookie'] = 'learn_session=' + token
        self.assertEqual(self.change(password='other-password')[0], 403)
        self.assertNotIn('nodeAccess', self.material())

    def test_all_whole_puts_and_generated_patches_protect_access(self):
        self.assertEqual(self.change()[0], 200)
        for trusted in (False, True):
            for access in ({}, {'n1': 'locked'}):
                self.app.repository.put_entries({KEY: {**self.initial, 'nodeAccess': access}}, trusted=trusted)
                self.assertEqual(self.material()['nodeAccess'], {'n2': 'unlocked'})
            new_key = KEY + ('-trusted' if trusted else '-copy')
            self.app.repository.put_entries({new_key: {**self.initial, 'nodeAccess': {'n2': 'unlocked'}}}, trusted=trusted)
            self.assertFalse(self.app.repository.material(new_key).get('nodeAccess'))
        self.app.repository.merge(KEY, {'nodeAccess': {}, 'brief': 'new generated brief'})
        self.assertEqual(self.material()['nodeAccess'], {'n2': 'unlocked'})
        self.assertEqual(self.material()['brief'], 'new generated brief')

    def test_delete_between_validation_and_commit_does_not_revive(self):
        original = self.store.confirm_password
        def delete_after_password(*args):
            original(*args)
            self.app.repository.put_entries({KEY: None})
        with patch.object(self.store, 'confirm_password', side_effect=delete_after_password):
            self.assertEqual(self.change()[0], 404)
        self.assertIsNone(self.app.repository.read_key(KEY))

    def test_concurrent_save_keeps_override_and_latest_draft(self):
        repository = self.app.repository
        def save():
            repository.put_entries({KEY: {**self.initial, 'nodeState': {'n1': {'mark': 'review'}},
                                          'nodeAccess': {}}})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            calls = [pool.submit(save), pool.submit(repository.set_node_access, KEY, 'n2', 'unlocked')]
            for call in calls:
                call.result()
        self.assertEqual(self.material()['nodeAccess'], {'n2': 'unlocked'})
        self.assertEqual(self.material()['nodeState']['n1']['mark'], 'review')
        self.assertEqual(self.material()['nodeState']['n1']['score'], 30)

    def test_write_failure_rolls_back_and_returns_unavailable(self):
        repository = self.app.repository
        original = repository.write_key
        before = repository.read_key(KEY)
        def fail_after_write(*args):
            original(*args)
            raise sqlite3.OperationalError('simulated failure')
        with patch.object(repository, 'write_key', side_effect=fail_after_write):
            self.assertEqual(self.change()[0], 503)
        self.assertEqual(repository.read_key(KEY), before)

    def test_lock_back_and_refinement_keep_original_identity(self):
        self.assertEqual(self.change()[0], 200)
        self.assertEqual(self.change(access='locked')[1]['nodeAccess'], {'n2': 'locked'})
        repository = self.app.repository
        plan = repository.append_refinement(KEY, None, [
            {'for': 'n1', 'title': 'Additional practice', 'essence': 'Practice', 'objectives': []}
        ])
        self.assertEqual(self.material()['nodeAccess'], {'n2': 'locked'})
        added = set(node['id'] for node in plan['nodes']) - {'n1', 'n2'}
        self.assertEqual(len(added), 1)
        self.assertTrue(added.isdisjoint(self.material()['nodeAccess']))
        repository.put_entries({KEY: {'topic': 'Old client omits access'}})
        self.assertEqual(self.material()['nodeAccess'], {'n2': 'locked'})

    def test_schema_rejects_malformed_access(self):
        for access in (None, [], {'': 'locked'}, {'n2': 'default'}, {'n2': True}):
            with self.subTest(access=access), self.assertRaises(ValueError):
                validate_value(KEY, json.dumps({**self.initial, 'nodeAccess': access}))
