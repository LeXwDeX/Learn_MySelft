"""Logout remains safe and idempotent after revocation; other writes stay protected."""

import copy
import unittest
import test_state_regressions as base


class LogoutTests(unittest.TestCase):
    def setUp(self):
        self.case = base.StateRegressionTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def test_revoked_and_repeated_logout_clear_cookie_without_changing_users(self):
        before = copy.deepcopy(self.case.store.data["users"])
        self.case.store.logout(self.case.token)
        for _ in range(2):
            status, result = self.case.post("/auth/logout", {})
            self.assertEqual(status, 200)
            self.assertTrue(result["ok"])
            self.assertIn("Max-Age=0", self.case.response_headers["Set-Cookie"])
        self.assertEqual(self.case.store.data["users"], before)
        self.assertEqual(
            self.case.post(
                "/auth/password",
                {"old_password": "test-password", "new_password": "different-password"},
            )[0],
            401,
        )

    def test_logout_still_checks_origin(self):
        self.case.headers["Origin"] = "https://untrusted.example"
        self.assertEqual(self.case.post("/auth/logout", {})[0], 403)
