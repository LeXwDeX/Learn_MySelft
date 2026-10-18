"""Closed scene contracts for the fixed ManimGX animation runtime.

The model submits either a teaching recipe with bounded parameters or a
canonical scene description built from whitelisted objects and actions. The
runtime never executes model-written Python.
"""
import math
import re

from manim_contracts import MAX_STEPS, ManimContractError

SCENE_VERSION = 1
MAX_OBJECTS = 40
MAX_INITIAL_OBJECTS = 20
MAX_ACTIONS = 10
MAX_TEXT = 200
MAX_TEX = 200
MIN_RUN_TIME = 0.3
MAX_RUN_TIME = 4.0
STEP_HOLD_SECONDS = 0.7
MAX_STEP_SECONDS = 12.0
MAX_TOTAL_SECONDS = 90.0
MAX_STEP_CAPTION = 160

BACKGROUND = '#f5f5f5'
COLORS = ('#2d3142', '#c74f20', '#245b83', '#757575', '#9a9a9a', '#bbbbbb')
X_LIMIT = 6.8
Y_LIMIT = 3.8
TEXT_X_LIMIT = 6.5
TEXT_Y_LIMIT = 3.6
MIN_MOVE = 0.2
MIN_ROTATE_DEG = 5.0

TEX_FORBIDDEN = re.compile(
    r'\\(?:input|include|write|openout|def|newcommand|catcode|special|usepackage|directlua|immediate)\b'
)
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')

RECIPES = {
    'shear_basis': 2,
    'swap_components': 2,
    'vector_rotation': 3,
}

_OBJECT_FIELDS = {
    'text': {'text', 'at', 'size'},
    'math': {'tex', 'at', 'size'},
    'dot': {'at', 'radius'},
    'line': {'start', 'end', 'stroke_width'},
    'arrow': {'start', 'end', 'stroke_width'},
    'circle': {'center', 'radius', 'stroke_width'},
    'rectangle': {'center', 'width', 'height', 'stroke_width'},
    'arc': {'start', 'end', 'angle_deg', 'stroke_width'},
    'axes': {'x_range', 'y_range', 'x_length', 'y_length'},
    'number_plane': {'x_range', 'y_range', 'x_length', 'y_length'},
}

_MOVABLE = frozenset({'text', 'math', 'dot', 'line', 'arrow', 'circle', 'rectangle'})
_ROTATABLE = frozenset({'line', 'arrow', 'rectangle', 'arc'})
_TRANSFORMABLE = _MOVABLE | {'arc'}
_PATH_TARGETS = _MOVABLE


def _require(condition, message):
    if not condition:
        raise ManimContractError(message)


def _fields(value, allowed, label):
    _require(isinstance(value, dict), '%s必须是对象' % label)
    _require(not (set(value) - allowed), '%s包含未知字段' % label)
    return value


def _pick(value, base, name, default=None):
    if name in value:
        return value[name]
    if base is not None and name in base:
        return base[name]
    return default


def _text(value, cap, label):
    _require(isinstance(value, str) and value.strip() and len(value) <= cap, '%s必须为1至%d字符' % (label, cap))
    _require(CONTROL.search(value) is None, '%s包含控制字符' % label)
    return value


def _number(value, low, high, label):
    _require(type(value) in (int, float) and math.isfinite(value) and low <= value <= high,
             '%s必须在%s至%s之间' % (label, low, high))
    return float(value)


def _integer(value, low, high, label):
    _require(type(value) is int and low <= value <= high, '%s必须是%d至%d的整数' % (label, low, high))
    return value


def _point(value, label, x_limit=X_LIMIT, y_limit=Y_LIMIT):
    _require(isinstance(value, list) and len(value) == 2, '%s必须是两个数字的坐标' % label)
    return [_number(value[0], -x_limit, x_limit, label), _number(value[1], -y_limit, y_limit, label)]


def _color(value, default, label):
    if value is None:
        return default
    _require(value in COLORS, '%s必须使用项目调色板' % label)
    return value


def _range(value, label):
    _require(isinstance(value, list) and len(value) == 3, '%s必须是[起点,终点,步长]' % label)
    low = _number(value[0], -20, 20, label)
    high = _number(value[1], -20, 20, label)
    step = _number(value[2], 0.1, 20, label)
    _require(high > low and step <= high - low, '%s范围无效' % label)
    _require((high - low) / step <= 24, '%s刻度过多' % label)
    return [low, high, step]


def _object(value, label, object_id, base=None):
    _require(isinstance(value, dict) and isinstance(value.get('type'), str), '%s缺少类型' % label)
    kind = value['type']
    _require(kind in _OBJECT_FIELDS, '%s类型不在白名单内' % label)
    allowed = {'type', 'color'} | _OBJECT_FIELDS[kind] | ({'id'} if object_id else set())
    _fields(value, allowed, label)
    _require(('id' in value) == object_id, '%s编号无效' % label)
    result = {'type': kind}
    if object_id:
        identifier = value['id']
        _require(isinstance(identifier, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', identifier) is not None,
                 '%s编号必须为小写字母开头的1至32位编号' % label)
        result['id'] = identifier
    if kind in ('text', 'math'):
        if kind == 'text':
            result['text'] = _text(_pick(value, base, 'text'), MAX_TEXT, '文本')
        else:
            result['tex'] = _text(_pick(value, base, 'tex'), MAX_TEX, '数学表达式')
            _require(TEX_FORBIDDEN.search(result['tex']) is None, '数学表达式包含不允许的命令')
        result['at'] = _point(_pick(value, base, 'at'), '文本位置', TEXT_X_LIMIT, TEXT_Y_LIMIT)
        result['size'] = _number(_pick(value, base, 'size', 56), 24, 120, '字号')
        result['color'] = _color(_pick(value, base, 'color'), '#2d3142', '颜色')
    elif kind == 'dot':
        result['at'] = _point(_pick(value, base, 'at'), '点坐标')
        result['radius'] = _number(_pick(value, base, 'radius', 0.08), 0.03, 0.3, '点半径')
        result['color'] = _color(_pick(value, base, 'color'), '#2d3142', '颜色')
    elif kind in ('line', 'arrow'):
        result['start'] = _point(_pick(value, base, 'start'), '起点')
        result['end'] = _point(_pick(value, base, 'end'), '终点')
        _require(result['start'] != result['end'], '%s起点和终点不能相同' % label)
        default = base.get('stroke_width', 5 if kind == 'arrow' else 4) if base else (5 if kind == 'arrow' else 4)
        result['stroke_width'] = _number(_pick(value, base, 'stroke_width', default), 1, 10, '线宽')
        result['color'] = _color(_pick(value, base, 'color'), '#245b83', '颜色')
    elif kind == 'circle':
        result['center'] = _point(_pick(value, base, 'center'), '圆心')
        result['radius'] = _number(_pick(value, base, 'radius'), 0.2, 6, '半径')
        _require(abs(result['center'][0]) + result['radius'] <= X_LIMIT
                 and abs(result['center'][1]) + result['radius'] <= Y_LIMIT, '圆超出画面安全区')
        result['stroke_width'] = _number(_pick(value, base, 'stroke_width', 3), 1, 10, '线宽')
        result['color'] = _color(_pick(value, base, 'color'), '#757575', '颜色')
    elif kind == 'rectangle':
        result['center'] = _point(_pick(value, base, 'center'), '中心')
        result['width'] = _number(_pick(value, base, 'width'), 0.5, 10, '宽度')
        result['height'] = _number(_pick(value, base, 'height'), 0.5, 6, '高度')
        _require(abs(result['center'][0]) + result['width'] / 2 <= X_LIMIT
                 and abs(result['center'][1]) + result['height'] / 2 <= Y_LIMIT, '矩形超出画面安全区')
        result['stroke_width'] = _number(_pick(value, base, 'stroke_width', 3), 1, 10, '线宽')
        result['color'] = _color(_pick(value, base, 'color'), '#757575', '颜色')
    elif kind == 'arc':
        result['start'] = _point(_pick(value, base, 'start'), '起点')
        result['end'] = _point(_pick(value, base, 'end'), '终点')
        _require(result['start'] != result['end'], '弧线起点和终点不能相同')
        result['angle_deg'] = _number(_pick(value, base, 'angle_deg'), -350, 350, '弧线角度')
        _require(abs(result['angle_deg']) >= MIN_ROTATE_DEG, '弧线角度不能接近0')
        result['stroke_width'] = _number(_pick(value, base, 'stroke_width', 4), 1, 10, '线宽')
        result['color'] = _color(_pick(value, base, 'color'), '#757575', '颜色')
    else:
        result['x_range'] = _range(_pick(value, base, 'x_range'), 'x范围')
        result['y_range'] = _range(_pick(value, base, 'y_range'), 'y范围')
        result['x_length'] = _number(_pick(value, base, 'x_length'), 6, 12, 'x轴长度')
        result['y_length'] = _number(_pick(value, base, 'y_length'), 4, 7.6, 'y轴长度')
        result['color'] = _color(_pick(value, base, 'color'),
                                 '#757575' if kind == 'axes' else '#bbbbbb', '颜色')
    return result


def _center(item):
    kind = item['type']
    if kind in ('text', 'math', 'dot'):
        return list(item['at'])
    if kind in ('line', 'arrow', 'arc'):
        return [(item['start'][0] + item['end'][0]) / 2, (item['start'][1] + item['end'][1]) / 2]
    if kind in ('circle', 'rectangle'):
        return list(item['center'])
    return [0.0, 0.0]


def _translated(item, delta):
    result = dict(item)
    kind = item['type']
    if kind in ('text', 'math', 'dot'):
        result['at'] = _point([item['at'][0] + delta[0], item['at'][1] + delta[1]], '移动位置',
                              TEXT_X_LIMIT if kind in ('text', 'math') else X_LIMIT,
                              TEXT_Y_LIMIT if kind in ('text', 'math') else Y_LIMIT)
    elif kind in ('line', 'arrow', 'arc'):
        result['start'] = _point([item['start'][0] + delta[0], item['start'][1] + delta[1]], '移动位置')
        result['end'] = _point([item['end'][0] + delta[0], item['end'][1] + delta[1]], '移动位置')
    elif kind in ('circle', 'rectangle'):
        result['center'] = _point([item['center'][0] + delta[0], item['center'][1] + delta[1]], '移动位置')
        if kind == 'circle':
            _require(abs(result['center'][0]) + result['radius'] <= X_LIMIT
                     and abs(result['center'][1]) + result['radius'] <= Y_LIMIT, '圆超出画面安全区')
        else:
            _require(abs(result['center'][0]) + result['width'] / 2 <= X_LIMIT
                     and abs(result['center'][1]) + result['height'] / 2 <= Y_LIMIT, '矩形超出画面安全区')
    return result


def _rotate_point(point, degrees, about):
    radians = math.radians(degrees)
    cosine, sine = math.cos(radians), math.sin(radians)
    x, y = point[0] - about[0], point[1] - about[1]
    return [about[0] + x * cosine - y * sine, about[1] + x * sine + y * cosine]


def _rotated(item, degrees, about):
    result = dict(item)
    kind = item['type']
    if kind in ('line', 'arrow', 'arc'):
        result['start'] = _point(_rotate_point(item['start'], degrees, about), '旋转位置')
        result['end'] = _point(_rotate_point(item['end'], degrees, about), '旋转位置')
    elif kind == 'rectangle':
        center = _rotate_point(item['center'], degrees, about)
        reach = math.hypot(item['width'] / 2, item['height'] / 2)
        _require(abs(center[0]) + reach <= X_LIMIT and abs(center[1]) + reach <= Y_LIMIT,
                 '矩形旋转后可能超出画面安全区')
        result['center'] = _point(center, '旋转位置')
        # Rectangle orientation is not part of the canonical geometry, so a
        # later transform must still count as a visible change.
        result['_turned'] = True
    return result


def _without_color(item):
    return {key: value for key, value in item.items() if key not in ('id', 'color', '_turned')}


def _action(value, state, counter):
    _require(isinstance(value, dict) and isinstance(value.get('op'), str), '动作缺少类型')
    op = value['op']
    if op == 'create':
        _fields(value, {'op', 'object', 'animation', 'run_time'}, '创建动作')
        item = _object(value.get('object'), '创建对象', True)
        _require(item['id'] not in state, '创建对象的编号已存在')
        _require(counter['objects'] < MAX_OBJECTS, '动画对象超过%d个' % MAX_OBJECTS)
        kind = item['type']
        if kind in ('text', 'math'):
            allowed = {'write', 'fade_in'}
        elif kind == 'arrow':
            allowed = {'grow_arrow', 'fade_in', 'create'}
        else:
            allowed = {'create', 'fade_in'}
        animation = value.get('animation')
        _require(animation in allowed, '对象类型不支持该入场动画')
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, MAX_RUN_TIME, '动作时长')
        state[item['id']] = item
        counter['objects'] += 1
        return {'op': op, 'object': item, 'animation': animation, 'run_time': run_time}, run_time
    if op == 'transform':
        _fields(value, {'op', 'target', 'object', 'run_time'}, '变换动作')
        target = value.get('target')
        _require(target in state, '变换目标不存在')
        current = state[target]
        _require(current['type'] in _TRANSFORMABLE, '该对象不支持变换')
        item = _object(value.get('object'), '变换对象', False, current)
        _require(item['type'] == current['type'], '变换前后对象类型必须一致')
        _require(_without_color(item) != _without_color(current),
                 '变换必须改变位置、尺寸或内容，不能只改颜色')
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, MAX_RUN_TIME, '动作时长')
        state[target] = {**item, 'id': target}
        return {'op': op, 'target': target, 'object': item, 'run_time': run_time}, run_time
    if op == 'move':
        _fields(value, {'op', 'target', 'to', 'run_time'}, '移动动作')
        target = value.get('target')
        _require(target in state and state[target]['type'] in _MOVABLE, '移动目标不存在或不支持移动')
        destination = _point(value.get('to'), '移动目标')
        before = _center(state[target])
        _require(math.dist(before, destination) >= MIN_MOVE, '移动距离过小，无法形成可见动画')
        state[target] = _translated(state[target], [destination[0] - before[0], destination[1] - before[1]])
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, MAX_RUN_TIME, '动作时长')
        return {'op': op, 'target': target, 'to': destination, 'run_time': run_time}, run_time
    if op == 'rotate':
        _fields(value, {'op', 'target', 'angle_deg', 'about', 'run_time'}, '旋转动作')
        target = value.get('target')
        _require(target in state and state[target]['type'] in _ROTATABLE, '旋转目标不存在或不支持旋转')
        angle = _number(value.get('angle_deg'), -360, 360, '旋转角度')
        _require(abs(angle) >= MIN_ROTATE_DEG, '旋转角度过小，无法形成可见动画')
        about = _point(value.get('about', [0, 0]), '旋转中心')
        state[target] = _rotated(state[target], angle, about)
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, MAX_RUN_TIME, '动作时长')
        return {'op': op, 'target': target, 'angle_deg': angle, 'about': about, 'run_time': run_time}, run_time
    if op == 'fade_out':
        _fields(value, {'op', 'target', 'run_time'}, '退出动作')
        target = value.get('target')
        _require(target in state, '退出目标不存在')
        del state[target]
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, MAX_RUN_TIME, '动作时长')
        return {'op': op, 'target': target, 'run_time': run_time}, run_time
    if op == 'indicate':
        _fields(value, {'op', 'target', 'color', 'run_time'}, '强调动作')
        target = value.get('target')
        _require(target in state, '强调目标不存在')
        _require('color' in value, '强调动作必须指定颜色')
        _require(value['color'] in COLORS, '强调颜色必须使用项目调色板')
        color = value['color']
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, 2, '动作时长')
        return {'op': op, 'target': target, 'color': color, 'run_time': run_time}, run_time
    if op == 'move_along_path':
        _fields(value, {'op', 'target', 'path', 'run_time'}, '路径动作')
        target, path = value.get('target'), value.get('path')
        _require(target in state and state[target]['type'] in _PATH_TARGETS, '路径目标不存在或不支持移动')
        _require(path in state and state[path]['type'] == 'arc', '路径必须是已存在的弧线')
        _require(path != target, '路径不能是移动对象自身')
        before = _center(state[target])
        after = state[path]['end']
        state[target] = _translated(state[target], [after[0] - before[0], after[1] - before[1]])
        run_time = _number(value.get('run_time'), MIN_RUN_TIME, MAX_RUN_TIME, '动作时长')
        return {'op': op, 'target': target, 'path': path, 'run_time': run_time}, run_time
    raise ManimContractError('未知动作类型')


def _step(value, state, counter):
    _fields(value, {'caption', 'actions'}, '步骤')
    caption = _text(value.get('caption'), MAX_STEP_CAPTION, '步骤说明')
    actions = value.get('actions')
    _require(isinstance(actions, list) and 1 <= len(actions) <= MAX_ACTIONS, '每步必须有1至10个动作')
    normalized, longest = [], 0.0
    for action in actions:
        item, run_time = _action(action, state, counter)
        normalized.append(item)
        longest = max(longest, run_time)
    _require(longest <= MAX_STEP_SECONDS, '单步动画时间过长')
    return {'caption': caption, 'actions': normalized}, longest


def _recipe(value):
    recipe = value.get('recipe')
    _require(recipe in RECIPES, '教学配方不在白名单内')
    parameters = value.get('parameters')
    _require(isinstance(parameters, dict), '配方参数无效')
    if recipe == 'shear_basis':
        _fields(parameters, {'k'}, '配方参数')
        normalized = {'k': _number(parameters.get('k'), 0.5, 1.5, '剪切系数')}
    elif recipe == 'swap_components':
        _fields(parameters, {'values'}, '配方参数')
        values = parameters.get('values')
        _require(isinstance(values, list) and len(values) == 3, '交换配方需要三个分量')
        normalized = {'values': [_integer(item, -9, 9, '分量') for item in values]}
        _require(normalized['values'][0] != normalized['values'][1], '交换的前两个分量不能相同')
    else:
        _fields(parameters, {'vector', 'angle_deg'}, '配方参数')
        vector = parameters.get('vector')
        _require(isinstance(vector, list) and len(vector) == 2, '旋转配方需要二维向量')
        vector = [_integer(vector[0], -3, 3, '向量分量'), _integer(vector[1], -3, 3, '向量分量')]
        _require(1 <= vector[0] ** 2 + vector[1] ** 2 <= 6, '向量长度无效')
        _require(parameters.get('angle_deg') == 90, '旋转配方首版只支持逆时针90度')
        normalized = {'vector': vector, 'angle_deg': 90}
    steps = value.get('steps')
    expected = RECIPES[recipe]
    _require(isinstance(steps, list) and len(steps) == expected, '配方步骤数必须为%d' % expected)
    captions = []
    for step in steps:
        _fields(step, {'caption'}, '配方步骤')
        captions.append({'caption': _text(step.get('caption'), MAX_STEP_CAPTION, '步骤说明')})
    return {'version': SCENE_VERSION, 'kind': 'recipe', 'recipe': recipe,
            'parameters': normalized, 'steps': captions}


def validate_scene(value):
    """Validate and normalize a recipe or closed scene specification."""
    _require(isinstance(value, dict), '动画场景必须是对象')
    _require(type(value.get('version')) is int and value['version'] == SCENE_VERSION, '动画场景版本无效')
    kind = value.get('kind')
    if kind == 'recipe':
        _fields(value, {'version', 'kind', 'recipe', 'parameters', 'steps'}, '动画场景')
        return _recipe(value)
    _require(kind == 'spec', '动画场景类型无效')
    _fields(value, {'version', 'kind', 'initial', 'steps'}, '动画场景')
    initial = value.get('initial')
    _require(isinstance(initial, list) and 1 <= len(initial) <= MAX_INITIAL_OBJECTS,
             '首帧必须有1至%d个已有对象' % MAX_INITIAL_OBJECTS)
    state, normalized_initial, counter = {}, [], {'objects': 0}
    for item in initial:
        normalized = _object(item, '首帧对象', True)
        _require(normalized['id'] not in state, '首帧对象编号重复')
        state[normalized['id']] = normalized
        normalized_initial.append(normalized)
        counter['objects'] += 1
    _require(sum(item['type'] == 'axes' for item in normalized_initial) <= 1, '首帧最多一个坐标轴')
    _require(sum(item['type'] == 'number_plane' for item in normalized_initial) <= 1, '首帧最多一个坐标网格')
    steps = value.get('steps')
    _require(isinstance(steps, list) and 1 <= len(steps) <= MAX_STEPS, '动画必须有1至8个步骤')
    normalized_steps, duration = [], STEP_HOLD_SECONDS * len(steps)
    for step in steps:
        normalized, longest = _step(step, state, counter)
        normalized_steps.append(normalized)
        duration += longest
    _require(duration <= MAX_TOTAL_SECONDS, '动画总时长超过%d秒' % MAX_TOTAL_SECONDS)
    return {'version': SCENE_VERSION, 'kind': 'spec', 'initial': normalized_initial,
            'steps': normalized_steps}
