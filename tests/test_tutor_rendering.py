"""Tutor gates never leak unchecked diagrams across chunk boundaries."""

from pathlib import Path
import json
import subprocess
import sys
import unittest
import io
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from tutor_rendering import MermaidStream, TutorRendering, MAX_DIAGRAMS, MAX_SOURCE, MAX_OPENING
from http_handler import Handler
from render_review import normalize_mermaid
from scene_contracts import MAX_SOURCE as MAX_SCENE_SOURCE


class TutorRenderingTests(unittest.TestCase):
    def passed(self, source):
        self.checked.append(source)
        return {'status': 'passed', 'source': normalize_mermaid(source)}

    def setUp(self):
        self.checked = []
        self.graph = '```mermaid\nflowchart TD\n A["向量<br/>坐标"] --> B["线性组合"]\n```\n'

    def collect(self, source, chunks=None, validator=None):
        gate = MermaidStream(validator or self.passed)
        result = []
        for chunk in chunks or [source]:
            result.extend(gate.feed(chunk))
        result.extend(gate.finish())
        return ''.join(result)

    def test_every_two_chunk_boundary_and_single_character_chunks(self):
        source = '先读正文。\n\n' + self.graph + '\n接下来检查坐标。'
        expected = source.replace('<br/>', ' ')
        for cut in range(1, len(source)):
            with self.subTest(cut=cut):
                self.assertEqual(self.collect(source, [source[:cut], source[cut:]]), expected)
        self.assertEqual(self.collect(source, list(source)), expected)

    def test_cr_and_split_crlf_cannot_bypass_the_gate(self):
        for ending in ('\r', '\r\n'):
            source = self.graph.replace('\n', ending)
            self.assertEqual(self.collect(source, list(source)), self.graph.replace('<br/>', ' '))

    def test_prose_and_list_prose_stream_before_answer_finishes(self):
        gate = MermaidStream(self.passed)
        self.assertEqual(gate.feed('普通文字'), ['普通文字'])
        self.assertEqual(gate.feed('\n- 分步说明'), ['\n', '- 分步说明'])
        self.assertEqual(self.checked, [])
        self.assertEqual(gate.finish(), [])
        inline = '`行内代码`' + '正常讲解' * 100
        self.assertEqual(self.collect(inline, list(inline)), inline)

    def test_diagram_is_held_until_closed_and_validated(self):
        gate = MermaidStream(self.passed)
        self.assertEqual(gate.feed(self.graph[:-4]), [])
        self.assertEqual(self.checked, [])
        output = ''.join(gate.feed('```\n'))
        self.assertIn('```mermaid', output)
        self.assertNotIn('<br/>', output)
        self.assertEqual(len(self.checked), 1)
        self.assertEqual(gate.finish(), [])

    def test_unavailable_invalid_and_validator_exception_downgrade(self):
        for status in ('failed', 'unavailable'):
            result = self.collect(self.graph, validator=lambda _: {'status': status})
            self.assertNotIn('```mermaid', result)
            self.assertIn('```text', result)
            self.assertIn('向量<br/>坐标', result)
            self.assertIn('保留源码', result)
        def unavailable(_):
            raise OSError('private renderer detail')
        result = self.collect(self.graph, validator=unavailable)
        self.assertNotIn('private renderer detail', result)
        self.assertNotIn('```mermaid', result)

    def test_unclosed_and_oversize_blocks_never_call_renderer(self):
        for source in (self.graph[:-4], '```mermaid\nflowchart TD\n' + 'A' * (MAX_SOURCE + 1)):
            output = self.collect(source, list(source))
            self.assertNotIn('```mermaid', output)
            self.assertIn('```text', output)
            self.assertIn('保留源码', output)
        self.assertEqual(self.checked, [])

    def test_boundary_source_does_not_count_split_closing_marker(self):
        for size in (MAX_SOURCE - 2, MAX_SOURCE - 1, MAX_SOURCE):
            body = 'flowchart TD\n A["' + 'x' * (size - 30) + '"] --> B\n'
            body += ' ' * (size - len(body) - 1) + '\n'
            self.assertEqual(len(body), size)
            graph = '```mermaid\n' + body + '```\n'
            output = self.collect(graph, list(graph))
            self.assertIn('```mermaid', output)
        self.assertEqual(len(self.checked), 3)

    def test_diagram_count_is_bounded(self):
        source = self.graph * (MAX_DIAGRAMS + 3)
        output = self.collect(source, list(source))
        self.assertEqual(len(self.checked), MAX_DIAGRAMS)
        self.assertEqual(output.count('```mermaid'), MAX_DIAGRAMS)
        self.assertEqual(output.count('```text'), 3)

    def test_tilde_long_fences_and_close_without_newline(self):
        for fence in ('~~~', '````', '~~~~~'):
            source = self.graph.replace('```', fence).rstrip('\n')
            result = self.collect(source, list(source))
            self.assertIn(fence + 'mermaid', result)
            self.assertEqual(result.count(fence), 2)

    def test_mermaid_literal_inside_ordinary_code_is_unchanged(self):
        source = '````markdown\n' + self.graph + '````\n普通文字\n~~~text\n' + self.graph + '~~~\n'
        self.assertEqual(self.collect(source, list(source)), source)
        self.assertEqual(self.checked, [])

    def test_nested_diagrams_are_ordinary_source_not_unchecked_figures(self):
        for prefix in ('> ', '> > ', '- ', '1. ', '> - '):
            source = prefix + '```mermaid\n' + prefix + 'flowchart TD\n' + prefix + 'A-->B\n' + prefix + '```\n'
            result = self.collect(source, list(source))
            self.assertNotIn('```mermaid', result)
            self.assertIn('```text', result)
        self.assertEqual(self.checked, [])

    def test_unbounded_opening_line_cannot_create_an_unchecked_figure(self):
        source = '```mermaid' + ' ' * 300 + '\nflowchart TD\nA-->B\n```\n'
        result = self.collect(source, list(source))
        self.assertTrue(result.startswith('\\```mermaid'))
        self.assertEqual(self.checked, [])

    def test_interrupted_answer_keeps_partial_source_without_validation(self):
        gate = MermaidStream(self.passed)
        gate.feed(self.graph.rstrip('\n'))
        result = ''.join(gate.finish(interrupted=True))
        self.assertNotIn('```mermaid', result)
        self.assertIn('向量<br/>坐标', result)
        self.assertIn('保留源码', result)
        self.assertEqual(self.checked, [])

    def nested_prefixes(self, language='text', closed=True, closer='```'):
        for opening, continuation in (('- ', '  '), ('1. ', '   '),
                                      ('> ', '> '), ('> > ', '> > '),
                                      ('> - ', '>   '), ('- > ', '  > '),
                                      ('- - ', '    ')):
            body = opening + '```' + language + '\n' + continuation + 'sample\n'
            if closed:
                body += continuation + closer + '\n'
            yield body + '\n'

    def assert_all_chunkings(self, source, expected, calls, validator=None):
        chunkings = [[source], list(source)]
        chunkings.extend([source[:cut], source[cut:]] for cut in range(1, len(source)))
        for chunks in chunkings:
            self.checked = []
            with self.subTest(parts=len(chunks), first=len(chunks[0])):
                self.assertEqual(self.collect(source, chunks, validator), expected)
                self.assertEqual(len(self.checked), calls)

    def test_nested_code_closer_never_hides_a_later_top_level_graph(self):
        for language in ('text', 'mermaid'):
            for prefix in self.nested_prefixes(language):
                source = prefix + self.graph
                expected = prefix.replace('```mermaid', '```text') + self.graph.replace('<br/>', ' ')
                self.assert_all_chunkings(source, expected, 1)

    def test_prose_started_list_keeps_indented_code_scope_until_the_list_ends(self):
        for opening, continuation in (('- ', '  '), ('1. ', '   '), ('> - ', '>   ')):
            for language in ('text', 'mermaid'):
                for closed in (True, False):
                    prefix = opening + '示例\n\n' + continuation + '```' + language + '\n' + continuation + 'sample\n'
                    if closed:
                        prefix += continuation + '```\n'
                    prefix += '\n'
                    source = prefix + self.graph
                    expected = prefix.replace('```mermaid', '```text') + self.graph.replace('<br/>', ' ')
                    self.assert_all_chunkings(source, expected, 1)

    def test_unclosed_or_wrong_nested_closer_ends_at_the_container_boundary(self):
        for prefix in (*self.nested_prefixes(closed=False),
                       *self.nested_prefixes(closer='~~~'),
                       *self.nested_prefixes(closer='``'),
                       *self.nested_prefixes(closer='``` extra')):
            source = prefix + self.graph
            self.assert_all_chunkings(source, prefix + self.graph.replace('<br/>', ' '), 1)

    def test_nested_code_preserves_mermaid_examples_and_checks_only_following_graph(self):
        for opening, continuation in (('- ', '  '), ('> ', '> '), ('- > ', '  > ')):
            prefix = opening + '````markdown\n' + ''.join(continuation + line + '\n' for line in self.graph.rstrip('\n').split('\n'))
            prefix += continuation + '````\n\n'
            source = prefix + self.graph
            self.assert_all_chunkings(source, prefix + self.graph.replace('<br/>', ' '), 1)

    def test_later_invalid_unclosed_and_unavailable_graphs_are_not_released(self):
        prefix = next(self.nested_prefixes())
        for status in ('failed', 'unavailable'):
            def verdict(source):
                self.checked.append(source)
                return {'status': status}
            output = self.collect(prefix + self.graph, list(prefix + self.graph), verdict)
            self.assertEqual(len(self.checked), 1)
            self.checked = []
            self.assertNotIn('```mermaid', output)
            self.assertIn('向量<br/>坐标', output)
        output = self.collect(prefix + self.graph[:-4], list(prefix + self.graph[:-4]))
        self.assertNotIn('```mermaid', output)
        self.assertEqual(self.checked, [])

    def test_opening_cap_is_identical_for_whole_two_piece_and_character_deltas(self):
        for length in (MAX_OPENING - 1, MAX_OPENING, MAX_OPENING + 1, MAX_OPENING + 54):
            opener = '```mermaid' + ' ' * (length - len('```mermaid'))
            source = opener + '\nflowchart TD\nA-->B\n```\n'
            if length > MAX_OPENING:
                self.assert_all_chunkings(source, '\\' + source, 0)
            else:
                self.assert_all_chunkings(source, '```mermaid\nflowchart TD\nA-->B\n```\n', 1)

    def test_real_shared_parser_cannot_render_an_unchecked_graph_after_nested_code(self):
        sources = []
        for language in ('text', 'mermaid'):
            for prefix in self.nested_prefixes(language):
                def failed(source):
                    self.checked.append(source)
                    return {'status': 'failed'}
                self.checked = []
                sources.append(self.collect(prefix + self.graph, list(prefix + self.graph), failed))
                self.assertEqual(len(self.checked), 1)
        # Partial container exits must retain the outer list. A following fence
        # can still belong to that list before the top-level graph begins.
        prefixes = ('- ', '1. ', '> ', '> > ', '> - ', '- > ', '- - ', '> 1. ',
                    '   - ', '-     ', '    > ')
        continuations = ('', ' ', '  ', '   ', '    ', '      ', '> ', '>   ', '  > ', '> > ')
        for prefix in prefixes:
            for continuation in continuations:
                for language in ('text', 'mermaid'):
                    source = prefix + '```' + language + '\n' + continuation + 'sample\n'
                    source += continuation + '```\n\n' + self.graph
                    whole = self.collect(source, validator=lambda _: {'status': 'failed'})
                    chars = self.collect(source, list(source), lambda _: {'status': 'failed'})
                    self.assertEqual(whole, chars, (prefix, continuation, language))
                    sources.append(whole)
        for opening, continuation in (('- ', '  '), ('1. ', '   '), ('> - ', '>   ')):
            for language in ('text', 'mermaid'):
                for closed in (True, False):
                    source = opening + '示例\n\n' + continuation + '```' + language + '\n' + continuation + 'sample\n'
                    if closed:
                        source += continuation + '```\n'
                    source += '\n' + self.graph
                    sources.append(self.collect(source, list(source), lambda _: {'status': 'failed'}))
        expected = [0] * len(sources)
        for language in ('text', 'mermaid'):
            for prefix in self.nested_prefixes(language):
                self.checked = []
                sources.append(self.collect(prefix + self.graph, list(prefix + self.graph)))
                self.assertEqual(len(self.checked), 1)
                expected.append(1)
        for closed in (True, False):
            prefix = '- 示例\n\n  ```text\n  sample\n' + ('  ```\n' if closed else '') + '\n'
            self.checked = []
            sources.append(self.collect(prefix + self.graph, list(prefix + self.graph)))
            self.assertEqual(len(self.checked), 1)
            expected.append(1)
        self.assertEqual(self.shared_diagram_counts(sources), expected)

    def shared_diagram_counts(self, sources):
        script = """const fs=require('fs'),vm=require('vm');
const window={markdownit:require('./shared/vendor-markdown-it.js')};
vm.runInNewContext(fs.readFileSync('shared/markdown.js','utf8'),{window,WeakMap,Promise});
const sources=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(sources.map(source=>(window.LearnMarkdown.render(source).match(/data-diagram=/g)||[]).length)));
"""
        result = subprocess.run(['node', '-e', script], input=json.dumps(sources),
                                cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_nested_language_whitespace_preserves_tabs_and_downgrades_mermaid(self):
        source = '- ```\tmermaid\n  flowchart TD\n  A-->B\n  ```\n\n' + self.graph
        expected = source.replace('```\tmermaid', '```\ttext').replace('<br/>', ' ')
        self.assert_all_chunkings(source, expected, 1)

    def test_large_list_padding_does_not_hide_a_following_nested_graph(self):
        for fence in ('```', '~~~'):
            for padding in (5, 6):
                for indentation in (2, 3):
                    source = '-' + ' ' * padding + fence + 'text\n'
                    source += ' ' * indentation + fence + 'mermaid\n'
                    source += ' ' * indentation + 'flowchart TD\n'
                    source += ' ' * indentation + 'A-->B\n'
                    source += ' ' * indentation + fence + '\n'
                    self.assert_all_chunkings(source, source.replace(fence + 'mermaid', fence + 'text'), 0)
        source = '- item\n\n      ```text\n  ```mermaid\n  flowchart TD\n  A-->B\n  ```\n'
        self.assert_all_chunkings(source, source.replace('```mermaid', '```text'), 0)

    def test_indented_code_examples_keep_mermaid_language_and_long_lines_unchanged(self):
        for prefix in ('    ', '\t', '      '):
            source = prefix + '```mermaid' + ' ' * 300 + '\n' + prefix + 'flowchart TD\n' + prefix + 'A-->B\n' + prefix + '```\n'
            self.assert_all_chunkings(source, source, 0)
        for padding in (5, 6):
            continuation = ' ' * (padding + 1)
            source = '-' + ' ' * padding + '```text\n' + continuation + '```mermaid\n'
            source += continuation + 'flowchart TD\n' + continuation + 'A-->B\n' + continuation + '```\n'
            self.assert_all_chunkings(source, source, 0)

    def test_real_parser_large_padding_and_indented_code_cannot_bypass_gate(self):
        sources, expected = [], []
        for fence in ('```', '~~~'):
            for padding in range(1, 11):
                for indentation in range(8):
                    graph = ' ' * indentation + fence + 'mermaid\n'
                    graph += ' ' * indentation + 'flowchart TD\n' + ' ' * indentation + 'A-->B\n'
                    graph += ' ' * indentation + fence + '\n'
                    source = '-' + ' ' * padding + fence + 'text\n' + graph
                    for status in ('failed', 'passed'):
                        def verdict(body):
                            self.checked.append(body)
                            return {'status': status, 'source': body}
                        self.checked = []
                        whole = self.collect(source, validator=verdict)
                        calls = len(self.checked)
                        self.checked = []
                        chars = self.collect(source, list(source), verdict)
                        self.assertEqual(whole, chars, (fence, padding, indentation, status))
                        self.assertEqual(len(self.checked), calls)
                        sources.append(whole)
                        expected.append(calls if status == 'passed' else 0)
        for fence in ('```', '~~~'):
            for indentation in (6, 7):
                prefix = '- item\n\n' + ' ' * indentation + fence + 'text\n'
                graph = '  ' + fence + 'mermaid\n  flowchart TD\n  A-->B\n  ' + fence + '\n'
                for status in ('failed', 'passed'):
                    sources.append(self.collect(prefix + graph, list(prefix + graph), lambda _: {'status': status}))
                    expected.append(0)
        self.assertEqual(self.shared_diagram_counts(sources), expected)

    def empty_list_code_prefixes(self):
        for marker in ('-', '+', '*', '1.', '1)'):
            width = len(marker) + 1
            for trailing in range(7):
                for opening, continuation in ((marker, ' ' * width),
                                               ('> ' + marker, '> ' + ' ' * width),
                                               ('- ' + marker, ' ' * (2 + width)),
                                               ('- > ' + marker, '  > ' + ' ' * width)):
                    for closed in (True, False):
                        prefix = opening + ' ' * trailing + '\n'
                        prefix += continuation + '```text\n' + continuation + 'sample\n'
                        if closed:
                            prefix += continuation + '```\n'
                        yield prefix + '\n'

    def test_empty_list_item_width_ignores_zero_to_six_trailing_spaces(self):
        for prefix in self.empty_list_code_prefixes():
            source = prefix + self.graph
            self.assert_all_chunkings(source, prefix + self.graph.replace('<br/>', ' '), 1)
        for marker in ('-', '+', '*', '1.', '1)'):
            for trailing in range(7):
                plain = marker + ' ' * trailing + '\n'
                self.assert_all_chunkings(plain, plain, 0)

    def test_real_parser_empty_list_items_never_hide_top_level_mermaid(self):
        sources, expected = [], []
        for prefix in self.empty_list_code_prefixes():
            for language in ('text', 'mermaid'):
                source = prefix.replace('```text', '```' + language) + self.graph
                for status in ('failed', 'passed'):
                    def verdict(body):
                        self.checked.append(body)
                        return {'status': status, 'source': normalize_mermaid(body)}
                    self.checked = []
                    whole = self.collect(source, validator=verdict)
                    self.assertEqual(len(self.checked), 1)
                    self.checked = []
                    chars = self.collect(source, list(source), verdict)
                    self.assertEqual(whole, chars)
                    self.assertEqual(len(self.checked), 1)
                    sources.append(whole)
                    expected.append(1 if status == 'passed' else 0)
        self.assertEqual(self.shared_diagram_counts(sources), expected)


class TutorAnimationTests(unittest.TestCase):
    def scene(self, *, animated=True):
        scene = {"version": 1, "type": "diagram", "title": "信息流",
                 "summary": "信息点从发送端移动到接收端。",
                 "elements": [{"id": "packet", "kind": "point", "points": [[0, 0]]}]}
        if animated:
            scene['steps'] = [{"caption": "传递信息。", "changes": [{"id": "packet", "points": [[2, 0]]}]}]
        return json.dumps(scene, ensure_ascii=False)

    def collect(self, source, *, repair=None, interrupted=False, chunks=None, required=True):
        gate = MermaidStream(lambda _: {'status': 'passed'}, require_animation=required, repair=repair)
        output = []
        for piece in chunks or [source]:
            output.extend(gate.feed(piece))
        output.extend(gate.finish(interrupted=interrupted))
        self.assertEqual(gate.finish(), [])
        return ''.join(output), gate

    def test_static_scene_is_not_released_as_animation_and_repair_is_once(self):
        calls = []
        source = '先看关系。\n\n```learn-scene\n' + self.scene(animated=False) + '\n```\n'
        def repair(reply):
            calls.append(reply)
            return self.scene()
        output, gate = self.collect(source, repair=repair, chunks=list(source))
        self.assertTrue(gate.animation_passed)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], source)
        self.assertIn('先看关系。', output)
        self.assertIn('```text', output)
        self.assertEqual(output.count('```learn-scene'), 1)

    def test_valid_scene_all_chunk_boundaries_and_crlf_need_no_repair(self):
        source = '```learn-scene\n' + self.scene() + '\n```\n'
        def unexpected(_):
            self.fail('valid animation must not retry')
        chunkings = [[source], list(source)]
        chunkings.extend([source[:cut], source[cut:]] for cut in range(1, len(source)))
        for chunks in chunkings:
            output, gate = self.collect(source, repair=unexpected, chunks=chunks)
            self.assertEqual(output, source)
            self.assertTrue(gate.animation_passed)
        output, _ = self.collect(source.replace('\n', '\r\n'), chunks=list(source.replace('\n', '\r\n')), repair=unexpected)
        self.assertEqual(output, source)

    def test_failed_missing_bad_and_oversized_repairs_report_failure(self):
        for repaired in (None, 'null', '{}', self.scene(animated=False), 'x' * (MAX_SCENE_SOURCE + 1)):
            calls = []
            def repair(reply):
                calls.append(reply)
                return repaired
            output, gate = self.collect('保留讲解。', repair=repair)
            self.assertEqual(len(calls), 1)
            self.assertFalse(gate.animation_passed)
            self.assertIn('保留讲解。', output)
            self.assertIn('动画暂未生成成功', output)
            self.assertNotIn('```learn-scene', output)
        def fail(_):
            raise OSError('private upstream detail')
        output, _ = self.collect('讲解。', repair=fail)
        self.assertNotIn('private upstream detail', output)
        self.assertIn('动画暂未生成成功', output)

    def test_interruption_does_not_validate_release_or_repair_partial_scene(self):
        def unexpected(_):
            self.fail('interruption must not repair')
        source = '讲解。\n```learn-scene\n' + self.scene() + '\n```'
        output, gate = self.collect(source, chunks=list(source), interrupted=True, repair=unexpected)
        self.assertFalse(gate.animation_passed)
        self.assertNotIn('```learn-scene', output)
        self.assertIn('```text', output)

    def test_unclosed_oversized_or_nested_scene_needs_safe_repair(self):
        for source in ('```learn-scene\n' + self.scene(),
                       '```learn-scene\n' + 'x' * (MAX_SCENE_SOURCE + 1) + '\n```\n',
                       '> ```learn-scene\n> ' + self.scene() + '\n> ```\n',
                       '- ```learn-scene\n  ' + self.scene() + '\n  ```\n'):
            output, gate = self.collect(source, repair=lambda _: self.scene(), chunks=list(source))
            self.assertTrue(gate.animation_passed)
            self.assertEqual(output.count('```learn-scene'), 1)
            self.assertIn('```text', output)

    def test_ordinary_static_scene_keeps_legacy_source(self):
        source = '```learn-scene\n' + self.scene(animated=False) + '\n```\n'
        output, _ = self.collect(source, required=False, chunks=list(source))
        self.assertEqual(output, source)

    def test_scene_source_limit_excludes_the_closing_separator_newline(self):
        raw = self.scene()
        for length, success in ((MAX_SCENE_SOURCE, True), (MAX_SCENE_SOURCE + 1, False)):
            source = '```learn-scene\n' + raw + ' ' * (length - len(raw)) + '\n```\n'
            output, gate = self.collect(source, chunks=list(source))
            self.assertEqual(gate.animation_passed, success)
            self.assertEqual('```learn-scene' in output, success)

    def test_unclosed_ordinary_code_cannot_hide_a_repaired_scene(self):
        source = '```python\nprint("untrusted example")'
        output, gate = self.collect(source, repair=lambda _: self.scene(), chunks=list(source))
        self.assertTrue(gate.animation_passed)
        self.assertIn('print("untrusted example")\n```\n\n\n```learn-scene', output)

    def test_repair_context_is_bounded_and_mermaid_gate_still_runs(self):
        checked, repaired = [], []
        def validate(source):
            checked.append(source)
            return {'status': 'passed'}
        def repair(source):
            repaired.append(source)
            return self.scene()
        gate = MermaidStream(validate, require_animation=True, repair=repair)
        source = '```mermaid\nflowchart TD\nA-->B\n```\n' + '文' * (MAX_SCENE_SOURCE + 1)
        output = ''.join(gate.feed(source) + gate.finish())
        self.assertEqual(len(checked), 1)
        self.assertEqual(len(repaired), 1)
        self.assertEqual(len(repaired[0]), MAX_SCENE_SOURCE)
        self.assertIn('```mermaid', output)
        self.assertEqual(output.count('```learn-scene'), 1)

    def test_detected_disconnected_client_does_not_launch_repair(self):
        response = io.BytesIO(json.dumps({'choices': [{'message': {'content': ''}}]}).encode())
        response.headers = {'Content-Type': 'application/json'}
        model = SimpleNamespace(stream=Mock(return_value=response), json=Mock())
        app = SimpleNamespace(model=model, tutor_rendering=TutorRendering(lambda _: {'status': 'passed'}))
        request = SimpleNamespace(app=app, send_response=Mock(), send_header=Mock(),
                                  end_headers=Mock(), _cors=Mock(),
                                  wfile=SimpleNamespace(write=Mock(side_effect=BrokenPipeError), flush=Mock()))
        Handler.stream(request, [{'role': 'system', 'content': '说明。'}, {'role': 'user', 'content': '请做动画演示'}])
        model.json.assert_not_called()
        self.assertTrue(response.closed)


if __name__ == '__main__':
    unittest.main()
