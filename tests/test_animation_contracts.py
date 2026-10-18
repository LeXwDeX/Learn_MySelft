import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from animation_contracts import validate_scene
from manim_contracts import ManimContractError, validate_manifest


def scene():
    return {
        'version': 1,
        'kind': 'spec',
        'initial': [
            {'id': 'a', 'type': 'arrow', 'start': [0, 0], 'end': [2, 1], 'color': '#245b83'},
        ],
        'steps': [
            {'caption': '首帧已有向量a，标出它的长度', 'actions': [
                {'op': 'create', 'object': {'id': 'len', 'type': 'math',
                                            'tex': r'|\vec a|=\sqrt{5}', 'at': [-5.5, -3.0]},
                 'animation': 'write', 'run_time': 1.2},
            ]},
            {'caption': '绕原点逆时针旋转90度', 'actions': [
                {'op': 'rotate', 'target': 'a', 'angle_deg': 90, 'about': [0, 0], 'run_time': 2.0},
            ]},
        ],
    }


def manifest(engine):
    return {'version': 1, 'fps': 30, 'width': 1280, 'height': 720, 'duration': 2, 'engine': engine,
            'steps': [{'caption': '观察变化', 'start_frame': 0, 'end_frame': 60,
                       'result_frame': 59, 'hold_start_frame': 39}]}


class SceneContractTests(unittest.TestCase):
    def test_valid_spec_is_normalized(self):
        value = scene()
        result = validate_scene(value)
        self.assertEqual(result['kind'], 'spec')
        self.assertEqual([item['id'] for item in result['initial']], ['a'])
        self.assertEqual(result['steps'][1]['actions'][0]['angle_deg'], 90.0)
        self.assertEqual(value['steps'][1]['actions'][0]['angle_deg'], 90)

    def test_valid_recipe(self):
        value = {'version': 1, 'kind': 'recipe', 'recipe': 'vector_rotation',
                 'parameters': {'vector': [2, 1], 'angle_deg': 90},
                 'steps': [{'caption': '一'}, {'caption': '二'}, {'caption': '三'}]}
        result = validate_scene(value)
        self.assertEqual(result['parameters'], {'vector': [2, 1], 'angle_deg': 90})
        self.assertEqual(len(result['steps']), 3)

    def test_static_or_invisible_actions_are_rejected(self):
        value = scene()
        value['steps'][0]['actions'] = []
        with self.assertRaisesRegex(ManimContractError, '动作'):
            validate_scene(value)
        value = scene()
        value['steps'][1]['actions'][0]['angle_deg'] = 0
        with self.assertRaisesRegex(ManimContractError, '旋转角度'):
            validate_scene(value)
        value = scene()
        value['steps'][1]['actions'] = [{'op': 'move', 'target': 'a', 'to': [1.0, 0.5], 'run_time': 1}]
        with self.assertRaisesRegex(ManimContractError, '移动距离'):
            validate_scene(value)

    def test_transform_must_change_non_color_state(self):
        value = scene()
        value['steps'][1]['actions'] = [
            {'op': 'transform', 'target': 'len', 'object': {'type': 'math', 'color': '#c74f20'}, 'run_time': 1}]
        with self.assertRaisesRegex(ManimContractError, '只改颜色'):
            validate_scene(value)
        value = scene()
        value['steps'][1]['actions'] = [
            {'op': 'transform', 'target': 'len', 'object': {'type': 'math', 'tex': r'|\vec a|=2'}, 'run_time': 1}]
        result = validate_scene(value)
        self.assertEqual(result['steps'][1]['actions'][0]['object']['at'], [-5.5, -3.0])

    def test_unknown_references_and_actions_are_rejected(self):
        value = scene()
        value['steps'][1]['actions'] = [{'op': 'fade_out', 'target': 'missing', 'run_time': 1}]
        with self.assertRaisesRegex(ManimContractError, '退出目标'):
            validate_scene(value)
        value = scene()
        value['steps'][1]['actions'] = [{'op': 'explode', 'target': 'a', 'run_time': 1}]
        with self.assertRaisesRegex(ManimContractError, '未知动作'):
            validate_scene(value)
        value = scene()
        value['steps'][1]['actions'] = [{'op': 'move_along_path', 'target': 'a', 'path': 'a', 'run_time': 1}]
        with self.assertRaisesRegex(ManimContractError, '弧线'):
            validate_scene(value)

    def test_bounds_palette_and_tex_are_closed(self):
        value = scene()
        value['initial'][0]['end'] = [20, 1]
        with self.assertRaisesRegex(ManimContractError, '6.8'):
            validate_scene(value)
        value = scene()
        value['initial'][0]['color'] = '#ff0000'
        with self.assertRaisesRegex(ManimContractError, '调色板'):
            validate_scene(value)
        value = scene()
        value['initial'][0]['color'] = '#f5f5f5'
        with self.assertRaisesRegex(ManimContractError, '调色板'):
            validate_scene(value)
        value = scene()
        value['steps'][0]['actions'][0]['object']['tex'] = r'\input{secret}'
        with self.assertRaisesRegex(ManimContractError, '不允许的命令'):
            validate_scene(value)
        value = scene()
        value['initial'][0] = {'id': 'c', 'type': 'circle', 'center': [0, 0], 'radius': 5}
        with self.assertRaisesRegex(ManimContractError, '安全区'):
            validate_scene(value)

    def test_indicate_requires_a_palette_color(self):
        for color in (None, '#ff0000'):
            value = scene()
            value['steps'][1]['actions'] = [
                {'op': 'indicate', 'target': 'a', 'color': color, 'run_time': 1}]
            with self.subTest(color=color), self.assertRaisesRegex(ManimContractError, '强调颜色'):
                validate_scene(value)
        value = scene()
        value['steps'][1]['actions'] = [
            {'op': 'indicate', 'target': 'a', 'color': '#c74f20', 'run_time': 1}]
        self.assertEqual(validate_scene(value)['steps'][1]['actions'][0]['color'], '#c74f20')

    def test_arc_cannot_move_but_can_transform(self):
        arc = {'id': 'path', 'type': 'arc', 'start': [-2, 0], 'end': [0, 2], 'angle_deg': 90}
        value = scene()
        value['initial'].append(arc)
        value['steps'][1]['actions'] = [
            {'op': 'move', 'target': 'path', 'to': [1, 1], 'run_time': 1}]
        with self.assertRaisesRegex(ManimContractError, '移动目标'):
            validate_scene(value)
        value = scene()
        value['initial'].append(arc)
        value['steps'][1]['actions'] = [
            {'op': 'transform', 'target': 'path',
             'object': {'type': 'arc', 'start': [-2, 0], 'end': [0, 2], 'angle_deg': 45},
             'run_time': 1}]
        result = validate_scene(value)
        self.assertEqual(result['steps'][1]['actions'][0]['object']['angle_deg'], 45)

    def test_identity_and_size_limits(self):
        value = scene()
        value['initial'].append(dict(value['initial'][0]))
        with self.assertRaisesRegex(ManimContractError, '编号重复'):
            validate_scene(value)
        value = scene()
        value['steps'][0]['caption'] = '字' * 161
        with self.assertRaisesRegex(ManimContractError, '步骤说明'):
            validate_scene(value)
        value = scene()
        value['steps'][1]['caption'] = '字'
        value['steps'] = value['steps'][:1] * 9
        with self.assertRaisesRegex(ManimContractError, '1至8'):
            validate_scene(value)

    def test_recipe_parameters_are_bounded(self):
        base = {'version': 1, 'kind': 'recipe', 'recipe': 'swap_components',
                'parameters': {'values': [3, -1, 4]},
                'steps': [{'caption': '一'}, {'caption': '二'}]}
        self.assertEqual(validate_scene(base)['parameters']['values'], [3, -1, 4])
        bad = dict(base, parameters={'values': [3, 3, 4]})
        with self.assertRaises(ManimContractError):
            validate_scene(bad)
        bad = dict(base, parameters={'values': [3.0, 1, 4]})
        with self.assertRaises(ManimContractError):
            validate_scene(bad)
        bad = {'version': 1, 'kind': 'recipe', 'recipe': 'vector_rotation',
               'parameters': {'vector': [0, 0], 'angle_deg': 90},
               'steps': [{'caption': '一'}, {'caption': '二'}, {'caption': '三'}]}
        with self.assertRaises(ManimContractError):
            validate_scene(bad)
        bad = dict(bad, parameters={'vector': [2, 1], 'angle_deg': 45})
        with self.assertRaisesRegex(ManimContractError, '90度'):
            validate_scene(bad)
        bad = dict(bad, parameters={'vector': [2, 2], 'angle_deg': 90})
        with self.assertRaisesRegex(ManimContractError, '向量长度'):
            validate_scene(bad)
        good = dict(bad, parameters={'vector': [-1, 2], 'angle_deg': 90})
        self.assertEqual(validate_scene(good)['parameters']['vector'], [-1, 2])


class ManifestEngineTests(unittest.TestCase):
    def test_both_engines_are_accepted(self):
        for engine in ({'name': 'ManimGL', 'version': '1.7.2'}, {'name': 'ManimGX', 'version': '0.1.1'}):
            self.assertEqual(validate_manifest(manifest(engine))['engine'], engine)
        for engine in ({'name': 'ManimGX', 'version': '0.1.0'}, {'name': 'SVG', 'version': '1.7.2'}, None):
            with self.assertRaisesRegex(ManimContractError, '引擎'):
                validate_manifest(manifest(engine))


if __name__ == '__main__':
    unittest.main()
