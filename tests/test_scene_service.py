"""Generic graphic decisions, bounded validation and atomic lesson supplements."""

import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "study-assistant"))
from application import create_application
from background_jobs import JobError
from prompts import SCENE_SUPPLEMENT, SCENE_TEACHING
from scene_contracts import SceneContractError, scenes_in, validate_scene
from user_accounts import AccountError


def diagram(dimension=2):
    start = [0] * dimension
    end = [2, 1] + ([1] if dimension == 3 else [])
    return {"version": 1, "type": "diagram", "title": "关系与变化", "summary": "观察箭头终点的变化。",
            "dimension": dimension, "elements": [
                {"id": "a", "kind": "arrow", "label": "起点到终点", "points": [start, end]},
                {"id": "region", "kind": "circle", "points": [start], "radius": 1}],
            "steps": [{"caption": "改变方向，观察位置关系。", "changes": [
                {"id": "a", "points": [start, [-1, 2] + ([2] if dimension == 3 else [])]},
                {"id": "region", "radius": 2, "opacity": 0.5}]}]}


def addition():
    return "观察下面的关系与变化。\n\n```learn-scene\n" + json.dumps(diagram(), ensure_ascii=False) + "\n```"


def response():
    return json.dumps({"needed": True, "reason": "位置关系更容易观察", "markdown": addition()}, ensure_ascii=False)


class SceneContractTests(unittest.TestCase):
    def test_supplement_prompt_ends_with_valid_outer_json_examples(self):
        final_instructions = SCENE_SUPPLEMENT.split(SCENE_TEACHING, 1)[1]
        examples = [json.loads(line) for line in final_instructions.splitlines()
                    if line.startswith('{"needed":')]
        self.assertEqual(len(examples), 2)
        self.assertEqual([example["needed"] for example in examples], [True, False])
        for example in examples:
            self.assertEqual(set(example), {"needed", "reason", "markdown"})
        self.assertEqual(len(scenes_in(examples[0]["markdown"])), 1)
        self.assertEqual(examples[1]["markdown"], "")

    def test_generic_shapes_steps_and_dimensions(self):
        for dimension in (2, 3):
            spec = diagram(dimension)
            self.assertEqual(validate_scene(spec), spec)
        self.assertEqual(scenes_in(addition())[0]["type"], "diagram")
        self.assertEqual(scenes_in("````text\n" + addition() + "\n````"), [])
        self.assertEqual(len(scenes_in(addition().replace("```", "~~~"))), 1)

    def test_invalid_fields_geometry_and_actions_are_rejected(self):
        invalid = []
        def case(change):
            value = diagram()
            change(value)
            invalid.append(value)
        case(lambda s: s.update({"code": "do_something()"}))
        case(lambda s: s.update({"dimension": True}))
        case(lambda s: s["elements"][0].update({"kind": "html"}))
        case(lambda s: s["elements"][0].update({"color": {"style": "red"}}))
        case(lambda s: s["elements"][0].update({"color": "#ff0000"}))
        case(lambda s: s["elements"][0].update({"points": [[0, 0], [True, 1]]}))
        case(lambda s: s["elements"][0].update({"points": [[0, 0], [float("nan"), 1]]}))
        case(lambda s: s["elements"][0].update({"points": [[0, 0], [11, 1]]}))
        case(lambda s: s["elements"][0].update({"radius": 1}))
        case(lambda s: s["elements"][1].update({"id": "a"}))
        case(lambda s: s["elements"][1].update({"radius": 0}))
        case(lambda s: s["steps"][0]["changes"][0].update({"id": "missing"}))
        case(lambda s: s["steps"][0]["changes"][0].update({"points": [[0, 0]]}))
        case(lambda s: s["steps"][0]["changes"].append({"id": "a", "opacity": 0}))
        case(lambda s: s["steps"].extend(s["steps"] * 8))
        for index, value in enumerate(invalid):
            with self.subTest(index=index), self.assertRaises(SceneContractError):
                validate_scene(value)
        for source in (addition().rsplit("```", 1)[0], "\n\n".join([addition()] * 5),
                       "```learn-scene\n" + " " * 12001 + "\n```"):
            with self.assertRaises(SceneContractError):
                scenes_in(source)


class SceneServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = create_application({"STATE_DIR": self.temp.name, "DELETE_PASSWORD": "test-password"})
        self.addCleanup(self.app.close)
        admin = self.app.accounts.get_user("u0")
        self.user = self.app.accounts.create_user(admin, "learner", "Learner", "learner-password")
        self.key = self.user["id"] + "/learn-path-v1-scenes"
        self.body = {"key": self.key, "node": {"id": "n1"}}
        self.material = {"topic": "数据库事务", "stage": "learning",
                         "plan": {"nodes": [{"id": "n1", "title": "事务状态", "objectives": ["理解状态转换"]}]},
                         "nodeDetail": {"n1": {"study_notes": "事务经历开始、读写与提交或回滚。", "extra": {"keep": 1},
                            "quiz": {"round_id": "old-round", "questions": [], "rounds": [], "history": ["original"]}}},
                         "nodeState": {"n1": {"completed": True, "score": 88, "lastResult": {"pass": True}}}}
        self.app.repository.write_key(self.key, json.dumps(self.material))
        self.review = patch.object(self.app.verification, "review_rendered", return_value={"status": "passed"})
        self.review.start()
        self.addCleanup(self.review.stop)

    def invoke(self):
        return self.app.run_job(self.user["id"], "/path/node/scene", self.body)

    def test_non_math_supplement_preserves_quiz_progress_and_unknown_fields(self):
        with patch.object(self.app.model, "nonempty", return_value=response()) as model:
            status, result = self.invoke()
            self.assertEqual(status, 200)
            self.assertFalse(result["reused"])
            self.assertEqual(result["source_notes"], self.material["nodeDetail"]["n1"]["study_notes"])
            self.assertTrue(result["study_notes"].startswith(self.material["nodeDetail"]["n1"]["study_notes"]))
            saved = self.app.repository.material(self.key)
            self.assertEqual(saved["nodeDetail"]["n1"]["quiz"], self.material["nodeDetail"]["n1"]["quiz"])
            self.assertEqual(saved["nodeDetail"]["n1"]["extra"], {"keep": 1})
            self.assertEqual(saved["nodeState"], self.material["nodeState"])
            model.reset_mock()
            self.assertTrue(self.invoke()[1]["reused"])
            model.assert_not_called()
            # A stale independent browser save cannot remove the new supplement.
            self.app.repository.put_entries({self.key: json.dumps(self.material)})
            after = self.app.repository.material(self.key)
            self.assertEqual(after["nodeDetail"]["n1"]["study_notes"], result["study_notes"])
            self.assertEqual(after["nodeDetail"]["n1"]["sceneSupplement"], result["sceneSupplement"])

    def test_client_cannot_plant_supplement_marker_on_first_or_later_save(self):
        key = self.user["id"] + "/learn-path-v1-untrusted-scene"
        planted = copy.deepcopy(self.material)
        planted["nodeDetail"]["n1"]["sceneSupplement"] = {
            "version": 1, "source_sha256": "a" * 64, "notes_sha256": "b" * 64}
        self.app.repository.put_entries({key: json.dumps(planted)})
        self.assertNotIn("sceneSupplement", self.app.repository.material(key)["nodeDetail"]["n1"])
        planted["nodeDetail"]["n1"]["study_notes"] = "更新的正文"
        self.app.repository.put_entries({key: json.dumps(planted)})
        saved = self.app.repository.material(key)["nodeDetail"]["n1"]
        self.assertNotIn("sceneSupplement", saved)
        self.assertEqual(saved["study_notes"], "更新的正文")

    def test_generic_decision_enriches_new_prose_and_can_decline(self):
        original = {"study_notes": "两组对象有共同的成员。", "quiz": {"immutable": "original"}}
        with patch.object(self.app.model, "nonempty", return_value=response()) as model:
            enriched = self.app.scenes.enrich_candidate(copy.deepcopy(original), {"title": "集合交集"})
            self.assertEqual(enriched["quiz"], original["quiz"])
            self.assertEqual(len(scenes_in(enriched["study_notes"])), 1)
            self.assertIn("集合交集", model.call_args.args[0][1]["content"])
        declined = {"needed": False, "reason": "本段是简短的学习约定，无结构或动态过程。", "markdown": ""}
        with patch.object(self.app.model, "nonempty", return_value=json.dumps(declined)):
            self.assertEqual(self.app.scenes.enrich_candidate(copy.deepcopy(original), {}), original)
            self.assertFalse(self.invoke()[1]["needed"])
            self.assertEqual(self.app.repository.material(self.key), self.material)

    def test_bad_graphics_get_one_retry_and_never_change_notes_on_failure(self):
        bad = json.dumps({"needed": True, "reason": "示意", "markdown": "```learn-scene\n{\"code\":\"private-script\"}\n```"})
        with patch.object(self.app.model, "nonempty", side_effect=[bad, response()]) as model:
            self.assertEqual(self.invoke()[0], 200)
            self.assertEqual(model.call_count, 2)
            self.assertNotIn("private-script", model.call_args_list[1].args[0][-1]["content"])
        self.app.repository.write_key(self.key, json.dumps(self.material))
        with patch.object(self.app.model, "nonempty", return_value=bad) as model:
            with self.assertRaises(JobError) as error:
                self.invoke()
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn("private-script", str(error.exception))
            self.assertEqual(model.call_count, 2)
            self.assertEqual(self.app.repository.material(self.key), self.material)

    def test_missing_markdown_outer_field_retries_then_accepts_only_complete_envelope(self):
        missing = json.dumps({"needed": True, "reason": "private-marker"}) + "\n" + addition()
        with patch.object(self.app.model, "nonempty", side_effect=[missing, response()]) as model:
            status, result = self.invoke()
            self.assertEqual(status, 200)
            self.assertEqual(len(scenes_in(result["study_notes"])), 1)
            self.assertEqual(model.call_count, 2)
            feedback = model.call_args_list[1].args[0][-1]["content"]
            for field in ("needed", "reason", "markdown"):
                self.assertIn(field, feedback)
            self.assertIn("一个完整 JSON 对象", feedback)
            self.assertIn("外层对象后", feedback)
            self.assertNotIn("private-marker", feedback)
        self.app.repository.write_key(self.key, json.dumps(self.material))
        with patch.object(self.app.model, "nonempty", return_value=missing) as model:
            with self.assertRaises(JobError) as error:
                self.invoke()
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn("private-marker", str(error.exception))
            self.assertEqual(model.call_count, 2)
            self.assertEqual(self.app.repository.material(self.key), self.material)

    def test_decline_without_markdown_is_not_accepted(self):
        missing = json.dumps({"needed": False, "reason": "无需图示"})
        decline = json.dumps({"needed": False, "reason": "没有图形收益", "markdown": ""})
        with patch.object(self.app.model, "nonempty", side_effect=[missing, decline]) as model:
            status, result = self.invoke()
            self.assertEqual(status, 200)
            self.assertFalse(result["needed"])
            self.assertEqual(model.call_count, 2)
            self.assertIn("markdown", model.call_args_list[1].args[0][-1]["content"])
            self.assertEqual(self.app.repository.material(self.key), self.material)
        with patch.object(self.app.model, "nonempty", return_value=missing) as model:
            with self.assertRaises(JobError) as error:
                self.invoke()
            self.assertEqual(error.exception.status, 502)
            self.assertEqual(model.call_count, 2)
            self.assertEqual(self.app.repository.material(self.key), self.material)

    def test_unavailable_renderer_is_not_reported_as_success(self):
        with patch.object(self.app.model, "nonempty", return_value=response()), \
                patch.object(self.app.verification, "review_rendered", return_value={"status": "unavailable"}):
            with self.assertRaises(JobError) as error:
                self.invoke()
            self.assertEqual(error.exception.status, 503)
            self.assertEqual(self.app.repository.material(self.key), self.material)

    def test_concurrent_notes_change_deletion_and_deactivation_are_rechecked(self):
        for mode in ("notes", "delete", "node", "deactivate"):
            self.app.repository.write_key(self.key, json.dumps(self.material))
            self.app.accounts.update_user(self.app.accounts.get_user("u0"), self.user["id"], {"active": True})
            def generate(*args, **kwargs):
                changed = copy.deepcopy(self.material)
                if mode == "notes":
                    changed["nodeDetail"]["n1"]["study_notes"] = "新的正文"
                    self.app.repository.write_key(self.key, json.dumps(changed))
                elif mode == "delete":
                    self.app.repository.write_key(self.key, None)
                elif mode == "node":
                    changed["plan"]["nodes"] = []
                    self.app.repository.write_key(self.key, json.dumps(changed))
                else:
                    self.app.accounts.update_user(self.app.accounts.get_user("u0"), self.user["id"], {"active": False})
                return response()
            with self.subTest(mode=mode), patch.object(self.app.model, "nonempty", side_effect=generate):
                with self.assertRaises((JobError, AccountError)):
                    self.invoke()
                saved = self.app.repository.material(self.key)
                if saved is not None:
                    self.assertNotIn("learn-scene", saved["nodeDetail"]["n1"]["study_notes"])

    def test_concurrent_quiz_and_progress_updates_survive_supplement(self):
        def generate(*args, **kwargs):
            changed = copy.deepcopy(self.material)
            changed["nodeDetail"]["n1"]["quiz"]["round_id"] = "new-round"
            changed["nodeState"]["n1"]["score"] = 99
            self.app.repository.write_key(self.key, json.dumps(changed))
            return response()
        with patch.object(self.app.model, "nonempty", side_effect=generate):
            self.invoke()
        saved = self.app.repository.material(self.key)
        self.assertEqual(saved["nodeDetail"]["n1"]["quiz"]["round_id"], "new-round")
        self.assertEqual(saved["nodeState"]["n1"]["score"], 99)

    def test_other_user_cannot_read_or_write_the_supplement_job(self):
        with patch.object(self.app.model, "nonempty") as model:
            with self.assertRaises(AccountError) as error:
                self.app.run_job("u0", "/path/node/scene", self.body)
            self.assertEqual(error.exception.status, 403)
            model.assert_not_called()

    def test_receipt_recovery_uses_committed_effect_without_replaying_model(self):
        queue = self.app.jobs()
        with patch.object(self.app.model, "nonempty", return_value=response()) as model:
            job = queue.submit(self.user["id"], "scene-receipt-test", "/path/node/scene", self.body)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = queue.get(job["id"], self.user["id"])
                if current["status"] == "succeeded":
                    break
                time.sleep(0.01)
            self.assertEqual(current["status"], "succeeded")
            again = queue.submit(self.user["id"], "scene-receipt-test", "/path/node/scene", self.body)
            self.assertEqual(again["id"], job["id"])
            self.assertEqual(model.call_count, 1)
            with self.app.repository.store.transaction() as connection:
                connection.execute("UPDATE jobs SET status='running',result=NULL WHERE id=?", (job["id"],))
            queue.stop()
            from background_jobs import JobQueue
            recovered = JobQueue(self.app.repository.store, lambda *args: self.fail("replayed"))
            self.assertEqual(recovered.get(job["id"], self.user["id"])["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
