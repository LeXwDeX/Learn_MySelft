"""State regressions use an isolated store and never call an upstream model."""

import concurrent.futures
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import sys
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "study-assistant"))
from application import create_application
import generation_contracts as contracts
import prompts

KEY = "u0/learn-path-v1-regression"
PLAN = {
    "nodes": [
        {"id": "n1", "title": "Basics", "deps": []},
        {"id": "n2", "title": "Practice", "deps": ["n1"]},
    ],
    "edges": [["n1", "n2"]],
}


class StateRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = create_application(
            {
                "STATE_DIR": str(Path(self.tmp.name) / "state"),
                "DELETE_PASSWORD": "test-password",
            }
        )
        self.addCleanup(self.app.close)
        self.store = self.app.accounts
        _, self.token = self.store.login("admin", "test-password", "127.0.0.1")
        self.headers = {
            "Content-Type": "application/json",
            "Cookie": "learn_session=" + self.token,
        }
        self.server = self.app.server(("127.0.0.1", 0))
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True
        )
        self.thread.start()

        def close_server():
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()

        self.addCleanup(close_server)
        self.initial = {
            "topic": "Regression",
            "plan": copy.deepcopy(PLAN),
            "nodeDetail": {},
            "nodeState": {"n1": {"score": 30, "completed": False}},
        }
        self.app.repository.write_key(KEY, json.dumps(self.initial))

    def post(self, path, body):
        request = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.server.server_port, path),
            json.dumps(body).encode(),
            self.headers,
        )
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            self.response_headers = response.headers
            return response.status, json.load(response)

    def material(self):
        return self.app.repository.material(KEY)

    def test_quizmap_title_uses_canonical_document_name(self):
        self.assertEqual(
            contracts._quizmap_title(
                {
                    "title": "八年级数学",
                    "topic": "请教我",
                    "plan": {"title": "不再引用的旧标题"},
                }
            ),
            "八年级数学综合测验",
        )
        self.assertEqual(
            contracts._quizmap_title(
                {"title": "日语动词", "spec": {"topic": "更宽泛的范围"}}
            ),
            "日语动词综合测验",
        )
        self.assertEqual(
            contracts._quizmap_title({"topic": "请教我"}), "学习资料综合测验"
        )

    def test_research_filters_before_brief_and_persists_verified_version(self):
        candidates = [
            {"title": "AI news", "url": "https://example.org/news", "snippet": "GPT"},
            {
                "title": "日本語の動詞",
                "url": "https://example.org/japanese",
                "snippet": "活用",
            },
        ]
        with (
            patch.object(self.app.model, "search", return_value=candidates),
            patch.object(
                self.app.model,
                "nonempty",
                side_effect=['["日语 动词"]', '{"selected_ids":[2]}', "动词活用 [1]"],
            ) as model,
        ):
            status, result = self.post(
                "/path/research", {"key": KEY, "spec": {"topic": "日语"}}
            )
        self.assertEqual(status, 200)
        self.assertEqual(result["sources"], candidates[1:])
        brief_input = model.call_args_list[2].args[0][1]["content"]
        self.assertNotIn("AI news", brief_input)
        self.assertIn("[1] 日本語の動詞", brief_input)
        self.assertEqual(self.material()["research_version"], 2)

    def test_unverified_research_cache_and_material_context(self):
        self.app.repository.merge(
            KEY, {"brief": "old", "queries": ["old"], "sources": []}
        )
        self.assertIsNone(self.app.repository.stage_result(KEY, "research"))
        for status in ["missing", "generating", "failed"]:
            prompt = prompts.build_system(
                {"material_status": status, "unit_title": "日语"}
            )
            self.assertIn("正文尚未就绪", prompt)
            self.assertIn("实际作答证据", prompt)
        self.assertNotIn(
            "正文尚未就绪",
            prompts.build_system({"material_status": "ready", "notes": "正文"}),
        )

    def test_all_deletion_routes_require_password(self):
        for path, body in [
            ("/state/delete", {"keys": [KEY]}),
            ("/state/del", {"keys": [KEY]}),
            ("/state/put", {"entries": {KEY: None}}),
        ]:
            for password in [None, "wrong", 7, {"value": "test-password"}]:
                with self.subTest(path=path, password=password):
                    self.assertEqual(
                        self.post(path, {**body, "password": password})[0], 403
                    )
                    self.assertEqual(self.material(), self.initial)
            self.assertEqual(
                self.post(path, {**body, "password": "test-password"})[0], 200
            )
            self.assertIsNone(self.app.repository.read_key(KEY))
            self.app.repository.write_key(KEY, json.dumps(self.initial))

    def test_account_password_survives_environment_change(self):
        with patch.dict("os.environ", {"DELETE_PASSWORD": ""}):
            self.assertEqual(self.post("/state/del", {"keys": [KEY]})[0], 403)
        self.assertEqual(self.material(), self.initial)

    def test_mixed_batch_is_not_partially_applied(self):
        self.assertEqual(
            self.post("/state/put", {"entries": {"u0/metadata": "changed", KEY: None}})[
                0
            ],
            403,
        )
        self.assertIsNone(self.app.repository.read_key("u0/metadata"))
        self.assertEqual(self.material(), self.initial)

    def test_invalid_material_values_cannot_disappear_from_library(self):
        for value in [
            "null",
            "[]",
            "{}",
            "not-json",
            "true",
            3,
            {},
            [],
            {"spec": {"topic": "hidden draft"}},
        ]:
            with self.subTest(value=value):
                self.assertEqual(
                    self.post(
                        "/state/put",
                        {"entries": {"u0/metadata": "changed", KEY: value}},
                    )[0],
                    400,
                )
                self.assertEqual(self.material(), self.initial)
                self.assertIsNone(self.app.repository.read_key("u0/metadata"))

    def test_ordinary_draft_metadata_and_quiz_saves(self):
        entries = {
            "u0/learn-path-v1-draft": json.dumps({"topic": "new", "stage": "intake"}),
            "u0/learn-path-v1-last": "draft",
            "u0/learn-ai-v1-draft": "{}",
            "u0/quiz-map-v1-draft": json.dumps(
                {"questions": [{"q": "Q", "answer": "A"}]}
            ),
        }
        self.assertEqual(self.post("/state/put", {"entries": entries})[0], 200)
        self.assertEqual(self.app.repository.read_key("u0/learn-path-v1-last"), "draft")

    def test_invalid_keys_and_alias_routes(self):
        for path, body in [
            ("/state/del", {"keys": KEY}),
            ("/state/put", []),
            ("/state/delete-other", {"keys": [KEY]}),
            ("/state/del/", {"keys": [KEY]}),
        ]:
            self.assertIn(self.post(path, body)[0], (400, 404))
            self.assertEqual(self.material(), self.initial)

    def test_concurrent_merge_keeps_each_node_and_plan(self):
        original = self.app.repository.material

        def slow_read(key):
            result = original(key)
            time.sleep(0.003)  # Widen the old read/write-lock gap deterministically.
            return result

        def update(i):
            patch_data = (
                {"nodeDetail": {f"n{i}": {"study_notes": str(i)}}}
                if i
                else {"brief": "new brief"}
            )
            return self.app.repository.merge(KEY, patch_data)

        with patch.object(self.app.repository, "material", slow_read):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                self.assertTrue(all(pool.map(update, range(12))))
        result = self.material()
        self.assertEqual(len(result["nodeDetail"]), 11)
        self.assertEqual(result["brief"], "new brief")
        self.assertEqual(result["plan"], PLAN)

    def refine(self, title="Remedial", nid="n1"):
        generated = {
            "units": [
                {
                    "for": nid,
                    "title": title,
                    "essence": "basics",
                    "objectives": ["practice"],
                }
            ]
        }
        with patch.object(
            self.app.model, "nonempty", return_value=json.dumps(generated)
        ):
            return self.post(
                "/path/refine",
                {
                    "key": KEY,
                    "plan": copy.deepcopy(PLAN),
                    "weaknesses": [{"nid": nid, "reason": "failed"}],
                },
            )

    def test_refinement_inherits_prerequisites_not_failed_parent(self):
        status, result = self.refine()
        self.assertEqual(status, 200)
        self.assertEqual(result["plan"]["nodes"][1]["deps"], [])
        status, result = self.refine(nid="n2")
        self.assertEqual(result["plan"]["nodes"][-1]["deps"], ["n1"])
        self.assertFalse(self.material()["nodeState"]["n1"]["completed"])

    def test_repeated_refinement_ignores_stale_client_plan(self):
        self.refine("First")
        self.refine("Second")
        nodes = self.material()["plan"]["nodes"]
        self.assertEqual([n["title"] for n in nodes[1:3]], ["First", "Second"])
        self.assertEqual([n["id"] for n in nodes], ["n1", "n3", "n4", "n2"])
        self.assertEqual(self.material()["nodeState"], self.initial["nodeState"])

    def test_parallel_refinement_allocates_distinct_ids(self):
        def append(i):
            return self.app.repository.append_refinement(
                KEY,
                PLAN,
                [{"for": "n1", "title": str(i), "essence": "", "objectives": []}],
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(append, range(10)))
        nodes = self.material()["plan"]["nodes"]
        self.assertEqual(len(nodes), 12)
        self.assertEqual(len({n["id"] for n in nodes}), 12)

    def test_stale_browser_save_preserves_generated_plan_and_nodes(self):
        self.refine("Keep me")
        self.app.repository.merge(KEY, {"nodeDetail": {"n3": {"study_notes": "new"}}})
        self.assertEqual(
            self.post("/state/put", {"entries": {KEY: json.dumps(self.initial)}})[0],
            200,
        )
        self.assertEqual(self.material()["plan"]["nodes"][1]["title"], "Keep me")
        self.assertIn("n3", self.material()["nodeDetail"])

    def test_missing_parent_rejects_without_writing(self):
        self.assertEqual(self.refine(nid="missing")[0], 400)
        self.assertEqual(self.material(), self.initial)
        self.assertFalse(self.app.cache.gates)

    def test_deleted_material_cannot_be_resurrected_by_generation(self):
        self.post("/state/del", {"keys": [KEY], "password": "test-password"})
        self.assertFalse(self.app.repository.merge(KEY, {"brief": "late result"}))
        self.assertEqual(self.refine()[0], 404)
        self.assertIsNone(self.app.repository.read_key(KEY))

    def test_http_boundary_delete_and_save(self):
        server = self.app.server(("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = "http://127.0.0.1:%d/state/del" % server.server_port

            def request(body):
                req = urllib.request.Request(
                    url,
                    json.dumps(body).encode(),
                    {
                        "Content-Type": "application/json",
                        "Cookie": "learn_session=" + self.token,
                    },
                )
                try:
                    with urllib.request.urlopen(req) as response:
                        return response.status
                except urllib.error.HTTPError as response:
                    with response:
                        return response.code

            self.assertEqual(request({"keys": [KEY]}), 403)
            self.assertEqual(request({"keys": [KEY], "password": "test-password"}), 200)
            self.assertIsNone(self.app.repository.read_key(KEY))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
