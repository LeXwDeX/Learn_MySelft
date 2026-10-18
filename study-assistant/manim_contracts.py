"""Bounded contracts for real teaching animations."""
import ast
import math
import re

MAX_SOURCE = 20000
MAX_VIDEO = 32 * 1024 * 1024
MAX_IMAGE = 3 * 1024 * 1024
MAX_TOTAL = 56 * 1024 * 1024
MAX_STEPS = 8
FPS = 30
STEP_HOLD_SECONDS = 0.7
WIDTH = 1280
HEIGHT = 720
MANIMGL_ENGINE = {'name': 'ManimGL', 'version': '1.7.2'}
MANIMGX_ENGINE = {'name': 'ManimGX', 'version': '0.1.1'}
SUPPORTED_ENGINES = (MANIMGL_ENGINE, MANIMGX_ENGINE)


class ManimContractError(ValueError):
    pass


def step_frame_bounds(seconds, fps=FPS, hold_seconds=STEP_HOLD_SECONDS):
    """Return hold start and end frames with an exact fixed-length hold.

    An animation that ends between two frames still changes the earlier one,
    so the first fully static frame is the next one. Rounding picks the
    transition frame at a half-frame boundary. Start from the ceiling, then
    add the integer hold length so every step keeps the same hold.
    """
    hold_start = math.ceil(seconds * fps - 1e-9)
    return hold_start, hold_start + round(hold_seconds * fps)


def validate_render_diagnostic(value, source_lines):
    """Accept only closed failure types, source-relative lines and identifiers."""
    fields = {'TypeError': 'keyword', 'AttributeError': 'attribute', 'NameError': 'name', 'ValueError': None}
    if type(source_lines) is not int or not 1 <= source_lines <= MAX_SOURCE:
        raise ManimContractError('动画诊断无效')
    if not isinstance(value, dict) or not isinstance(value.get('exception_type'), str):
        raise ManimContractError('动画诊断无效')
    exception = value['exception_type']
    if exception not in fields:
        raise ManimContractError('动画诊断无效')
    identifier = fields[exception]
    allowed = {'exception_type', 'line'} | ({identifier} if identifier else set())
    if not set(value) <= allowed:
        raise ManimContractError('动画诊断无效')
    if 'line' in value and (type(value['line']) is not int or not 1 <= value['line'] <= source_lines):
        raise ManimContractError('动画诊断无效')
    if identifier in value:
        name = value[identifier]
        if not isinstance(name, str) or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', name) is None:
            raise ManimContractError('动画诊断无效')
    return dict(value)


def validate_teaching_plan(plan, step_count=None):
    """Require an inspectable learning purpose before rendering model code."""
    limits = {'objective': 120, 'visual_reason': 200, 'observe': 160}
    if not isinstance(plan, dict) or set(plan) != set(limits) | {'steps'}:
        raise ManimContractError('动画教学计划字段无效')
    def bounded(value, name, cap):
        if not isinstance(value, str) or not value.strip() or len(value) > cap:
            raise ManimContractError('教学计划 %s 必须为非空字符串，最多%d字符' % (name, cap))
    for name, cap in limits.items():
        bounded(plan[name], name, cap)
    steps = plan['steps']
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise ManimContractError('教学计划必须有1至8个步骤')
    if step_count is not None and len(steps) != step_count:
        raise ManimContractError('教学计划步骤与实际动画步骤不一致')
    for step in steps:
        if not isinstance(step, dict) or set(step) != {'change', 'why'}:
            raise ManimContractError('教学步骤必须说明变化和原因')
        for name in ('change', 'why'):
            bounded(step[name], name, 160)
    return plan


def validate_source(source):
    if not isinstance(source, str) or not source.strip() or len(source.encode()) > MAX_SOURCE:
        raise ManimContractError('动画代码长度无效')
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise ManimContractError('动画代码语法无效') from error
    # This filter improves reliability. The container is the security boundary.
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    if len(tree.body) != 1 or len(classes) != 1 or classes[0].name != 'LessonScene':
        raise ManimContractError('仅允许 LessonScene 类')
    scene = classes[0]
    if scene.decorator_list or scene.keywords or len(scene.body) != 1:
        raise ManimContractError('动画类只允许 construct 方法')
    construct = scene.body[0]
    if (not isinstance(construct, ast.FunctionDef) or construct.name != 'construct'
            or construct.decorator_list or construct.returns is not None
            or len(construct.args.args) != 1 or construct.args.args[0].arg != 'self'
            or construct.args.args[0].annotation is not None or construct.args.defaults
            or construct.args.vararg or construct.args.kwarg or construct.args.kwonlyargs
            or construct.args.posonlyargs):
        raise ManimContractError('动画必须定义 construct(self)')
    if len(scene.bases) != 1 or not isinstance(scene.bases[0], ast.Name) or scene.bases[0].id != 'TeachingScene':
        raise ManimContractError('必须使用 TeachingScene')
    forbidden = {'exec', 'eval', 'compile', 'open', '__import__', 'getattr', 'setattr', 'globals', 'locals', 'input', 'breakpoint'}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal)):
            raise ManimContractError('动画代码不能导入模块')
        if isinstance(node, ast.Name) and (node.id in forbidden or node.id.startswith('__')):
            raise ManimContractError('动画代码包含不支持的操作')
        if isinstance(node, ast.Attribute) and node.attr.startswith('_'):
            raise ManimContractError('动画代码不能访问内部属性')
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == 'Line' and any(keyword.arg == 'thickness' for keyword in node.keywords)):
            raise ManimContractError('第%d行：ManimGL Line 不支持 thickness，请使用 stroke_width；只有 Arrow 箭杆使用 thickness' % node.lineno)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ('FadeIn','FadeOut'):
            shifts = [keyword.value for keyword in node.keywords if keyword.arg == 'shift']
            if len(node.args) > 1:
                shifts.append(node.args[1])
            if any(isinstance(shift,(ast.Tuple,ast.List)) for shift in shifts):
                raise ManimContractError('ManimGL FadeIn/FadeOut 的 shift 必须使用方向向量，例如 0.3*UP，不能使用 tuple/list')
    return source


FIRST_FRAME_CLAIM = re.compile(
    r'(?:首帧|第一帧|开始帧|开始时|起始帧|初始画面)'
    r'(?:即|直接)?'
    r'(?:显示|呈现|已有|包含|可见|出现|保留|摆放|展示)')
FIRST_FRAME_NEGATION = re.compile(r'(?:不|未|没有|勿|别|不得|不要)[^，。；]{0,8}$')
FIRST_FRAME_VISUAL_CALLS = frozenset({'add', 'shear_basis', 'swap_components'})


def claims_first_frame(change):
    """Return true only for an affirmative promise that the step starts populated."""
    if not isinstance(change, str):
        return False
    for match in FIRST_FRAME_CLAIM.finditer(change):
        prefix = change[max(0, match.start() - 10):match.start()]
        if not FIRST_FRAME_NEGATION.search(prefix):
            return True
    return False


def _earliest_scene_call(source):
    tree = ast.parse(source)
    scene = next(node for node in tree.body if isinstance(node, ast.ClassDef))
    construct = scene.body[0]
    calls = []
    for node in ast.walk(construct):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id == 'self'
                and node.func.attr in FIRST_FRAME_VISUAL_CALLS | {'play', 'wait', 'next_step'}):
            calls.append((node.lineno, node.col_offset, node.func.attr))
    return min(calls) if calls else None


def validate_first_frame_plan(plan, source):
    """Reject a first step that promises a populated start but animates from empty."""
    steps = plan.get('steps') if isinstance(plan, dict) else None
    if not isinstance(steps, list) or not steps or not isinstance(steps[0], dict):
        raise ManimContractError('动画教学计划无效')
    if not claims_first_frame(steps[0].get('change')):
        return plan
    earliest = _earliest_scene_call(source)
    if earliest is None or earliest[2] not in FIRST_FRAME_VISUAL_CALLS:
        raise ManimContractError(
            '教学计划第1步声称首帧显示对象，但代码在开始动画前没有self.add这些对象。'
            '请在该步第一个self.play/self.wait前用self.add(...)放入首帧对象，'
            '或把计划改为“先建立/逐步显示”的表述。')
    return plan


def validate_manifest(value):
    if not isinstance(value, dict) or value.get('version') != 1:
        raise ManimContractError('动画清单无效')
    if (value.get('fps'), value.get('width'), value.get('height')) != (FPS, WIDTH, HEIGHT):
        raise ManimContractError('动画尺寸无效')
    duration = value.get('duration')
    if type(duration) not in (int, float) or not math.isfinite(duration) or not 0 < duration <= 90:
        raise ManimContractError('动画时长无效')
    if value.get('engine') not in SUPPORTED_ENGINES:
        raise ManimContractError('动画引擎无效')
    steps = value.get('steps')
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise ManimContractError('动画步骤无效')
    previous = 0
    for step in steps:
        if not isinstance(step, dict) or set(step) != {'caption', 'start_frame', 'end_frame', 'result_frame', 'hold_start_frame'}:
            raise ManimContractError('动画步骤字段无效')
        caption = step['caption']
        start, end, result = (step[k] for k in ('start_frame', 'end_frame', 'result_frame'))
        if not isinstance(caption, str) or not caption.strip() or len(caption) > 160:
            raise ManimContractError('动画步骤说明无效')
        if any(type(n) is not int for n in (start, end, result)) or start != previous or end <= start or result != end - 1:
            raise ManimContractError('动画帧边界无效')
        hold = step['hold_start_frame']
        if type(hold) is not int or hold < start or end - hold < 21:
            raise ManimContractError('动画停留时间无效')
        previous = end
    if abs(previous / FPS - duration) > 1 / FPS:
        raise ManimContractError('动画清单时长不一致')
    return value


def valid_asset_id(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) is not None


def _graphic_fences(markdown):
    """Yield real top-level graphic fences with exact source spans."""
    if not isinstance(markdown, str) or len(markdown) > 180000:
        raise ManimContractError('学习正文无效')
    position, active = 0, None
    for line in markdown.splitlines(keepends=True):
        text = line.rstrip('\r\n')
        if active:
            marker, size, language, start, content_start = active
            if re.fullmatch(r' {0,3}' + re.escape(marker) + '{' + str(size) + r',}[ \t]*', text):
                if language in ('learn-scene', 'learn-manim'):
                    yield language, markdown[content_start:position], start, position + len(line)
                active = None
        else:
            match = re.fullmatch(r' {0,3}(`{3,}|~{3,})([^\r\n]*)', text)
            if match:
                info = match[2].strip()
                if match[1][0] != '`' or '`' not in info:
                    active = (match[1][0], len(match[1]), (info.split() or [''])[0], position, position+len(line))
        position += len(line)
    if active and active[2] in ('learn-scene', 'learn-manim'):
        raise ManimContractError('图示围栏未结束')


def references_in(markdown):
    import json
    result = []
    for language, content, _, _ in _graphic_fences(markdown):
        if language != 'learn-manim':
            continue
        try:
            value = json.loads(content)
        except ValueError as error:
            raise ManimContractError('动画引用无效') from error
        if (not isinstance(value, dict) or set(value) != {'version','asset_id','title','summary'}
                or type(value['version']) is not int or value['version'] != 1 or not valid_asset_id(value['asset_id'])):
            raise ManimContractError('动画引用无效')
        for name, cap in [('title',80), ('summary',400)]:
            if not isinstance(value[name], str) or not value[name].strip() or len(value[name]) > cap:
                raise ManimContractError('动画引用说明无效')
        result.append(value)
        if len(result) > 8:
            raise ManimContractError('动画引用过多')
    return result


def strip_generated_scenes(markdown):
    for _, _, start, end in reversed(list(_graphic_fences(markdown))):
        markdown = markdown[:start] + markdown[end:]
    return markdown
