"""Rejected POST bodies cannot become request lines or enter request logs."""
import http.client
import json
import socket
import unittest
from unittest.mock import patch

import test_state_regressions as state_fixture
from http_handler import Handler


class PostBodyFramingTests(unittest.TestCase):
    setUp = state_fixture.StateRegressionTests.setUp

    def connection(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        return connection

    def valid_body(self):
        return json.dumps({'key': state_fixture.KEY, 'node_id': 'missing',
                           'access': 'locked', 'password': 'dummy-body-marker'})

    def test_unauthenticated_body_closes_then_authenticated_request_succeeds(self):
        connection = self.connection()
        connection.request('POST', '/state/node-access', self.valid_body(),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        self.assertEqual(response.status, 401)
        self.assertEqual(response.getheader('Connection'), 'close')
        response.read()
        connection.request('POST', '/state/node-access', self.valid_body(), self.headers)
        response = connection.getresponse()
        self.assertEqual(response.status, 404)
        self.assertIsNone(response.getheader('Connection'))
        response.read()

    def test_successful_read_allows_reuse_and_next_request_resets_flag(self):
        connection = self.connection()
        first_socket = None
        for _ in range(2):
            connection.request('POST', '/state/node-access', self.valid_body(), self.headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            self.assertIsNone(response.getheader('Connection'))
            response.read()
            if first_socket is None:
                first_socket = connection.sock
            else:
                self.assertIs(connection.sock, first_socket)
        connection.request('POST', '/state/node-access', self.valid_body(),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        self.assertEqual(response.status, 401)
        self.assertEqual(response.getheader('Connection'), 'close')
        response.read()
        self.assertIsNone(connection.sock)

    @staticmethod
    def read_wire_response(stream):
        status = int(stream.readline().split()[1])
        headers = {}
        while True:
            line = stream.readline()
            if line == b"\r\n":
                break
            if not line:
                raise AssertionError("Incomplete response headers")
            name, value = line.decode().split(":", 1)
            headers[name.lower()] = value.strip()
        body = stream.read(int(headers.get('content-length', 0)))
        return status, headers, body

    def test_expect_continue_first_and_reused_connection_preserve_keepalive(self):
        body = self.valid_body().encode()
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as client:
            with client.makefile('rb') as stream:
                for _ in range(2):
                    headers = {**self.headers, 'Host': '127.0.0.1',
                               'Content-Length': str(len(body)), 'Expect': '100-continue'}
                    request = ('POST /state/node-access HTTP/1.1\r\n' + ''.join(
                        '%s: %s\r\n' % item for item in headers.items()) + '\r\n').encode()
                    client.sendall(request)
                    status, interim_headers, _ = self.read_wire_response(stream)
                    self.assertEqual(status, 100)
                    self.assertNotIn('connection', interim_headers)
                    client.sendall(body)
                    status, final_headers, _ = self.read_wire_response(stream)
                    self.assertEqual(status, 404)
                    self.assertNotIn('connection', final_headers)
                client.sendall(b'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
                self.assertEqual(self.read_wire_response(stream)[0], 200)

    def test_expect_early_rejection_closes_only_final_response(self):
        body = self.valid_body().encode()
        headers = {'Host': '127.0.0.1', 'Content-Type': 'application/json',
                   'Content-Length': str(len(body)), 'Expect': '100-continue'}
        request = ('POST /state/node-access HTTP/1.1\r\n' + ''.join(
            '%s: %s\r\n' % item for item in headers.items()) + '\r\n').encode()
        logs = []
        with patch.object(Handler, 'log_message', lambda handler, fmt, *args: logs.append(fmt % args)):
            with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as client:
                with client.makefile('rb') as stream:
                    client.sendall(request + body + b'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
                    status, interim_headers, _ = self.read_wire_response(stream)
                    self.assertEqual(status, 100)
                    self.assertNotIn('connection', interim_headers)
                    status, final_headers, _ = self.read_wire_response(stream)
                    self.assertEqual(status, 401)
                    self.assertEqual(final_headers.get('connection'), 'close')
                    try:
                        self.assertEqual(stream.read(1), b'')
                    except ConnectionResetError:
                        pass
        self.assertEqual(len(logs), 1)
        self.assertNotIn('dummy-body-marker', '\n'.join(logs))

    def test_early_rejections_close_without_parsing_or_logging_unread_body(self):
        body = b'{"password":"dummy-body-marker"}'
        cases = [
            ('/state/node-access', {}, 401),
            ('/state/node-access', {'Content-Type': 'text/plain'}, 415),
            ('/state/node-access', {'Origin': 'http://untrusted.invalid'}, 403),
            ('/no-route', {'Cookie': self.headers['Cookie']}, 404),
            ('/state/node-access', {'Cookie': self.headers['Cookie'],
                                    'Content-Length': str(self.app.settings.max_request_bytes + 1)}, 413),
            ('/state/node-access', {'Cookie': self.headers['Cookie'],
                                    'Transfer-Encoding': 'chunked'}, 400),
            ('/state/node-access', {'Cookie': self.headers['Cookie'],
                                    'Content-Length': 'invalid'}, 400),
        ]
        for path, extra, status in cases:
            with self.subTest(status=status, headers=tuple(extra)):
                headers = {'Host': '127.0.0.1', 'Content-Type': 'application/json',
                           'Content-Length': str(len(body)), **extra}
                request = ('POST %s HTTP/1.1\r\n' % path + ''.join(
                    '%s: %s\r\n' % item for item in headers.items()) + '\r\n').encode() + body
                # Pipeline a second request: the rejected body must not be interpreted.
                request += b'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
                logs = []
                def capture_log(handler, fmt, *args):
                    logs.append(fmt % args)
                with patch.object(Handler, 'log_message', capture_log):
                    with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as client:
                        client.sendall(request)
                        chunks = []
                        while True:
                            try:
                                chunk = client.recv(65536)
                            except ConnectionResetError:
                                break
                            if not chunk:
                                break
                            chunks.append(chunk)
                response = b''.join(chunks)
                self.assertTrue(response.startswith(('HTTP/1.1 %d ' % status).encode()))
                self.assertIn(b'Connection: close\r\n', response)
                self.assertEqual(response.count(b'HTTP/1.1 '), 1)
                self.assertNotIn('dummy-body-marker', '\n'.join(logs))
                self.assertEqual(len(logs), 1)
