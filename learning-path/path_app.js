/* 学习路径 · 前端逻辑
 * 三阶段状态机：intake → research → learning
 * 后端契约：/path/intake /path/research /path/plan /path/node /path/quiz
 * 依赖：无（纯原生 JS，无 CDN）
 */
(function () {
  'use strict';

  var API = location.protocol + '//' + location.hostname + ':8101';
  var TIMEOUT = 180000;               // 单次调用最长 180s（后端推理可能 30~90s）
  var STORE_PREFIX = 'learn-path-v1-';
  var LAST_KEY = 'learn-path-v1-last'; // 指向最近一次会话的 slug

  var state = {
    stage: 'intake',                  // intake | research | learning
    topic: '',
    history: [],                      // [{role:'assistant'|'user', content}]
    spec: null,
    queries: [],
    sources: [],
    brief: '',
    plan: null,
    nodeDetail: {},                   // {id: NodeDetail}
    nodeState: {}                     // {id: {completed, score}}
  };
  var selectedId = null;
  var busy = false;
  var retryFn = null;

  // ---------- 小工具 ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function slug(s) {
    return String(s || 'untitled').toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled';
  }
  // KaTeX：把 $...$ / $$...$$ 渲染成公式（失败不影响正文）
  function renderMathIn(el) {
    if (!el || typeof window.renderMathInElement !== 'function') return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
      });
    } catch (e) { /* 渲染失败保留原始文本 */ }
  }
  // 语法高亮：对迷你 Markdown 输出的代码块执行 highlight.js（库缺失时静默跳过）
  function highlightIn(el) {
    if (typeof hljs === 'undefined' || !el) return;
    var codes = el.querySelectorAll('pre.md-code code');
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      try {
        if (/\blanguage-/.test(c.className)) {
          hljs.highlightElement(c);
        } else {
          var r = hljs.highlightAuto(c.textContent);
          c.innerHTML = r.value;
          c.className = 'hljs';
        }
      } catch (e) { /* 高亮失败不影响正文 */ }
    }
  }
  // 迷你 Markdown：``` 围栏代码块 + 行内 `code`；文本换行由容器 pre-wrap 保留
  function mdText(t) {
    return esc(t)
      .replace(/`([^`\n]+)`/g, function (_, c) { return '<code class="md-inline">' + c + '</code>'; })
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }
  function mdRender(text) {
    var src = String(text == null ? '' : text);
    var out = '', last = 0, m;
    var re = /```([a-zA-Z0-9+#-]*)\r?\n?([\s\S]*?)```/g;
    while ((m = re.exec(src))) {
      out += mdText(src.slice(last, m.index));
      out += '<pre class="md-code"><code' + (m[1] ? ' class="language-' + m[1] + '"' : '') + '>' + esc(m[2].replace(/\r/g, '').replace(/\n+$/, '')) + '</code></pre>';
      last = m.index + m[0].length;
    }
    out += mdText(src.slice(last));
    return out;
  }
  function storeKey() { return STORE_PREFIX + slug(state.topic); }
  // 答案框自动扩展：随输入增高（以 CSS min-height 为下限）
  function bindAutoGrow(el) {
    if (!el || el.__ag) return;
    el.__ag = true;
    var fit = function () {
      el.style.height = 'auto';
      var mh = parseFloat(window.getComputedStyle(el).minHeight) || 140;
      el.style.height = Math.max(el.scrollHeight, mh) + 'px';
    };
    el.addEventListener('input', fit);
    fit();
  }
  function domain(u) { try { return new URL(u).hostname; } catch (e) { return u; } }

  // ---------- 服务端读写（页面不做任何本地保存；所有数据只在服务端） ----------
  var pendingEntries = null, saveTimer = null;
  function putState(entries) {
    try {
      fetch(API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: entries }), keepalive: true
      }).catch(function () {
        var retry = entries;
        setTimeout(function () {
          try {
            fetch(API + '/state/put', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entries: retry })
            }).catch(function () {});
          } catch (e) {}
        }, 1500);
      });
    } catch (e) {}
  }
  function delState(keys) {
    try {
      fetch(API + '/state/del', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keys }), keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!pendingEntries) return;
    var entries = pendingEntries; pendingEntries = null;
    putState(entries);
  }
  function flushBeacon() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!pendingEntries) return;
    var payload = JSON.stringify({ entries: pendingEntries }); pendingEntries = null;
    try {
      if (navigator.sendBeacon) {
        if (navigator.sendBeacon(API + '/state/put', new Blob([payload], { type: 'text/plain;charset=UTF-8' }))) return;
      }
    } catch (e) {}
    try {
      fetch(API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: payload, keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushBeacon(); });

  function save() {
    try {
      // 没有主题就不写：防止把空状态写进 learn-path-v1-untitled（历史 bug 的根源）
      if (!state.topic) return;
      var payload = {
        stage: state.stage, topic: state.topic, history: state.history,
        spec: state.spec, queries: state.queries, sources: state.sources,
        brief: state.brief, plan: state.plan,
        nodeDetail: state.nodeDetail, nodeState: state.nodeState
      };
      pendingEntries = {};
      pendingEntries[storeKey()] = JSON.stringify(payload);
      pendingEntries[LAST_KEY] = slug(state.topic);
      if (!saveTimer) saveTimer = setTimeout(flushSave, 350);
    } catch (e) { console.warn('save failed', e); }
  }
  function clearSave() {
    delState([storeKey(), LAST_KEY]);
  }
  function serverLoad() {
    return fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.entries) return false;
      var entries = j.entries;
      // 支持 ?t=<slug> 深链（从「学习资料库」直接打开某份资料）；无参则从零开始新生成
      var s = null;
      try { s = new URLSearchParams(location.search).get('t'); } catch (e2) { s = null; }
      if (s && typeof entries[STORE_PREFIX + s] !== 'string') s = null;   // 指定的资料不存在则回退
      if (!s) return false;   // 无参数 = 全新开始；已有资料请从「学习资料库」进入
      var raw = entries[STORE_PREFIX + s];
      if (typeof raw !== 'string') return false;
      var d; try { d = JSON.parse(raw); } catch (e3) { return false; }
      if (!d || typeof d !== 'object') return false;
      state.stage = d.stage || 'intake';
      // 兼容修复：历史状态可能缺 topic 字段 → 依次从 plan/spec 恢复，而不是拒绝加载
      state.topic = d.topic || (d.plan && d.plan.title) || (d.spec && d.spec.topic) || '';
      if (!state.topic) return false;
      state.history = d.history || [];
      state.spec = d.spec || null;
      state.queries = d.queries || [];
      state.sources = d.sources || [];
      state.brief = d.brief || '';
      state.plan = d.plan || null;
      state.nodeDetail = d.nodeDetail || {};
      state.nodeState = d.nodeState || {};
      // 状态自洽性：learning 必须有 plan
      if (state.stage === 'learning' && !state.plan) state.stage = 'research';
      if (state.stage === 'research' && !state.spec) state.stage = 'intake';
      // 历史「untitled」空壳键修复：主题可读后迁移到正确键名（旧键删除）
      var fixSlug = slug(state.topic);
      if (s === 'untitled' && fixSlug && fixSlug !== 'untitled') {
        delState([STORE_PREFIX + 'untitled']);
        save();
        s = fixSlug;
      }
      if (entries[LAST_KEY] !== s) {
        var o = {}; o[LAST_KEY] = s; putState(o);
      }
      return true;
    }).catch(function () { return false; });
  }

  // ---------- 浏览器本地清理 ----------
  // 页面已不再本地保存任何数据（数据只在服务端）；启动时把历史遗留的本地键清干净
  function purgeLocalLegacy() {
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf(STORE_PREFIX) === 0 || k.indexOf('__sync') === 0)) kill.push(k);
      }
      for (var j = 0; j < kill.length; j++) { try { localStorage.removeItem(kill[j]); } catch (e) {} }
      try { sessionStorage.removeItem('__sync_reloads'); } catch (e) {}
    } catch (e) {}
  }

  // ---------- 网络 ----------
  function post(path, body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    }, function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? '请求超时（180s）' : '网络错误：' + (e && e.message || e));
    });
  }

  function showError(msg, retry) {
    retryFn = retry || null;
    $('errtext').textContent = msg;
    $('errretry').hidden = !retry;
    $('errbar').hidden = false;
  }
  function hideError() { $('errbar').hidden = true; retryFn = null; }

  // ---------- 阶段/进度 ----------
  var STAGE_LABEL = { intake: '阶段 I · 需求采集', research: '阶段 R · 主动研究', learning: '阶段 L · 学习路径' };
  function setStage(s) {
    state.stage = s;
    viewStage(s);
    save();
  }
  // 阶段导航：只切视图，不改 state.stage（数据齐的阶段可随时回看）
  function viewStage(s) {
    $('stage-intake').hidden = s !== 'intake';
    $('stage-research').hidden = s !== 'research';
    $('stage-learning').hidden = s !== 'learning';
    var tabs = document.querySelectorAll('.stab');
    for (var i = 0; i < tabs.length; i++) {
      var k = tabs[i].dataset.stage;
      tabs[i].classList.toggle('on', k === s);
      tabs[i].disabled = (k === 'research' && !state.spec) || (k === 'learning' && !state.plan);
    }
  }
  function bindStageNav() {
    var tabs = document.querySelectorAll('.stab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        if (this.disabled) return;
        viewStage(this.dataset.stage);
      });
    }
  }
  function renderProgress() {
    var nodes = (state.plan && state.plan.nodes) || [];
    var done = nodes.filter(function (n) { return isDone(n.id); }).length;
    $('progress-text').textContent = '已完成 ' + done + '/' + nodes.length;
    $('progress-fill').style.width = nodes.length ? (done / nodes.length * 100) + '%' : '0%';
  }

  // ---------- 图状态 ----------
  function nodeById(id) {
    if (!state.plan) return null;
    for (var i = 0; i < state.plan.nodes.length; i++) if (state.plan.nodes[i].id === id) return state.plan.nodes[i];
    return null;
  }
  function depsOf(id) {
    var n = nodeById(id);
    return (n && n.deps) || [];
  }
  function isDone(id) { return !!(state.nodeState[id] && state.nodeState[id].completed); }
  function isUnlocked(id) {
    return depsOf(id).every(function (d) { return isDone(d); });
  }
  function depTitles(id) {
    return depsOf(id).map(function (d) { var n = nodeById(d); return n ? n.title : d; });
  }

  // ---------- 阶段 A：采集对话 ----------
  function appendBubble(role, text) {
    var log = $('chat-log');
    var d = document.createElement('div');
    d.className = 'bubble ' + (role === 'user' ? 'me' : 'ai');
    d.innerHTML = '<span class="who">' + (role === 'user' ? '你' : 'AI') + '</span>' + esc(text);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function renderChat() {
    var log = $('chat-log');
    log.innerHTML = '';
    if (state.topic) appendBubble('user', state.topic);
    state.history.forEach(function (m) { appendBubble(m.role, m.content); });
    if (!state.topic) {
      appendBubble('assistant', '你好，我是你的学习规划助手。先说说你想学什么？例如「三周入门 Rust」「系统学会 Blender 建模」。');
    }
  }
  function setChatDisabled(off) {
    $('chat-input').disabled = off;
    $('chat-send').disabled = off;
  }

  function sendMessage() {
    if (busy) return;
    var el = $('chat-input');
    var text = (el.value || '').trim();
    if (!text) return;
    el.value = '';
    hideError();
    if (!state.topic) {
      // 首次输入：作为学习主题
      state.topic = text;
      appendBubble('user', text);
      save();
    } else {
      state.history.push({ role: 'user', content: text });
      appendBubble('user', text);
      save();
    }
    callIntake();
  }

  function callIntake() {
    busy = true; setChatDisabled(true);
    var log = $('chat-log');
    var thinking = document.createElement('div');
    thinking.className = 'bubble ai';
    thinking.innerHTML = '<span class="who">AI</span><span class="spinner"></span>思考中…';
    log.appendChild(thinking); log.scrollTop = log.scrollHeight;

    post('/path/intake', { topic: state.topic, history: state.history })
      .then(function (r) {
        thinking.remove();
        busy = false; setChatDisabled(false);
        if (r.done && r.spec) {
          state.spec = r.spec; save();
          renderSpecCard();
          setStage('research');
          startResearch();
        } else {
          state.history.push({ role: 'assistant', content: r.question || '请再具体说说你的学习目标？' });
          appendBubble('assistant', r.question || '请再具体说说你的学习目标？');
          save();
        }
      })
      .catch(function (e) {
        thinking.remove();
        busy = false; setChatDisabled(false);
        showError('采集失败：' + e.message, callIntake);
      });
  }

  function renderSpecCard() {
    var sp = state.spec || {};
    var card = $('spec-card');
    function row(k, v) {
      return '<div><div class="k">' + esc(k) + '</div><div class="v">' + esc(v || '—') + '</div></div>';
    }
    card.innerHTML = '<h3>需求单（Spec）</h3><div class="spec-grid">' +
      row('主题', sp.topic) + row('目标', sp.goal) + row('现有基础', sp.level) +
      row('期望深度', sp.depth) + row('可投入时间', sp.budget) +
      row('偏好形式', (sp.preferences || []).join('、')) +
      row('约束', sp.constraints) + row('大纲线索', (sp.outline_hint || []).join('；')) +
      '</div>';
    card.hidden = false;
  }

  // ---------- 阶段 B：研究 ----------
  function startResearch() {
    $('research-card').hidden = true;
    $('research-status').hidden = false;
    $('research-status').innerHTML = '<span class="spinner"></span>正在生成检索式并查询资料…';
    hideError();
    post('/path/research', { spec: state.spec, key: storeKey() })
      .then(function (r) {
        state.queries = r.queries || [];
        state.sources = r.sources || [];
        state.brief = r.brief || '';
        save();
        renderResearch();
        $('research-status').innerHTML = '<span class="spinner"></span>研究完成，正在生成学习路径…';
        return post('/path/plan', { spec: state.spec, brief: state.brief, key: storeKey() });
      })
      .then(function (plan) {
        if (!plan || !plan.nodes || plan.nodes.length < 6) throw new Error('路径节点不足 6 个，请重试');
        normalizePlan(plan);
        state.plan = plan;
        save();
        $('research-status').hidden = true;
        setStage('learning');
        renderPlan();
      })
      .catch(function (e) {
        $('research-status').innerHTML = '研究/规划失败：' + esc(e.message);
        showError('研究与规划失败：' + e.message, function () {
          $('research-status').hidden = false;
          startResearch();
        });
      });
  }

  // 补齐 edges、确保 id 连续、deps 只引用更小序号
  function normalizePlan(plan) {
    plan.nodes.forEach(function (n, i) { if (!n.id) n.id = 'n' + (i + 1); });
    var order = {};
    plan.nodes.forEach(function (n, i) { order[n.id] = i; });
    plan.nodes.forEach(function (n) {
      n.deps = (n.deps || []).filter(function (d) { return order[d] != null && order[d] < order[n.id]; });
      n.objectives = n.objectives || [];
    });
    var edges = [];
    plan.nodes.forEach(function (n) {
      n.deps.forEach(function (d) { edges.push([d, n.id]); });
    });
    plan.edges = edges;
    plan.title = plan.title || '学习路径';
    plan.summary = plan.summary || '';
  }

  function renderResearch() {
    var chips = state.queries.map(function (q) { return '<span class="chip">' + esc(q) + '</span>'; }).join('');
    $('query-chips').innerHTML = chips || '<span class="empty-note">无检索式</span>';
    var srcs = state.sources.map(function (s, i) {
      return '<div class="src"><span class="no">[' + (i + 1) + ']</span><div>' +
        '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a>' +
        ' <span class="dom">' + esc(domain(s.url)) + '</span>' +
        (s.snippet ? '<span class="snip">' + esc(s.snippet) + '</span>' : '') +
        '</div></div>';
    }).join('');
    $('source-list').innerHTML = srcs || '<p class="empty-note">没有检索到来源（仍会基于模型知识生成路径）。</p>';
    $('brief-text').textContent = state.brief || '（无简报）';
    renderMathIn($('brief-text'));
    $('research-card').hidden = false;
  }

  // ---------- 阶段 C：路径图 ----------
  function renderPlan() {
    var plan = state.plan;
    $('plan-title').textContent = plan.title || '学习路径';
    $('plan-summary').textContent = plan.summary || '';
    // 分层：level = 前置最大层级 + 1
    var level = {};
    plan.nodes.forEach(function (n) {
      var mx = -1;
      n.deps.forEach(function (d) { if (level[d] != null && level[d] > mx) mx = level[d]; });
      level[n.id] = mx + 1;
    });
    var maxLv = 0;
    plan.nodes.forEach(function (n) { if (level[n.id] > maxLv) maxLv = level[n.id]; });
    var layerEl = $('graph-layer');
    layerEl.innerHTML = '';
    for (var lv = 0; lv <= maxLv; lv++) {
      var div = document.createElement('div');
      div.className = 'layer';
      plan.nodes.forEach(function (n, i) {
        if (level[n.id] !== lv) return;
        div.appendChild(nodeCard(n, i + 1));
      });
      layerEl.appendChild(div);
    }
    renderProgress();
    requestAnimationFrame(drawEdges);
  }

  function nodeCard(n, no) {
    var done = isDone(n.id);
    var unlocked = isUnlocked(n.id);
    var st = state.nodeState[n.id] || {};
    var cls, label;
    if (done) { cls = 'done'; label = '✅ 已完成'; }
    else if (!unlocked) { cls = 'locked'; label = '🔒 锁定'; }
    else if (typeof st.score === 'number' && st.score < 60) { cls = 'failed'; label = '❌ 自测未过'; }
    else { cls = 'unlocked'; label = '可学习'; }
    var el = document.createElement('article');
    el.className = 'node ' + cls;
    el.id = 'node-' + n.id;
    el.dataset.id = n.id;
    el.innerHTML = '<div class="node-head">' +
      '<span class="node-no">' + esc(n.id) + '</span>' +
      '<h3 class="node-title">' + esc(n.title) + '</h3>' +
      '<span class="status ' + cls + '">' + label + '</span></div>' +
      '<p class="node-ess">' + esc(n.essence || '') + '</p>';
    el.addEventListener('click', function () { selectNode(n.id); });
    return el;
  }

  function drawEdges() {
    var wrap = $('graph-wrap'), svg = $('graph-svg');
    if (!state.plan || !wrap || !svg) return;
    var wr = wrap.getBoundingClientRect();
    svg.setAttribute('width', wrap.clientWidth);
    svg.setAttribute('height', wrap.clientHeight);
    var parts = [];
    (state.plan.edges || []).forEach(function (e) {
      var a = document.getElementById('node-' + e[0]);
      var b = document.getElementById('node-' + e[1]);
      if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var x1 = ra.left - wr.left + ra.width / 2, y1 = ra.bottom - wr.top;
      var x2 = rb.left - wr.left + rb.width / 2, y2 = rb.top - wr.top;
      var my = (y1 + y2) / 2;
      var d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2;
      var ok = isDone(e[0]);
      parts.push('<path d="' + d + '" fill="none" stroke="' + (ok ? '#2f7d5d' : '#c9ced8') +
        '" stroke-width="2"' + (ok ? '' : ' stroke-dasharray="5 4"') + '/>');
    });
    svg.innerHTML = parts.join('');
  }

  // ---------- 右面板：节点详情 ----------
  function panelHead(id, title, ess, sub) {
    $('panel-id').textContent = sub || id;
    $('panel-title').textContent = title;
    $('panel-ess').textContent = ess || '';
  }
  function setFoot(html) {
    var f = $('panel-foot');
    if (html) { f.innerHTML = html; f.hidden = false; } else { f.innerHTML = ''; f.hidden = true; }
  }

  function selectNode(id) {
    selectedId = id;
    var n = nodeById(id);
    if (!n) return;
    hideError();
    // 门控：锁定节点不发 /path/node
    if (!isUnlocked(id) && !isDone(id)) {
      panelHead(id, n.title, n.essence, 'NODE ' + id + ' · 锁定');
      var pre = depTitles(id);
      $('panel-body').innerHTML = '<div class="panel-sec"><h4>先完成以下前置节点</h4><ul>' +
        pre.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' +
        '<p class="tip">完成全部前置节点后，本节点会自动解锁。</p>';
      setFoot('');
      return;
    }
    if (state.nodeDetail[id]) { renderNodeDetail(id); return; }
    panelHead(id, n.title, n.essence, 'NODE ' + id);
    $('panel-body').innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
    setFoot('');
    post('/path/node', {
      spec: state.spec,
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      dep_titles: depTitles(id),
      key: storeKey()
    }).then(function (detail) {
      state.nodeDetail[id] = detail; save();
      if (selectedId === id) renderNodeDetail(id);
    }).catch(function (e) {
      if (selectedId !== id) return;
      $('panel-body').innerHTML = '<p class="tip">生成失败：' + esc(e.message) + '</p>';
      setFoot('<button class="btn primary" id="reload-node" type="button">重试生成</button>');
      $('reload-node').addEventListener('click', function () {
        delete state.nodeDetail[id]; save(); selectNode(id);
      });
      showError('学习材料生成失败：' + e.message, function () {
        delete state.nodeDetail[id]; save(); selectNode(id);
      });
    });
  }

  // 简单 markdown：## 小标题 + 空行分段 + ``` 围栏代码块 + 行内 `code`；$...$ 交给 KaTeX
  function renderNotes(s) {
    var lines = String(s || '').split('\n');
    var out = [], fence = null;
    lines.forEach(function (ln) {
      var m = ln.match(/^\s*```([a-zA-Z0-9+#-]*)\s*$/);
      if (fence === null && m) { fence = { lang: m[1] || '', lines: [] }; return; }
      if (fence !== null) {
        if (m) {
          out.push('<pre class="md-code"><code' + (fence.lang ? ' class="language-' + fence.lang + '"' : '') + '>' + esc(fence.lines.join('\n')) + '</code></pre>');
          fence = null;
        } else fence.lines.push(ln);
        return;
      }
      var t = ln.trim();
      if (/^#{2,3}\s+/.test(t)) out.push('<h5>' + esc(t.replace(/^#{2,3}\s+/, '')) + '</h5>');
      else if (/^\s*[-*]\s+/.test(ln)) out.push('<div style="padding-left:14px">· ' + mdText(t.replace(/^\s*[-*]\s+/, '')) + '</div>');
      else if (t === '') out.push('<div style="height:8px"></div>');
      else out.push('<div>' + mdText(ln) + '</div>');
    });
    if (fence !== null) out.push('<pre class="md-code"><code' + (fence.lang ? ' class="language-' + fence.lang + '"' : '') + '>' + esc(fence.lines.join('\n')) + '</code></pre>');
    return out.join('');
  }
  function listSection(title, arr) {
    if (!arr || !arr.length) return '';
    return '<div class="panel-sec"><h4>' + esc(title) + '</h4><ul class="mdlist">' +
      arr.map(function (x) { return '<li>' + mdRender(x) + '</li>'; }).join('') + '</ul></div>';
  }

  // ---------- 自测题渲染（选择题点选 / 填空·简答文本作答） ----------
  var choiceAns = {};   // { 题号: 字母 } —— 选择题当前选择
  function quizQHtml(q, i, radioPrefix, areaPrefix, cur) {
    var head = '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' + mdRender(q.q) + '</p>';
    if (q.options && q.options.length) {
      var opts = q.options.map(function (o, j) {
        var letter = String.fromCharCode(65 + j);
        var checked = choiceAns[i] === letter ? ' checked' : '';
        return '<label class="qopt"><input type="radio" name="' + radioPrefix + i + '" value="' + letter + '"' + checked + '>' +
          '<span>' + letter + '. ' + mdRender(o) + '</span></label>';
      }).join('');
      return head + '<div class="qopts">' + opts + '</div></div>';
    }
    return head + '<textarea id="' + areaPrefix + i + '" placeholder="' + (q.type === 'short' ? '写下你的思路和答案…' : '写下你的答案…') + '">' + (cur != null ? esc(cur) : '') + '</textarea></div>';
  }
  function choiceChange(e) {
    var t = e.target;
    if (!t || t.type !== 'radio') return;
    var m = (t.name || '').match(/^(opt|qmo)-(\d+)$/);
    if (m) choiceAns[+m[2]] = t.value;
  }
  function syncChoiceRadios() {
    var ins = document.querySelectorAll('#panel-body input[type=radio]');
    for (var i = 0; i < ins.length; i++) {
      var m = (ins[i].name || '').match(/^opt-(\d+)$/);
      if (m && choiceAns[+m[1]] != null) ins[i].checked = (ins[i].value === choiceAns[+m[1]]);
    }
  }

  function renderNodeDetail(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    panelHead(id, n.title, n.essence, 'NODE ' + id + (isDone(id) ? ' · 已完成' : ''));
    var qs = ((d.quiz && d.quiz.questions) || []);
    choiceAns = {};
    var quizHtml = qs.map(function (q, i) {
      return quizQHtml(q, i, 'opt-', 'ans-', null);
    }).join('');
    var prev = state.nodeState[id] || {};
    var prevResult = '';
    var prevOk = prev.completed || !!(prev.lastResult && prev.lastResult.pass);
    if (typeof prev.score === 'number') {
      prevResult = '<div class="result ' + (prevOk ? 'ok' : 'bad') + '">' +
        '<span class="score ' + (prevOk ? 'ok' : 'bad') + '">' + prev.score + '</span> 分' +
        (prev.completed ? ' · 已通过' : (prevOk ? ' · 已通过（待完成）' : ' · 上次未通过')) + '</div>';
    }
    $('panel-body').innerHTML =
      '<div class="panel-sec"><h4>学习正文</h4><div class="notes">' + renderNotes(d.study_notes) + '</div></div>' +
      listSection('要点', d.key_points) +
      listSection('例子', d.examples) +
      listSection('易错点', d.misconceptions) +
      (qs.length ? '<div class="panel-sec"><h4>自测（' + qs.length + ' 题）</h4>' + quizHtml + '</div>' : '') +
      prevResult;
    renderMathIn($('panel-body'));
    highlightIn($('panel-body'));
    qs.forEach(function (q, i) { bindAutoGrow($('ans-' + i)); });

    var foot = '';
    if (qs.length && !isDone(id)) foot += '<button class="btn primary" id="submit-quiz" type="button">提交自测</button>';
    if (qs.length && !isDone(id)) foot += '<button class="btn" id="zoom-quiz" type="button">⤢ 放大答题</button>';
    if (qs.length && !isDone(id) && typeof prev.score === 'number') foot += '<button class="btn" id="redo-quiz" type="button">换新题，再试一次</button>';
    if (isDone(id)) foot += '<span class="tip">✅ 已完成</span>';
    setFoot(foot);
    if ($('submit-quiz')) $('submit-quiz').addEventListener('click', function () { submitQuiz(id); });
    if ($('zoom-quiz')) $('zoom-quiz').addEventListener('click', function () { openQuizModal(id); });
    if ($('redo-quiz')) $('redo-quiz').addEventListener('click', function () { redoQuiz(id); });
  }

  // ---------- 放大答题（模态框） ----------
  var modalNodeId = null;
  function openQuizModal(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    modalNodeId = id;
    $('qm-title').textContent = 'NODE ' + id + ' · ' + n.title + ' — 自测答题';
    var qs = (d.quiz && d.quiz.questions) || [];
    var h = qs.map(function (q, i) {
      var cur = $('ans-' + i) ? $('ans-' + i).value : '';
      return quizQHtml(q, i, 'qmo-', 'qma-', cur);
    }).join('');
    $('qm-body').innerHTML = h;
    renderMathIn($('qm-body'));
    highlightIn($('qm-body'));
    qs.forEach(function (q, i) { bindAutoGrow($('qma-' + i)); });
    $('quiz-modal').hidden = false;
  }
  function closeQuizModal(saveBack) {
    if (saveBack && modalNodeId != null) {
      var qs = (((state.nodeDetail[modalNodeId] || {}).quiz) || {}).questions || [];
      qs.forEach(function (q, i) {
        var src = $('qma-' + i), dst = $('ans-' + i);
        if (src && dst) dst.value = src.value;
      });
      syncChoiceRadios();
    }
    $('quiz-modal').hidden = true;
    modalNodeId = null;
  }
  function submitQuizFromModal() {
    var id = modalNodeId;
    closeQuizModal(true);
    if (id != null) submitQuiz(id);
  }

  function submitQuiz(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    var qs = ((d.quiz && d.quiz.questions) || []);
    var answers = qs.map(function (q, i) {
      if (q.options && q.options.length) return choiceAns[i] || '';
      var el = $('ans-' + i);
      return el ? (el.value || '').trim() : '';
    });
    if (answers.every(function (a) { return !a; })) { alert('请至少回答一题再提交。'); return; }
    var btn = $('submit-quiz');
    btn.disabled = true; btn.textContent = '判分中…';
    hideError();
    post('/path/quiz', {
      node: { title: n.title, essence: n.essence, objectives: n.objectives || [] },
      questions: qs.map(function (q) {
        var o = { q: q.q, answer: q.answer };
        if (q.type) o.type = q.type;
        if (q.options && q.options.length) o.options = q.options;
        return o;
      }),
      answers: answers
    }).then(function (res) {
      var st = state.nodeState[id] || {};
      st.score = res.score;
      st.lastResult = { score: res.score, pass: res.pass, feedback: res.feedback || '',
                        per_question: res.per_question || [] };
      // pass=true 不自动完成，等用户点「完成本节点并解锁下一节点」
      state.nodeState[id] = st;
      save();
      showQuizResult(id, res);
      renderPlan();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '提交自测';
      showError('判分失败：' + e.message, function () { submitQuiz(id); });
    });
  }

  function showQuizResult(id, res) {
    var d = state.nodeDetail[id];
    var qs = ((d.quiz && d.quiz.questions) || []);
    var per = res.per_question || [];
    var detail = qs.map(function (q, i) {
      var p = per[i] || {};
      return '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' + mdRender(q.q) + '</p>' +
        '<div class="result ' + (p.ok ? 'ok' : 'bad') + '">' +
        '<strong>' + (p.ok ? '✓ 正确' : '✗ 有缺漏') + '</strong> ' + mdRender(p.comment || '') + '</div></div>';
    }).join('');
    var cls = res.pass ? 'ok' : 'bad';
    $('panel-body').innerHTML =
      '<div class="panel-sec"><h4>自测结果</h4>' +
      '<div class="result ' + cls + '"><span class="score ' + cls + '">' + esc(res.score) + '</span> 分 — ' +
      (res.pass ? '通过 ✅' : '未通过 ❌') + '</div>' +
      (res.feedback ? '<p style="font-size:13.5px;margin-top:10px;white-space:pre-wrap">' + mdRender(res.feedback) + '</p>' : '') +
      '<div style="height:10px"></div>' + detail + '</div>';
    renderMathIn($('panel-body'));
    highlightIn($('panel-body'));
    var foot = '';
    if (res.pass && !isDone(id)) {
      foot += '<button class="btn primary" id="complete-node" type="button">完成本节点并解锁下一节点</button>';
    } else if (res.pass && isDone(id)) {
      foot += '<span class="tip">✅ 已完成</span>';
    } else {
      foot += '<button class="btn primary" id="redo-quiz" type="button">换新题，再试一次</button>';
    }
    setFoot(foot);
    if ($('complete-node')) $('complete-node').addEventListener('click', function () { completeNode(id); });
    if ($('redo-quiz')) $('redo-quiz').addEventListener('click', function () { redoQuiz(id); });
  }

  // 换新题重测：调用 /path/requiz 生成全新变式题，替换当前题集后重新渲染
  function redoQuiz(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    var quiz = d.quiz || {};
    var used = ((quiz.used) || []).concat((quiz.questions || []).map(function (q) {
      return { q: q.q, answer: q.answer };
    }));
    var st = state.nodeState[id] || {};
    var btn = $('redo-quiz');
    if (btn) { btn.disabled = true; btn.textContent = '正在出新题…'; }
    hideError();
    post('/path/requiz', {
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      spec: state.spec,
      used: used.slice(-12),
      feedback: st.lastResult || null,
      key: storeKey()
    }).then(function (r) {
      var qs = (r && r.questions) || [];
      if (!qs.length) throw new Error('未获得新题');
      d.quiz = { questions: qs, used: used.slice(-30) };
      save();
      renderNodeDetail(id);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '换新题，再试一次'; }
      showError('换题失败：' + e.message, function () { redoQuiz(id); });
    });
  }

  function completeNode(id) {
    var st = state.nodeState[id] || {};
    st.completed = true;
    state.nodeState[id] = st;
    save();
    renderPlan();
    renderNodeDetail(id);
  }

  // ---------- 重新开始 ----------
  function restart() {
    if (!confirm('确定要清空当前学习路径并重新开始吗？')) return;
    clearSave();
    state = {
      stage: 'intake', topic: '', history: [], spec: null, queries: [], sources: [],
      brief: '', plan: null, nodeDetail: {}, nodeState: {}
    };
    selectedId = null; busy = false;
    hideError();
    $('chat-log').innerHTML = '';
    $('spec-card').hidden = true;
    $('research-card').hidden = true;
    $('panel-body').innerHTML = '<p class="tip">路径图生成后，点击一个「可学习」的节点开始。锁定节点需要先完成它的前置节点。</p>';
    panelHead('NODE DETAIL', '节点详情', '点击左侧任意节点，查看学习材料与自测。');
    setFoot('');
    setStage('intake');
    renderChat();
    renderProgress();
    setChatDisabled(false);
  }

  // ---------- 学习资料库（服务端数据动态扫描） ----------
  function fetchMaterials() {
    return fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var entries = (j && j.entries) || {}, out = [];
      Object.keys(entries).forEach(function (k) {
        if (k.indexOf(STORE_PREFIX) !== 0 || k === LAST_KEY) return;
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        var d = null;
        try { d = JSON.parse(v); } catch (e) { d = null; }
        var it = { slug: k.slice(STORE_PREFIX.length), topic: '', stage: '', total: 0, done: 0 };
        if (d && typeof d === 'object') {
          if (!d.topic && !d.plan && (!d.history || !d.history.length)) return;   // 跳过历史空壳
          it.topic = d.topic || (d.plan && d.plan.title) || (d.spec && d.spec.topic) || it.slug;
          it.stage = d.stage || '';
          if (d.plan && d.plan.nodes) it.total = d.plan.nodes.length;
          var ns = d.nodeState || {};
          for (var id in ns) { if (ns[id] && ns[id].completed) it.done++; }
        } else { it.topic = it.slug; }
        out.push(it);
      });
      out.sort(function (a, b) {
        var pa = a.stage === 'learning' ? 0 : 1, pb = b.stage === 'learning' ? 0 : 1;
        return pa - pb || b.done - a.done;
      });
      return out;
    }).catch(function () { return []; });
  }
  function libRender() {
    var pop = $('lib-pop');
    if (!pop) return;
    pop.innerHTML = '<p class="lib-h"><span>学习资料库</span><i>服务端数据</i></p><p class="lib-sub">加载中…</p>';
    fetchMaterials().then(function (items) {
      var cnt = $('lib-count');
      if (cnt) cnt.textContent = ' (' + items.length + ')';
      var h = '<p class="lib-h"><span>学习资料库</span><i>服务端动态扫描</i></p>';
      h += '<p class="lib-sub">学习路径</p>';
      if (!items.length) {
        h += '<p class="lib-empty">暂无生成的学习路径——去生成一个吧。</p>';
      } else {
        for (var i = 0; i < items.length; i++) {
          var it = items[i], meta = STAGE_LABEL[it.stage] || it.stage || '';
          if (it.stage === 'learning') meta = it.total ? (it.done + '/' + it.total + ' 节点完成') : '路径已生成';
          h += '<div class="lib-row">' +
               '<a class="lib-item" href="learning-path.html?t=' + encodeURIComponent(it.slug) + '">' +
               '<span class="t">' + esc(it.topic) + '</span><span class="m">' + esc(meta) + '</span></a>' +
               '<button class="lib-del" type="button" data-slug="' + esc(it.slug) + '" data-topic="' + esc(it.topic) + '" title="删除这份资料">🗑</button>' +
               '</div>';
        }
      }
      h += '<div class="lib-foot">' +
           '<a href="learning-path.html?new=1">＋ 生成新的学习路径</a>' +
           '</div>';
      pop.innerHTML = h;
    });
  }
  function libBind() {
    var btn = $('lib-btn'), pop = $('lib-pop'), wrap = $('lib-wrap');
    if (!btn || !pop) return;
    fetchMaterials().then(function (items) {
      var cnt = $('lib-count');
      if (cnt) cnt.textContent = ' (' + items.length + ')';
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) { libRender(); pop.hidden = false; } else { pop.hidden = true; }
    });
    pop.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.lib-del') : null;
      if (b) { e.stopPropagation(); openDelModal(b.getAttribute('data-slug'), b.getAttribute('data-topic')); }
    });
    document.addEventListener('click', function (e) {
      var dm = $('del-modal');
      if (!pop.hidden && wrap && !wrap.contains(e.target) && !(dm && !dm.hidden && dm.contains(e.target))) pop.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') pop.hidden = true; });
  }

  // ---------- 删除资料（需密码；校验在服务端） ----------
  var delSlug = null;
  function openDelModal(s, topic) {
    delSlug = s;
    $('dm-topic').textContent = topic || s;
    var err = $('dm-err'); if (err) err.hidden = true;
    var inp = $('dm-pass'); if (inp) inp.value = '';
    $('del-modal').hidden = false;
    if (inp) inp.focus();
  }
  function closeDelModal() {
    $('del-modal').hidden = true;
    delSlug = null;
  }
  function submitDel() {
    if (!delSlug) return;
    var target = delSlug;
    var pass = ($('dm-pass') || {}).value || '';
    fetch(API + '/state/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [STORE_PREFIX + target], password: pass })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) {
        var wasCurrent = slug(state.topic || '') === target;
        closeDelModal();
        if (wasCurrent) { location.href = location.pathname + '?new=1'; return; }
        libRender();
        var pop = $('lib-pop'); if (pop) pop.hidden = false;
      } else {
        var err = $('dm-err');
        if (err) { err.textContent = (j && j.error) || '删除失败'; err.hidden = false; }
      }
    }).catch(function () {
      var err = $('dm-err');
      if (err) { err.textContent = '网络错误，请重试'; err.hidden = false; }
    });
  }

  // ---------- 初始化 ----------
  // 页面不做任何本地保存；每次打开都从服务端远程加载
  function init() { boot(); }
  function boot() {
    $('chat-send').addEventListener('click', sendMessage);
    $('chat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMessage(); });
    $('restart-btn').addEventListener('click', restart);
    bindStageNav();
    $('errretry').addEventListener('click', function () { var f = retryFn; hideError(); if (f) f(); });
    window.addEventListener('resize', function () { if (state.plan) drawEdges(); });
    $('backend-label').textContent = API;
    $('qm-x').addEventListener('click', function () { closeQuizModal(true); });
    $('qm-cancel').addEventListener('click', function () { closeQuizModal(true); });
    $('qm-submit').addEventListener('click', submitQuizFromModal);
    $('panel-body').addEventListener('change', choiceChange);
    $('qm-body').addEventListener('change', choiceChange);
    $('quiz-modal').addEventListener('click', function (e) { if (e.target === this) closeQuizModal(true); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('quiz-modal').hidden) closeQuizModal(true);
    });
    $('dm-cancel').addEventListener('click', closeDelModal);
    $('dm-ok').addEventListener('click', submitDel);
    $('dm-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitDel(); });
    $('del-modal').addEventListener('click', function (e) { if (e.target === this) closeDelModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('del-modal').hidden) closeDelModal();
    });
    libBind();

    purgeLocalLegacy();   // 清理历史遗留的浏览器本地数据（页面已不再本地保存任何东西）
    // ?new=1：强制新开（不恢复历史；已有资料仍保留在「学习资料库」里）
    var fresh = false;
    try { fresh = !!new URLSearchParams(location.search).get('new'); } catch (e) {}
    (fresh ? Promise.resolve(false) : serverLoad()).then(function (restored) {
      if (restored) {
        renderChat();
        if (state.spec) renderSpecCard();
        if (state.stage === 'learning' && state.plan) {
          setStage('learning');
          renderPlan();
        } else if (state.stage === 'research') {
          setStage('research');
          renderResearch();
          $('research-status').innerHTML = '上次研究已完成或中断，<button class="btn" id="resume-research" type="button">继续生成路径</button>';
          var rb = $('resume-research');
          if (rb) rb.addEventListener('click', function () { startResearch(); });
        } else {
          setStage('intake');
        }
      } else {
        setStage('intake');
        renderChat();
      }
      renderProgress();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
