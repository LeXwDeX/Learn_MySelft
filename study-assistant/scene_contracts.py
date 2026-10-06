"""Closed, executable-free contracts for learning diagrams and animations."""

import json
import math
import re

MAX_SOURCE = 12000
MAX_SCENES = 4
MAX_NOTES = 50000
_COMMON = {"version", "type", "title", "summary"}
_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}\Z")
_COLORS = {"accent", "secondary", "muted", "positive", "warning"}
_KINDS = {"point", "line", "arrow", "polyline", "polygon", "circle", "label"}


class SceneContractError(ValueError):
    """Contain only a fixed diagnostic, never model content or user material."""


def _fail():
    raise SceneContractError("图示配置无效，请重新生成")


def _object(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        _fail()
    return value


def _number(value, lower, upper):
    if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
        _fail()
    return value


def _text(value, maximum, *, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        _fail()
    return value


def _array(value, minimum, maximum, lower, upper):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail()
    for item in value:
        _number(item, lower, upper)


def _points(value, kind, dimension):
    minimum, maximum = {"point": (1, 1), "label": (1, 1), "circle": (1, 1),
                        "line": (2, 2), "arrow": (2, 2), "polyline": (2, 16),
                        "polygon": (3, 16)}[kind]
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail()
    for point in value:
        _array(point, dimension, dimension, -10, 10)


def _diagram(spec):
    dimension = spec.get("dimension", 2)
    if type(dimension) not in (int, float) or dimension not in (2, 3):
        _fail()
    dimension = int(dimension)
    elements = spec.get("elements")
    if not isinstance(elements, list) or not 1 <= len(elements) <= 40:
        _fail()
    ids = {}
    for element in elements:
        _object(element, {"id", "kind", "color", "label", "points", "radius", "opacity"},
                {"id", "kind", "points"})
        identity, kind = element["id"], element["kind"]
        if not isinstance(identity, str) or not _ID.fullmatch(identity) or identity in ids:
            _fail()
        if not isinstance(kind, str) or kind not in _KINDS:
            _fail()
        if "color" in element and (not isinstance(element["color"], str) or element["color"] not in _COLORS):
            _fail()
        if "label" in element:
            _text(element["label"], 80, empty=True)
        _points(element["points"], kind, dimension)
        if kind == "circle":
            radius = _number(element.get("radius"), 0, 10)
            if radius == 0:
                _fail()
        elif "radius" in element:
            _fail()
        if "opacity" in element:
            _number(element["opacity"], 0, 1)
        ids[identity] = element
    steps = spec.get("steps", [])
    if not isinstance(steps, list) or len(steps) > 8:
        _fail()
    for step in steps:
        _object(step, {"caption", "changes"}, {"caption", "changes"})
        _text(step["caption"], 300)
        changes = step["changes"]
        if not isinstance(changes, list) or len(changes) > 40:
            _fail()
        seen = set()
        for change in changes:
            _object(change, {"id", "points", "radius", "opacity"}, {"id"})
            identity = change["id"]
            if not isinstance(identity, str) or identity not in ids or identity in seen or len(change) < 2:
                _fail()
            seen.add(identity)
            original = ids[identity]
            if "points" in change:
                _points(change["points"], original["kind"], dimension)
                # Interpolation preserves each vertex's identity.
                if len(change["points"]) != len(original["points"]):
                    _fail()
            if "radius" in change:
                if original["kind"] != "circle" or _number(change["radius"], 0, 10) == 0:
                    _fail()
            if "opacity" in change:
                _number(change["opacity"], 0, 1)


def validate_scene(spec):
    if not isinstance(spec, dict):
        _fail()
    kind = spec.get("type")
    fields = {"diagram": {"dimension", "elements", "steps"},
              "linear_transform": {"matrix", "vector"},
              "secant": {"coefficients", "domain", "baseX", "gap"},
              "surface_slice": {"coefficient", "radius", "height"}}
    if not isinstance(kind, str) or kind not in fields:
        _fail()
    _object(spec, _COMMON | fields[kind], _COMMON)
    if type(spec["version"]) not in (int, float) or spec["version"] != 1:
        _fail()
    _text(spec["title"], 80)
    _text(spec["summary"], 500)
    if kind == "diagram":
        _diagram(spec)
    elif kind == "linear_transform":
        matrix = spec.get("matrix")
        if not isinstance(matrix, list) or len(matrix) != 2:
            _fail()
        for row in matrix:
            _array(row, 2, 2, -4, 4)
        if "vector" in spec:
            _array(spec["vector"], 2, 2, -3, 3)
    elif kind == "secant":
        _array(spec.get("coefficients"), 1, 5, -20, 20)
        domain = spec.get("domain")
        _array(domain, 2, 2, -5, 5)
        if domain[0] >= domain[1]:
            _fail()
        base = _number(spec.get("baseX"), domain[0], domain[1])
        _interval(spec.get("gap"), 0.01, min(3, domain[1] - base))
    else:
        coefficient = _number(spec.get("coefficient"), 0.2, 5)
        radius = _number(spec.get("radius"), 0.5, 3)
        _interval(spec.get("height"), 0, coefficient * radius ** 2, positive=True)
    return spec


def _interval(value, lower, upper, *, positive=False):
    _object(value, {"min", "max", "value"}, {"min", "max", "value"})
    start = _number(value["min"], lower, upper)
    end = _number(value["max"], start, upper)
    _number(value["value"], start, end)
    if positive and start == 0:
        _fail()


def scenes_in(markdown):
    """Read real top-level fences; ignore examples inside ordinary code fences."""
    if not isinstance(markdown, str) or len(markdown) > MAX_NOTES:
        _fail()
    scenes, marker, size, language, lines = [], "", 0, "", []
    for line in markdown.splitlines():
        if marker:
            if re.fullmatch(r" {0,3}" + re.escape(marker) + "{" + str(size) + r",}[ \t]*", line):
                if language == "learn-scene":
                    source = "\n".join(lines)
                    if len(source) > MAX_SOURCE:
                        _fail()
                    try:
                        value = json.loads(source)
                    except (ValueError, TypeError):
                        _fail()
                    scenes.append(validate_scene(value))
                    if len(scenes) > MAX_SCENES:
                        _fail()
                marker, language, lines = "", "", []
            elif language == "learn-scene":
                lines.append(line)
            continue
        opening = re.fullmatch(r" {0,3}(`{3,}|~{3,})([^\r\n]*)", line)
        if opening:
            info = opening[2].strip()
            if opening[1][0] == "`" and "`" in info:
                continue
            marker, size = opening[1][0], len(opening[1])
            language = (info.split() or [""])[0]
    if marker and language == "learn-scene":
        _fail()
    return scenes
