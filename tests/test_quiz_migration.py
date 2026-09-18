import copy
import fcntl
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
import migrate_quiz_v2 as migration
import quiz_harness as harness
from state_store import StateStore


class QuizMigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = StateStore(self.root)
        question = {'type': 'fill', 'q': '写出 ____ 和 ____', 'answer': 'x；y',
                    'points': 100, 'explain': '依次填写 x 与 y'}
        self.old = {'id': 'old', 'questions': [question], 'harness_version': 1,
                    'attempts': [{'answers': ['x；错误'], 'result': {'score': 0}}],
                    'draft': {'answers': ['未完成草稿']}}
        self.document = {'questions': [question], 'round_id': 'old', 'rounds': [self.old],
                         'lastResult': {'score': 0}, 'lastAnswers': ['x；错误']}
        structured = copy.deepcopy(question)
        structured.update(scoring={'mode': 'per_blank'}, blanks=[
            {'id': 'b1', 'answer': 'x', 'accepted_answers': ['x'], 'match': 'text', 'points': 40},
            {'id': 'b2', 'answer': 'y', 'accepted_answers': ['y'], 'match': 'text', 'points': 60}])
        harness.validate_questions([structured])
        self.plan = {'version': 1, 'id': 'migration-1', 'documents': [{
            'key': 'u1/quiz', 'source_sha256': migration.digest(self.document), 'editions': [{
                'path': [], 'source_round_id': 'old', 'source_sha256': migration.digest(self.old),
                'questions': [structured], 'review': 'Checked blank ordering and 40+60 allocation'}]}]}
        self.store.put('u1/quiz', json.dumps(self.document))
        self.store.put('u2/unrelated', 'unchanged')

    def test_preview_then_apply_preserves_history_and_is_idempotent(self):
        before = self.store.records()
        self.assertEqual(migration.migrate(self.store.path, self.plan)['editions'], 1)
        self.assertEqual(before, self.store.records())
        report = migration.migrate(self.store.path, self.plan, self.root / 'backup.sqlite3')
        self.assertTrue(report['applied'])
        updated = json.loads(self.store.record('u1/quiz')['value'])
        self.assertEqual(updated['rounds'][0], self.old)
        self.assertEqual(updated['lastAnswers'], self.document['lastAnswers'])
        self.assertEqual(updated['lastResult'], self.document['lastResult'])
        self.assertEqual(updated['rounds'][1]['attempts'], [])
        self.assertEqual(updated['round_id'], updated['rounds'][1]['id'])
        result = harness.grade(updated['questions'], [['x', 'wrong']], lambda _: {})
        self.assertEqual(result['score'], 40)
        after = self.store.records()
        self.assertEqual(after[1], before[1])
        self.assertEqual(migration.migrate(self.store.path, self.plan)['editions'], 0)
        self.assertFalse(migration.migrate(self.store.path, self.plan, self.root / 'unused')['applied'])
        self.assertEqual(after, self.store.records())
        self.assertFalse((self.root / 'unused').exists())

    def test_stale_document_and_round_are_rejected(self):
        for level in ('document', 'round'):
            plan = copy.deepcopy(self.plan)
            target = plan['documents'][0]
            if level == 'round':
                target = target['editions'][0]
            target['source_sha256'] = 'stale'
            before = self.store.records()
            with self.assertRaises(ValueError):
                migration.migrate(self.store.path, plan, self.root / ('backup-' + level))
            self.assertEqual(before, self.store.records())

    def test_remigrating_migrated_source_is_rejected(self):
        self.assertEqual(migration.migrate(self.store.path, self.plan, self.root / 'backup-once')['editions'], 1)
        before = self.store.records()
        second = copy.deepcopy(self.plan)
        second['id'] = 'migration-2'
        second['documents'][0]['source_sha256'] = migration.digest(
            json.loads(self.store.record('u1/quiz')['value']))
        with self.assertRaises(ValueError):
            migration.migrate(self.store.path, second)
        with self.assertRaises(ValueError):
            migration.migrate(self.store.path, second, self.root / 'backup-twice')
        self.assertEqual(before, self.store.records())
        self.assertFalse((self.root / 'backup-twice').exists())
        self.assertEqual(migration.migrate(self.store.path, self.plan)['editions'], 0)

    def test_invalid_contract_leaves_database_unchanged(self):
        self.plan['documents'][0]['editions'][0]['questions'][0]['blanks'][0]['points'] = 1
        before = self.store.records()
        with self.assertRaises(harness.QuizContractError):
            migration.migrate(self.store.path, self.plan, self.root / 'bad-backup')
        self.assertEqual(before, self.store.records())

    def test_running_service_lock_blocks_apply(self):
        with open(self.root / '.writer.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                migration.migrate(self.store.path, self.plan, self.root / 'locked-backup')

    def test_missing_document_rolls_back_all_documents(self):
        self.plan['documents'].append({'key': 'missing', 'editions': []})
        before = self.store.records()
        with self.assertRaises(ValueError):
            migration.migrate(self.store.path, self.plan, self.root / 'missing-backup')
        self.assertEqual(before, self.store.records())


if __name__ == '__main__':
    unittest.main()
