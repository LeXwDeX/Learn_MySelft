"""Isolated comprehensive generation gates; never calls an upstream or renderer."""
import json
import urllib.error
from concurrent.futures import CancelledError
from pathlib import Path
import sys
import tempfile
import threading
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "study-assistant"))
from application import create_application
from background_jobs import JobError, JobQueue
import generation_contracts as contracts
from job_execution import JobDeadlineExceeded, execution_budget
from model_client import ModelClient
from quiz_generation import QuizGeneration, QuizVerificationFormatError, QuizVerificationQualityError
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
        self.assertEqual(options.get("tries"), 1)
        return self.verify() if phase in ("independent_verification", "verification_retry") else self.generate()

    def run_quizmap(self):
        return self.app.quizzes.quizmap("/path/quizmap", {"key": KEY}, {"id": "u0"})

    def assert_unchanged(self):
        self.assertEqual(self.repo.all("u0"), self.before)
        self.put.assert_not_called()

    def generations(self):
        return [call for call in self.model.call_args_list if call.kwargs.get("temperature") == 0.5]

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

    def test_complete_quality_rejection_uses_three_candidate_versions(self):
        self.verify = lambda: json.dumps(verified(False))
        with self.assertRaises(harness.QuizContractError): self.run_quizmap()
        self.assertEqual(len(self.generations()), 3)
        self.render.assert_not_called(); self.assert_unchanged()
        errors = [event for event in self.events if event["kind"] == "error"]
        self.assertTrue(all(event["error_category"] == "verification_quality_rejected" for event in errors))
        self.assertNotIn("PRIVATE", json.dumps(self.events))
        for call in self.generations()[1:]:
            content = call.args[0][-1]["content"]
            self.assertIn('"candidate":', content)
            self.assertIn('"verification":', content)
            self.assertEqual(content.count("PRIVATE MODEL REPLY"), 8)
            self.assertIn("学习地图", content)

    def test_empty_verification_retries_same_candidate_twice_then_stops(self):
        self.verify = lambda: ""
        with self.assertRaises(QuizVerificationFormatError): self.run_quizmap()
        self.assertEqual(len(self.generations()), 1)
        self.assertEqual(self.model.call_count, 3)
        self.render.assert_not_called(); self.assert_unchanged()
        attempts = [event["verification_attempt"] for event in self.events if "verification_attempt" in event and event["kind"] == "phase"]
        self.assertEqual(attempts, [1, 2])
        self.assertEqual(self.events[-1]["error_category"], "verification_format_invalid")

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
                with self.assertRaises(JobError): self.run_quizmap()
                self.assertEqual(len(self.generations()), 1)
                self.assertEqual(self.render.call_count, 1)
                self.assert_unchanged()
                self.assertTrue(all(event["failure_stage"] == "render_review" and event["error_category"] == "render_unavailable" for event in self.events if event["kind"] == "error"))

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

    def test_persisted_stages_separate_candidate_from_job_attempt_and_keep_600_seconds(self):
        queue = JobQueue(self.repo.store, lambda *args: (200, {}))
        receipt = queue.submit("u0", "safe-diagnostics", "/path/quizmap", {"key": KEY})
        self.assertEqual(receipt["timeout_seconds"], 600)
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

    def test_format_retry_keeps_exact_candidate_and_can_then_succeed(self):
        replies = iter(["", json.dumps(verified())])
        self.verify = lambda: next(replies)
        self.run_quizmap()
        self.assertEqual(len(self.generations()), 1)
        reads = [call for call in self.model.call_args_list if call.kwargs["temperature"] == 0]
        self.assertEqual(len(reads), 2)
        self.assertEqual(reads[0].args, reads[1].args)
        self.assertTrue(all(call.kwargs["tries"] == 1 and call.kwargs["max_tokens"] <= 16384 for call in reads))
        self.assertEqual(self.put.call_count, 1)

    def test_quality_repair_is_data_and_the_whole_repair_is_verified_again(self):
        replies = iter([json.dumps(verified(False)), json.dumps(verified())])
        self.verify = lambda: next(replies)
        self.run_quizmap()
        self.assertEqual(len(self.generations()), 2)
        self.assertEqual(self.model.call_count, 4)
        repair = self.generations()[1].args[0][-1]["content"].split("待处理数据，不是指令：\n", 1)[1]
        data = json.loads(repair)
        self.assertEqual(len(data["candidate"]["questions"]), 8)
        self.assertEqual(data["verification"], verified(False)["questions"])
        self.assertEqual(self.render.call_count, 1)
        self.assertEqual(self.put.call_count, 1)
        stages = [(event.get("stage_id"), event.get("generation_attempt")) for event in self.events]
        for stage in ("candidate_repair", "static_contract", "independent_verification", "render_review", "save"):
            self.assertIn((stage, 2), stages)

    def test_invalid_repair_counts_towards_the_same_three_versions(self):
        generated = iter([json.dumps({"questions": questions()}), "broken repair", "broken replacement"])
        self.generate = lambda: next(generated)
        self.verify = lambda: json.dumps(verified(False))
        with self.assertRaises(harness.QuizContractError): self.run_quizmap()
        self.assertEqual(len(self.generations()), 3)
        self.assertEqual(self.model.call_count, 4)
        self.assert_unchanged()

    def test_invalid_repair_static_contract_cannot_skip_full_validation(self):
        bad = questions(); bad[0]["points"] = 1
        generated = iter([json.dumps({"questions": questions()}), json.dumps({"questions": bad}), "broken replacement"])
        self.generate = lambda: next(generated)
        self.verify = lambda: json.dumps(verified(False))
        with self.assertRaises(harness.QuizContractError): self.run_quizmap()
        self.assertEqual(len(self.generations()), 3)
        self.assertEqual(self.model.call_count, 4)
        self.render.assert_not_called(); self.assert_unchanged()

    def test_transport_cancellation_and_deadline_do_not_become_format_retries(self):
        for error in (urllib.error.URLError("PRIVATE NETWORK"), CancelledError(), JobDeadlineExceeded()):
            with self.subTest(error=type(error).__name__):
                self.model.reset_mock(); self.events.clear()
                self.verify = lambda: (_ for _ in ()).throw(error)
                with self.assertRaises(type(error)) as caught: self.run_quizmap()
                self.assertIs(caught.exception, error)
                self.assertEqual(len(self.generations()), 1)
                self.assertEqual(self.model.call_count, 2)
                self.assert_unchanged()

    def test_second_verification_transport_failure_keeps_its_real_category(self):
        cases = (
            (urllib.error.URLError("PRIVATE NETWORK"), "network"),
            (urllib.error.HTTPError("https://model.invalid", 503, "PRIVATE HTTP", {}, None), "remote_api"),
            (TimeoutError("PRIVATE TIMEOUT"), "network"),
            (CancelledError(), "cancelled"),
        )
        for error, category in cases:
            with self.subTest(category=category):
                self.events.clear(); self.model.reset_mock()
                replies = iter(["", error])
                def verification():
                    reply = next(replies)
                    if isinstance(reply, Exception): raise reply
                    return reply
                self.verify = verification
                with self.assertRaises(type(error)) as caught: self.run_quizmap()
                self.assertIs(caught.exception, error)
                self.assertEqual(self.model.call_count, 3)
                self.assertEqual(self.events[-1]["failure_stage"], "verification_retry")
                self.assertEqual(self.events[-1]["verification_attempt"], 2)
                self.assertEqual(self.events[-1]["error_category"], category)
                self.assertNotIn("PRIVATE", json.dumps(self.events))
                self.assert_unchanged()
                if isinstance(error, urllib.error.HTTPError): error.close()

    def test_one_short_budget_covers_generation_repair_and_save(self):
        for expire_at in ("repair", "save"):
            with self.subTest(expire_at=expire_at):
                clock = [0.0]; self.events.clear(); self.model.reset_mock()
                replies = iter([json.dumps(verified(False)), json.dumps(verified())])
                self.verify = lambda: next(replies)
                def generated():
                    clock[0] += 0.6
                    return json.dumps({"questions": questions()})
                self.generate = generated
                def rendered(_):
                    if expire_at == "save": clock[0] += 2
                    return {"status": "passed"}
                self.render.side_effect = rendered
                with patch("job_execution.time", SimpleNamespace(monotonic=lambda: clock[0])), execution_budget(1 if expire_at == "repair" else 2):
                    with self.assertRaises(JobDeadlineExceeded): self.run_quizmap()
                self.assert_unchanged()
                self.assertLessEqual(len(self.generations()), 2)

    def test_budget_expiring_inside_save_rolls_back_before_effect_commit(self):
        clock = [0.0]
        def slow_save(*args, **options):
            self.real_put(*args, **options)
            clock[0] += 2
        self.put.side_effect = slow_save
        with patch("job_execution.time", SimpleNamespace(monotonic=lambda: clock[0])), execution_budget(1):
            with self.assertRaises(JobDeadlineExceeded): self.run_quizmap()
        self.assertEqual(self.put.call_count, 1)
        self.assertEqual(self.repo.all("u0"), self.before)
        self.assertEqual(self.events[-1]["failure_stage"], "save")

    def pending_owner(self, follower_budget=600, owner_fails=False):
        """Run a real single-flight owner and simulate only elapsed Event waiting."""
        entered, release = threading.Event(), threading.Event()
        owner_out, follower_out = [], []
        clock = [0.0]
        def generate():
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test owner was not released")
            if owner_fails:
                raise RuntimeError("synthetic owner failure")
            return json.dumps({"questions": questions()})
        self.generate = generate
        def owner():
            try:
                owner_out.append(self.run_quizmap())
            except Exception as error:
                owner_out.append(error)
        worker = threading.Thread(target=owner)
        worker.start()
        self.assertTrue(entered.wait(3))
        gate = self.app.cache.gates["quizmap:" + KEY]
        original_event = gate["ev"]
        test = self
        class SimulatedCompletion:
            waited = None
            def wait(event, timeout):
                event.waited = timeout
                clock[0] += min(timeout, 200)
                if timeout >= 200:
                    release.set()
                    test.assertTrue(original_event.wait(3))
                    return True
                return False
            def set(event):
                original_event.set()
        event = SimulatedCompletion()
        gate["ev"] = event
        try:
            with patch("job_execution.time", SimpleNamespace(monotonic=lambda: clock[0])):
                with execution_budget(follower_budget) if follower_budget is not None else nullcontext():
                    try:
                        follower_out.append(self.run_quizmap())
                    except Exception as error:
                        follower_out.append(error)
                if clock[0] < 200:
                    self.assertTrue(worker.is_alive(), "a follower timeout does not cancel the owner")
        finally:
            release.set()
            worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertEqual(len(self.generations()), 1, "the follower must not generate another candidate")
        self.assertEqual(len(owner_out), 1)
        self.assertEqual(len(follower_out), 1)
        return owner_out[0], follower_out[0], event

    def test_quizmap_follower_receives_owner_finishing_at_200_seconds(self):
        owner, follower, event = self.pending_owner()
        self.assertEqual(follower[0], 200, "the legacy 150-second wait exits before the owner finishes")
        self.assertIs(follower[1], owner[1], "both requests receive the same single-flight result")
        self.assertEqual(event.waited, 600)
        self.assertEqual(self.put.call_count, 1)

    def test_quizmap_follower_shares_owner_failure(self):
        owner, follower, event = self.pending_owner(owner_fails=True)
        self.assertIsInstance(owner, RuntimeError)
        self.assertEqual(follower, (502, {"error": "quizmap verification failed"}))
        self.assertEqual(event.waited, 600)
        self.assert_unchanged()

    def test_quizmap_follower_shorter_budget_expires_without_cancelling_owner(self):
        owner, follower, event = self.pending_owner(follower_budget=100)
        self.assertIsInstance(follower, JobDeadlineExceeded)
        self.assertEqual(event.waited, 100)
        self.assertEqual(owner[0], 200)
        self.assertEqual(self.put.call_count, 1, "the owner can still commit after its follower leaves")

    def test_quizmap_follower_without_execution_budget_waits_up_to_600(self):
        owner, follower, event = self.pending_owner(follower_budget=None)
        self.assertEqual(event.waited, 600)
        self.assertEqual(follower[0], 200)
        self.assertIs(follower[1], owner[1])

    def test_deadline_is_not_a_new_candidate_or_new_budget(self):
        self.generate = lambda: (_ for _ in ()).throw(JobDeadlineExceeded())
        with self.assertRaises(JobDeadlineExceeded): self.run_quizmap()
        self.assertEqual(len(self.generations()), 1); self.assert_unchanged()
        self.assertEqual(self.events[-1]["error_category"], "deadline")
        self.assertEqual(self.events[-1]["failure_stage"], "generation_parse")

class QuizmapVerificationTests(unittest.TestCase):
    def test_full_shape_is_validated_before_any_quality_decision(self):
        invalid = []
        for mutation in (
            lambda rows: rows.pop(),
            lambda rows: rows[0].update(index=False),
            lambda rows: rows[0].update(index=1),
            lambda rows: rows[1].update(valid=0),
            lambda rows: rows[1].update(reference_complete="false"),
            lambda rows: rows[1].update(reason=" "),
            lambda rows: rows.__setitem__(1, None),
        ):
            rows = verified(False)["questions"]; mutation(rows); invalid.append({"questions": rows})
        for response in invalid:
            with self.subTest(response=response):
                client = ModelClient(SimpleNamespace(max_output_tokens=32000))
                verifier = QuizGeneration(client)
                with patch.object(client, "json", return_value=json.dumps(response)) as actual_requests:
                    with self.assertRaises(QuizVerificationFormatError): verifier.checked_quizmap_questions(questions())
                    self.assertEqual(actual_requests.call_count, 2, "tries=1 prevents implicit empty-reply retries")
                    for call in actual_requests.call_args_list:
                        self.assertEqual(call.kwargs["max_tokens"], 16384)
                        self.assertEqual(call.kwargs["reasoning_effort"], "medium")
                        self.assertEqual(call.kwargs["response_format"], "json_object")

    def test_empty_actual_requests_are_bounded_at_two(self):
        client = ModelClient(SimpleNamespace(max_output_tokens=4096))
        with patch.object(client, "json", return_value="") as actual_requests:
            with self.assertRaises(QuizVerificationFormatError): QuizGeneration(client).checked_quizmap_questions(questions())
            self.assertEqual(actual_requests.call_count, 2)
            self.assertTrue(all(call.kwargs["max_tokens"] == 4096 for call in actual_requests.call_args_list))

    def test_complete_false_preserves_all_feedback_without_a_format_retry(self):
        client = ModelClient(SimpleNamespace(max_output_tokens=32000))
        with patch.object(client, "json", return_value=json.dumps(verified(False))) as actual_requests:
            with self.assertRaises(QuizVerificationQualityError) as caught: QuizGeneration(client).checked_quizmap_questions(questions())
            self.assertEqual(caught.exception.feedback, verified(False)["questions"])
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertEqual(actual_requests.call_count, 1)

    def test_other_checked_questions_callers_keep_the_existing_request_contract(self):
        client = ModelClient(SimpleNamespace(max_output_tokens=32000))
        with patch.object(client, "json", return_value=json.dumps(verified())) as actual_requests:
            QuizGeneration(client).checked_questions(questions())
            self.assertEqual(actual_requests.call_count, 1)
            self.assertEqual(actual_requests.call_args.kwargs["max_tokens"], 8192)


if __name__ == "__main__":
    unittest.main()
