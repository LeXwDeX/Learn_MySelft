"""Media routes enforce ownership, deletion and byte-range semantics."""
import json
import urllib.error
import urllib.request
import unittest
import test_user_isolation as isolation
from manim_routes import byte_range


class RangeTests(unittest.TestCase):
    def test_single_ranges_and_unsatisfiable_input(self):
        for header, expected in [(None, (0, 9, False)), ('bytes=2-4', (2, 4, True)),
                                 ('bytes=7-', (7, 9, True)), ('bytes=-3', (7, 9, True)),
                                 ('bytes=0-100', (0, 9, True))]:
            self.assertEqual(byte_range(header, 10), expected)
        for header in ('bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=', 'bytes=0-1,3-4', 'items=0-1'):
            with self.assertRaises(ValueError):
                byte_range(header, 10)


class ManimMediaTests(unittest.TestCase):
    setUp = isolation.UserIsolationTests.setUp
    stop_server = isolation.UserIsolationTests.stop_server
    request = isolation.UserIsolationTests.request
    login = isolation.UserIsolationTests.login
    create = isolation.UserIsolationTests.create

    def fixture(self):
        key = self.alice + '/learn-path-v1-media'
        self.app.repository.write_key(key, json.dumps({'plan': {'nodes': [{'id': 'n1'}]}}))
        asset_id = 'a' * 32
        directory = self.app.manim.root / self.alice / asset_id
        directory.mkdir(parents=True)
        (directory / 'metadata.json').write_text(json.dumps(
            {'owner': self.alice, 'key': key, 'node_id': 'n1', 'published': True}))
        (directory / 'manifest').write_text(json.dumps({'steps': [{}]}))
        (directory / 'video.mp4').write_bytes(b'0123456789')
        return key, '/manim/assets/' + asset_id + '/video.mp4'

    def media(self, path, cookie, range_header=None):
        headers = {'Cookie': cookie}
        if range_header:
            headers['Range'] = range_header
        request = urllib.request.Request('http://127.0.0.1:%d%s' % (self.server.server_port, path), headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read(), response.headers

    def test_range_owner_admin_read_only_and_live_deletion(self):
        key, path = self.fixture()
        status, body, headers = self.media(path, self.alice_cookie, 'bytes=2-4')
        self.assertEqual((status, body), (206, b'234'))
        self.assertEqual(headers['Content-Range'], 'bytes 2-4/10')
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        self.assertEqual(self.media(path, self.alice_cookie, 'bytes=10-')[0], 416)
        self.assertEqual(self.media(path, self.bob_cookie)[0], 404)
        self.assertEqual(self.media(path + '?user=' + self.alice, self.bob_cookie)[0], 403)
        self.assertEqual(self.media(path + '?user=' + self.alice, self.admin)[0], 200)
        self.app.repository.write_key(key, json.dumps({'plan': {'nodes': []}}))
        self.assertEqual(self.media(path, self.alice_cookie)[0], 404)

    def test_missing_session_and_link_outputs_are_rejected(self):
        _, path = self.fixture()
        self.assertEqual(self.media(path, '')[0], 401)
        file = self.app.manim.root / self.alice / ('a' * 32) / 'video.mp4'
        file.unlink()
        file.symlink_to('/etc/passwd')
        self.assertEqual(self.media(path, self.alice_cookie)[0], 404)
