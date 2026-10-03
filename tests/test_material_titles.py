"""Single document names: migration, ownership, intake, and late browser saves."""

import copy
import json
import unittest
from unittest.mock import patch
import test_state_regressions as base
from material_titles import migrate_titles
from background_jobs import JobQueue


class MaterialTitleTests(unittest.TestCase):
    def setUp(self):
        self.case = base.StateRegressionTests()
        self.case.setUp()
        self.app = self.case.app
        self.addCleanup(self.case.doCleanups)
        self.store = self.app.repository.store

    def test_intake_persists_name_and_late_snapshot_cannot_replace_it(self):
        raw = copy.deepcopy(self.case.material())
        with patch.object(
            self.app.model,
            "nonempty",
            return_value="TITLE: 日语基础语法\nASK: 学过哪些动词？",
        ):
            status, result = self.case.post(
                "/path/intake", {"key": base.KEY, "topic": "请你帮我学习日语。"}
            )
        self.assertEqual(status, 200)
        self.assertEqual(result["task_title"], "日语基础语法")
        self.assertEqual(self.case.material()["title"], "日语基础语法")
        raw["title"] = "旧客户端想覆盖的名字"
        status, _ = self.case.post(
            "/state/put", {"entries": {base.KEY: json.dumps(raw)}}
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.case.material()["title"], "日语基础语法")
        queue = JobQueue(self.store, lambda *args: None)
        queue.submit("u0", "canonical-title-test", "/path/node", {"key": base.KEY})
        self.assertEqual(queue.recent("u0")[0]["title"], self.case.material()["title"])
        self.assertEqual(queue.recent("other"), [])

    def test_migration_is_title_only_account_scoped_and_idempotent(self):
        other = "u1111111111111111/learn-path-v1-regression"
        deleted = "u0/learn-path-v1-deleted"
        quiz = "u0/quiz-map-v1-legacy"
        self.store.put(
            other, json.dumps({"topic": "请帮我", "plan": {"title": "另一个人的课程"}})
        )
        self.store.put(deleted, None)
        self.store.put(
            quiz,
            json.dumps(
                {
                    "title": "请帮我学习 · 测验",
                    "sourceKey": base.KEY,
                    "questions": [{"q": "原题"}],
                }
            ),
        )
        with self.store.transaction() as c:
            c.execute(
                "DELETE FROM metadata WHERE name=?", ("canonical_document_titles_v1",)
            )
            c.execute(
                "INSERT INTO task_titles VALUES (?,?,?)",
                ("u0", base.KEY, "日语基础语法"),
            )
            c.execute(
                "INSERT INTO task_titles VALUES (?,?,?)",
                ("u0", other, "不得跨用户采用"),
            )
        before = {r["key"]: r for r in self.store.records()}
        with self.store.transaction() as c:
            migrate_titles(c)
        after = {r["key"]: r for r in self.store.records()}
        self.assertEqual(json.loads(after[base.KEY]["value"])["title"], "日语基础语法")
        self.assertEqual(json.loads(after[other]["value"])["title"], "另一个人的课程")
        self.assertEqual(
            json.loads(after[quiz]["value"])["title"], "日语基础语法综合测验"
        )
        self.assertEqual(before[deleted], after[deleted])
        for key, row in before.items():
            if row["value"] is None:
                continue
            old, new = json.loads(row["value"]), json.loads(after[key]["value"])
            old.pop("title", None)
            new.pop("title", None)
            self.assertEqual(old, new)
            self.assertEqual(row["updated_ms"], after[key]["updated_ms"])
        with self.store.transaction() as c:
            migrate_titles(c)
        self.assertEqual(after, {r["key"]: r for r in self.store.records()})

    def test_plan_has_no_second_article_title_and_generation_does_not_rename(self):
        self.store.put(
            base.KEY, json.dumps({**self.case.material(), "title": "正式课程名"})
        )
        plan = {
            "title": "模型额外生成的名字",
            "nodes": [
                {"id": "n" + str(i), "title": "节点" + str(i), "deps": []}
                for i in range(1, 7)
            ],
        }
        with patch.object(self.app.model, "json", return_value=json.dumps(plan)):
            status, result = self.case.post(
                "/path/plan", {"key": base.KEY, "spec": {"topic": "课程领域"}}
            )
        self.assertEqual(status, 200)
        self.assertNotIn("title", result)
        self.assertEqual(self.case.material()["title"], "正式课程名")
        self.assertEqual(len(self.case.material()["plan"]["nodes"]), 6)

    def test_deleted_material_is_not_revived_by_title_generation(self):
        self.store.put(base.KEY, None)
        with patch.object(
            self.app.model, "nonempty", return_value="TITLE: 日语基础\nASK: 学过吗？"
        ):
            self.case.post("/path/intake", {"key": base.KEY, "topic": "日语"})
        self.assertIsNone(self.store.record(base.KEY)["value"])
