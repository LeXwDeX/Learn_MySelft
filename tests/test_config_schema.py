"""Reject malformed state/configuration before persistence or upstream work."""

import io
import json
import ssl
from email.message import Message
import unittest
from unittest.mock import patch
from app_config import Settings
from state_schema import validate_value
from user_accounts import AccountError
from http_io import read_json_body
from model_client import ModelClient
import model_client


class ConfigSchemaTests(unittest.TestCase):
    def test_configuration_rejects_ambiguous_or_unbounded_values(self):
        for settings in [
            {"PORT": "0"},
            {"JOB_WORKERS": "999"},
            {"UPSTREAM_TIMEOUT": "never"},
            {"LLM_BASE": "file:///tmp/private"},
            {"LLM_BASE": "http://user:pass@host"},
            {"LLM_MODEL": ""},
            {"MANIM_ENGINE": "svg"},
        ]:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                Settings.from_env(settings)
        self.assertEqual(Settings.from_env({"PORT": "8111"}).port, 8111)
        self.assertEqual(Settings.from_env({}).manim_engine, "manimgx")
        self.assertEqual(Settings.from_env({"MANIM_ENGINE": "manimgl"}).manim_engine, "manimgl")

    def test_nested_state_types_and_vocabulary(self):
        for name, value in [
            ("history", {}),
            ("plan", "broken"),
            ("nodeDetail", []),
            ("nodeState", []),
            ("nodeState", {"n1": {"completed": "yes"}}),
            ("stage", "unknown"),
        ]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_value(
                    "u0/learn-path-v1-example",
                    json.dumps({"topic": "example", name: value}),
                )
        validate_value("u0/knowledge-map-v1-marks", '{"n1":{"s":"again","t":123}}')
        validate_value(
            "u0/knowledge-map-ai-v1-n1", '[{"role":"user","content":"说明一下"}]'
        )
        with self.assertRaises(ValueError):
            validate_value("u0/knowledge-map-ai-v1-n1", "{}")

    def test_request_body_limits_are_checked_before_read(self):
        headers = Message()
        stream = io.BytesIO(b"{}")
        for value, status in [("-1", 400), ("999999999", 413), ("invalid", 400),
                              ("+2", 400), ("２", 400), ("0", 400), ("2, 2", 400),
                              ("9" * 5000, 413)]:
            headers.replace_header(
                "Content-Length", value
            ) if "Content-Length" in headers else headers.add_header(
                "Content-Length", value
            )
            with self.assertRaises(AccountError) as caught:
                read_json_body(headers, stream, Settings.from_env({}))
            self.assertEqual(caught.exception.status, status)
            self.assertEqual(stream.tell(), 0)

    def test_streaming_client_verifies_tls(self):
        with patch.object(
            model_client.urllib.request, "urlopen", return_value=None
        ) as opened:
            ModelClient(Settings.from_env({})).stream([])
            context = opened.call_args.kwargs["context"]
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
