"""Render diagnostics are useful without disclosing the worker's raw stderr."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from manim_contracts import ManimContractError, validate_render_diagnostic
from manim_renderer import ManimRenderer
from manim_worker import MAX_RENDER_STDERR, PRELUDE, SceneRenderFailure, render_diagnostic, render_process

SOURCE = 'class LessonScene(TeachingScene):\n def construct(self):\n  self.next_step("观察")'


def traceback_tail(exception, message, source_line=3):
    line = (PRELUDE + '\n').count('\n') + source_line
    return ('Traceback (most recent call last):\n'
            '  File "/tmp/lesson.py", line %d, in construct\n'
            '    private_source_should_never_escape()\n'
            '  File "/private/runtime/module.py", line 900, in internal\n'
            '%s: %s\n' % (line, exception, message)).encode()


class DiagnosticParsingTests(unittest.TestCase):
    def test_known_keyword_attribute_name_and_unknown_value_message(self):
        cases = [
            ('TypeError', "Mobject.__init__() got an unexpected keyword argument 'tip_length'", 'keyword', 'tip_length'),
            ('AttributeError', "'Arrow' object has no attribute 'set_tip_length'", 'attribute', 'set_tip_length'),
            ('NameError', "name 'UnknownArrow' is not defined", 'name', 'UnknownArrow'),
            ('ValueError', '/private/path secret arbitrary text', None, None),
        ]
        for exception, message, field, name in cases:
            with self.subTest(exception=exception):
                expected = {'exception_type': exception, 'line': 3}
                if field:
                    expected[field] = name
                diagnostic = render_diagnostic(traceback_tail(exception, message), 3)
                self.assertEqual(diagnostic, expected)
                self.assertNotIn('private', json.dumps(diagnostic))

    def test_prelude_and_source_line_bounds(self):
        for line in (-10, 0, 4, 10000):
            self.assertEqual(render_diagnostic(traceback_tail('ValueError', 'hidden', line), 3), {'exception_type': 'ValueError'})
        self.assertEqual(render_diagnostic(traceback_tail('NameError', "name 'ok' is not defined", 1), 3)['line'], 1)

    def test_unknown_failures_paths_nonascii_and_oversize_never_escape(self):
        for exception in ('RuntimeError', 'KeyError', 'CustomFailure'):
            self.assertIsNone(render_diagnostic(traceback_tail(exception, 'secret'), 3))
        self.assertIsNone(render_diagnostic(traceback_tail('TypeError', 'hidden') + b'RuntimeError: final hidden\n', 3))
        for name in ('../../secret', 'secret\nleak', '字', 'a' * 65):
            diagnostic = render_diagnostic(traceback_tail('TypeError', "got an unexpected keyword argument '%s'" % name), 3)
            self.assertNotIn('keyword', diagnostic or {})
        self.assertIsNone(render_diagnostic(b'x' * (MAX_RENDER_STDERR + 1), 3))
        self.assertIsNone(render_diagnostic(b'network/socket/private path\n', 3))

    def test_real_subprocess_output_is_drained_and_bounded(self):
        tail = traceback_tail('TypeError', "Mobject.__init__() got an unexpected keyword argument 'tip_length'")
        command = [sys.executable, '-c', 'import sys;sys.stderr.buffer.write(b"s"*300000+' + repr(b'\n' + tail) + ');sys.exit(1)']
        with patch('manim_worker.render_diagnostic', wraps=render_diagnostic) as parse:
            with self.assertRaises(SceneRenderFailure) as raised:
                render_process(command, dict(os.environ), 3)
        self.assertLessEqual(len(parse.call_args.args[0]), MAX_RENDER_STDERR)
        self.assertEqual(raised.exception.diagnostic, {'exception_type': 'TypeError', 'line': 3, 'keyword': 'tip_length'})
        self.assertEqual(str(raised.exception), 'render failed')

    def test_timeout_keeps_failure_and_process_group_cleanup(self):
        class Process:
            pid = 123
            def __init__(self):
                import io
                self.stderr = io.BytesIO()
            def wait(self, timeout):
                raise subprocess.TimeoutExpired('hidden-command', timeout)
        with patch('manim_worker.subprocess.Popen', return_value=Process()), patch('manim_worker.os.killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                render_process(['command'], {}, 3)
        kill.assert_called_once()

    def test_worker_emits_only_safe_diagnostic_or_legacy_generic_envelope(self):
        import io
        from manim_worker import main
        diagnostic = {'exception_type':'TypeError','line':3,'keyword':'tip_length'}
        for failure, expected in ((SceneRenderFailure(diagnostic), {'error':'scene_render_failed','diagnostic':diagnostic}),
                                  (SceneRenderFailure(), {'error':'scene_render_failed'}),
                                  (ValueError('/private/path secret'), {'error':'scene_render_failed'})):
            incoming = type('Input', (), {'buffer':io.BytesIO(json.dumps({'phase':'render','source':SOURCE}).encode())})()
            outgoing = io.StringIO()
            with patch('manim_worker.sys.stdin', incoming), patch('manim_worker.sys.stdout', outgoing), patch('manim_worker.render', side_effect=failure):
                main()
            self.assertEqual(json.loads(outgoing.getvalue()), expected)


class DiagnosticBoundaryTests(unittest.TestCase):
    def test_validated_fields_are_closed_and_strictly_typed(self):
        self.assertEqual(validate_render_diagnostic({'exception_type':'TypeError','line':3,'keyword':'tip_length'}, 3)['keyword'], 'tip_length')
        invalid = [None, [], {}, {'exception_type':'RuntimeError'}, {'exception_type':'TypeError','message':'secret'},
                   {'exception_type':'TypeError','attribute':'Arrow'}, {'exception_type':'ValueError','name':'hidden'},
                   {'exception_type':'NameError','name':'/private/path'}, {'exception_type':'TypeError','keyword':'字'},
                   {'exception_type':'TypeError','keyword':'a'*65}, {'exception_type':'TypeError','keyword':[]},
                   {'exception_type':'TypeError','line':True}, {'exception_type':'TypeError','line':0},
                   {'exception_type':'TypeError','line':4}, {'exception_type':'TypeError','line':1.0},
                   {'exception_type':'x'*MAX_RENDER_STDERR}, {'exception_type':'TypeError','extra':{}},
                   {'exception_type':'NameError','name':'a b'}, {'exception_type':'AttributeError','attribute':'x\nsecret'}]
        for value in invalid:
            with self.subTest(value=type(value).__name__), self.assertRaises(ManimContractError):
                validate_render_diagnostic(value, 3)

    def test_renderer_revalidates_worker_and_supplies_only_safe_feedback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path/'manim-runtime.json').write_text(json.dumps({'image':'sha256:'+'a'*64}))
            renderer = ManimRenderer(path)
            valid = {'exception_type':'TypeError','line':3,'keyword':'tip_length'}
            with patch.object(renderer, '_phase', return_value={'error':'scene_render_failed','diagnostic':valid}):
                with self.assertRaises(ManimContractError) as raised:
                    renderer.render(SOURCE)
            self.assertEqual(raised.exception.render_diagnostic, valid)
            self.assertEqual(raised.exception.diagnostic_stage, 'rendering')
            self.assertIn('TypeError，生成代码第3行，不支持的参数 tip_length', str(raised.exception))
            for raw in ({'error':'scene_render_failed'},
                        {'error':'scene_render_failed','diagnostic':dict(valid,message='/private/secret')},
                        {'error':'scene_render_failed','diagnostic':dict(valid,line=999)},
                        {'error':'scene_render_failed','diagnostic':dict(valid,keyword='/secret')},
                        {'error':'scene_render_failed','diagnostic':dict(valid,keyword='s'*70000)},
                        {'error':'scene_render_failed','diagnostic':valid,'stderr':'secret'}):
                with patch.object(renderer, '_phase', return_value=raw), self.assertRaises(ManimContractError) as failure:
                    renderer.render(SOURCE)
                self.assertNotIn('secret', str(failure.exception))
                self.assertNotIn('/private', str(failure.exception))


if __name__ == '__main__':
    unittest.main()
