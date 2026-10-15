"""Isolated comprehensive generation gates; never calls an upstream or renderer."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "study-assistant"))
from application import create_application
from background_jobs import JobQueue
import generation_contracts as contracts
from job_execution import JobDeadlineExceeded
import quiz_harness as harness

KEY = "u0/learn-path-v1-quizmap-generation"
OLD = "u0/quiz-map-v1-previous"
PROMPTS = ["观察日晷影子的方向变化，可以判断什么信息？", "把苹果均分给两人时，每个人得到的份额是多少？", "植物叶片在阳光下主要完成哪一种过程？", "一张三角形纸片有多少条边？", "读到文章结尾时应如何概括中心思想？", "在地图上查找河流通常需要关注哪种符号？", "比较两组实验数据之前应先确认哪个条件？", "制作木制书架前测量长度适合使用什么工具？"]


def questions():
    return [dict(q=text, type="choice", options=["正确选项", "不同答案", "另一答案", "无关答案"], answer="A", explain="独立验题检查此参考。", points=12 if i < 4 else 13, point="L1 Basics", scoring={"mode": "single_choice"}) for i, text in enumerate(PROMPTS)]


def verified(valid=True):
    return {"questions": [dict(index=i, valid=valid, reference_complete=valid, reason="accepted" if valid else "PRIVATE MODEL REPLY") for i in range(8)]}


class QuizmapGenerationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.app = create_application({"STATE_DIR": str(Path(tmp.name) / "state"), "DELETE_PASSWORD": "test-only"})
        self.addCleanup(self.app.close)
        self.repo = self.app.repository
        self.repo.write_key(KEY, json.dumps({"topic": "Basics", "plan": {"nodes": [{"id": "n1", "title": "Basics", "deps": []}]}, "nodeDetail": {}, "nodeState": {"n1": {"score": 80, "completed": True}}}))
        old_questions = [dict(questions()[0], q="旧历史题：请找出昨天使用的温度计。", points=100)]
        old = {"sourceKey": KEY, "sourceSlug": "quizmap-generation", **contracts._issued_quiz(old_questions)}
        old["rounds"][0]["attempts"] = [{"id": "old-attempt", "result": {"score": 80, "pass": True}}]
        self.repo.write_key(OLD, json.dumps(old))
        self.before = self.repo.all("u0")
        self.events = []
        self.real_job_event = self.repo.store.job_event
        self.event = self.enterContext(patch.object(self.repo.store, "job_event", side_effect=lambda kind, label, **fields: self.events.append({"kind": kind, "label": label, **fields})))
        self.render = self.enterContext(patch.object(self.app.verification, "review_rendered", return_value={"status": "passed"}))
        self.real_put = self.repo.put_entries
        self.put = self.enterContext(patch.object(self.repo, "put_entries", wraps=self.repo.put_entries))
        self.model = self.enterContext(patch.object(self.app.model, "nonempty", side_effect=self.respond))
        self.generate = lambda: json.dumps({"questions": questions()})
        self.verify = lambda: json.dumps(verified())

    def respond(self, messages, **options):
        phase = next(event["stage_id"] for event in reversed(self.events) if "stage_id" in event)
        self.assertEqual(phase, "generation_parse" if options.get("tries") == 1 else "independent_verification")
        return self.generate() if options.get("tries") == 1 else self.verify()

    def run_quizmap(self):
        return self.app.quizzes.quizmap("/path/quizmap", {"key": KEY}, {"id": "u0"})

    def assert_unchanged(self):
        self.assertEqual(self.repo.all("u0"), self.before)
        self.put.assert_not_called()

    def generations(self):
        return [call for call in self.model.call_args_list if call.kwargs.get("tries") == 1]

    def assert_success(self, maximum):
        with patch.object(self.app.model, "settings", SimpleNamespace(max_output_tokens=maximum)):
            status, out = self.run_quizmap()
            self.assertEqual(status, 200)
            params = self.generations()[-1].kwargs
            self.assertEqual(params, {"tries": 1, "max_tokens": min(maximum, 16384), "reasoning_effort": "medium", "response_format": "json_object", "temperature": 0.5})
            self.assertEqual(out["count"], 8)
            issued = self.repo.material("u0/quiz-map-v1-" + out["slug"])
            self.assertTrue(issued["rounds"][0]["verified"])
            self.assertEqual(issued["render_review"]["status"], self.render.return_value["status"])
            phases = [event["stage_id"] for event in self.events if "stage_id" in event]
            self.assertEqual(phases[-5:], ["generation_parse", "static_contract", "independent_verification", "render_review", "save"])
            self.assertEqual(self.put.call_count, 1)
            self.assertEqual(self.repo.read_key(KEY), self.before[KEY])
            self.assertEqual(self.repo.read_key(OLD), self.before[OLD])

    def test_structured_request_caps_and_success_saves_once_after_all_gates(self):
        self.assert_success(32000)

    def test_configured_output_cap_is_not_increased(self):
        self.assert_success(4096)

    def test_three_candidates_on_empty_or_invalid_json_never_issue(self):
        for text in ("", "invalid PRIVATE MODEL REPLY", "{broken", "{}"):
            with self.subTest(text=text):
                self.model.reset_mock(); self.events.clear(); self.generate = lambda: text
                with self.assertRaises(harness.QuizContractError):
                    self.run_quizmap()
                self.assertEqual(len(self.generations()), 3)
                self.render.assert_not_called(); self.assert_unchanged()
                self.assertEqual([event["generation_attempt"] for event in self.events if event["kind"] == "error"], [1, 2, 3])
                self.assertNotIn("PRIVATE", json.dumps(self.events))

    def test_independent_rejection_or_empty_verification_cannot_issue(self):
        for reply in (json.dumps(verified(False)), ""):
            with self.subTest(reply=reply):
                self.model.reset_mock(); self.events.clear(); self.verify = lambda: reply
                with self.assertRaises(harness.QuizContractError): self.run_quizmap()
                self.assertEqual(len(self.generations()), 3)
                self.render.assert_not_called(); self.assert_unchanged()
                errors = [event for event in self.events if event["kind"] == "error"]
                self.assertTrue(all(event["failure_stage"] == "independent_verification" and event["error_category"] == "verification_rejected" for event in errors))
                self.assertNotIn("PRIVATE", json.dumps(self.events))

    def test_static_contract_node_mapping_and_history_dedupe_remain_required(self):
        for mutation in (lambda q: q.pop(), lambda q: q[0].update(point="missing node"), lambda q: q[0].update(points=1), lambda q: q[0].update(q="旧历史题：请找出昨天使用的温度计。")):
            with self.subTest(mutation=mutation):
                self.model.reset_mock(); self.events.clear()
                candidate = questions(); mutation(candidate); self.generate = lambda: json.dumps({"questions": candidate})
                with self.assertRaises(harness.QuizContractError): self.run_quizmap()
                self.assertEqual(len(self.generations()), 3); self.assertEqual(self.model.call_count, 3)
                self.render.assert_not_called(); self.assert_unchanged()
                self.assertTrue(all(event["failure_stage"] == "static_contract" for event in self.events if event["kind"] == "error"))

    def test_render_rejection_keeps_old_material_and_history(self):
        self.render.side_effect = harness.QuizContractError("PRIVATE RENDER CONTENT")
        with self.assertRaises(harness.QuizContractError): self.run_quizmap()
        self.assertEqual(len(self.generations()), 3); self.assertEqual(self.render.call_count, 3); self.assert_unchanged()
        self.assertTrue(all(event["failure_stage"] == "render_review" for event in self.events if event["kind"] == "error"))
        self.assertNotIn("PRIVATE", json.dumps(self.events))

    def test_unavailable_failed_or_malformed_render_result_never_issues(self):
        for review in ({"status": "unavailable"}, {"status": "failed"}, {"passed": True}, {}, None, [], "passed"):
            with self.subTest(review=review):
                self.model.reset_mock(); self.events.clear(); self.render.reset_mock()
                self.render.return_value = review
                with self.assertRaises(harness.QuizContractError): self.run_quizmap()
                self.assertEqual(len(self.generations()), 3)
                self.assertEqual(self.render.call_count, 3)
                self.assert_unchanged()
                self.assertTrue(all(event["failure_stage"] == "render_review" and event["error_category"] == "render_rejected" for event in self.events if event["kind"] == "error"))

    def test_render_not_needed_is_an_explicit_success(self):
        self.render.return_value = {"status": "not_needed"}
        self.assert_success(16384)

    def test_source_deleted_during_render_is_not_revived(self):
        def deleted(_):
            self.repo.put_entries({KEY: None}, trusted=True)
            return {"status": "passed"}
        self.render.side_effect = deleted
        with self.assertRaisesRegex(ValueError, "已删除"): self.run_quizmap()
        self.assertIsNone(self.repo.material(KEY)); self.assertEqual(self.repo.read_key(OLD), self.before[OLD])
        self.assertEqual(self.put.call_count, 1, "only the concurrent deletion wrote state")
        self.assertEqual(set(self.repo.all("u0")), set(self.before))
        self.assertEqual(self.events[-1]["failure_stage"], "save")

    def test_save_failure_rolls_back_new_exam_and_preserves_source_and_history(self):
        def fail_after_write(*args, **options):
            self.real_put(*args, **options)
            raise RuntimeError("PRIVATE STORAGE CONTENT")
        self.put.side_effect = fail_after_write
        with self.assertRaises(RuntimeError): self.run_quizmap()
        self.assertEqual(self.put.call_count, 1)
        self.assertEqual(self.repo.all("u0"), self.before)
        self.assertEqual(self.events[-1]["failure_stage"], "save")
        self.assertEqual(self.events[-1]["error_category"], "save_failed")
        self.assertNotIn("PRIVATE", json.dumps(self.events))

    def test_persisted_stages_separate_candidate_from_job_attempt_and_keep_300_seconds(self):
        queue = JobQueue(self.repo.store, lambda *args: (200, {}))
        receipt = queue.submit("u0", "safe-diagnostics", "/path/quizmap", {"key": KEY})
        self.assertEqual(receipt["timeout_seconds"], 300)
        self.repo.store.local.job_id = receipt["id"]
        self.repo.store.local.job_attempt = 4
        self.addCleanup(lambda: delattr(self.repo.store.local, "job_id"))
        self.addCleanup(lambda: delattr(self.repo.store.local, "job_attempt"))
        def record(kind, label, **fields):
            self.events.append({"kind": kind, "label": label, **fields})
            self.real_job_event(kind, label, **fields)
        self.event.side_effect = record
        self.generate = lambda: "PRIVATE INVALID RESPONSE"
        with self.assertRaises(harness.QuizContractError): self.run_quizmap()
        events = queue.details(receipt["id"], "u0")["details"]["events"]
        stages = [event for event in events if "stage_id" in event]
        self.assertEqual([event["generation_attempt"] for event in stages], [1, 2, 3])
        self.assertTrue(all(event["attempt"] == 4 for event in stages))
        self.assertTrue(all(event["attempt"] == 4 for event in events if event["kind"] == "error"))
        self.assertNotIn("PRIVATE", json.dumps(events))
        self.assert_unchanged()

    def test_deadline_is_not_a_new_candidate_or_new_budget(self):
        self.generate = lambda: (_ for _ in ()).throw(JobDeadlineExceeded())
        with self.assertRaises(JobDeadlineExceeded): self.run_quizmap()
        self.assertEqual(len(self.generations()), 1); self.assert_unchanged()
        self.assertEqual(self.events[-1]["error_category"], "deadline")
        self.assertEqual(self.events[-1]["failure_stage"], "generation_parse")


if __name__ == "__main__":
    unittest.main()
