"""Fixed ManimGX runtime. Model data only selects whitelisted objects and actions."""
import json
import math
import os
from pathlib import Path

import manimgx as m

FPS = 30
HOLD_SECONDS = 0.7
WIDTH = 1280
HEIGHT = 720
BACKGROUND = '#f5f5f5'

m.config.pixel_width, m.config.pixel_height = WIDTH, HEIGHT
m.config.frame_rate = FPS
m.config.background_color = BACKGROUND


class TeachingScene(m.Scene):
    """Records logical step frames; the worker turns them into a CFR manifest."""

    def __init__(self):
        super().__init__()
        self.step_records = []
        self.step_start = 0

    def label(self, text, color='#2d3142', size=72):
        return m.Text(text, font_size=size, color=color)

    def next_step(self, caption):
        hold_start = round(self.time * FPS)
        self.wait(HOLD_SECONDS)
        end = round(self.time * FPS)
        self.step_records.append({
            'caption': caption,
            'start_frame': self.step_start,
            'end_frame': end,
            'result_frame': end - 1,
            'hold_start_frame': hold_start,
        })
        self.step_start = end

    def tear_down(self):
        Path(os.environ.get('STEP_MANIFEST', '/output/steps.json')).write_text(
            json.dumps(self.step_records, ensure_ascii=False))


def _point(value):
    return [value[0], value[1], 0]


def _pair(x, y):
    return '(%d,%d)' % (x, y)


def _mobject(item):
    kind = item['type']
    color = item['color']
    if kind == 'text':
        return m.Text(item['text'], font_size=item['size'], color=color).move_to(_point(item['at']))
    if kind == 'math':
        return m.MathTex(item['tex'], font_size=item['size'], color=color).move_to(_point(item['at']))
    if kind == 'dot':
        return m.Dot(_point(item['at']), radius=item['radius'], color=color)
    if kind == 'line':
        return m.Line(_point(item['start']), _point(item['end']), stroke_width=item['stroke_width'], color=color)
    if kind == 'arrow':
        return m.Arrow(_point(item['start']), _point(item['end']), buff=0,
                       stroke_width=item['stroke_width'], color=color)
    if kind == 'circle':
        return m.Circle(radius=item['radius'], color=color,
                        stroke_width=item['stroke_width']).move_to(_point(item['center']))
    if kind == 'rectangle':
        return m.Rectangle(width=item['width'], height=item['height'], color=color,
                           stroke_width=item['stroke_width']).move_to(_point(item['center']))
    if kind == 'arc':
        return m.ArcBetweenPoints(_point(item['start']), _point(item['end']),
                                  angle=item['angle_deg'] * m.DEGREES,
                                  color=color, stroke_width=item['stroke_width'])
    if kind == 'axes':
        return m.Axes(x_range=item['x_range'], y_range=item['y_range'],
                      x_length=item['x_length'], y_length=item['y_length'], tips=False,
                      axis_config={'stroke_width': 2.5, 'color': color})
    if kind == 'number_plane':
        return m.NumberPlane(x_range=item['x_range'], y_range=item['y_range'],
                             x_length=item['x_length'], y_length=item['y_length'],
                             background_line_style={'stroke_color': color, 'stroke_width': 1,
                                                    'stroke_opacity': 0.45},
                             axis_config={'stroke_opacity': 0.0})
    raise ValueError('unknown object type')


def _animation(scene, action):
    op = action['op']
    if op == 'create':
        item = action['object']
        mobject = _mobject(item)
        scene.objects[item['id']] = mobject
        factory = {'write': m.Write, 'fade_in': m.FadeIn, 'grow_arrow': m.GrowArrow, 'create': m.Create}
        return factory[action['animation']](mobject)
    target = scene.objects.get(action['target'])
    if target is None:
        raise ValueError('missing target')
    if op == 'transform':
        return m.Transform(target, _mobject(action['object']))
    if op == 'move':
        return target.animate.move_to(_point(action['to']))
    if op == 'rotate':
        return m.Rotate(target, angle=action['angle_deg'] * m.DEGREES, about_point=_point(action['about']))
    if op == 'fade_out':
        del scene.objects[action['target']]
        return m.FadeOut(target)
    if op == 'indicate':
        return m.Indicate(target, color=action['color'])
    if op == 'move_along_path':
        path = scene.objects.get(action['path'])
        if path is None:
            raise ValueError('missing path')
        return m.MoveAlongPath(target, path)
    raise ValueError('unknown action')


def _spec_scene(scene, value):
    scene.objects = {}
    initial = [_mobject(item) for item in value['initial']]
    scene.objects.update({item['id']: mobject for item, mobject in zip(value['initial'], initial)})
    scene.add(*initial)
    for step in value['steps']:
        animations = [_animation(scene, action) for action in step['actions']]
        if not animations:
            raise ValueError('empty step')
        longest = max(action['run_time'] for action in step['actions'])
        scene.play(*animations, run_time=longest)
        scene.next_step(step['caption'])


def _shear_basis(scene, value):
    k = value['parameters']['k']
    captions = [step['caption'] for step in value['steps']]
    text = format(k, '.3f').rstrip('0').rstrip('.')
    origin, first = [-3, -1.5, 0], [-3, 1.5, 0]
    last = [-3 + 3 * k, 1.5, 0]
    dot = m.Dot(origin, radius=0.1, color='#2d3142')
    origin_label = scene.label('O').next_to(dot, m.DOWN, buff=0.35)
    arrow = m.Arrow(origin, first, buff=0, stroke_width=5, color='#245b83')
    endpoint = m.Dot(first, radius=0.18, color='#245b83')
    name = scene.label('e2').next_to(arrow, m.LEFT, buff=0.45)
    coordinate = scene.label('(0,1)').next_to(first, m.UP, buff=0.35)
    scene.add(dot, origin_label, endpoint, name, coordinate)
    scene.play(m.GrowArrow(arrow), run_time=1.2)
    scene.next_step(captions[0])

    original = arrow.copy().set_color('#757575')
    original_name = name.copy().set_color('#757575')
    original_coordinate = coordinate.copy().set_color('#757575')
    guide = m.Line(first, last, stroke_width=6, color='#757575')
    target = m.Arrow(origin, last, buff=0, stroke_width=5, color='#c74f20')
    target_name = scene.label('Ae2', color='#c74f20').next_to(target, m.RIGHT, buff=0.5)
    target_coordinate = scene.label('(' + text + ',1)', color='#c74f20').next_to(last, m.RIGHT, buff=0.35)
    scene.play(m.FadeOut(name), m.FadeOut(coordinate), m.FadeIn(guide), run_time=0.4)
    scene.play(m.FadeIn(original), m.FadeIn(original_name), m.FadeIn(original_coordinate),
               m.Transform(arrow, target), endpoint.animate.move_to(last).set_color('#c74f20'), run_time=2.4)
    scene.play(m.FadeIn(target_name), m.FadeIn(target_coordinate), run_time=0.4)
    scene.next_step(captions[1])


def _swap_components(scene, value):
    values = value['parameters']['values']
    captions = [step['caption'] for step in value['steps']]
    original_tuple = '(' + ','.join(str(item) for item in values) + ')'
    swapped_tuple = '(' + ','.join(str(values[index]) for index in (1, 0, 2)) + ')'
    positions = [m.LEFT * 3, m.ORIGIN, m.RIGHT * 3]
    slots = m.VGroup(*[m.Rectangle(width=2.2, height=1.2, color='#757575',
                                   stroke_width=4).move_to(position) for position in positions])
    indices = m.VGroup(*[scene.label(str(index + 1)).move_to(position + m.DOWN * 1.5)
                         for index, position in enumerate(positions)])
    dimension = scene.label('维度3').move_to(m.RIGHT * 4.2 + m.UP * 2.3)
    first = scene.label(str(values[0]), color='#245b83', size=120).move_to(positions[0] + m.UP * 1.6)
    second = scene.label(str(values[1]), color='#c74f20', size=120).move_to(positions[1] + m.UP * 1.6)
    third = scene.label(str(values[2]), size=120).move_to(positions[2] + m.UP * 1.6)
    original = scene.label(original_tuple).move_to(m.LEFT * 1.5 + m.UP * 2.5)
    scene.add(slots, indices, dimension, first, second, third, original)
    scene.play(first.animate.move_to(positions[0]), second.animate.move_to(positions[1]),
               third.animate.move_to(positions[2]), run_time=1.5)
    scene.next_step(captions[0])

    original.set_color('#757575')
    upper = m.ArcBetweenPoints(positions[0], positions[1], angle=-m.PI / 2)
    lower = m.ArcBetweenPoints(positions[1], positions[0], angle=-m.PI / 2)
    scene.play(m.MoveAlongPath(first, upper), m.MoveAlongPath(second, lower), run_time=2.4)
    result = scene.label(swapped_tuple).move_to(m.DOWN * 3.1)
    scene.play(m.FadeIn(result), run_time=0.4)
    scene.next_step(captions[1])


def _vector_rotation(scene, value):
    x, y = value['parameters']['vector']
    captions = [step['caption'] for step in value['steps']]
    rotated = [-y, x]
    radius = math.sqrt(x * x + y * y)
    plane = m.NumberPlane(x_range=[-6, 6, 1], y_range=[-4, 4, 1], x_length=12, y_length=8,
                          background_line_style={'stroke_color': '#bbbbbb', 'stroke_width': 1,
                                                 'stroke_opacity': 0.45},
                          axis_config={'stroke_opacity': 0.0})
    axes = m.Axes(x_range=[-6, 6, 1], y_range=[-4, 4, 1], x_length=12, y_length=8, tips=False,
                  axis_config={'stroke_width': 2.5, 'color': '#888888'})
    origin = m.Dot(m.ORIGIN, radius=0.07, color='#2d3142')
    origin_label = scene.label('O', size=56).next_to(origin, m.DL, buff=0.15)
    vector = m.Arrow(m.ORIGIN, _point([x, y]), buff=0, stroke_width=5, color='#245b83')
    name = scene.label('向量 a', color='#245b83').to_corner(m.UR, buff=0.45)
    coords = m.MathTex(r'\vec a=' + _pair(x, y), font_size=56, color='#245b83').to_corner(m.UL, buff=0.45)
    length = m.MathTex(r'|\vec a|=\sqrt{%d}' % (x * x + y * y), font_size=52,
                       color='#2d3142').to_corner(m.DL, buff=0.45)
    scene.add(plane, axes, origin, origin_label, vector, name, length)
    scene.play(m.Write(coords), m.Indicate(length, color='#c74f20'),
               m.Indicate(vector, color='#c74f20'), run_time=1.4)
    scene.next_step(captions[0])

    ghost = vector.copy().set_color('#9a9a9a')
    ghost_name = scene.label('原向量', color='#9a9a9a', size=56).next_to(name, m.DOWN, buff=0.3)
    after_coords = m.MathTex(r"\vec a'=" + _pair(*rotated), font_size=56,
                             color='#c74f20').to_corner(m.UL, buff=0.45)
    after_name = scene.label("向量 a'", color='#c74f20').to_corner(m.UR, buff=0.45)
    # Fade the old labels out instead of morphing text, which overlaps glyphs.
    scene.play(m.FadeOut(name), m.FadeOut(coords), m.FadeIn(ghost), m.FadeIn(ghost_name),
               m.Rotate(vector, angle=90 * m.DEGREES, about_point=m.ORIGIN), run_time=2.4)
    scene.play(m.FadeIn(after_name), m.FadeIn(after_coords), run_time=0.6)
    scene.next_step(captions[1])

    circle = m.Circle(radius=radius, color='#757575', stroke_width=3)
    radius_label = scene.label('半径不变', color='#757575', size=52).to_corner(m.DR, buff=0.5)
    verify = m.MathTex(r"|\vec a|=|\vec a'|=\sqrt{%d}" % (x * x + y * y), font_size=52,
                       color='#2d3142').to_corner(m.DL, buff=0.45)
    scene.play(m.Create(circle), m.FadeIn(radius_label), m.Transform(length, verify), run_time=1.8)
    scene.next_step(captions[2])


RECIPES = {'shear_basis': _shear_basis, 'swap_components': _swap_components,
           'vector_rotation': _vector_rotation}


def run_scene(scene, value):
    if value.get('kind') == 'recipe':
        RECIPES[value['recipe']](scene, value)
    elif value.get('kind') == 'spec':
        _spec_scene(scene, value)
    else:
        raise ValueError('unknown scene kind')
