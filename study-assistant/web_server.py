"""Static site with stable /learn/u/<user-id>/ routes sharing generated assets."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import re
import json
import os
from urllib.parse import unquote, urlsplit

SPACE_ROUTE = re.compile(r'^/learn/u/(u0|u[0-9a-f]{16})/(.*)$')
PAGES = {'': '/learn/index.html', 'learning-path.html': '/diagram-design/learning-path/learning-path.html',
         'quiz-map.html': '/diagram-design/learning-path/quiz-map.html',
         'junior-math-linalg.html': '/diagram-design/learning-path/junior-math-linalg.html'}


class LearningWebHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, api_port=8101, api_base=None, **kwargs):
        self.api_port = api_port
        self.api_base = api_base
        super().__init__(*args, **kwargs)

    def _route(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/learn/config.js':
            body = ('window.LearnConfig = ' + json.dumps({'apiPort': self.api_port, 'apiBase': self.api_base}) + ';\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
            return False
        # Redirect the user-space root to its slash form for relative links.
        if re.fullmatch(r'/learn/u/(u0|u[0-9a-f]{16})', path):
            self.send_response(302)
            self.send_header('Location', path + '/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return False
        if path.startswith('/learn/u/'):
            matched = SPACE_ROUTE.fullmatch(path)
            if not matched:
                self.send_error(404)
                return False
            suffix = matched.group(2)
            if suffix in PAGES:
                self.path = PAGES[suffix]
            elif suffix.startswith(('katex/', 'highlight/')) and '..' not in suffix.split('/') and '\\' not in suffix:
                self.path = '/diagram-design/learning-path/' + suffix
            else:
                self.send_error(404)
                return False
        return True

    def do_GET(self):
        if self._route():
            super().do_GET()

    def do_HEAD(self):
        if self._route():
            super().do_HEAD()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--port', type=int, default=8100)
    parser.add_argument('--api-port', type=int, default=8101)
    parser.add_argument('--api-base', default=os.environ.get('API_PUBLIC_BASE'))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.api_port <= 65535:
        parser.error('ports must be between 1 and 65535')
    if args.api_base:
        parsed = urlsplit(args.api_base)
        relative = args.api_base.startswith('/') and not args.api_base.startswith('//')
        absolute = parsed.scheme in ('http', 'https') and parsed.hostname
        if not (relative or absolute) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error('--api-base must be a root-relative or HTTP(S) base URL')
    server = ThreadingHTTPServer(('0.0.0.0', args.port), partial(LearningWebHandler,
                                 directory=args.directory, api_port=args.api_port, api_base=args.api_base))
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
