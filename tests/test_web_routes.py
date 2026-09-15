"""Serve actual user-space paths and assets without exposing directories."""
from functools import partial
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from web_server import LearningWebHandler, ThreadingHTTPServer


class WebRoutesTests(unittest.TestCase):
    def test_user_pages_assets_and_invalid_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['learn/index.html', 'diagram-design/learning-path/learning-path.html',
                         'diagram-design/learning-path/quiz-map.html',
                         'diagram-design/learning-path/junior-math-linalg.html',
                         'diagram-design/learning-path/katex/katex.min.css']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            # Retired files deliberately remain: routes must not serve stale releases.
            for name in ['math-knowledge-map.html', 'math-knowledge-map.json']:
                (root / 'diagram-design/learning-path' / name).write_text('old example')
            server = ThreadingHTTPServer(('127.0.0.1', 0), partial(LearningWebHandler, directory=directory))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = 'http://127.0.0.1:%s' % server.server_port
                for user in ['u0', 'u0123456789abcdef']:
                    for suffix in ['', 'learning-path.html', 'quiz-map.html', 'katex/katex.min.css']:
                        with urllib.request.urlopen(base + '/learn/u/' + user + '/' + suffix + '?t=example') as response:
                            self.assertEqual(response.status, 200)
                            self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                    with urllib.request.urlopen(base + '/learn/u/' + user) as response:
                        self.assertTrue(response.url.endswith('/'))
                for suffix in ['/learn/u/invalid/', '/learn/u/u0/unknown.html', '/learn/u/u0/katex/%2e%2e/quiz-map.html', '/diagram-design/']:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(base + suffix)
                    self.assertEqual(caught.exception.code, 404)
                for suffix in ['/learn/u/u0/junior-math-linalg.html',
                               '/learn/u/u0123456789abcdef/junior-math-linalg.html',
                               '/diagram-design/learning-path/junior-math-linalg.html',
                               '/diagram-design/learning-path/math-knowledge-map.html',
                               '/diagram-design/learning-path/math-knowledge-map.json',
                               '/diagram-design/learning-path/%6dath-knowledge-map.html',
                               '/diagram-design/learning-path/./junior-math-linalg.html']:
                    for method in ['GET', 'HEAD']:
                        with self.assertRaises(urllib.error.HTTPError) as caught:
                            urllib.request.urlopen(urllib.request.Request(base + suffix, method=method))
                        self.assertEqual(caught.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
