"""HTTP-level identity, namespace and administrator read-only regressions."""

import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
import test_state_regressions
from test_quiz_harness import questions


class UserIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = test_state_regressions.create_application(
            {
                "STATE_DIR": str(Path(self.tmp.name) / "state"),
                "DELETE_PASSWORD": "admin-test-password",
            }
        )
        self.addCleanup(self.app.close)
        self.server = self.app.server(("127.0.0.1", 0))
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True
        )
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.admin = self.login("admin", "admin-test-password")
        self.alice = self.create("alice", "爱丽丝")
        self.bob = self.create("bob", "小博")
        self.alice_cookie = self.login("alice", "learner-password")
        self.bob_cookie = self.login("bob", "learner-password")

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None, cookie=None, target=None, extra=None):
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if target:
            headers["X-Learn-User"] = target
        headers.update(extra or {})
        request = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.server.server_port, path),
            None if body is None else json.dumps(body).encode(),
            headers,
        )
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), response.headers

    def login(self, name, password):
        status, body, headers = self.request(
            "/auth/login", {"username": name, "password": password}
        )
        self.assertEqual(status, 200, body)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        return headers["Set-Cookie"].split(";")[0]

    def create(self, username, name):
        status, body, _ = self.request(
            "/admin/users/create",
            {
                "username": username,
                "display_name": name,
                "password": "learner-password",
            },
            self.admin,
        )
        self.assertEqual(status, 201, body)
        return body["user"]["id"]

    def put(self, user, cookie, value="same topic"):
        key = user + "/learn-path-v1-same-topic"
        self.assertEqual(
            self.request(
                "/state/put", {"entries": {key: json.dumps({"topic": value})}}, cookie
            )[0],
            200,
        )
        return key

    def test_two_users_have_independent_data_and_direct_cross_access_is_denied(self):
        alice_key = self.put(self.alice, self.alice_cookie, "Alice only")
        bob_key = self.put(self.bob, self.bob_cookie, "Bob only")
        status, result, _ = self.request("/state/all", cookie=self.alice_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(list(result["entries"]), [alice_key])
        self.assertEqual(
            json.loads(result["entries"][alice_key])["topic"], "Alice only"
        )
        self.assertEqual(
            self.request("/state/all?user=" + self.bob, cookie=self.alice_cookie)[0],
            403,
        )
        self.assertEqual(
            self.request(
                "/state/put",
                {
                    "entries": {alice_key: '{"topic":"overwrite"}', bob_key: None},
                    "password": "learner-password",
                },
                self.alice_cookie,
            )[0],
            403,
        )
        self.assertEqual(self.app.repository.material(alice_key)["topic"], "Alice only")
        for path in ["/state/delete", "/state/del"]:
            self.assertEqual(
                self.request(
                    path,
                    {"keys": [bob_key], "password": "learner-password"},
                    self.alice_cookie,
                )[0],
                403,
            )
        with patch.object(
            self.app.model,
            "nonempty",
            side_effect=AssertionError("Unauthorized request reached model"),
        ):
            for path in [
                "/path/node",
                "/path/requiz",
                "/path/refine",
                "/path/quizmap",
                "/path/quiz",
                "/path/quiz/state",
                "/path/quiz/draft",
            ]:
                self.assertEqual(
                    self.request(
                        path, {"key": bob_key, "node": {"id": "n1"}}, self.alice_cookie
                    )[0],
                    403,
                    path,
                )
        self.assertEqual(
            self.request("/ask", {"question": "test"}, self.alice_cookie, self.bob)[0],
            403,
        )

    def test_admin_reads_each_user_without_writing_even_legacy_quiz(self):
        key = self.put(self.alice, self.alice_cookie)
        legacy = {
            "topic": "legacy",
            "nodeDetail": {"n1": {"quiz": {"questions": questions()}}},
            "nodeState": {},
        }
        self.app.repository.write_key(key, json.dumps(legacy))
        before = self.app.repository.store.record(key)
        status, data, _ = self.request(
            "/auth/session", cookie=self.admin, target=self.alice
        )
        self.assertTrue(data["read_only"])
        self.assertEqual(status, 200)
        status, data, _ = self.request(
            "/state/all", cookie=self.admin, target=self.alice
        )
        self.assertEqual(list(data["entries"]), [key])
        status, quiz, _ = self.request(
            "/path/quiz/state",
            {"key": key, "node": {"id": "n1"}},
            self.admin,
            self.alice,
        )
        self.assertEqual(status, 200, quiz)
        self.assertEqual(len(quiz["rounds"]), 1)
        self.assertEqual(self.app.repository.store.record(key), before)
        for path, body in [
            ("/state/put", {"entries": {key: '{"topic":"bad"}'}}),
            ("/path/quiz/draft", {"key": key, "node": {"id": "n1"}}),
        ]:
            self.assertEqual(self.request(path, body, self.admin, self.alice)[0], 403)
        self.assertEqual(self.request("/admin/users", cookie=self.alice_cookie)[0], 403)
        status, data, _ = self.request("/admin/users", cookie=self.admin)
        self.assertEqual(status, 200)
        self.assertEqual({u["id"] for u in data["users"]}, {"u0", self.alice, self.bob})
        self.assertNotIn("digest", json.dumps(data))

    def test_deactivation_reset_and_logout_revoke_sessions(self):
        self.assertEqual(
            self.request(
                "/admin/users/update",
                {"user_id": self.alice, "changes": {"active": False}},
                self.admin,
            )[0],
            200,
        )
        self.assertEqual(self.request("/state/all", cookie=self.alice_cookie)[0], 401)
        self.assertEqual(
            self.request(
                "/auth/login", {"username": "alice", "password": "learner-password"}
            )[0],
            401,
        )
        self.request(
            "/admin/users/update",
            {
                "user_id": self.alice,
                "changes": {"active": True, "password": "new-password"},
            },
            self.admin,
        )
        new_cookie = self.login("alice", "new-password")
        self.assertEqual(self.request("/state/all", cookie=self.alice_cookie)[0], 401)
        self.assertEqual(
            self.request(
                "/auth/password",
                {"old_password": "wrong", "new_password": "another-password"},
                new_cookie,
            )[0],
            403,
        )
        self.assertEqual(
            self.request(
                "/auth/password",
                {"old_password": "new-password", "new_password": "another-password"},
                new_cookie,
            )[0],
            200,
        )
        self.assertEqual(self.request("/state/all", cookie=new_cookie)[0], 401)
        latest = self.login("alice", "another-password")
        self.assertEqual(self.request("/auth/logout", {}, latest)[0], 200)
        self.assertEqual(self.request("/state/all", cookie=latest)[0], 401)

    def test_unauthenticated_and_cross_origin_requests_fail_closed(self):
        self.assertEqual(self.request("/state/all")[0], 401)
        self.assertEqual(self.request("/path/quiz", {})[0], 401)
        self.assertEqual(
            self.request(
                "/state/put",
                {"entries": {}},
                self.admin,
                extra={"Origin": "http://evil.example"},
            )[0],
            403,
        )
        self.assertEqual(
            self.request(
                "/state/put",
                {"entries": {}},
                self.admin,
                extra={"Content-Type": "text/plain"},
            )[0],
            415,
        )
        self.assertEqual(
            self.request(
                "/admin/users/create",
                {
                    "username": "../bad",
                    "display_name": "x",
                    "password": "learner-password",
                },
                self.admin,
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                "/admin/users/create",
                {
                    "username": "ALICE",
                    "display_name": "x",
                    "password": "learner-password",
                },
                self.admin,
            )[0],
            409,
        )
        self.assertEqual(
            self.request(
                "/admin/users/update",
                {"user_id": "u0", "changes": {"active": False}},
                self.admin,
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                "/state/put",
                {"entries": {"learn-path-v1-bad": "{}"}},
                self.alice_cookie,
            )[0],
            400,
        )

    def test_credentials_are_hashed_and_restart_keeps_sessions(self):
        filename = Path(self.app.settings.state_dir + "-accounts") / "accounts.json"
        data = filename.read_text()
        self.assertNotIn("admin-test-password", data)
        self.assertNotIn("learner-password", data)
        self.assertNotIn(self.alice_cookie.split("=", 1)[1], data)
        self.assertEqual(filename.stat().st_mode & 0o777, 0o600)
        from user_accounts import AccountStore

        reopened = AccountStore(filename.parent, "")
        self.assertEqual(
            reopened.authenticate(self.alice_cookie.split("=", 1)[1])["id"], self.alice
        )

    def test_legacy_u0_data_is_not_visible_to_new_users(self):
        self.app.repository.write_key("learn-path-v1-old", '{"topic":"old data"}')
        self.assertEqual(
            self.app.repository.material("u0/learn-path-v1-old")["topic"], "old data"
        )
        _, own, _ = self.request("/state/all", cookie=self.alice_cookie)
        self.assertFalse(own["entries"])
        _, legacy, _ = self.request("/state/all", cookie=self.admin)
        self.assertIn("u0/learn-path-v1-old", legacy["entries"])
        self.request(
            "/state/delete",
            {"keys": ["u0/learn-path-v1-old"], "password": "admin-test-password"},
            self.admin,
        )
        self.assertIsNone(self.app.repository.read_key("u0/learn-path-v1-old"))


if __name__ == "__main__":
    unittest.main()
