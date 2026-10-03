"""Migration, rollback, independent writers, and account commit failures."""

import hashlib
import json
import multiprocessing
import subprocess
import sys
import fcntl
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from state_store import StateStore, StateConflict
from user_accounts import AccountStore


def increment_documents(directory, count):
    store = StateStore(directory)
    for _ in range(count):
        with store.transaction():
            previous = int(store.record("counter")["value"])
            store.put("counter", str(previous + 1))


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "state"
        self.directory.mkdir()

    def test_import_preserves_every_value_tombstone_and_original_file(self):
        original = {
            "u0/learn-path-v1-old": '{"topic":"旧课程","history":[]}',
            "u0/deleted": None,
            "knowledge-map-v1-marks": '{"n1":{"s":"again"}}',
        }
        before = {}
        for key, value in original.items():
            path = self.directory / (hashlib.sha1(key.encode()).hexdigest() + ".json")
            path.write_text(
                json.dumps({"key": key, "v": value, "ts": 123}, ensure_ascii=False)
            )
            before[path.name] = path.read_bytes()
        store = StateStore(self.directory)
        imported = {row["key"]: row["value"] for row in store.records()}
        migrated = json.loads(imported.pop("u0/learn-path-v1-old"))
        self.assertEqual(migrated.pop("title"), "旧课程")
        self.assertEqual(migrated, json.loads(original["u0/learn-path-v1-old"]))
        self.assertEqual(
            imported,
            {
                key: value
                for key, value in original.items()
                if key != "u0/learn-path-v1-old"
            },
        )
        store.put("u0/learn-path-v1-old", '{"topic":"changed"}')
        reopened = StateStore(self.directory)
        self.assertEqual(
            reopened.record("u0/learn-path-v1-old")["value"], '{"topic":"changed"}'
        )
        self.assertEqual(
            {p.name: p.read_bytes() for p in self.directory.glob("*.json")}, before
        )
        self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(store.check(), "ok")

    def test_failed_batch_rolls_back_already_written_keys(self):
        from material_repository import MaterialRepository

        repository = MaterialRepository(StateStore(self.directory))
        original = repository.write_key

        def fail_second(key, value):
            if key.endswith("second"):
                raise OSError("simulated disk failure")
            original(key, value)

        with patch.object(repository, "write_key", side_effect=fail_second):
            with self.assertRaises(OSError):
                repository.put_entries({"u0/first": "new", "u0/second": "new"})
        self.assertIsNone(repository.read_key("u0/first"))
        self.assertEqual(repository.store.check(), "ok")

    def test_independent_processes_do_not_lose_updates(self):
        store = StateStore(self.directory)
        store.put("counter", "0")
        context = multiprocessing.get_context("spawn")
        processes = [
            context.Process(target=increment_documents, args=(str(self.directory), 15))
            for _ in range(3)
        ]
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=15)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(store.record("counter")["value"], "45")

    def test_revision_conflict_and_online_backup_include_committed_data(self):
        store = StateStore(self.directory)
        store.put("counter", "1", expected_revision=0)
        with self.assertRaises(StateConflict):
            store.put("counter", "stale", expected_revision=0)
        store.put("counter", "2", expected_revision=1)
        backup_dir = Path(self.temp.name) / "restored"
        backup_dir.mkdir()
        store.backup(backup_dir / "state.sqlite3")
        restored = StateStore(backup_dir)
        self.assertEqual(restored.records(), store.records())
        self.assertEqual(restored.check(), "ok")

    def test_bad_legacy_file_aborts_import_without_partial_data(self):
        (self.directory / "a.json").write_text('{"key":"good","v":"value"}')
        (self.directory / "b.json").write_text("broken")
        with self.assertRaisesRegex(ValueError, "b.json"):
            StateStore(self.directory)
        (self.directory / "b.json").write_text('{"key":"also-good","v":null}')
        self.assertEqual(len(StateStore(self.directory).records()), 2)

    def test_account_failed_replace_does_not_change_live_password(self):
        accounts = AccountStore(Path(self.temp.name) / "accounts", "original-password")
        actor = accounts.get_user("u0")
        before = accounts.path.read_bytes()
        with patch("user_accounts.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                accounts.change_password(actor, "original-password", "new-password")
        self.assertEqual(accounts.path.read_bytes(), before)
        self.assertTrue(accounts.check_password(actor, "original-password"))
        self.assertFalse(accounts.check_password(actor, "new-password"))

    def test_paired_backup_refuses_running_writer_and_preserves_accounts(self):
        store = StateStore(self.directory)
        store.put("u0/metadata", "committed")
        AccountStore(str(self.directory) + "-accounts", "backup-password")
        target = Path(self.temp.name) / "paired-backup"
        script = (
            Path(__file__).resolve().parents[1] / "study-assistant" / "backup_state.py"
        )
        with (self.directory / ".writer.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(
                [sys.executable, str(script), str(self.directory), str(target)],
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(target.exists())
        result = subprocess.run(
            [sys.executable, str(script), str(self.directory), str(target)],
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((target / "accounts" / "accounts.json").is_file())
        self.assertEqual(StateStore(target).record("u0/metadata")["value"], "committed")
