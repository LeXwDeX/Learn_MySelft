"""Reference ingestion contracts: archive validation, persistence and model input."""
import base64
import io
import importlib.util
import json
from pathlib import Path
import stat
import struct
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile
import zlib
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
    def test_pdf_text_pages_and_scanned_pages_have_separate_limits(self):
        text_page = SimpleNamespace(extract_text=lambda: '语法')
        scan_page = SimpleNamespace(extract_text=lambda: '')
        reader = SimpleNamespace(is_encrypted=False, pages=[text_page] * 133)
        with patch.dict(sys.modules, {'pypdf': SimpleNamespace(PdfReader=lambda _: reader)}):
            self.assertIn('第 133 页', worker.pdf_text(b'pdf'))
            reader.pages = [text_page] * 201
            with self.assertRaisesRegex(worker.Invalid, '200'):
                worker.pdf_text(b'pdf')
            reader.pages = [scan_page] * 41
            with patch.object(worker, 'command'), patch.object(worker, 'ocr', return_value='识别文字'), patch.object(Path, 'read_bytes', return_value=b'image'):
                with self.assertRaisesRegex(worker.Invalid, '40 页扫描页'):
                    worker.pdf_text(b'pdf')

    @unittest.skipUnless(importlib.util.find_spec('py7zr'), 'py7zr is installed on the deployment host')
    def test_seven_zip_skips_incidental_files(self):
        import py7zr
        data = io.BytesIO()
        with py7zr.SevenZipFile(data, 'w') as archive:
            archive.writestr(b'lesson', '课程.txt')
            archive.writestr(b'lock', '~$课程.docx')
        skipped = []
        result = worker.parse('x.7z', data.getvalue(), skipped)
        self.assertEqual([x['text'] for x in result], ['lesson'])
        self.assertEqual(skipped, ['~$课程.docx'])

    def test_unmarked_zip_names_and_unicode_extra(self):
        class LegacyName(zipfile.ZipInfo):
            def _encodeFilenameFlags(self):
                return self.filename.encode(self.encoding), 0
        for encoding in ('utf-8', 'gb18030'):
            entry = LegacyName('语法/课程.txt'); entry.encoding = encoding
            result = worker.parse('资料.zip', packed([(entry, '语法知识'.encode())]))
            self.assertEqual(result[0]['name'], '资料.zip/语法/课程.txt')
        entry = zipfile.ZipInfo('legacy.txt')
        value = b'\x01' + struct.pack('<I', zlib.crc32(b'legacy.txt')) + '课程.txt'.encode()
        entry.extra = struct.pack('<HH', 0x7075, len(value)) + value
        self.assertEqual(worker.parse('x.zip', packed([(entry, b'ok')]))[0]['name'], 'x.zip/课程.txt')
        # A valid Unicode alias must still pass the same path checks.
        value = b'\x01' + struct.pack('<I', zlib.crc32(b'legacy.txt')) + b'../escape.txt'
        entry.extra = struct.pack('<HH', 0x7075, len(value)) + value
        with self.assertRaises(worker.Invalid):
            worker.parse('x.zip', packed([(entry, b'ok')]))

    def test_incidental_files_skipped_but_not_safety_checks(self):
        ignored = ['语法/~WRL1606.tmp', '语法/~$课程.docx', '__MACOSX/语法/._课程', '.DS_Store']
        skipped = []
        result = worker.parse('x.zip', packed([(n, b'incidental') for n in ignored] +
            [('语法/%d.txt' % i, b'lesson') for i in range(39)]), skipped)
        self.assertEqual(len(result), 39)
        self.assertEqual(skipped, ignored)
        for name in ('../~WRL1606.tmp', '__MACOSX/run.sh', 'unrecognized.tmp'):
            with self.assertRaises(worker.Invalid):
                worker.parse('x.zip', packed([(name, b'x'), ('ok.txt', b'ok')]))
        link = zipfile.ZipInfo('~WRL1606.tmp')
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(worker.Invalid):
            worker.parse('x.zip', packed([(link, b'/etc/passwd')]))
        with self.assertRaises(worker.Invalid):
            worker.check_entries([('~WRL1606.tmp', worker.MAX_BYTES + 1, False, False, False)], 100000)

    def test_normalized_duplicate_names_rejected(self):
        with self.assertRaises(worker.Invalid):
            worker.parse('x.zip', packed([('が.txt', b'a'), ('が.txt', b'b')]))

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
                        [(str(i)+'.txt', b'x') for i in range(101)]):
            with self.assertRaises(worker.Invalid): worker.parse('x.zip', packed(entries))
        with self.assertRaises(worker.Invalid):
            worker.check_entries([('x.txt', 100000, False, False, False)], 10)
        with self.assertRaises(worker.Invalid):
            worker.check_entries([('x.txt', 1, False, False, True)], 10)

    def test_fake_text_and_fake_documents_rejected(self):
        for data in (b'MZpayload', b'\x7fELF', b'#!/bin/sh\necho x', b'hello\x00binary'):
            with self.assertRaises(worker.Invalid): worker.parse('fake.txt', data)
        for name, data in [('fake.pdf', b'not pdf'), ('empty.txt', b'  '), ('large.txt', b'x'*(200001))]:
            with self.assertRaises(worker.Invalid): worker.parse(name, data)

    def test_context_keeps_sources_and_rejects_silent_truncation(self):
        self.assertIn('资料甲.txt', parser.context([{'name':'资料甲.txt', 'text':'测试知识'}]))
        with self.assertRaises(parser.MaterialError):
            parser.context([{'name':'x', 'text':'x'*200001}])
        with self.assertRaises(parser.MaterialError): parser.validate_materials([{'name':'x','text':None}])


class UploadHTTPTests(UserIsolationTests):
    # Inherited identity regressions also run against the new endpoint integration.
    def test_parse_requires_auth_and_own_user_context(self):
        payload = {'name':'notes.txt', 'data':base64.b64encode(b'notes').decode()}
        with patch('material_parser.parse_upload', return_value={'materials':[{'name':'notes.txt','text':'notes'}], 'skipped':[]}) as parse:
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
        with patch.object(study, '_upstream_nonempty', return_value='TITLE: **图论入门学习**\nASK: 你希望测验的难度？') as model:
            status, result, _ = self.request('/path/intake', {'key':key,'topic':'图论'}, self.alice_cookie)
            self.assertEqual(status, 200)
            self.assertEqual(result['task_title'], '图论入门学习')
            self.assertEqual(result['question'], '你希望测验的难度？')
            content = json.dumps(model.call_args.args[0], ensure_ascii=False)
            self.assertIn('磁星柠檬定律', content)
            self.assertIn('lecture.txt', content)
