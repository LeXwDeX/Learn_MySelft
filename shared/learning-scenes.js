(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg', serial = 0;
  var controllers = new Map(), observer = null;
  function fail(message) { throw new Error(message); }
  function object(value, keys, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name + ' 必须是对象');
    var proto = Object.getPrototypeOf(value);
    if (proto && Object.getPrototypeOf(proto) !== null) fail(name + ' 必须是普通对象');
    keys.forEach(function (key) { if (key in value && !Object.prototype.hasOwnProperty.call(value, key)) fail(name + ' 不允许继承字段'); });
    Reflect.ownKeys(value).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !keys.includes(key) || !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(name + ' 含不允许的字段');
    });
  }
  function number(value, min, max, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(name + ' 必须是 ' + min + ' 到 ' + max + ' 的有限数值');
    return value;
  }
  function array(value, minLength, maxLength, min, max, name) {
    if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) fail(name + ' 数组长度不正确');
    Reflect.ownKeys(value).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if ((key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(String(key))) || typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(name + ' 含不允许的字段');
    });
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, String(i))) fail(name + ' 不允许空缺或继承元素');
      out.push(number(value[i], min, max, name));
    }
    return out;
  }
  function dataList(value, minLength, maxLength, name) {
    if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) fail(name + ' 数组长度不正确');
    Reflect.ownKeys(value).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(name + ' 含不允许的字段');
    });
    for (var i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, String(i))) fail(name + ' 不允许空缺或继承元素');
    return value;
  }
  function text(value, max, name) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(name + ' 必须是非空文本，最多 ' + max + ' 字符');
    return value.trim();
  }
  function interval(value, min, max, name) {
    object(value, ['min', 'max', 'value'], name);
    var lo = number(value.min, min, max, name + '.min'), hi = number(value.max, lo, max, name + '.max');
    return {min: lo, max: hi, value: number(value.value, lo, hi, name + '.value')};
  }
  function validate(spec) {
    object(spec, ['version', 'type', 'title', 'summary', 'matrix', 'vector', 'dimension', 'elements', 'steps', 'coefficients', 'domain', 'baseX', 'gap', 'coefficient', 'radius', 'height'], '场景');
    if (spec.version !== 1) fail('不支持的场景版本');
    var fields = {linear_transform: ['matrix', 'vector'], diagram: ['dimension', 'elements', 'steps'], secant: ['coefficients', 'domain', 'baseX', 'gap'], surface_slice: ['coefficient', 'radius', 'height']};
    if (typeof spec.type !== 'string' || !Object.prototype.hasOwnProperty.call(fields, spec.type)) fail('不支持的场景类型');
    object(spec, ['version', 'type', 'title', 'summary'].concat(fields[spec.type]), '场景');
    var out = {version: 1, type: spec.type, title: text(spec.title, 80, 'title'), summary: text(spec.summary, 500, 'summary')};
    if (spec.type === 'linear_transform') {
      if (!Array.isArray(spec.matrix) || spec.matrix.length !== 2) fail('matrix 必须是二行二列矩阵');
      // Validate the outer array as data too; its values are rows rather than numbers.
      Reflect.ownKeys(spec.matrix).forEach(function (key) {
        var d = Object.getOwnPropertyDescriptor(spec.matrix, key);
        if (!['0', '1', 'length'].includes(key) || !Object.prototype.hasOwnProperty.call(d, 'value')) fail('matrix 含不允许的字段');
      });
      if (!Object.prototype.hasOwnProperty.call(spec.matrix, '0') || !Object.prototype.hasOwnProperty.call(spec.matrix, '1')) fail('matrix 不允许空缺或继承元素');
      out.matrix = [array(spec.matrix[0], 2, 2, -4, 4, 'matrix'), array(spec.matrix[1], 2, 2, -4, 4, 'matrix')];
      out.vector = spec.vector === undefined ? [1, 1] : array(spec.vector, 2, 2, -3, 3, 'vector');
    } else if (spec.type === 'diagram') {
      out.dimension = spec.dimension === undefined ? 2 : number(spec.dimension, 2, 3, 'dimension');
      if (!Number.isInteger(out.dimension)) fail('dimension 必须是 2 或 3');
      dataList(spec.elements, 1, 40, 'elements');
      var ids = new Set(), limits = {point: [1, 1], label: [1, 1], circle: [1, 1], line: [2, 2], arrow: [2, 2], polyline: [2, 16], polygon: [3, 16]};
      out.elements = spec.elements.map(function (element) {
        object(element, ['id', 'kind', 'color', 'label', 'points', 'radius', 'opacity'], 'element');
        if (typeof element.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(element.id) || ids.has(element.id)) fail('element.id 格式错误或重复');
        ids.add(element.id);
        if (typeof element.kind !== 'string' || !Object.prototype.hasOwnProperty.call(limits, element.kind)) fail('不支持的 element.kind');
        var color = element.color === undefined ? 'accent' : element.color;
        if (typeof color !== 'string' || !['accent', 'secondary', 'muted', 'positive', 'warning'].includes(color)) fail('不支持的 element.color');
        var item = {id: element.id, kind: element.kind, color: color, points: diagramPoints(element.points, out.dimension, limits[element.kind], 'element.points'), opacity: element.opacity === undefined ? 1 : number(element.opacity, 0, 1, 'element.opacity')};
        if (element.label !== undefined) {
          if (typeof element.label !== 'string' || element.label.length > 80) fail('element.label 最多 80 字符');
          item.label = element.label;
        }
        if (element.kind === 'circle') item.radius = number(element.radius, Number.MIN_VALUE, 10, 'element.radius');
        else if (element.radius !== undefined) fail('radius 仅用于 circle');
        return item;
      });
      if (spec.steps !== undefined) {
        dataList(spec.steps, 0, 8, 'steps');
        out.steps = spec.steps.map(function (step) {
          object(step, ['caption', 'changes'], 'step');
          dataList(step.changes, 0, 40, 'changes');
          var changed = new Set();
          if (typeof step.caption !== 'string' || !step.caption.trim() || step.caption.length > 300) fail('step.caption 必须是非空文本，最多 300 字符');
          return {caption: step.caption.trim(), changes: step.changes.map(function (change) {
            object(change, ['id', 'points', 'radius', 'opacity'], 'change');
            if (typeof change.id !== 'string' || !ids.has(change.id) || changed.has(change.id)) fail('change.id 不存在或重复');
            changed.add(change.id);
            if (change.points === undefined && change.radius === undefined && change.opacity === undefined) fail('change 至少修改一个字段');
            var base = out.elements.find(function (item) { return item.id === change.id; });
            var result = {id: change.id};
            if (change.points !== undefined) {
              result.points = diagramPoints(change.points, out.dimension, limits[base.kind], 'change.points');
              if (result.points.length !== base.points.length) fail('change.points 点数必须与初始图元相同');
            }
            if (change.radius !== undefined) {
              if (base.kind !== 'circle') fail('radius 仅用于 circle');
              result.radius = number(change.radius, Number.MIN_VALUE, 10, 'change.radius');
            }
            if (change.opacity !== undefined) result.opacity = number(change.opacity, 0, 1, 'change.opacity');
            return result;
          })};
        });
      }
    } else if (spec.type === 'secant') {
      out.coefficients = array(spec.coefficients, 1, 5, -20, 20, 'coefficients');
      out.domain = array(spec.domain, 2, 2, -5, 5, 'domain');
      if (out.domain[0] >= out.domain[1]) fail('domain 必须严格递增');
      out.baseX = number(spec.baseX, out.domain[0], out.domain[1], 'baseX');
      out.gap = interval(spec.gap, 0.01, 3, 'gap');
      if (out.baseX + out.gap.max > out.domain[1]) fail('baseX + gap.max 必须位于 domain 内');
    } else {
      out.coefficient = number(spec.coefficient, 0.2, 5, 'coefficient');
      out.radius = number(spec.radius, 0.5, 3, 'radius');
      out.height = interval(spec.height, Number.MIN_VALUE, out.coefficient * out.radius * out.radius, 'height');
    }
    return out;
  }
  function diagramPoints(value, dimension, limits, name) {
    dataList(value, limits[0], limits[1], name);
    var points = [];
    for (var i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, String(i))) fail(name + ' 不允许空缺或继承元素');
      points.push(array(value[i], dimension, dimension, -10, 10, name));
    }
    return points;
  }
  function el(parent, tag, attrs, content) {
    var node = parent.ownerDocument.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (content !== undefined) node.textContent = content;
    parent.appendChild(node); return node;
  }
  function svg(parent, tag, attrs, content) {
    var node = parent.ownerDocument.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (content !== undefined) node.textContent = content;
    parent.appendChild(node); return node;
  }
  function fmt(n) { return Math.abs(n) < 1e-10 ? '0' : Number(n.toPrecision(6)).toString(); }
  function axisFmt(n) { return Math.abs(n) < 1e-10 ? '0' : Number(n.toPrecision(4)).toString(); }
  function pair(v) { return '(' + fmt(v[0]) + ', ' + fmt(v[1]) + ')'; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function hidden(node) { return !!node.closest('[hidden]'); }
  function live(node) { return node.isConnected && !hidden(node) && !node.ownerDocument.hidden; }
  function lifecycle(root) {
    var cleanups = [], frames = new Set(), dead = false;
    var api = {
      on: function (target, event, fn) { target.addEventListener(event, fn); cleanups.push(function () { target.removeEventListener(event, fn); }); },
      cleanup: function (fn) { cleanups.push(fn); },
      frame: function (fn) {
        if (dead) return 0;
        var id = window.requestAnimationFrame(function (now) { frames.delete(id); if (!dead && root.isConnected) fn(now); });
        frames.add(id); return id;
      },
      cancel: function (id) { window.cancelAnimationFrame(id); frames.delete(id); },
      resize: function (fn) {
        if (window.ResizeObserver) { var ro = new window.ResizeObserver(fn); ro.observe(root); cleanups.push(function () { ro.disconnect(); }); }
        else api.on(window, 'resize', fn);
      },
      dispose: function () {
        if (dead) return; dead = true;
        frames.forEach(function (id) { window.cancelAnimationFrame(id); }); frames.clear();
        cleanups.forEach(function (fn) { fn(); });
        if (!controllers.size && observer) { observer.disconnect(); observer = null; }
      }
    };
    return api;
  }
  function button(parent, label, fn, life, primary) {
    var node = el(parent, 'button', {type: 'button', class: primary ? 'btn primary' : 'btn'}, label);
    life.on(node, 'click', fn); return node;
  }
  function range(parent, name, bounds, id, life, fn) {
    var wrap = el(parent, 'div', {class: 'learn-scene-field'});
    el(wrap, 'label', {for: id}, name);
    var input = el(wrap, 'input', {id: id, type: 'range', min: bounds.min, max: bounds.max, step: 'any', value: bounds.value});
    input.disabled = bounds.min === bounds.max;
    life.on(input, 'input', function () { fn(Number(input.value)); });
    return input;
  }
  function plot(root, title) {
    var box = el(root, 'div', {class: 'learn-scene-plot'});
    var drawing = svg(box, 'svg', {viewBox: '0 0 640 380', role: 'img', 'aria-label': title});
    return {box: box, svg: drawing};
  }
  function axes(drawing, map, bounds) {
    var group = svg(drawing, 'g', {class: 'learn-scene-axes'});
    var leftBottom = map(bounds[0], bounds[2]), rightTop = map(bounds[1], bounds[3]);
    var ticks = rightTop[0] - leftBottom[0] < 350 ? 2 : 4;
    for (var i = 0; i <= ticks; i++) {
      var x = bounds[0] + (bounds[1] - bounds[0]) * i / ticks, y = bounds[2] + (bounds[3] - bounds[2]) * i / ticks;
      var a = map(x, bounds[2]), b = map(x, bounds[3]), c = map(bounds[0], y), d = map(bounds[1], y);
      svg(group, 'path', {d: 'M' + a.join(' ') + 'L' + b.join(' ') + 'M' + c.join(' ') + 'L' + d.join(' '), class: 'learn-scene-grid'});
      svg(group, 'text', {x: a[0], y: leftBottom[1] + 23, 'text-anchor': 'middle'}, axisFmt(x));
      svg(group, 'text', {x: leftBottom[0] - 8, y: c[1] + 4, 'text-anchor': 'end'}, axisFmt(y));
    }
    var ox = clamp(0, bounds[0], bounds[1]), oy = clamp(0, bounds[2], bounds[3]);
    var p = map(bounds[0], oy), q = map(bounds[1], oy), r = map(ox, bounds[2]), s = map(ox, bounds[3]);
    svg(group, 'path', {d: 'M' + p.join(' ') + 'L' + q.join(' ') + 'M' + r.join(' ') + 'L' + s.join(' '), class: 'learn-scene-axis'});
    svg(group, 'text', {x: q[0] + 8, y: q[1] - 7}, 'x');
    svg(group, 'text', {x: s[0] + 8, y: rightTop[1] - 8}, 'y');
    return group;
  }
  function linear(root, spec, life, id) {
    var a = spec.matrix[0][0], b = spec.matrix[0][1], c = spec.matrix[1][0], d = spec.matrix[1][1], v = spec.vector;
    var u = [a * v[0], c * v[0]], w = [b * v[1], d * v[1]], av = [u[0] + w[0], u[1] + w[1]];
    el(root, 'p', {class: 'learn-scene-formula'}, 'A = [[' + fmt(a) + ', ' + fmt(b) + '], [' + fmt(c) + ', ' + fmt(d) + ']]，v = ' + pair(v));
    var captions = ['初始基底 e₁ = (1, 0)，e₂ = (0, 1)。向量 v = ' + pair(v) + '。',
      '第一列决定 Ae₁ = ' + pair([a, c]) + '。此步只展示第一列的变化，第二列仍是 e₂。',
      '第二列决定 Ae₂ = ' + pair([b, d]) + '。两列都完成后，Av = ' + pair(av) + '。',
      '按 v 的权重相加：' + fmt(v[0]) + 'Ae₁ + ' + fmt(v[1]) + 'Ae₂ = ' + pair(u) + ' + ' + pair(w) + ' = ' + pair(av) + '。'];
    var points = [[0, 0], [1, 0], [0, 1], [a, c], [b, d], v, u, w, av, [a * v[0], c * v[0] + v[1]]];
    var extent = 2 * Math.max(1, Math.abs(a) + Math.abs(b), Math.abs(c) + Math.max(1, Math.abs(d)));
    points.forEach(function (p) { extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1])); }); extent *= 1.2;
    var p = plot(root, '线性变换：固定坐标轴上的基底与向量');
    var width, height, scale, bounds, axisGroup;
    function metrics() {
      width = Math.max(100, p.box.clientWidth); height = width < 420 ? 300 : 380;
      p.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); p.svg.style.height = height + 'px';
      scale = Math.max(0.1, Math.min(Math.max(1, width - 82) / (2 * extent), (height - 64) / (2 * extent)));
      var hx = Math.max(1, width - 82) / (2 * scale), hy = (height - 64) / (2 * scale);
      bounds = [-hx, hx, -hy, hy];
    }
    metrics();
    var map = function (x, y) { return [(width + 34) / 2 + x * scale, (height - 10) / 2 - y * scale]; };
    axisGroup = axes(p.svg, map, bounds);
    var defs = svg(p.svg, 'defs'), marker = svg(defs, 'marker', {id: id + '-arrow', markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: 'auto', markerUnits: 'strokeWidth'});
    svg(marker, 'path', {d: 'M0 0L6 3L0 6Z', fill: 'context-stroke'});
    var grid = svg(p.svg, 'g', {class: 'learn-scene-transform-grid'}), lines = [];
    for (var k = -2; k <= 2; k++) {
      lines.push({node: svg(grid, 'path'), start: [k, -2], end: [k, 2]});
      lines.push({node: svg(grid, 'path'), start: [-2, k], end: [2, k]});
    }
    var basis1 = svg(p.svg, 'path', {class: 'learn-scene-first', 'marker-end': 'url(#' + id + '-arrow)'});
    var basis2 = svg(p.svg, 'path', {class: 'learn-scene-second', 'marker-end': 'url(#' + id + '-arrow)'});
    var result = svg(p.svg, 'path', {class: 'learn-scene-result', 'marker-end': 'url(#' + id + '-arrow)'});
    var add1 = svg(p.svg, 'path', {class: 'learn-scene-first learn-scene-sum', 'marker-end': 'url(#' + id + '-arrow)'});
    var add2 = svg(p.svg, 'path', {class: 'learn-scene-second learn-scene-sum', 'marker-end': 'url(#' + id + '-arrow)'});
    var legend = el(root, 'p', {class: 'learn-scene-legend'});
    var caption = el(root, 'p', {class: 'learn-scene-caption', 'aria-live': 'polite'});
    var controls = el(root, 'div', {class: 'learn-scene-controls'}), step = 0, progress = 1, running = false, raf = 0, last = 0;
    var speed = 1, reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    function path(node, start, end) { node.setAttribute('d', 'M' + map(start[0], start[1]).join(' ') + 'L' + map(end[0], end[1]).join(' ')); }
    function render(t) {
      var m = step === 0 ? [1, 0, 0, 1] : step === 1 ? [1 + (a - 1) * t, c * t, 0, 1] : step === 2 ? [a, c, b * t, 1 + (d - 1) * t] : [a, c, b, d];
      function transform(point) { return [m[0] * point[0] + m[2] * point[1], m[1] * point[0] + m[3] * point[1]]; }
      lines.forEach(function (line) { path(line.node, transform(line.start), transform(line.end)); });
      path(basis1, [0, 0], [m[0], m[1]]); path(basis2, [0, 0], [m[2], m[3]]); path(result, [0, 0], transform(v));
      add1.style.display = add2.style.display = step === 3 ? '' : 'none';
      path(add1, [0, 0], [u[0] * t, u[1] * t]); path(add2, u, [u[0] + w[0] * t, u[1] + w[1] * t]);
      legend.textContent = (step === 0 ? 'e₁' : step === 1 && t < 1 ? '第一列过渡' : 'Ae₁') + ': ' + pair([m[0], m[1]]) + '；' + (step >= 2 ? step === 2 && t < 1 ? '第二列过渡' : 'Ae₂' : 'e₂') + ': ' + pair([m[2], m[3]]) + '；' + (step >= 2 && (step !== 2 || t === 1) ? 'Av' : '当前向量') + ': ' + pair(transform(v)) + '。绿色实线：第一列；灰色实线：第二列；粗线：向量；虚线：加权相加。';
      p.svg.setAttribute('data-vector', transform(v).join(',')); p.svg.setAttribute('data-progress', String(t));
    }
    function reflect() {
      caption.textContent = '步骤 ' + (step + 1) + ' / 4：' + captions[step];
      prev.disabled = step === 0; next.disabled = step === 3;
      play.textContent = running ? '暂停' : progress < 1 ? '继续' : step === 0 ? '开始演示' : '播放本步';
    }
    function pause() { if (raf) life.cancel(raf); raf = 0; running = false; reflect(); }
    function tick(now) {
      raf = 0; if (!live(root)) { pause(); return; }
      progress = Math.min(1, progress + (now - last) * speed / 1200); last = now;
      render(progress * progress * (3 - 2 * progress));
      if (progress < 1 && running) raf = life.frame(tick); else { running = false; reflect(); }
    }
    function start() {
      if (!live(root)) return;
      if (reduced && reduced.matches) { progress = 1; render(1); reflect(); return; }
      running = true; last = window.performance.now(); reflect(); raf = life.frame(tick);
    }
    function go(target, animate) { pause(); step = target; progress = animate && target > 0 ? 0 : 1; render(progress); reflect(); if (progress === 0) start(); }
    var prev = button(controls, '上一步', function () { go(Math.max(0, step - 1), true); }, life);
    var play = button(controls, '开始演示', function () { if (running) pause(); else if (progress < 1) start(); else if (step === 0) go(1, true); else go(step, true); }, life, true);
    var next = button(controls, '下一步', function () { go(Math.min(3, step + 1), true); }, life);
    button(controls, '重播本步', function () { go(step, true); }, life);
    var speedWrap = el(controls, 'label', {class: 'learn-scene-speed'}, '速度 '), select = el(speedWrap, 'select', {'aria-label': '动画速度'});
    [['0.5', '慢速'], ['1', '正常'], ['2', '快速']].forEach(function (option) { el(select, 'option', {value: option[0]}, option[1]); }); select.value = '1';
    life.on(select, 'change', function () { if (running) { var now = window.performance.now(); progress = Math.min(1, progress + (now - last) * speed / 1200); last = now; } speed = Number(select.value); });
    life.on(root.ownerDocument, 'visibilitychange', function () { if (root.ownerDocument.hidden) pause(); });
    life.resize(function () { metrics(); axisGroup.remove(); axisGroup = axes(p.svg, map, bounds); p.svg.insertBefore(axisGroup, defs); render(progress * progress * (3 - 2 * progress)); });
    if (reduced && reduced.addEventListener) { var reduce = function () { if (reduced.matches) { pause(); progress = 1; render(1); reflect(); } }; life.on(reduced, 'change', reduce); }
    render(1); reflect();
  }
  function diagram(root, spec, life, id) {
    var steps = spec.steps || [], step = 0, progress = 1, running = false, paused = false;
    var animation = 0, inputFrame = 0, last = 0, speed = 1, view = 'oblique';
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    function copy(state) { return state.map(function (item) { return {id: item.id, kind: item.kind, color: item.color, label: item.label, points: item.points.map(function (point) { return point.slice(); }), radius: item.radius, opacity: item.opacity}; }); }
    var states = [copy(spec.elements)];
    steps.forEach(function (entry) {
      var next = copy(states[states.length - 1]);
      entry.changes.forEach(function (change) {
        var item = next.find(function (candidate) { return candidate.id === change.id; });
        if (change.points !== undefined) item.points = change.points.map(function (point) { return point.slice(); });
        if (change.radius !== undefined) item.radius = change.radius;
        if (change.opacity !== undefined) item.opacity = change.opacity;
      });
      states.push(next);
    });
    var p = plot(root, spec.dimension === 3 ? '三维图形的投影' : '二维图形');
    p.svg.classList.add('learn-scene-diagram-plot');
    var defs = svg(p.svg, 'defs'), markerColors = {accent: 'var(--learn-accent)', secondary: 'var(--learn-ink)', muted: 'var(--learn-muted)', positive: 'var(--learn-success)', warning: 'var(--learn-danger)'};
    Object.keys(markerColors).forEach(function (color) {
      var marker = svg(defs, 'marker', {id: id + '-diagram-arrow-' + color, markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: 'auto', markerUnits: 'strokeWidth'});
      svg(marker, 'path', {d: 'M0 0L6 3L0 6Z', fill: markerColors[color]});
    });
    var marks = svg(p.svg, 'g', {class: 'learn-scene-diagram-marks'});
    var nodes = spec.elements.map(function (item) {
      var tag = item.kind === 'point' ? 'circle' : item.kind === 'label' ? 'text' : 'path';
      var group = svg(marks, 'g', {class: 'learn-scene-diagram-item'});
      var node = svg(group, tag, {class: 'learn-scene-diagram-element learn-scene-diagram-' + item.kind + ' learn-scene-color-' + item.color, 'data-element-id': item.id});
      if (item.kind === 'arrow') node.setAttribute('marker-end', 'url(#' + id + '-diagram-arrow-' + item.color + ')');
      if (item.kind === 'point') node.setAttribute('r', 5);
      if (item.label !== undefined) {
        node.setAttribute('aria-label', item.label);
        if (item.kind !== 'label') svg(node, 'title', {}, item.label);
      }
      var label = item.kind !== 'label' && item.label ? svg(group, 'text', {class: 'learn-scene-diagram-label learn-scene-color-' + item.color, 'data-element-label': item.id, 'aria-label': item.label}) : null;
      return {group: group, shape: node, label: label};
    });
    var caption = el(root, 'p', {class: 'learn-scene-caption', 'aria-live': 'polite'});
    var labeled = spec.elements.filter(function (item) { return item.label; });
    if (labeled.length) {
      var legend = el(root, 'div', {class: 'learn-scene-diagram-legend'});
      el(legend, 'p', {}, '图中标签');
      var labels = el(legend, 'ul');
      labeled.forEach(function (item) { el(labels, 'li', {}, item.label); });
    }
    var controls, prev, next, play, slider, viewSelect;
    if (spec.dimension === 3) {
      var viewWrap = el(root, 'label', {class: 'learn-scene-diagram-view'}, '视角 ');
      viewSelect = el(viewWrap, 'select', {'aria-label': '图形视角'});
      [['oblique', '斜视'], ['top', '俯视']].forEach(function (option) { el(viewSelect, 'option', {value: option[0]}, option[1]); });
      life.on(viewSelect, 'change', function () { view = viewSelect.value; metrics(); render(); });
    }
    if (steps.length) {
      var controlBox = el(root, 'div', {class: 'learn-scene-diagram-controls'});
      controls = el(controlBox, 'div', {class: 'learn-scene-controls'});
      prev = button(controls, '上一步', function () { go(Math.max(0, step - 1)); }, life);
      next = button(controls, '下一步', function () { go(Math.min(steps.length, step + 1)); }, life);
      play = button(controls, '开始', function () {
        if (running) { pause(true); return; }
        if (paused && progress < 1) { start(); return; }
        if (step === steps.length && progress === 1) go(0);
        if (progress === 1) { step++; progress = 0; }
        start();
      }, life, true);
      button(controls, '重播', function () { go(0); step = 1; progress = 0; start(); }, life);
      var speedWrap = el(controls, 'label', {class: 'learn-scene-speed'}, '速度 '), speedSelect = el(speedWrap, 'select', {'aria-label': '动画速度'});
      [['0.5', '慢速'], ['1', '正常']].forEach(function (option) { el(speedSelect, 'option', {value: option[0]}, option[1]); });
      speedSelect.value = '1';
      life.on(speedSelect, 'change', function () { speed = Number(speedSelect.value); });
      slider = range(controlBox, '本步进度', {min: 0, max: 1, value: 1}, id + '-progress', life, function (value) {
        pause(false); progress = value; schedule(); reflect();
      });
      slider.step = '0.01';
    }
    var width = 0, height = 0, scale = 1, offsetX = 0, offsetY = 0;
    function project(point) {
      var x = point[0], y = point[1], z = point[2] || 0;
      if (spec.dimension === 2 || view === 'top') return [x, -y, z];
      return [x + 0.5 * y, -0.35 * x + 0.55 * y - z, 0.3 * x - 0.5 * y + 0.5 * z];
    }
    function projectedCircle(item, count) {
      var center = item.points[0], result = [];
      for (var i = 0; i < count; i++) {
        var angle = 2 * Math.PI * i / count;
        result.push(project([center[0] + item.radius * Math.cos(angle), center[1] + item.radius * Math.sin(angle), center[2] || 0]));
      }
      return result;
    }
    function metrics() {
      width = Math.max(180, p.box.clientWidth); height = width < 420 ? 300 : 380;
      p.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); p.svg.style.height = height + 'px';
      var left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      states.forEach(function (state) { state.forEach(function (item) {
        var points = item.kind === 'circle' ? projectedCircle(item, 32) : item.points.map(project);
        points.forEach(function (point) { left = Math.min(left, point[0]); right = Math.max(right, point[0]); top = Math.min(top, point[1]); bottom = Math.max(bottom, point[1]); });
      }); });
      var spanX = Math.max(1, right - left), spanY = Math.max(1, bottom - top);
      scale = Math.min((width - 48) / spanX, (height - 48) / spanY);
      offsetX = width / 2 - (left + right) * scale / 2; offsetY = height / 2 - (top + bottom) * scale / 2;
    }
    function screen(point) { return [offsetX + point[0] * scale, offsetY + point[1] * scale]; }
    function interpolate(a, b, t) {
      var length = Math.max(a.length, b.length), points = [];
      for (var i = 0; i < length; i++) {
        var before = a[Math.min(i, a.length - 1)], after = b[Math.min(i, b.length - 1)];
        points.push(before.map(function (value, index) { return value + (after[index] - value) * t; }));
      }
      return points;
    }
    function placeLabel(node, full, anchor, occupied, reserve) {
      if (node._sceneLabelWidth !== width || node._sceneLabelSource !== full) {
        var letters = Array.from(full), visible = full, maximum = width - 24;
        node.textContent = visible;
        while (node.getComputedTextLength() > maximum && letters.length > 1) {
          letters.pop(); visible = letters.join('') + '…'; node.textContent = visible;
        }
        node._sceneLabelWidth = width; node._sceneLabelSource = full;
        node._sceneTextWidth = Math.min(maximum, node.getComputedTextLength());
      }
      var textWidth = node._sceneTextWidth, x = anchor[0], y = anchor[1];
      var candidates = [[8, -8], [8, 18], [-textWidth - 8, -8], [-textWidth - 8, 18], [8, 36], [-textWidth - 8, 36]];
      var box;
      for (var c = 0; c < candidates.length; c++) {
        var bx = clamp(x + candidates[c][0], 12, width - textWidth - 12), by = clamp(y + candidates[c][1], 18, height - 12);
        box = [bx, by - 15, bx + textWidth, by + 3];
        if (!occupied.some(function (other) { return box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]; })) break;
      }
      if (reserve) occupied.push(box);
      node.setAttribute('x', box[0]); node.setAttribute('y', box[3] - 3);
    }
    function render() {
      if (!live(root)) return;
      var before = states[step ? step - 1 : 0], after = states[step], t = step ? progress : 1, occupied = [];
      var order = nodes.map(function (entry, index) {
        var node = entry.shape;
        var start = before[index], end = after[index], points = interpolate(start.points, end.points, t);
        var radius = start.radius === undefined ? undefined : start.radius + (end.radius - start.radius) * t;
        var opacity = start.opacity + (end.opacity - start.opacity) * t;
        var item = {kind: end.kind, points: points, radius: radius};
        var projected = item.kind === 'circle' ? projectedCircle(item, 48) : points.map(project);
        var onScreen = projected.map(screen);
        node.setAttribute('opacity', opacity);
        if (item.kind === 'point') { node.setAttribute('cx', onScreen[0][0]); node.setAttribute('cy', onScreen[0][1]); }
        else if (item.kind === 'label') {
          placeLabel(node, end.label || end.id, onScreen[0], occupied, opacity >= 0.05);
        } else {
          var isZeroArrow = item.kind === 'arrow' && Math.hypot(onScreen[1][0] - onScreen[0][0], onScreen[1][1] - onScreen[0][1]) < 0.01;
          if (item.kind === 'arrow') {
            node.setAttribute('data-zero', isZeroArrow ? 'true' : 'false');
            node.setAttribute('marker-end', isZeroArrow ? 'none' : 'url(#' + id + '-diagram-arrow-' + end.color + ')');
            node.style.strokeWidth = isZeroArrow ? '6px' : '';
          }
          node.setAttribute('d', isZeroArrow ? 'M' + onScreen[0][0].toFixed(2) + ' ' + onScreen[0][1].toFixed(2) + 'l0.01 0' :
            onScreen.map(function (point, i) { return (i ? 'L' : 'M') + point[0].toFixed(2) + ' ' + point[1].toFixed(2); }).join('') + (item.kind === 'polygon' || item.kind === 'circle' ? 'Z' : ''));
        }
        if (entry.label) {
          var anchor = [0, 0];
          onScreen.forEach(function (point) { anchor[0] += point[0] / onScreen.length; anchor[1] += point[1] / onScreen.length; });
          entry.label.setAttribute('opacity', opacity);
          placeLabel(entry.label, end.label, anchor, occupied, opacity >= 0.05);
        }
        var depth = projected.reduce(function (sum, point) { return sum + point[2]; }, 0) / projected.length;
        return {node: entry.group, depth: depth, index: index};
      });
      if (spec.dimension === 3) order.sort(function (a, b) { return a.depth - b.depth || a.index - b.index; }).forEach(function (item, index) {
        if (marks.children[index] !== item.node) marks.insertBefore(item.node, marks.children[index] || null);
      });
      p.svg.dataset.step = String(step); p.svg.dataset.progress = String(progress); p.svg.dataset.view = spec.dimension === 3 ? view : 'plane';
    }
    function reflect() {
      caption.textContent = '步骤 ' + (step + 1) + ' / ' + (steps.length + 1) + '：' + (step ? steps[step - 1].caption : '观察初始图形。');
      if (!steps.length) return;
      prev.disabled = step === 0; next.disabled = step === steps.length;
      play.textContent = running ? '暂停' : step === steps.length && progress === 1 ? '重播' : paused || (step > 0 && progress < 1) ? '继续' : '开始';
      slider.disabled = step === 0; slider.value = String(progress);
    }
    function pause(keepPosition) { if (animation) life.cancel(animation); animation = 0; running = false; paused = !!keepPosition; reflect(); }
    function tick(now) {
      animation = 0; if (!live(root)) { pause(false); return; }
      progress = Math.min(1, progress + Math.max(0, now - last) * speed / 1000); last = now;
      render(); reflect();
      if (progress < 1) animation = life.frame(tick);
      else if (step < steps.length) { step++; progress = 0; render(); reflect(); animation = life.frame(tick); }
      else { running = false; paused = false; reflect(); }
    }
    function start() {
      if (!live(root)) return;
      if (reduced && reduced.matches) { progress = 1; running = false; paused = false; render(); reflect(); return; }
      running = true; paused = false; last = window.performance.now(); reflect(); animation = life.frame(tick);
    }
    function go(target) { pause(false); step = target; progress = 1; render(); reflect(); }
    function schedule() { if (!inputFrame && live(root)) inputFrame = life.frame(function () { inputFrame = 0; render(); }); }
    life.resize(function () { if (live(root)) { metrics(); render(); } });
    if (reduced && reduced.addEventListener) life.on(reduced, 'change', function () {
      if (reduced.matches && running) { pause(false); progress = 1; render(); reflect(); }
    });
    life.on(root.ownerDocument, 'visibilitychange', function () { if (root.ownerDocument.hidden) { pause(false); if (inputFrame) life.cancel(inputFrame); inputFrame = 0; } });
    if (window.MutationObserver) {
      var visibility = new window.MutationObserver(function () { if (!live(root)) { pause(false); if (inputFrame) life.cancel(inputFrame); inputFrame = 0; } });
      visibility.observe(root.ownerDocument.documentElement, {subtree: true, attributes: true, attributeFilter: ['hidden']});
      life.cleanup(function () { visibility.disconnect(); });
    }
    life.cleanup(function () { animation = 0; inputFrame = 0; running = false; });
    metrics(); render(); reflect();
  }
  function polynomial(coefficients, x) {
    var y = 0; for (var i = coefficients.length - 1; i >= 0; i--) y = y * x + coefficients[i]; return y;
  }
  function secant(root, spec, life, id) {
    var f = function (x) { return polynomial(spec.coefficients, x); };
    var derivative = spec.coefficients.slice(1).map(function (v, i) { return v * (i + 1); });
    var slope = polynomial(derivative, spec.baseX), py = f(spec.baseX), xmin = spec.domain[0], xmax = spec.domain[1], samples = [];
    var ymin = py, ymax = py;
    for (var i = 0; i <= 200; i++) { var x = xmin + (xmax - xmin) * i / 200, y = f(x); samples.push([x, y]); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    var pad = Math.max((ymax - ymin) * 0.12, Math.abs(py) * 0.02, 0.5); ymin -= pad; ymax += pad;
    el(root, 'p', {class: 'learn-scene-formula'}, 'f(x) 的升幂系数：[' + spec.coefficients.map(fmt).join(', ') + ']；P 的 x = ' + fmt(spec.baseX));
    var p = plot(root, '割线连接 P、Q，虚线为 P 点切线');
    var width, height, axisGroup;
    function metrics() { width = Math.max(100, p.box.clientWidth); height = width < 420 ? 300 : 380; p.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); p.svg.style.height = height + 'px'; }
    metrics();
    var map = function (x, y) { return [58 + (x - xmin) * Math.max(1, width - 82) / (xmax - xmin), height - 38 - (y - ymin) * (height - 64) / (ymax - ymin)]; };
    axisGroup = axes(p.svg, map, [xmin, xmax, ymin, ymax]);
    var defs = svg(p.svg, 'defs'), clip = svg(defs, 'clipPath', {id: id + '-clip'}), clipRect = svg(clip, 'rect', {x: 58, y: 26, width: Math.max(1, width - 82), height: height - 64});
    var marks = svg(p.svg, 'g', {'clip-path': 'url(#' + id + '-clip)'});
    var curve = svg(marks, 'path', {class: 'learn-scene-curve', d: samples.map(function (p, i) { return (i ? 'L' : 'M') + map(p[0], p[1]).join(' '); }).join('')});
    function line(m) { return 'M' + map(xmin, py + m * (xmin - spec.baseX)).join(' ') + 'L' + map(xmax, py + m * (xmax - spec.baseX)).join(' '); }
    var tangent = svg(marks, 'path', {class: 'learn-scene-tangent', d: line(slope)});
    var sec = svg(marks, 'path', {class: 'learn-scene-result'}), q = svg(marks, 'circle', {r: 5, class: 'learn-scene-point'});
    var pp = map(spec.baseX, py), ppNode = svg(marks, 'circle', {cx: pp[0], cy: pp[1], r: 5, class: 'learn-scene-point'});
    var labels = svg(p.svg, 'g', {class: 'learn-scene-axes'}), pl = svg(labels, 'text', {}, 'P'), ql = svg(labels, 'text', {}, 'Q');
    var output = el(root, 'p', {class: 'learn-scene-values', 'aria-live': 'polite'});
    var current = spec.gap.value, frame = 0;
    function render() {
      frame = 0; var qx = spec.baseX + current, qy = f(qx), m = (qy - py) / current, pos = map(qx, qy);
      sec.setAttribute('d', line(m)); q.setAttribute('cx', pos[0]); q.setAttribute('cy', pos[1]);
      ql.setAttribute('x', clamp(pos[0] + 10, 65, Math.max(65, width - 35))); ql.setAttribute('y', clamp(pos[1] + 20, 40, height - 44));
      pl.setAttribute('x', clamp(pp[0] - 12, 65, Math.max(65, width - 35))); pl.setAttribute('y', clamp(pp[1] - 12, 40, height - 58));
      output.textContent = 'h = ' + fmt(current) + '；P = ' + pair([spec.baseX, py]) + '；Q = ' + pair([qx, qy]) + '；割线斜率 = ' + fmt(m) + '；切线斜率 f′(x₀) = ' + fmt(slope) + '。';
      p.svg.setAttribute('data-gap', String(current)); p.svg.setAttribute('data-secant-slope', String(m)); p.svg.setAttribute('data-tangent-slope', String(slope));
    }
    range(root, '点间距 h（向右接近 P）', spec.gap, id + '-gap', life, function (value) { current = value; if (!frame) frame = life.frame(render); });
    life.resize(function () {
      metrics(); axisGroup.remove(); axisGroup = axes(p.svg, map, [xmin, xmax, ymin, ymax]); p.svg.insertBefore(axisGroup, defs);
      clipRect.setAttribute('width', Math.max(1, width - 82)); clipRect.setAttribute('height', height - 64);
      curve.setAttribute('d', samples.map(function (p, i) { return (i ? 'L' : 'M') + map(p[0], p[1]).join(' '); }).join(''));
      tangent.setAttribute('d', line(slope)); pp = map(spec.baseX, py); ppNode.setAttribute('cx', pp[0]); ppNode.setAttribute('cy', pp[1]); render();
    });
    el(root, 'p', {class: 'learn-scene-legend'}, '曲线：f(x)；实线：割线 PQ；虚线：P 点切线。h 保持大于 0，观察差商逼近导数。'); render();
  }
  function surface(root, spec, life, id) {
    var state = {h: spec.height.value, yaw: -0.65, elevation: 0.58, view: 'oblique'}, drag = null, frame = 0, cache = null, dirty = true;
    var radius = spec.radius, zmax = spec.coefficient * radius * radius, half = radius * 1.06, faces = [], wires = [], extent = [];
    function point(r, angle) { return [r * Math.cos(angle), r * Math.sin(angle), spec.coefficient * r * r]; }
    for (var ri = 0; ri < 12; ri++) for (var ai = 0; ai < 48; ai++) {
      var points = [point(radius * ri / 12, ai * Math.PI / 24), point(radius * (ri + 1) / 12, ai * Math.PI / 24), point(radius * (ri + 1) / 12, (ai + 1) * Math.PI / 24), point(radius * ri / 12, (ai + 1) * Math.PI / 24)];
      faces.push(points); extent.push(points[1]);
    }
    for (var ring = 1; ring <= 6; ring++) { var circle = []; for (var j = 0; j <= 96; j++) circle.push(point(radius * ring / 6, j * Math.PI / 48)); wires.push(circle); }
    for (var spoke = 0; spoke < 12; spoke++) { var radial = []; for (var n = 0; n <= 24; n++) radial.push(point(radius * n / 24, spoke * Math.PI / 6)); wires.push(radial); }
    extent.push([-half, -half, 0], [half, half, 0], [-half, half, zmax], [half, -half, zmax], [radius * 1.2, 0, 0], [0, radius * 1.2, 0], [0, 0, zmax * 1.1]);
    el(root, 'p', {class: 'learn-scene-formula'}, 'z = ' + fmt(spec.coefficient) + '(x² + y²)，水平切面 z = h，交圈半径 r = √(h / ' + fmt(spec.coefficient) + ')。');
    var p = plot(root, '抛物面与水平切面，交圈以粗线标明');
    var canvas = el(p.box, 'canvas', {class: 'learn-scene-canvas', 'aria-hidden': 'true'}); p.box.insertBefore(canvas, p.svg);
    var ctx = canvas.getContext('2d'); if (!ctx) fail('此浏览器无法创建三维画布');
    p.svg.setAttribute('tabindex', '0'); p.svg.setAttribute('role', 'group'); p.svg.setAttribute('aria-label', '三维视角。方向键旋转，选择预设视角可重置。');
    var edge = svg(p.svg, 'path', {class: 'learn-scene-plane'}), cut = svg(p.svg, 'path', {class: 'learn-scene-result learn-scene-cut'});
    var axisLabels = ['x', 'y', 'z'].map(function (name) { return svg(p.svg, 'text', {class: 'learn-scene-axis-label', 'text-anchor': 'middle'}, name); });
    var values = el(root, 'p', {class: 'learn-scene-values', 'aria-live': 'polite'});
    range(root, '切面高度 h', spec.height, id + '-height', life, function (value) { state.h = value; schedule(); });
    var controls = el(root, 'div', {class: 'learn-scene-controls'}), label = el(controls, 'label', {for: id + '-view'}, '视角 ');
    var view = el(label, 'select', {id: id + '-view'});
    [['oblique', '斜视'], ['top', '俯视'], ['low', '低角度'], ['free', '自由视角']].forEach(function (v) { el(view, 'option', {value: v[0]}, v[1]); });
    el(root, 'p', {class: 'learn-scene-legend'}, '曲面：浅色网格；切面：虚线边框；交圈：粗实线。交圈叠加显示，以便观察截面。鼠标拖动或方向键可旋转；触摸请先选自由视角。');
    function path(points, project, close) { var out = new window.Path2D(); points.forEach(function (p, i) { var q = project(p); if (i) out.lineTo(q[0], q[1]); else out.moveTo(q[0], q[1]); }); if (close) out.closePath(); return out; }
    function rebuild() {
      var width = Math.max(1, p.box.clientWidth), height = width < 420 ? 310 : 360, dpr = clamp(window.devicePixelRatio || 1, 1, 3);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); p.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); p.svg.style.height = height + 'px';
      var cy = Math.cos(state.yaw), sy = Math.sin(state.yaw), ce = Math.cos(state.elevation), se = Math.sin(state.elevation);
      function raw(p) { var depth = sy * p[0] + cy * p[1]; return [cy * p[0] - sy * p[1], ce * p[2] - se * depth, ce * depth + se * p[2]]; }
      var bounds = [Infinity, -Infinity, Infinity, -Infinity]; extent.forEach(function (p) { var q = raw(p); bounds[0] = Math.min(bounds[0], q[0]); bounds[1] = Math.max(bounds[1], q[0]); bounds[2] = Math.min(bounds[2], q[1]); bounds[3] = Math.max(bounds[3], q[1]); });
      var scale = Math.max(0.1, Math.min(Math.max(1, width - 62) / (bounds[1] - bounds[0]), (height - 68) / (bounds[3] - bounds[2])));
      function project(p) { var q = raw(p); return [width / 2 + (q[0] - (bounds[0] + bounds[1]) / 2) * scale, height / 2 - (q[1] - (bounds[2] + bounds[3]) / 2) * scale, q[2]]; }
      var projected = faces.map(function (face, i) { return {path: path(face, project, true), depth: face.reduce(function (sum, p) { return sum + raw(p)[2]; }, 0) / 4, shade: 0.13 + (i % 48) / 48 * 0.16}; }).sort(function (a, b) { return a.depth - b.depth; });
      var wire = new window.Path2D(); wires.forEach(function (line) { wire.addPath(path(line, project, false)); });
      var axesPath = new window.Path2D(), positions = [[radius * 1.2, 0, 0], [0, radius * 1.2, 0], [0, 0, zmax * 1.1]];
      positions.forEach(function (end, i) { axesPath.addPath(path([[0, 0, 0], end], project, false)); var q = project(end); axisLabels[i].setAttribute('x', clamp(q[0], 15, Math.max(15, width - 15))); axisLabels[i].setAttribute('y', clamp(q[1] - 8, 18, height - 15)); });
      axisLabels[2].style.display = state.elevation > 1.49 ? 'none' : '';
      var planes = [], tiles = 8;
      for (var x = 0; x < tiles; x++) for (var y = 0; y < tiles; y++) {
        var x0 = -half + 2 * half * x / tiles, x1 = -half + 2 * half * (x + 1) / tiles, y0 = -half + 2 * half * y / tiles, y1 = -half + 2 * half * (y + 1) / tiles;
        var plane = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
        planes.push({path: path(plane, project, true), depth: plane.reduce(function (sum, p) { return sum + raw(p)[2]; }, 0) / 4});
      }
      planes.sort(function (a, b) { return a.depth - b.depth; });
      var style = window.getComputedStyle(root);
      cache = {width: width, height: height, dpr: dpr, faces: projected, planes: planes, wire: wire, axes: axesPath, project: project, shift: -scale * ce, depthShift: se,
        colors: {surface: style.getPropertyValue('--learn-surface').trim() || '#fff', ink: style.getPropertyValue('--learn-ink').trim() || '#2d3142', accent: style.getPropertyValue('--learn-accent').trim() || '#c74f20', success: style.getPropertyValue('--learn-success').trim() || '#2f7d5d'}};
      dirty = false;
    }
    function render() {
      frame = 0; if (!live(root) || p.box.clientWidth < 1) return;
      if (dirty || !cache || cache.width !== p.box.clientWidth || cache.dpr !== clamp(window.devicePixelRatio || 1, 1, 3)) rebuild();
      ctx.setTransform(cache.dpr, 0, 0, cache.dpr, 0, 0); ctx.clearRect(0, 0, cache.width, cache.height);
      ctx.globalAlpha = 1; ctx.fillStyle = cache.colors.surface; ctx.fillRect(0, 0, cache.width, cache.height); ctx.strokeStyle = cache.colors.ink; ctx.lineWidth = 1; ctx.stroke(cache.axes);
      var fi = 0, pi = 0, dy = cache.shift * state.h;
      while (fi < cache.faces.length || pi < cache.planes.length) {
        if (pi < cache.planes.length && (fi === cache.faces.length || cache.planes[pi].depth + cache.depthShift * state.h < cache.faces[fi].depth)) {
          ctx.translate(0, dy); ctx.fillStyle = cache.colors.accent; ctx.globalAlpha = 0.09; ctx.fill(cache.planes[pi++].path); ctx.translate(0, -dy);
        } else { var face = cache.faces[fi++]; ctx.fillStyle = cache.colors.success; ctx.globalAlpha = face.shade; ctx.fill(face.path); }
      }
      ctx.globalAlpha = 0.48; ctx.strokeStyle = cache.colors.success; ctx.lineWidth = 0.8; ctx.stroke(cache.wire); ctx.globalAlpha = 1;
      function svgPath(points) { return points.map(function (point, i) { var q = cache.project(point); return (i ? 'L' : 'M') + q[0].toFixed(3) + ' ' + q[1].toFixed(3); }).join('') + 'Z'; }
      edge.setAttribute('d', svgPath([[-half, -half, state.h], [half, -half, state.h], [half, half, state.h], [-half, half, state.h]]));
      var r = Math.sqrt(state.h / spec.coefficient), circle = [];
      for (var i = 0; i < 128; i++) circle.push([r * Math.cos(i * Math.PI / 64), r * Math.sin(i * Math.PI / 64), state.h]);
      cut.setAttribute('d', svgPath(circle)); cut.setAttribute('data-radius', String(r)); cut.setAttribute('data-height', String(state.h));
      values.textContent = 'h = ' + fmt(state.h) + '；交圈半径 r = ' + fmt(r) + '；交圈满足 x² + y² = ' + fmt(state.h / spec.coefficient) + '。';
    }
    function schedule() { if (!frame) frame = life.frame(render); }
    function free() { state.view = 'free'; view.value = 'free'; p.box.classList.add('learn-scene-free'); }
    life.on(view, 'change', function () { state.view = view.value; state.yaw = -0.65; state.elevation = state.view === 'top' ? Math.PI / 2 : state.view === 'low' ? 0.2 : 0.58; p.box.classList.toggle('learn-scene-free', state.view === 'free'); dirty = true; schedule(); });
    life.on(p.svg, 'pointerdown', function (event) { if (event.button !== 0 || (event.pointerType !== 'mouse' && state.view !== 'free')) return; p.svg.setPointerCapture(event.pointerId); drag = {id: event.pointerId, x: event.clientX, y: event.clientY, yaw: state.yaw, elevation: state.elevation}; });
    life.on(p.svg, 'pointermove', function (event) { if (!drag || drag.id !== event.pointerId) return; state.yaw = drag.yaw + (event.clientX - drag.x) * 0.009; state.elevation = clamp(drag.elevation + (event.clientY - drag.y) * 0.007, 0.12, Math.PI / 2); free(); dirty = true; schedule(); });
    function release(event) { if (drag && drag.id === event.pointerId) drag = null; }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (event) { life.on(p.svg, event, release); });
    life.cleanup(function () { if (drag && p.svg.hasPointerCapture(drag.id)) p.svg.releasePointerCapture(drag.id); drag = null; });
    life.on(p.svg, 'keydown', function (event) { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); state.yaw += event.key === 'ArrowRight' ? 0.12 : event.key === 'ArrowLeft' ? -0.12 : 0; state.elevation = clamp(state.elevation + (event.key === 'ArrowDown' ? 0.08 : event.key === 'ArrowUp' ? -0.08 : 0), 0.12, Math.PI / 2); free(); dirty = true; schedule(); });
    life.resize(function () { dirty = true; schedule(); });
    life.on(root.ownerDocument, 'visibilitychange', function () { if (!root.ownerDocument.hidden) { dirty = true; schedule(); } }); render();
  }
  function mount(container, raw) {
    var spec = validate(raw);
    if (controllers.has(container)) return controllers.get(container);
    var root = el(container, 'section', {class: 'learn-scene', 'data-scene-type': spec.type}), id = 'learn-scene-' + (++serial), life = lifecycle(root);
    el(root, 'h4', {}, spec.title); el(root, 'p', {class: 'learn-scene-summary'}, spec.summary);
    var controller = {isConnected: function () { return root.isConnected && container.contains(root); }, dispose: function () { controllers.delete(container); life.dispose(); root.remove(); }};
    try { if (spec.type === 'linear_transform') linear(root, spec, life, id); else if (spec.type === 'diagram') diagram(root, spec, life, id); else if (spec.type === 'secant') secant(root, spec, life, id); else surface(root, spec, life, id); }
    catch (error) { controller.dispose(); throw error; }
    var details = container.querySelector(':scope > details');
    if (details) container.insertBefore(root, details);
    controllers.set(container, controller);
    if (!observer && window.MutationObserver) {
      observer = new window.MutationObserver(function () { controllers.forEach(function (control, host) { if (!host.isConnected || !control.isConnected()) control.dispose(); }); });
      observer.observe(container.ownerDocument.documentElement, {childList: true, subtree: true});
    }
    return controller;
  }
  function status(figure, message) {
    var caption = figure.querySelector('figcaption');
    if (!caption) caption = el(figure, 'figcaption', {role: 'status'});
    caption.textContent = message;
  }
  function enhance(root) {
    if (!root || !root.querySelectorAll) return;
    var figures = Array.from(root.querySelectorAll('figure[data-scene]'));
    if (root.matches && root.matches('figure[data-scene]')) figures.unshift(root);
    figures.forEach(function (figure, index) {
      if (!['pending', 'invalid'].includes(figure.dataset.scene) || hidden(figure)) return;
      if (index >= 4) { figure.dataset.scene = 'error'; status(figure, '每段内容最多显示 4 个学习场景。请阅读保留的说明与场景数据。'); return; }
      if (figure.dataset.scene === 'invalid') { figure.dataset.scene = 'error'; status(figure, '场景数据未完整结束。请阅读保留的场景数据。'); return; }
      try {
        var code = figure.querySelector('code'), raw = code ? code.textContent : '';
        if (raw.length > 12000) fail('场景数据超过 12000 字符');
        mount(figure, JSON.parse(raw)); figure.dataset.scene = 'ready'; status(figure, '交互学习场景。说明和原始场景数据仍可阅读。');
      } catch (error) { figure.dataset.scene = 'error'; status(figure, '场景无法显示：' + error.message + '。请阅读保留的场景数据。'); }
    });
  }
  function dispose(root) {
    controllers.forEach(function (control, container) { if (container === root || (root && root.contains && root.contains(container))) control.dispose(); });
  }
  window.LearnScenes = {validate: validate, mount: mount, enhance: enhance, dispose: dispose};
}());
