"""Reference ingestion contracts: archive validation, persistence and model input."""
import base64
import io
import json
from pathlib import Path
import stat
import sys
import unittest
from unittest.mock import patch
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
import material_worker as worker
import material_parser as parser
from test_user_isolation import UserIsolationTests


def packed(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return output.getvalue()


class ParserTests(unittest.TestCase):
    def test_text_encodings_and_nested_directory(self):
        for encoding in ('utf-8-sig', 'utf-16', 'gb18030'):
            self.assertEqual(worker.parse('课程.TXT', '集合与映射'.encode(encoding))[0]['text'], '集合与映射')
        result = worker.parse('notes.zip', packed([('folder/课程.txt', '函数与关系'.encode())]))
        self.assertEqual(result[0]['name'], 'notes.zip/folder/课程.txt')

    def test_all_archive_names_checked_before_parsing(self):
        for bad in ('../escape.txt', '/absolute.txt', 'a\\b.txt', 'C:evil.txt', 'a/./x.txt',
                    'setup.exe', 'run.sh', 'inner.zip', 'macro.docm'):
            with self.subTest(bad=bad), patch.object(worker, 'parse_document') as parse:
                with self.assertRaises(worker.Invalid):
                    worker.parse('x.zip', packed([('good.txt', b'ok'), (bad, b'bad')]))
                parse.assert_not_called()

    def test_link_duplicate_and_bomb_rejected(self):
        link = zipfile.ZipInfo('link.txt'); link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in ([(link, b'/etc/passwd')], [('a.txt', b'x'), ('A.txt', b'y')],
                        [(str(i)+'.txt', b'x') for i in range(21)]):
            with self.assertRaises(worker.Invalid): worker.parse('x.zip', packed(entries))
        with self.assertRaises(worker.Invalid):
            worker.check_entries([('x.txt', 100000, False, False, False)], 10)
        with self.assertRaises(worker.Invalid):
            worker.check_entries([('x.txt', 1, False, False, True)], 10)

    def test_fake_text_and_fake_documents_rejected(self):
        for data in (b'MZpayload', b'\x7fELF', b'#!/bin/sh\necho x', b'hello\x00binary'):
            with self.assertRaises(worker.Invalid): worker.parse('fake.txt', data)
        for name, data in [('fake.pdf', b'not pdf'), ('empty.txt', b'  '), ('large.txt', b'x'*(120001))]:
            with self.assertRaises(worker.Invalid): worker.parse(name, data)

    def test_context_keeps_sources_and_rejects_silent_truncation(self):
        self.assertIn('资料甲.txt', parser.context([{'name':'资料甲.txt', 'text':'测试知识'}]))
        with self.assertRaises(parser.MaterialError):
            parser.context([{'name':'x', 'text':'x'*120001}])
        with self.assertRaises(parser.MaterialError): parser.validate_materials([{'name':'x','text':None}])


class UploadHTTPTests(UserIsolationTests):
    # Inherited identity regressions also run against the new endpoint integration.
    def test_parse_requires_auth_and_own_user_context(self):
        payload = {'name':'notes.txt', 'data':base64.b64encode(b'notes').decode()}
        with patch('material_parser.parse_upload', return_value=[{'name':'notes.txt','text':'notes'}]) as parse:
            self.assertEqual(self.request('/materials/parse', payload)[0], 401)
            self.assertEqual(self.request('/materials/parse', payload, self.alice_cookie, self.bob)[0], 403)
            self.assertEqual(self.request('/materials/parse', payload, self.admin, self.alice)[0], 403)
            parse.assert_not_called()
            self.assertEqual(self.request('/materials/parse', payload, self.alice_cookie)[0], 200)

    def test_quiz_draft_persists_without_overwriting_learning_state(self):
        from test_state_regressions import study
        key = self.put(self.alice, self.alice_cookie)
        refs = [{'name':'quiz.txt','text':'仅测验使用的资料'}]
        self.assertEqual(self.request('/materials/quiz-draft', {'key':key,'materials':refs}, self.bob_cookie)[0],403)
        self.assertEqual(self.request('/materials/quiz-draft', {'key':key,'materials':refs}, self.alice_cookie)[0],200)
        self.put(self.alice, self.alice_cookie, 'new title')
        self.assertEqual(study._state_material(key)['quizMaterials'], refs)
        self.assertEqual(study._state_material(key)['topic'], 'new title')

    def test_intake_model_receives_persisted_references(self):
        from test_state_regressions import study
        key = self.put(self.alice, self.alice_cookie)
        refs = [{'name':'lecture.txt','text':'磁星柠檬定律：每个环包含七个点'}]
        self.request('/state/put', {'entries':{key:json.dumps({'topic':'图论','stage':'intake','materials':refs})}}, self.alice_cookie)
        with patch.object(study, '_upstream_nonempty', return_value='ASK: 你希望测验的难度？') as model:
            self.assertEqual(self.request('/path/intake', {'key':key,'topic':'图论'}, self.alice_cookie)[0],200)
            content = json.dumps(model.call_args.args[0], ensure_ascii=False)
            self.assertIn('磁星柠檬定律', content)
            self.assertIn('lecture.txt', content)
