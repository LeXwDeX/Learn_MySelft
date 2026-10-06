"""Explicit application ownership, worker authorization and HTTP stream contracts."""

import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "study-assistant"))
from application import create_application
from background_jobs import JobError
from user_accounts import AccountError


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.apps = []
        for name in ("one", "two"):
            app = create_application(
                {
                    "STATE_DIR": str(Path(self.temp.name) / name),
                    "DELETE_PASSWORD": "test-password",
                }
            )
            self.apps.append(app)
            self.addCleanup(app.close)

    def test_instances_keep_accounts_documents_and_generation_cache_separate(self):
        one, two = self.apps
        key = "u0/learn-path-v1-same-topic"
        one.repository.write_key(key, '{"topic":"private"}')
        one.cache.put(key, {"private": True})
        one.accounts.create_user(
            one.accounts.get_user("u0"), "alice", "Alice", "alice-password"
        )
        self.assertIsNone(two.repository.read_key(key))
        self.assertIsNone(two.cache.get(key))
        self.assertEqual(
            [
                u["username"]
                for u in two.accounts.list_users(two.accounts.get_user("u0"))
            ],
            ["admin"],
        )
        one.jobs()
        self.assertIsNone(two._queue)

    def test_worker_uses_service_results_and_checks_ownership_deactivation_and_tombstones(
        self,
    ):
        app = self.apps[0]
        admin = app.accounts.get_user("u0")
        alice = app.accounts.create_user(admin, "alice", "Alice", "alice-password")
        own = alice["id"] + "/learn-path-v1-own"
        app.repository.write_key(own, '{"topic":"Basics"}')
        body = {"key": own, "topic": "Basics"}
        with patch.object(
            app.model, "nonempty", return_value="TITLE: 基础课程\nASK: 学过吗？"
        ) as model:
            status, result = app.run_job(alice["id"], "/path/intake", body)
            self.assertEqual(status, 200)
            self.assertEqual(result["question"], "学过吗？")
            self.assertEqual(app.repository.material(own)["title"], "基础课程")
            model.reset_mock()
            with self.assertRaises(AccountError) as foreign:
                app.run_job("u0", "/path/intake", body)
            self.assertEqual(foreign.exception.status, 403)
            app.accounts.update_user(admin, alice["id"], {"active": False})
            with self.assertRaises(JobError) as inactive:
                app.run_job(alice["id"], "/path/intake", body)
            self.assertEqual(inactive.exception.status, 403)
            app.accounts.update_user(admin, alice["id"], {"active": True})
            app.repository.write_key(own, None)
            with self.assertRaises(JobError) as deleted:
                app.run_job(alice["id"], "/path/intake", body)
            self.assertEqual(deleted.exception.status, 404)
            model.assert_not_called()

    def test_importing_entrypoint_does_not_read_settings_create_stores_or_start_workers(
        self,
    ):
        directory = Path(self.temp.name) / "import-only"
        process = subprocess.run(
            [sys.executable, "-c", "import study_assistant"],
            cwd=Path(__file__).resolve().parents[1] / "study-assistant",
            env={"STATE_DIR": str(directory), "PORT": "invalid"},
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertFalse(directory.exists())
        self.assertFalse(Path(str(directory) + "-accounts").exists())
        self.assertEqual(process.stdout, "")

    def test_real_http_sse_closes_and_finishes_for_streaming_and_json_upstreams(self):
        app = self.apps[0]
        _, token = app.accounts.login("admin", "test-password", "127.0.0.1")
        server = app.server(("127.0.0.1", 0))
        thread = threading.Thread(
            target=lambda: server.serve_forever(poll_interval=0.01), daemon=True
        )
        thread.start()
        try:
            for mime, payload in [
                (
                    "text/event-stream",
                    b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
                ),
                ("application/json", b'{"choices":[{"message":{"content":"hello"}}]}'),
            ]:
                response = io.BytesIO(payload)
                response.headers = {"Content-Type": mime}
                with (
                    self.subTest(mime=mime),
                    patch.object(app.model, "stream", return_value=response),
                ):
                    request = urllib.request.Request(
                        "http://127.0.0.1:%d/ask" % server.server_port,
                        json.dumps(
                            {"question": "Explain", "unit": {"unit_id": "n1"}}
                        ).encode(),
                        {
                            "Content-Type": "application/json",
                            "Cookie": "learn_session=" + token,
                        },
                    )
                    with urllib.request.urlopen(request, timeout=5) as result:
                        self.assertEqual(result.headers["Connection"], "close")
                        self.assertIn(
                            "text/event-stream", result.headers["Content-Type"]
                        )
                        data = result.read().decode()
                    messages = [
                        json.loads(line[6:])
                        for line in data.splitlines()
                        if line.startswith("data: ")
                    ]
                    self.assertEqual(messages, [{"delta": "hello"}, {"done": True}])
                    self.assertTrue(response.closed)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


    def test_real_http_tutor_diagrams_are_checked_and_failures_keep_source(self):
        app = self.apps[0]
        _, token = app.accounts.login("admin", "test-password", "127.0.0.1")
        server = app.server(("127.0.0.1", 0))
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        graph = '先读正文。\n\n```mermaid\nflowchart TD\n A["向量<br/>坐标"] --> B\n```\n'

        class InterruptedResponse(io.BytesIO):
            def __iter__(self):
                while line := self.readline():
                    yield line
                raise OSError("synthetic upstream interruption")

        try:
            for mime, status, interrupted in [("text/event-stream", "passed", False),
                                               ("application/json", "passed", False),
                                               ("text/event-stream", "unavailable", False),
                                               ("application/json", "failed", False),
                                               ("text/event-stream", "passed", True)]:
                source = graph[:-4] if interrupted else graph
                if mime == "text/event-stream":
                    payload = b"".join(("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}) + "\n\n").encode()
                                       for piece in source)
                    if not interrupted:
                        payload += b"data: [DONE]\n\n"
                else:
                    payload = json.dumps({"choices": [{"message": {"content": source}}]}).encode()
                response = (InterruptedResponse if interrupted else io.BytesIO)(payload)
                response.headers = {"Content-Type": mime}
                with self.subTest(mime=mime, status=status, interrupted=interrupted), \
                     patch.object(app.model, "stream", return_value=response), \
                     patch.object(app.tutor_rendering, "validate", return_value={"status": status, "source": source.split('```mermaid\n')[1].split('```')[0].replace('<br/>', ' ')}) as validate:
                    request = urllib.request.Request(
                        "http://127.0.0.1:%d/ask" % server.server_port,
                        json.dumps({"question": "Explain", "unit": {"unit_id": "n1"}}).encode(),
                        {"Content-Type": "application/json", "Cookie": "learn_session=" + token},
                    )
                    with urllib.request.urlopen(request, timeout=5) as result:
                        events = [json.loads(line[6:]) for line in result.read().decode().splitlines()
                                  if line.startswith("data: ")]
                    text = ''.join(event.get('delta', '') for event in events)
                    self.assertIn('先读正文。', text)
                    self.assertTrue(all(set(event) <= {'delta', 'done', 'error'} for event in events))
                    if status == 'passed' and not interrupted:
                        self.assertIn('```mermaid', text)
                        self.assertIn('向量 坐标', text)
                        validate.assert_called_once()
                    else:
                        self.assertNotIn('```mermaid', text)
                        self.assertIn('```text', text)
                        self.assertIn('向量<br/>坐标', text)
                        self.assertIn('保留源码', text)
                    if interrupted:
                        validate.assert_not_called()
                        self.assertIn('error', events[-1])
                    else:
                        self.assertEqual(events[-1], {'done': True})
                    self.assertTrue(response.closed)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
