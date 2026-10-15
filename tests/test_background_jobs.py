"""Durable receipts, bounded queues, recovery, ownership and unlocked upstream IO."""

import json
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch
import quiz_harness as harness
from state_store import StateStore
from background_jobs import JobQueue, JobError, failure_detail
from job_execution import remaining_timeout
from material_titles import short_title
import test_user_isolation as isolation


class QueueTests(unittest.TestCase):
    def test_receipts_and_workers_share_operation_specific_budget(self):
        observed = {}
        def execute(user_id, operation, body):
            observed[operation] = remaining_timeout(1000)
            return 200, {"ok": True}
        queue = JobQueue(self.store, execute, workers=1, node_timeout=9, job_timeout=7, quizmap_timeout=11)
        self.addCleanup(queue.stop)
        queue.start()
        for index, (operation, expected) in enumerate((("/path/quizmap", 11), ("/path/requiz", 7), ("/path/node", 9))):
            with self.subTest(operation=operation):
                receipt = queue.submit("u0", "operation-budget-%d" % index, operation, {"key": "u0/budget"})
                self.assertEqual(receipt["timeout_seconds"], expected)
                self.wait_status(queue, receipt["id"])
                self.assertGreater(observed[operation], expected - 1)
                self.assertLessEqual(observed[operation], expected)

    def test_scene_default_and_custom_budget_match_receipt_and_worker(self):
        for custom in (None,13):
            observed={}
            def execute(user_id,operation,body):
                observed[operation]=remaining_timeout(1000)
                return 200, {'ok':True}
            options={} if custom is None else {'scene_timeout':custom}
            queue=JobQueue(self.store,execute,workers=1,**options)
            self.addCleanup(queue.stop)
            self.assertEqual(queue.retry_delay,5)
            queue.start()
            for index,(operation,seconds) in enumerate((('/path/node/scene',custom or 600),('/path/node',300),('/path/quizmap',600),('/path/requiz',300))):
                with self.subTest(custom=custom,operation=operation):
                    request_id='scene-budget-%s-%d'%(custom,index)
                    body={'key':'u0/budget','node':{'id':'n1'}}
                    receipt=queue.submit('u0',request_id,operation,body)
                    self.assertEqual(receipt['timeout_seconds'],seconds)
                    self.assertEqual(queue.submit('u0',request_id,operation,body)['id'],receipt['id'])
                    result=self.wait_status(queue,receipt['id'])
                    self.assertGreater(observed[operation],seconds-1)
                    self.assertLessEqual(observed[operation],seconds)
                    self.assertEqual(result['timeout_seconds'],seconds)
                    if operation in ('/path/node','/path/node/scene'):
                        self.assertTrue(result['auto_retry'])
                        self.assertEqual(result['max_attempts'],2)
            queue.stop()

    def test_scene_timeout_auto_retry_retains_identity_and_two_attempt_limit(self):
        from job_execution import JobDeadlineExceeded
        calls=[]
        def execute(*args):
            calls.append(remaining_timeout(1000))
            raise JobDeadlineExceeded()
        queue=JobQueue(self.store,execute,workers=1,scene_timeout=17,retry_delay=0)
        self.addCleanup(queue.stop)
        receipt=queue.submit('u0','scene-budget-retry','/path/node/scene',{'key':'u0/budget'})
        with self.assertLogs('background_jobs',level='ERROR'):
            queue.start()
            failed=self.wait_status(queue,receipt['id'],'failed')
        self.assertEqual(failed['id'],receipt['id'])
        self.assertEqual(failed['attempt'],2)
        self.assertEqual(failed['timeout_seconds'],17)
        self.assertIn('总时限：17 秒',failed['error'])
        self.assertEqual(len(calls),2)
        self.assertTrue(all(16<value<=17 for value in calls))

    def test_deadline_receipt_reports_the_actual_operation_budget(self):
        def execute(*args):
            from job_execution import JobDeadlineExceeded
            raise JobDeadlineExceeded()
        queue = JobQueue(self.store, execute, workers=1)
        self.addCleanup(queue.stop)
        queue.start()
        for index, (operation, seconds) in enumerate((("/path/quizmap", 600), ("/path/requiz", 300))):
            with self.subTest(operation=operation), self.assertLogs("background_jobs", level="ERROR"):
                receipt = queue.submit("u0", "deadline-budget-%d" % index, operation, {"key": "u0/budget"})
                failed = self.wait_status(queue, receipt["id"], "failed")
                self.assertEqual(failed["timeout_seconds"], seconds)
                self.assertIn("总时限：%s 秒" % seconds, failed["error"])

    def test_progress_persists_with_owner_isolation_and_retry_reset(self):
        entered, release = threading.Event(), threading.Event()

        def execute(*args):
            self.store.job_progress(3, "校验题目与评分标准", 2)
            entered.set()
            release.wait(3)
            raise urllib.error.HTTPError(
                "https://model.invalid", 503, "private body", {}, None
            )

        queue = JobQueue(self.store, execute, workers=1)
        self.addCleanup(queue.stop)
        job = queue.submit("u0", "progress-test", "/path/requiz", {"key": "u0/test"})
        queue.start()
        self.assertTrue(entered.wait(3))
        pending = queue.get(job["id"], "u0")
        self.assertEqual(
            pending["progress"],
            {"step": 3, "total": 4, "label": "校验题目与评分标准", "attempt": 2},
        )
        with self.assertRaises(JobError):
            queue.get(job["id"], "other")
        release.set()
        failed = self.wait_status(queue, job["id"], "failed")
        self.assertEqual(failed["error_category"], "remote_api")
        self.assertIn("API 503", failed["error"])
        self.assertNotIn("private body", failed["error"])
        queue.stop()
        restarted = JobQueue(StateStore(self.temp.name), lambda *args: (200, {}))
        self.assertEqual(restarted.get(job["id"], "u0")["progress"]["step"], 3)
        restarted.retry(job["id"], "u0")
        self.assertNotIn("progress", restarted.get(job["id"], "u0"))

    def test_error_categories_do_not_leak_exception_text(self):
        for error, category in [
            (TimeoutError("secret"), "network"),
            (urllib.error.URLError("secret"), "network"),
            (harness.QuizContractError("secret"), "validation"),
            (ValueError("secret"), "program"),
        ]:
            with self.subTest(category=category):
                actual, message = failure_detail(error)
                self.assertEqual(actual, category)
                self.assertNotIn("secret", message)

    def test_recent_groups_conversations_and_keeps_raw_receipts(self):
        queue = JobQueue(self.store, lambda *args: (200, {}))
        for index in range(105):
            key = "u0/other" if index == 0 else "u0/conversation"
            job = queue.submit(
                "u0",
                "request-%04d" % index,
                "/path/intake",
                {"key": key, "topic": "原始输入"},
            )
            with self.store.transaction() as connection:
                connection.execute(
                    "UPDATE jobs SET status='succeeded',created_ms=? WHERE id=?",
                    (index, job["id"]),
                )
        self.store.put("u0/conversation", json.dumps({"title": "日语基础语法"}))
        self.assertEqual(
            len(queue.list("u0", "u0/other")),
            1,
            "filter by material before limiting job history",
        )
        rows = queue.recent("u0")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["id"], job["id"])
        self.assertEqual(rows[0]["title"], "日语基础语法")
        self.assertEqual(queue.recent("other"), [])
        self.assertEqual(len(queue.list("u0")), 100)
        active = queue.submit(
            "u0", "request-active-new", "/path/node", {"key": "u0/other"}
        )
        self.assertEqual(queue.recent("u0")[0]["id"], active["id"])
        with self.store.transaction() as connection:
            connection.execute(
                "UPDATE jobs SET status='failed' WHERE id=?", (active["id"],)
            )
        retry = queue.retry(active["id"], "u0")
        self.assertEqual(queue.recent("u0")[0]["id"], retry["id"])

    def test_document_title_is_only_source_across_queue_restart(self):
        self.store.put("u0/conversation", json.dumps({"title": "日语基础语法"}))
        queue = JobQueue(
            self.store,
            lambda *args: (200, {"task_title": "不能覆盖文档标题"}),
            workers=1,
        )
        self.addCleanup(queue.stop)
        job = queue.submit(
            "u0", "request-title", "/path/intake", {"key": "u0/conversation"}
        )
        queue.start()
        self.wait_status(queue, job["id"])
        queue.stop()
        restarted = JobQueue(StateStore(self.temp.name), lambda *args: (200, {}))
        self.assertEqual(restarted.recent("u0")[0]["title"], "日语基础语法")
        with self.store.connection() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM task_titles").fetchone()[0], 0
            )
        self.assertEqual(short_title(None), "")

    def test_list_and_recent_titles_are_owned_document_snapshots(self):
        queue = JobQueue(self.store, lambda *args: (200, {"secret": "result body"}))
        documents = {
            "u0/alpha": json.dumps({"title": "甲课程", "private": "正文秘密"}),
            "u0/beta": json.dumps({"title": "乙课程"}),
            "u0/missing": None,
            "u0/broken": "{broken",
            "u0/array": json.dumps(["不能读作标题"]),
            "u1111111111111111/foreign": json.dumps({"title": "外部标题秘密"}),
        }
        for key, value in documents.items():
            self.store.put(key, value)

        jobs = []
        specs = [
            ("alpha", "u0/alpha", {"title": "伪造标题", "topic": "伪造主题"}),
            ("alpha-again", "u0/alpha", {"title": "伪造标题2", "topic": "另一个主题"}),
            ("beta", "u0/beta", {}),
            ("missing", "u0/missing", {}),
            ("broken", "u0/broken", {}),
            ("array", "u0/array", {}),
            ("foreign", "u1111111111111111/foreign", {"title": "外部正文不得读取"}),
            ("non-string", 123, {"title": "非字符串key"}),
        ]
        for name, key, extra in specs:
            jobs.append(queue.submit(
                "u0", "title-list-%s" % name, "/path/intake",
                {"key": key, "topic": "不得显示的主题", **extra},
            ))

        expected = {
            "u0/alpha": "甲课程",
            "u0/beta": "乙课程",
            "u0/missing": "学习资料",
            "u0/broken": "学习资料",
            "u0/array": "学习资料",
            "u1111111111111111/foreign": "学习资料",
            123: "学习资料",
        }
        rows = queue.list("u0")
        self.assertEqual(len(rows), len(specs))
        by_id = {row["id"]: row for row in rows}
        for job, (_, key, _) in zip(jobs, specs):
            self.assertEqual(by_id[job["id"]]["title"], expected[key])
            self.assertNotIn("result", by_id[job["id"]])
        public_rows = json.dumps(rows, ensure_ascii=False)
        self.assertNotIn("正文秘密", public_rows)
        self.assertNotIn("外部标题秘密", public_rows)
        self.assertNotIn("不得显示的主题", public_rows)
        self.assertNotIn("伪造标题", public_rows)
        self.assertEqual(len(queue.list("u0", "u0/alpha")), 2)
        self.assertTrue(
            all(row["title"] == "甲课程" for row in queue.list("u0", "u0/alpha"))
        )

        recent_rows = queue.recent("u0", limit=20)
        recent = {row["key"]: row for row in recent_rows}
        self.assertEqual(len(recent_rows), len(expected))
        for key, title in expected.items():
            self.assertEqual(recent[key]["title"], title)
        self.assertNotIn("result", json.dumps(recent_rows, ensure_ascii=False))
        self.assertEqual(queue.recent("other"), [])

        self.store.put("u0/alpha", json.dumps({"title": "改名后的课程"}))
        self.assertEqual(queue.list("u0", "u0/alpha")[0]["title"], "改名后的课程")
        self.assertEqual(
            next(
                row for row in queue.recent("u0", limit=20)
                if row["key"] == "u0/alpha"
            )["title"],
            "改名后的课程",
        )

    def test_list_and_recent_cache_document_titles_once_per_query(self):
        queue = JobQueue(self.store, lambda *args: (200, {}))
        queue.submit("u0", "title-cache-one", "/path/intake", {"key": "u0/shared"})
        queue.submit("u0", "title-cache-two", "/path/intake", {"key": "u0/shared"})
        self.store.put("u0/shared", json.dumps({"title": "共享资料"}))
        original_connection = self.store.connection

        def query_with_trace(reads):
            from contextlib import contextmanager

            @contextmanager
            def traced_connection(*args, **kwargs):
                with original_connection(*args, **kwargs) as connection:
                    connection.set_trace_callback(
                        lambda sql: reads.append(sql)
                        if "FROM documents WHERE key" in sql
                        else None
                    )
                    yield connection

            return traced_connection

        for query in (queue.list, queue.recent):
            reads = []
            with patch.object(self.store, "connection", query_with_trace(reads)):
                rows = query("u0")
            self.assertEqual(len(reads), 1)
            self.assertEqual({row["title"] for row in rows}, {"共享资料"})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = StateStore(self.temp.name)

    def wait_status(self, queue, job_id, expected="succeeded"):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = queue.get(job_id, "u0")
            if job["status"] == expected:
                return job
            time.sleep(0.01)
        self.fail(str(job))

    def test_duplicate_receipt_runs_once_and_capacity_is_bounded(self):
        count = []
        queue = JobQueue(
            self.store,
            lambda *args: (count.append(args) or 200, {"done": True}),
            workers=1,
            limit=1,
        )
        self.addCleanup(queue.stop)
        first = queue.submit("u0", "request-one", "/path/intake", {"key": "u0/topic"})
        self.assertEqual(
            queue.submit("u0", "request-one", "/path/intake", {"key": "u0/topic"})[
                "id"
            ],
            first["id"],
        )
        with self.assertRaises(JobError) as conflict:
            queue.submit("u0", "request-one", "/path/intake", {"key": "u0/other"})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(conflict.exception.error_category, 'request_id_conflict')
        with self.assertRaises(JobError) as full:
            queue.submit("u0", "request-two", "/path/intake", {"key": "u0/other"})
        self.assertEqual(full.exception.status, 429)
        queue.start()
        self.wait_status(queue, first["id"])
        self.assertEqual(len(count), 1)
        with self.assertRaises(JobError):
            queue.get(first["id"], "someone-else")

    def test_active_work_stays_visible_without_loading_large_results(self):
        queue = JobQueue(self.store, lambda *args: (200, {}), limit=2)
        active = queue.submit(
            "u0", "request-active", "/path/intake", {"key": "u0/active"}
        )
        done = queue.submit("u0", "request-done", "/path/intake", {"key": "u0/done"})
        with self.store.transaction() as connection:
            connection.execute(
                "UPDATE jobs SET status='succeeded',created_ms=created_ms+1000,result=? WHERE id=?",
                ("not-loaded-by-summary", done["id"]),
            )
        rows = queue.list("u0")
        self.assertEqual(rows[0]["id"], active["id"])
        self.assertNotIn("result", rows[1])

    def test_restart_marks_unfinished_work_and_preserves_queued_work(self):
        queue = JobQueue(self.store, lambda *args: (200, {"answer": "done"}), workers=1)
        interrupted = queue.submit(
            "u0", "request-first", "/path/intake", {"key": "u0/one"}
        )
        queue._claim()
        queued = queue.submit("u0", "request-second", "/path/intake", {"key": "u0/two"})
        restarted = JobQueue(
            self.store, lambda *args: (200, {"answer": "recovered"}), workers=1
        )
        self.addCleanup(restarted.stop)
        self.assertEqual(
            restarted.get(interrupted["id"], "u0")["status"], "interrupted"
        )
        self.assertEqual(restarted.get(queued["id"], "u0")["status"], "queued")
        restarted.retry(interrupted["id"], "u0")
        restarted.start()
        self.wait_status(restarted, interrupted["id"])
        self.wait_status(restarted, queued["id"])

    def test_effect_and_document_commit_together_and_survive_crash(self):
        queue = JobQueue(
            self.store, lambda *args: self.fail("Committed effect must not rerun")
        )
        job = queue.submit("u0", "request-effect", "/path/refine", {"key": "u0/one"})
        queue._claim()
        self.store.local.job_id = job["id"]
        with self.assertRaises(OSError):
            with self.store.transaction():
                self.store.put("u0/one", "new")
                self.store.record_job_effect({"plan": "new"})
                raise OSError("failure before commit")
        self.assertIsNone(self.store.record("u0/one"))
        with self.store.transaction():
            self.store.put("u0/one", "new")
            self.store.record_job_effect({"plan": "new"})
        del self.store.local.job_id
        restarted = JobQueue(
            StateStore(self.temp.name),
            lambda *args: self.fail("Must not execute again"),
        )
        result = restarted.get(job["id"], "u0")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["result"], {"plan": "new"})


class JobHttpTests(unittest.TestCase):
    # Reuse only the fixture/request helpers, without rerunning inherited tests.
    setUp = isolation.UserIsolationTests.setUp
    stop_server = isolation.UserIsolationTests.stop_server
    request = isolation.UserIsolationTests.request
    login = isolation.UserIsolationTests.login
    create = isolation.UserIsolationTests.create
    put = isolation.UserIsolationTests.put

    def stop_jobs(self):
        self.app.close()

    def test_http_old_node_receipt_conflict_is_typed_without_rewriting_old_job(self):
        key = self.put(self.alice, self.alice_cookie)
        old_body = {"key": key, "node": {"id": "n1"}}
        old_request = {"request_id": "old-batch:n1", "operation": "/path/node", "body": old_body}
        with patch.object(self.app, "run_job", return_value=(200, {"cached": True})):
            status, first, _ = self.request("/jobs", old_request, self.alice_cookie)
            self.assertEqual(status, 202, first)
            old_id = first['job']['id']
            self.assertEqual(self.request("/jobs", old_request, self.alice_cookie)[1]['job']['id'], old_id)
            current = {**old_request, "body": {**old_body, "defer_visual": True}}
            status, conflict, _ = self.request("/jobs", current, self.alice_cookie)
            self.assertEqual(status, 409)
            self.assertEqual(conflict, {
                "ok": False, "error": "同一任务回执不能用于不同内容",
                "error_category": "request_id_conflict",
            })
            self.assertEqual(self.request("/jobs", old_request, self.alice_cookie)[1]['job']['id'], old_id)
            accepted_status, accepted, _ = self.request("/jobs", {
                **current, "request_id": "current-content:n1",
            }, self.alice_cookie)
            self.assertEqual(accepted_status, 202, accepted)
            self.assertNotEqual(accepted['job']['id'], old_id)
            with self.app.repository.store.connection() as connection:
                stored = connection.execute('SELECT body FROM jobs WHERE id=?', (old_id,)).fetchone()
            self.assertEqual(json.loads(stored['body']), old_body)
            forbidden_status, forbidden, _ = self.request("/jobs", current, self.bob_cookie)
            self.assertEqual(forbidden_status, 403)
            self.assertNotIn('error_category', forbidden)
            with patch.object(self.app.jobs(), 'submit', side_effect=JobError(409, 'another conflict')):
                status, other, _ = self.request("/jobs", current, self.alice_cookie)
                self.assertEqual(status, 409)
                self.assertNotIn('error_category', other)

    def test_http_receipt_ownership_and_io_does_not_block_saving(self):
        self.addCleanup(self.stop_jobs)
        key = self.put(self.alice, self.alice_cookie)
        waiting, release = threading.Event(), threading.Event()

        def upstream(*args, **kwargs):
            waiting.set()
            if not release.wait(5):
                raise TimeoutError("test upstream not released")
            return "ASK: 你现在的基础如何？"

        with patch.object(self.app.model, "nonempty", side_effect=upstream):
            status, accepted, _ = self.request(
                "/jobs",
                {
                    "request_id": "test-http-job",
                    "operation": "/path/intake",
                    "body": {"key": key, "topic": "数学", "history": []},
                },
                self.alice_cookie,
            )
            self.assertEqual(status, 202, accepted)
            job_id = accepted["job"]["id"]
            self.assertTrue(waiting.wait(2))
            try:
                begin = time.monotonic()
                self.assertEqual(
                    self.request(
                        "/state/put",
                        {"entries": {self.bob + "/metadata": "saved"}},
                        self.bob_cookie,
                    )[0],
                    200,
                )
                self.assertLess(time.monotonic() - begin, 1)
                self.assertEqual(
                    self.request("/jobs/" + job_id, cookie=self.bob_cookie)[0], 404
                )
                self.assertEqual(
                    self.request(
                        "/jobs/" + job_id, cookie=self.admin, target=self.alice
                    )[0],
                    200,
                )
                self.assertEqual(
                    self.request(
                        "/jobs",
                        {
                            "request_id": "foreign-http-job",
                            "operation": "/path/intake",
                            "body": {"key": key, "topic": "x"},
                        },
                        self.bob_cookie,
                    )[0],
                    403,
                )
            finally:
                release.set()
            for _ in range(100):
                result = self.request("/jobs/" + job_id, cookie=self.alice_cookie)[1][
                    "job"
                ]
                if result["status"] == "succeeded":
                    break
                time.sleep(0.01)
            self.assertEqual(result["result"]["question"], "你现在的基础如何？")

    def test_deleted_material_rejects_new_jobs_and_stale_save(self):
        self.addCleanup(self.stop_jobs)
        key = self.put(self.alice, self.alice_cookie)
        self.request(
            "/state/delete",
            {"keys": [key], "password": "learner-password"},
            self.alice_cookie,
        )
        self.assertEqual(
            self.request(
                "/state/put", {"entries": {key: '{"topic":"stale"}'}}, self.alice_cookie
            )[0],
            409,
        )
        self.assertEqual(
            self.request(
                "/jobs",
                {
                    "request_id": "deleted-job",
                    "operation": "/path/node",
                    "body": {"key": key, "node": {"id": "n1"}},
                },
                self.alice_cookie,
            )[0],
            404,
        )
