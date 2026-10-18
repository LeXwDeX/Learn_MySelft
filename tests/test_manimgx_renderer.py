import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from manim_contracts import ManimContractError
from manim_renderer import ManimUnavailable
from manimgx_renderer import ManimgxRenderer
import manimgx_renderer
from manimgx_worker import (LayoutFailure, inspect_failed, inspect_sample_time, layout_detail,
                            require_clean_layout)
from animation_contracts import validate_scene


SCENE = {'version': 1, 'kind': 'spec',
         'initial': [{'id': 'a', 'type': 'arrow', 'start': [0, 0], 'end': [2, 1]}],
         'steps': [{'caption': '标出向量', 'actions': [
             {'op': 'indicate', 'target': 'a', 'color': '#c74f20', 'run_time': 1}]}]}


def png(width=240, height=135):
    import struct, zlib
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\xff\xff' * width) * height)) + chunk(b'IEND', b'')


class FakeRenderer(ManimgxRenderer):
    def __init__(self, path):
        super().__init__(path)
        self.inputs = []
        self.render_failure = None

    def _phase(self, image, envelope, limit, timeout):
        self.inputs.append(envelope)
        if envelope['phase'] == 'render':
            if self.render_failure:
                return self.render_failure if isinstance(self.render_failure, dict) else {'error': self.render_failure}
            return {'raw_video': base64.b64encode(b'untrusted').decode(),
                    'steps': [dict(caption='标出向量', start_frame=0, end_frame=30,
                                   result_frame=29, hold_start_frame=9)]}
        return {'manifest': dict(version=1, fps=30, width=1280, height=720, duration=1,
                                 engine={'name': 'ManimGX', 'version': '0.1.1'},
                                 steps=[dict(caption='标出向量', start_frame=0, end_frame=30,
                                             result_frame=29, hold_start_frame=9)]),
                'files': {'video.mp4': base64.b64encode(b'normalized').decode(),
                          'poster.png': base64.b64encode(png()).decode(),
                          'step-0.png': base64.b64encode(png()).decode()},
                'review_frames': [{name: base64.b64encode(png()).decode()
                                   for name in ('start', 'middle', 'result')}]}


class RendererTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        (self.path / 'manimgx-runtime.json').write_text(json.dumps({'image': 'sha256:' + 'a' * 64}))

    def test_scene_is_closed_and_validation_receives_media_only(self):
        renderer = FakeRenderer(self.path)
        result = renderer.render(SCENE)
        self.assertEqual(result['video'], b'normalized')
        self.assertEqual(renderer.inputs[0]['phase'], 'render')
        self.assertEqual(renderer.inputs[0]['scene'], validate_scene(SCENE))
        self.assertEqual(set(renderer.inputs[1]), {'phase', 'raw_video', 'steps'})
        self.assertEqual(renderer.inputs[1]['steps'][0]['end_frame'], 30)

    def test_model_code_cannot_enter_render_phase(self):
        renderer = FakeRenderer(self.path)
        broken = dict(SCENE, code='class LessonScene: pass')
        with self.assertRaises(ManimContractError):
            renderer.render(broken)
        self.assertEqual(renderer.inputs, [])

    def test_layout_and_render_failures_stay_repairable(self):
        renderer = FakeRenderer(self.path); renderer.render_failure = 'layout_problems'
        with self.assertRaises(ManimContractError) as raised:
            renderer.render(SCENE)
        self.assertEqual(raised.exception.failure_code, 'layout_invalid')
        self.assertEqual(raised.exception.diagnostic_stage, 'rendering')
        renderer.render_failure = 'scene_render_failed'
        with self.assertRaises(ManimContractError) as raised:
            renderer.render(SCENE)
        self.assertEqual(raised.exception.failure_code, 'render_failed')

    def test_layout_detail_reaches_repair_feedback_without_raw_output(self):
        renderer = FakeRenderer(self.path)
        detail = "  [1] t=6.6–7.3s (lesson.py:134)  initial[3] (Text 'a') and Circle: Circle runs\n through the text"
        renderer.render_failure = {'error': 'layout_problems', 'detail': detail}
        with self.assertRaises(ManimContractError) as raised:
            renderer.render(SCENE)
        message = str(raised.exception)
        self.assertIn('Circle runs through the text', message)
        self.assertNotIn('lesson.py', message)
        self.assertNotIn('\n', message)
        self.assertLessEqual(len(message), 600)
        renderer.render_failure = {'error': 'layout_problems', 'detail': ['hidden']}
        with self.assertRaises(ManimContractError) as raised:
            renderer.render(SCENE)
        self.assertNotIn('hidden', str(raised.exception))

    def test_media_failure_is_distinct_from_scene_failure(self):
        renderer = FakeRenderer(self.path)
        with patch.object(renderer, '_phase', side_effect=[renderer._phase('', {'phase': 'render', 'scene': SCENE}, 0, 0),
                                                           {'error': 'media_check_failed'}]):
            with self.assertRaises(ManimContractError) as raised:
                renderer.render(SCENE)
        self.assertEqual(raised.exception.failure_code, 'media_invalid')
        self.assertEqual(raised.exception.diagnostic_stage, 'media_validation')

    def test_mutable_or_missing_image_fails_before_any_container(self):
        renderer = FakeRenderer(self.path)
        for config in ({'image': 'learn-manimgx:latest'}, {'image': 'learn-manimgx'}, {}):
            (self.path / 'manimgx-runtime.json').write_text(json.dumps(config))
            with self.subTest(config=config), self.assertRaises(ManimUnavailable):
                renderer.render(SCENE)
        self.assertEqual(renderer.inputs, [])

    def test_unexpected_validation_fields_fail_closed(self):
        renderer = FakeRenderer(self.path)
        value = renderer._phase('', {'phase': 'validate'}, 0, 0)
        broken = dict(value, extra=True)
        with patch.object(renderer, '_phase', side_effect=[{'raw_video': 'AAAA', 'steps': []}, broken]):
            with self.assertRaises(ManimContractError):
                renderer.render(SCENE)


class DockerCommandTests(unittest.TestCase):
    def test_container_is_networkless_read_only_and_unprivileged(self):
        process = MagicMock()
        process.stdin = MagicMock()
        process.stdout = io.BytesIO(b'{}')
        process.returncode = 0
        process.wait.return_value = 0
        process.poll.return_value = 0
        removed = MagicMock(returncode=0)
        with patch.object(manimgx_renderer.subprocess, 'Popen', return_value=process) as popen, \
             patch.object(manimgx_renderer.subprocess, 'run', return_value=removed):
            ManimgxRenderer('/unused')._phase('sha256:' + 'a' * 64, {'phase': 'render'}, 100, 10)
        command = popen.call_args.args[0]
        self.assertEqual(command[command.index('--network') + 1], 'none')
        self.assertIn('--read-only', command)
        self.assertEqual(command[command.index('--cap-drop') + 1], 'ALL')
        self.assertEqual(command[command.index('--security-opt') + 1], 'no-new-privileges')
        self.assertEqual(command[command.index('--user') + 1], '10001:10001')
        self.assertEqual(command[command.index('-i') + 1], 'sha256:' + 'a' * 64)
        self.assertEqual(command[-2:], ['python', '/opt/learn/manimgx_worker.py'])
        self.assertNotIn('--network=host', command)


class LayoutReportTests(unittest.TestCase):
    def test_render_and_inspect_reports_are_strict(self):
        for text in ('layout: no problems\n', 'layout: no problems in 1 sample\n',
                     'layout: no problems in 2 samples\n', 'x\nlayout: no problems\n'):
            require_clean_layout(text)
        for text in ('', 'layout: 1 problem', 'layout: 2 problems', 'layout: no problems in x'):
            with self.subTest(text=text), self.assertRaises(LayoutFailure):
                require_clean_layout(text)

    def test_nonzero_inspect_exit_needs_a_problem_report(self):
        self.assertFalse(inspect_failed(0, ''))
        self.assertFalse(inspect_failed(1, 'layout: 1 problem\n'))
        self.assertFalse(inspect_failed(1, 'layout: 2 problems\n'))
        for code, text in ((1, ''), (1, 'layout: no problems in 1 sample\n'),
                           (2, 'layout: 0 problems\n')):
            with self.subTest(code=code, text=text):
                self.assertTrue(inspect_failed(code, text))

    def test_inspect_samples_the_middle_of_each_hold(self):
        self.assertEqual(inspect_sample_time(0), '0.016667')
        self.assertEqual(inspect_sample_time(1), '0.050000')
        self.assertEqual(inspect_sample_time(21), '0.716667')

    def test_layout_detail_is_bounded_and_path_free(self):
        text = ("layout: 1 problem\n"
                "  [1] t=6.6–7.3s (lesson.py:134)  initial[3] (Text 'a') and Circle: Circle runs through the text\n")
        detail = layout_detail(text)
        self.assertIn('Circle runs through the text', detail)
        self.assertNotIn('lesson.py', detail)
        self.assertLessEqual(len(detail), 400)
        self.assertEqual(layout_detail('layout: no problems\n'), '')
        with self.assertRaises(LayoutFailure) as raised:
            require_clean_layout(text)
        self.assertIn('Circle runs through the text', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
