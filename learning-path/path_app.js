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
    nodeState: {},                    // {id: {completed, score, mark}}
    aiHist: {},                       // {id: [{role, content}]} —— 每单元独立的 AI 辅助对话
    pending: null                     // {kind:'research'|'plan'|'node', nid?, at} —— 生成防中断
  };
  var selectedId = null;
  var busy = false;
  var retryFn = null;
  var expandedId = null;              // 手风琴：当前展开的卡片（同时只展开一张）
  var activeScope = null;             // 当前展开卡片的 .node-content（测验交互的作用域根）
  var generatingNode = null;          // 正在生成材料的节点 id（防重复请求）
  var reviewFilter = false;           // 只看「需复习」（纯显示层）
  var resumeAttempts = 0;             // 自动恢复重试计数
  var MARK_LABELS = [['none', '未学'], ['learning', '学习中'], ['mastered', '已掌握'], ['review', '需复习']];

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
  function aiKey() { return 'learn-ai-v1-' + slug(state.topic); }
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
        nodeDetail: state.nodeDetail, nodeState: state.nodeState,
        pending: state.pending || null
      };
      pendingEntries = {};
      pendingEntries[storeKey()] = JSON.stringify(payload);
      pendingEntries[LAST_KEY] = slug(state.topic);
      if (!saveTimer) saveTimer = setTimeout(flushSave, 350);
    } catch (e) { console.warn('save failed', e); }
  }
  function clearSave() {
    delState([storeKey(), LAST_KEY, aiKey()]);
  }
  // AI 辅助对话单独一个 key（learn-ai-v1-<slug>），与材料 save() 互不干扰
  function saveAi() {
    try {
      if (!state.topic) return;
      var o = {};
      o[aiKey()] = JSON.stringify(state.aiHist || {});
      putState(o);
    } catch (e) { console.warn('saveAi failed', e); }
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
      state.pending = (d.pending && typeof d.pending === 'object') ? d.pending : null;
      state.aiHist = {};
      var aiRaw = entries['learn-ai-v1-' + s];
      if (typeof aiRaw === 'string') {
        var aiD = null; try { aiD = JSON.parse(aiRaw); } catch (e4) { aiD = null; }
        if (aiD && typeof aiD === 'object') state.aiHist = aiD;
      }
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
    var qb = $('quizmap-btn');
    if (qb) qb.hidden = !(s === 'learning' && state.plan);
    var rf = $('review-filter-btn');
    if (rf) rf.hidden = !(s === 'learning' && state.plan);
    if (rf) updateReviewFilterBtn();
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
    updateReviewFilterBtn();
  }

  // ---------- 图状态 ----------
  // 显示层编号：学习单元 n1 → L1（内部 id / 数据键 / DOM id 一律不动）
  function dispId(id) { return String(id).replace(/^n(\d+)$/, 'L$1'); }
  // 老题目没有 points 时的均分值：100/n 向下取整，余数从最后一题向前每题 +1（与服务端 _fix_points 一致）
  function evenPts(n) {
    var out = [], base = Math.floor(100 / n), rem = 100 % n;
    for (var i = 0; i < n; i++) out.push(base);
    for (var j = 0; j < rem; j++) out[n - 1 - j] += 1;
    return out;
  }
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
    return depsOf(id).map(function (d) { var n = nodeById(d); return n ? n.title : dispId(d); });
  }

  // ---------- 单元状态标记（mark：与完成/解锁门控相互独立） ----------
  function markNormalize(m) {
    for (var i = 0; i < MARK_LABELS.length; i++) if (MARK_LABELS[i][0] === m) return m;
    return 'none';
  }
  function markOf(id) {
    return markNormalize((state.nodeState[id] || {}).mark);
  }
  function countReview() {
    var nodes = (state.plan && state.plan.nodes) || [];
    var n = 0;
    nodes.forEach(function (x) { if (markOf(x.id) === 'review') n++; });
    return n;
  }
  function updateReviewFilterBtn() {
    var b = $('review-filter-btn');
    if (!b) return;
    b.textContent = '只看需复习 (' + countReview() + ')';
    b.classList.toggle('on', reviewFilter);
  }
  function markButtonsHtml(id, cls) {
    var cur = markOf(id);
    return MARK_LABELS.map(function (kv) {
      return '<button class="mark-btn ' + cls + (cur === kv[0] ? ' on' : '') + '" type="button" ' +
        'data-mark="' + kv[0] + '" title="' + kv[1] + '">' + kv[1] + '</button>';
    }).join('');
  }
  function setMark(id, mark) {
    var st = state.nodeState[id] || {};
    st.mark = mark;
    state.nodeState[id] = st;
    save();
    // 就地刷新该卡片的四态按钮（不重建 DOM，避免丢掉卡内问答输入）
    var card = $('node-' + id);
    if (card) {
      var btns = card.querySelectorAll('.mark-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-mark') === mark);
      }
    }
    updateReviewFilterBtn();
    // 过滤激活时，取消「需复习」标记的卡片应从列表消失
    if (reviewFilter && mark !== 'review') {
      if (expandedId === id) { expandedId = null; activeScope = null; }
      renderPlan();
    }
  }
  // 把一组标记按钮的点击事件绑到容器（stopPropagation 避免触发卡片其它点击）
  function bindMarkButtons(container, id) {
    var btns = container.querySelectorAll('.mark-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.stopPropagation();
        setMark(id, this.getAttribute('data-mark'));
      });
    }
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
      appendBubble('assistant', '你好，我是你的学习助手。先说说你想学什么？例如「Go 语言入门」「Blender 建模」。');
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
      row('期望深度', sp.depth) +
      row('偏好形式', (sp.preferences || []).join('、')) +
      row('约束', sp.constraints) + row('大纲线索', (sp.outline_hint || []).join('；')) +
      '</div>';
    card.hidden = false;
  }

  // ---------- 生成防中断（pending 标记 + 自动恢复） ----------
  function setPending(kind, nid) {
    state.pending = { kind: kind, at: Date.now() };
    if (nid) state.pending.nid = nid;
    save();
  }
  function clearPending() {
    state.pending = null;
    resumeAttempts = 0;
    hideResumeBar();
    save();
  }
  // 纯函数：pending 是否仍在 24h 有效窗口内
  function pendingAlive(p, now) {
    return !!(p && p.kind && p.at && ((now || Date.now()) - p.at) < 24 * 3600 * 1000);
  }
  // 纯函数：pending 对应的结果是否已经有（有则只清标记）
  function pendingHasResult(p, st) {
    if (!p) return false;
    if (p.kind === 'research') return !!(st.queries && st.queries.length && st.brief) ||
      !!(st.plan && st.plan.nodes && st.plan.nodes.length);
    if (p.kind === 'plan') return !!(st.plan && st.plan.nodes && st.plan.nodes.length);
    if (p.kind === 'node') return !!(p.nid && st.nodeDetail && st.nodeDetail[p.nid]);
    return false;
  }
  function isBusyError(e) {
    return /仍在进行中|仍在生成中|稍后重试/.test(String((e && e.message) || ''));
  }
  function showResumeBar(msg) {
    var b = $('resume-bar');
    if (!b) return;
    b.innerHTML = '<span class="spinner"></span>' + esc(msg || '上次的生成已在服务端继续，正在取回结果…');
    b.hidden = false;
  }
  function hideResumeBar() { var b = $('resume-bar'); if (b) b.hidden = true; }
  // 生成失败且服务端仍在跑：60 秒后自动重试（最多 3 次）。返回 true 表示已接管处理。
  function handlePendingFailure(e) {
    if (state.pending && isBusyError(e) && resumeAttempts < 3) {
      resumeAttempts++;
      showResumeBar('服务端仍在生成，' + 60 + ' 秒后自动重试（第 ' + resumeAttempts + '/3 次）…');
      setTimeout(replayPending, 60000);
      return true;
    }
    if (state.pending) hideResumeBar();   // 失败但保留 pending，下次刷新再试
    return false;
  }
  function replayPending() {
    var p = state.pending;
    if (!p) { hideResumeBar(); return; }
    if (p.kind === 'research') startResearch();
    else if (p.kind === 'plan') continuePlan();
    else if (p.kind === 'node' && p.nid) selectNode(p.nid);
    else { hideResumeBar(); }
  }
  // serverLoad 完成后调用：结果已存在→仅清 pending；否则重放对应阶段
  function resumeIfPending() {
    var p = state.pending;
    if (!p || !p.kind) return false;
    if (!pendingAlive(p, Date.now())) { state.pending = null; save(); return false; }
    if (pendingHasResult(p, state)) {
      var wasNode = (p.kind === 'node' && p.nid && state.nodeDetail[p.nid]);
      state.pending = null; resumeAttempts = 0; save();
      if (wasNode) selectNode(p.nid);   // 结果已取回：自动展开对应卡片
      return false;
    }
    showResumeBar();
    replayPending();
    return true;
  }

  // ---------- 阶段 B：研究 ----------
  function startResearch() {
    setPending('research');
    $('research-card').hidden = true;
    $('research-status').hidden = false;
    $('research-status').innerHTML = '<span class="spinner"></span>正在生成检索式并查询资料…';
    hideError();
    return post('/path/research', { spec: state.spec, key: storeKey() })
      .then(function (r) {
        state.queries = r.queries || [];
        state.sources = r.sources || [];
        state.brief = r.brief || '';
        save();
        renderResearch();
        return continuePlan();
      })
      .catch(function (e) {
        $('research-status').innerHTML = '研究失败：' + esc(e.message);
        if (handlePendingFailure(e)) { $('research-status').hidden = true; return; }
        showError('研究失败：' + e.message, function () {
          $('research-status').hidden = false;
          startResearch();
        });
      });
  }

  // 只跑「生成路径」一段（research 成功后或自动恢复 plan 时复用）
  function continuePlan() {
    setPending('plan');
    $('research-status').hidden = false;
    $('research-status').innerHTML = '<span class="spinner"></span>研究完成，正在生成学习路径…';
    return post('/path/plan', { spec: state.spec, brief: state.brief, key: storeKey() })
      .then(function (plan) {
        if (!plan || !plan.nodes || plan.nodes.length < 6) throw new Error('路径节点不足 6 个，请重试');
        normalizePlan(plan);
        state.plan = plan;
        state.pending = null; resumeAttempts = 0; hideResumeBar();
        save();
        $('research-status').hidden = true;
        setStage('learning');
        renderPlan();
      })
      .catch(function (e) {
        $('research-status').innerHTML = '生成路径失败：' + esc(e.message);
        if (handlePendingFailure(e)) { $('research-status').hidden = true; return; }
        showError('生成学习路径失败：' + e.message, function () {
          $('research-status').hidden = false;
          continuePlan();
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
    var visible = plan.nodes.filter(function (n) { return !reviewFilter || markOf(n.id) === 'review'; });
    if (!visible.length) {
      layerEl.innerHTML = '<p class="empty-note">没有标记为「需复习」的单元</p>';
      expandedId = null; activeScope = null;
      renderProgress();
      var svg0 = $('graph-svg'); if (svg0) svg0.innerHTML = '';
      return;
    }
    for (var lv = 0; lv <= maxLv; lv++) {
      var div = document.createElement('div');
      div.className = 'layer';
      visible.forEach(function (n) {
        if (level[n.id] !== lv) return;
        div.appendChild(nodeCard(n, plan.nodes.indexOf(n) + 1));
      });
      if (div.childNodes.length) layerEl.appendChild(div);
    }
    renderProgress();
    applyCardStates();
    // 重建后恢复手风琴展开的卡片（含卡内内容重渲染）
    if (expandedId) {
      if ($('node-' + expandedId)) renderCardContent(expandedId);
      else { expandedId = null; activeScope = null; }
    }
    requestAnimationFrame(drawEdges);
  }

  // 卡片结构：卡头（编号+标题+状态+四态+AI） → 卡体（选项卡+内容）
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
      '<span class="node-caret">▸</span>' +
      '<span class="node-no">' + esc(dispId(n.id)) + '</span>' +
      '<h3 class="node-title">' + esc(n.title) + '</h3>' +
      '<span class="status ' + cls + '">' + label + '</span>' +
      '<button class="btn ai-mini" type="button" data-ai="' + esc(n.id) + '">AI 辅助</button></div>' +
      '<p class="node-ess">' + esc(n.essence || '') + '</p>' +
      '<div class="node-foot"><div class="marks">' + markButtonsHtml(n.id, 'mini') + '</div></div>' +
      '<div class="node-content" hidden></div>';
    el.addEventListener('click', function () { onCardClick(n.id); });
    bindMarkButtons(el, n.id);
    var aiBtn = el.querySelector('.ai-mini');
    if (aiBtn) aiBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openAiView(n.id);
    });
    // 卡内交互（单选框/输入框/按钮）不应冒泡触发卡片折叠
    var content = el.querySelector('.node-content');
    content.addEventListener('click', function (e) { e.stopPropagation(); });
    return el;
  }

  // 卡片选中/展开态同步（不动 DOM 内容）
  function applyCardStates() {
    if (!state.plan) return;
    state.plan.nodes.forEach(function (n) {
      var el = $('node-' + n.id);
      if (!el) return;
      el.classList.toggle('selected', n.id === selectedId);
      el.classList.toggle('expanded', n.id === expandedId);
      var c = el.querySelector('.node-caret');
      if (c) c.textContent = (n.id === expandedId) ? '▾' : '▸';
      var content = el.querySelector('.node-content');
      if (content) content.hidden = (n.id !== expandedId);
    });
  }

  // 选中单元（仅更新右侧 Agent 上下文与高亮，不展开）
  function selectUnit(id) {
    selectedId = id;
    applyCardStates();
    renderAgentPanel();
  }
  // 展开卡片（手风琴：不切换）
  function expandCard(id) {
    var n = nodeById(id);
    if (!n) return;
    if (!isUnlocked(id) && !isDone(id)) return;   // 锁定卡不可展开
    expandedId = id;
    applyCardStates();
    renderCardContent(id);
    requestAnimationFrame(drawEdges);
  }
  function collapseCard() {
    expandedId = null;
    activeScope = null;
    applyCardStates();
    requestAnimationFrame(drawEdges);
  }
  // 点卡片：选中 + 手风琴切展/收（锁定卡不展开）
  function onCardClick(id) {
    selectUnit(id);
    if (expandedId === id) { collapseCard(); return; }
    var n = nodeById(id);
    if (!n) return;
    if (!isUnlocked(id) && !isDone(id)) return;
    expandCard(id);
  }
  // 明确聚焦某单元的卡（恢复重放/显式打开用，不 toggle）
  function selectNode(id) {
    selectUnit(id);
    expandCard(id);
  }
  function openAiView(id) {
    selectUnit(id);
    expandCard(id);
  }

  // 卡内内容：未生成→卡内 loading 并请求 /path/node；已生成→渲染选项卡正文
  function cardContentEl(id) {
    var card = $('node-' + id);
    return card ? card.querySelector('.node-content') : null;
  }
  function renderCardContent(id) {
    var scope = cardContentEl(id);
    if (!scope) return;
    activeScope = scope;
    if (state.nodeDetail[id]) { renderNodeDetail(id); return; }
    if (generatingNode === id) {   // 已在生成：重建后仍显示卡内 loading，不重复请求
      scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
      return;
    }
    if (!isUnlocked(id) && !isDone(id)) return;
    var n = nodeById(id);
    scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
    requestAnimationFrame(drawEdges);
    generatingNode = id;
    setPending('node', id);
    post('/path/node', {
      spec: state.spec,
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      dep_titles: depTitles(id),
      key: storeKey()
    }).then(function (detail) {
      generatingNode = null;
      state.nodeDetail[id] = detail;
      state.pending = null; resumeAttempts = 0; hideResumeBar();
      save();
      if (expandedId === id) renderNodeDetail(id);
    }).catch(function (e) {
      generatingNode = null;
      if (expandedId !== id) return;
      if (handlePendingFailure(e)) {
        scope.innerHTML = '<p class="tip">服务端仍在生成本节点材料，稍后自动重试…</p>';
        return;
      }
      scope.innerHTML = '<p class="tip">生成失败：' + esc(e.message) + '</p>' +
        '<button class="btn primary reload-node" type="button">重试生成</button>';
      var rb = scope.querySelector('.reload-node');
      if (rb) rb.addEventListener('click', function (e2) {
        e2.stopPropagation();
        delete state.nodeDetail[id]; save(); renderCardContent(id);
      });
      showError('学习材料生成失败：' + e.message, function () {
        delete state.nodeDetail[id]; save(); renderCardContent(id);
      });
    });
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

  // ---------- 右侧面板：纯 Agent 区（只做 AI 对话；正文/测验在卡片里） ----------
  function renderAgentPanel() {
    if (!selectedId || !nodeById(selectedId)) {
      panelHead('AGENT', 'AI 学习助手', '点击左侧卡片展开学习，或点卡片上的「AI 辅助」与 AI 交互式学习。');
      $('panel-body').innerHTML = '<p class="tip">选一个单元，AI 会带你交互式学习：讲解、追问、出小题检验你，不直接给答案。</p>';
      setFoot('');
      return;
    }
    var n = nodeById(selectedId);
    panelHead('AGENT', dispId(selectedId) + ' · ' + n.title, n.essence || '');
    renderAiPanel(selectedId);
  }
  var aiBusy = false;
  var AI_SUGGEST = ['讲讲本单元的重点', '出个小题目考我', '我哪里最容易出错？'];
  function aiClip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  // 纯函数：取最近 n 条用于请求（不含本次问）
  function aiHistTail(arr, n) {
    if (!arr || !arr.length) return [];
    return arr.slice(-n).map(function (m) { return { role: m.role, content: m.content }; });
  }
  // 纯函数：只保留最近 max 条
  function aiHistTrim(arr, max) {
    while (arr.length > max) arr.shift();
    return arr;
  }
  function aiUnit(id) {
    var n = nodeById(id) || {};
    var d = state.nodeDetail[id] || {};
    var kp = (d.key_points && d.key_points.length) ? d.key_points : (n.objectives || []);
    var traps = (d.traps && d.traps.length) ? d.traps : (d.misconceptions || []);
    var quizzes = ((d.quiz && d.quiz.questions) || []).slice(0, 6).map(function (q) {
      return { q: q.q, a: q.answer, answer: q.answer };
    });
    return {
      unit_id: dispId(id), unit_title: n.title || '', domain: state.topic || '',
      essence: n.essence || '', musts: kp, traps: traps, quizzes: quizzes,
      notes: d.study_notes ? String(d.study_notes).slice(0, 6000) : ''
    };
  }  // (aiUnit end)
  function aiScroll() { var el = $('ai-msgs'); if (el) el.scrollTop = el.scrollHeight; }
  function aiRenderInto(el, text) {
    if (!el) return;
    el.innerHTML = mdRender(text);
    renderMathIn(el);
    highlightIn(el);
  }
  function aiBubble(role, content) {
    var d = document.createElement('div');
    d.className = 'ai-msg ' + (role === 'user' ? 'user' : 'assistant');
    var b = document.createElement('div');
    b.className = 'ai-bubble';
    if (role === 'user') b.textContent = content;
    else b.innerHTML = mdRender(content);
    d.appendChild(b);
    return d;
  }

  function renderAiPanel(id) {
    var n = nodeById(id);
    if (!n) return;
    $('panel-body').innerHTML =
      '<p class="ai-intro">AI 辅助 · 交互式学习 —— 会讲解、追问、出小题检验你；不会直接给答案。</p>' +
      '<div class="ai-msgs" id="ai-msgs"></div>' +
      '<div class="ai-compose"><textarea id="ai-input" placeholder="就本单元提问，Enter 发送 / Shift+Enter 换行"></textarea>' +
      '<button class="btn primary" id="ai-send" type="button">发送</button></div>' +
      '<p class="ai-note">AI 知道本单元内容，会引导你思考、不会直接给答案。</p>';
    setFoot('');
    var msgs = state.aiHist[id] || [];
    var box = $('ai-msgs');
    if (!msgs.length) {
      box.innerHTML = '<div class="ai-empty"><p>还没有对话。可以问我：</p>' +
        AI_SUGGEST.map(function (s) { return '<button class="ai-chip" type="button">' + esc(s) + '</button>'; }).join('') + '</div>';
      var chips = box.querySelectorAll('.ai-chip');
      for (var i = 0; i < chips.length; i++) {
        (function (txt, btn) {
          btn.addEventListener('click', function () { sendAi(id, txt); });
        })(AI_SUGGEST[i], chips[i]);
      }
    } else {
      msgs.forEach(function (m) { box.appendChild(aiBubble(m.role, m.content)); });
    }
    var input = $('ai-input');
    bindAutoGrow(input);
    var send = $('ai-send');
    function doSend() { sendAi(id, (input.value || '').trim()); }
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    if (aiBusy) { send.disabled = true; input.disabled = true; }
    aiScroll();
  }

  function sendAi(id, text) {
    if (aiBusy) return;
    var q = String(text == null ? '' : text).trim();
    if (!q) return;
    var msgs = state.aiHist[id] || (state.aiHist[id] = []);
    var hist = aiHistTail(msgs, 16);
    msgs.push({ role: 'user', content: aiClip(q, 4000) });
    aiHistTrim(msgs, 60);
    state.aiHist[id] = msgs;
    saveAi();
    var input = $('ai-input');
    if (input) { input.value = ''; input.style.height = ''; }
    var box = $('ai-msgs');
    if (box) { var em = box.querySelector('.ai-empty'); if (em) em.remove(); box.appendChild(aiBubble('user', q)); }
    aiScroll();
    aiBusy = true;
    var send = $('ai-send'); if (send) send.disabled = true;
    var target = aiBubble('assistant', '');
    var body = target.querySelector('.ai-bubble');
    body.innerHTML = '<span class="spinner"></span>思考中…';
    if (box) box.appendChild(target);
    aiScroll();
    var acc = '';
    fetch(API + '/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit: aiUnit(id), question: q, history: hist })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body || !res.body.getReader) throw new Error('浏览器不支持流式响应');
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim(); if (!payload) continue;
            var obj; try { obj = JSON.parse(payload); } catch (e2) { continue; }
            if (obj.error) acc += '\n[出错] ' + obj.error;
            if (obj.delta) { acc += obj.delta; aiRenderInto(body, acc); aiScroll(); }
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      if (!acc) acc = '（没有返回内容，请重试。）';
      aiFinish(id, body, acc);
    }).catch(function (e) {
      if (!acc) acc = '请求失败：' + ((e && e.message) || e);
      aiFinish(id, body, acc);
    });
  }
  function aiFinish(id, body, acc) {
    aiRenderInto(body, acc);
    var msgs = state.aiHist[id] || (state.aiHist[id] = []);
    msgs.push({ role: 'assistant', content: aiClip(acc, 4000) });
    aiHistTrim(msgs, 60);
    state.aiHist[id] = msgs;
    saveAi();
    aiBusy = false;
    var send = $('ai-send'); if (send) send.disabled = false;
    var input = $('ai-input'); if (input) input.disabled = false;
    aiScroll();
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
  var matTab = 'material';     // 单元内选项卡：material | quiz（仅前端内存）
  var matTabOwner = null;      // 当前选项卡归属的节点
  var lastQuizShown = null;    // {id, res} 最近一次提交结果（展示在「测验」tab 内）
  function answerLine(q) {
    if (q.options && q.options.length) {
      return '<b>正确答案：</b>' + esc(String(q.answer == null ? '' : q.answer).toUpperCase().trim());
    }
    return '<b>参考答案：</b>' + mdRender(q.answer || '（暂无）');
  }
  function quizQHtml(q, i, radioPrefix, areaPrefix, cur, ptsArr, withAns) {
    var pts = (q.points != null) ? q.points : (ptsArr ? ptsArr[i] : null);
    var head = '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' +
      (pts != null ? '<span class="q-points">（' + pts + ' 分）</span> ' : '') + mdRender(q.q) + '</p>';
    var ansHtml = withAns ? '<div class="q-answer" hidden>' + answerLine(q) + '</div>' : '';
    if (q.options && q.options.length) {
      var opts = q.options.map(function (o, j) {
        var letter = String.fromCharCode(65 + j);
        var checked = choiceAns[i] === letter ? ' checked' : '';
        return '<label class="qopt"><input type="radio" name="' + radioPrefix + i + '" value="' + letter + '"' + checked + '>' +
          '<span>' + letter + '. ' + mdRender(o) + '</span></label>';
      }).join('');
      return head + '<div class="qopts">' + opts + '</div>' + ansHtml + '</div>';
    }
    return head + '<textarea id="' + areaPrefix + i + '" placeholder="' + (q.type === 'short' ? '写下你的思路和答案…' : '写下你的答案…') + '">' + (cur != null ? esc(cur) : '') + '</textarea>' + ansHtml + '</div>';
  }
  // 查看答案 / 收起答案（作用域内所有 .q-answer）
  function toggleAnswers(scope, btn) {
    var on = btn.getAttribute('data-on') === '1';
    on = !on;
    btn.setAttribute('data-on', on ? '1' : '0');
    btn.textContent = on ? '收起答案' : '查看答案';
    var els = scope.querySelectorAll('.q-answer');
    for (var i = 0; i < els.length; i++) els[i].hidden = !on;
    renderMathIn(scope);
    highlightIn(scope);
  }
  function choiceChange(e) {
    var t = e.target;
    if (!t || t.type !== 'radio') return;
    var m = (t.name || '').match(/^(opt|qmo)-(\d+)$/);
    if (m) choiceAns[+m[2]] = t.value;
  }
  function syncChoiceRadios(scope) {
    if (!scope) return;
    var ins = scope.querySelectorAll('input[type=radio]');
    for (var i = 0; i < ins.length; i++) {
      var m = (ins[i].name || '').match(/^opt-(\d+)$/);
      if (m && choiceAns[+m[1]] != null) ins[i].checked = (ins[i].value === choiceAns[+m[1]]);
    }
  }

  // 卡内渲染：所有查询都从卡片内容元素向下查（作用域隔离，避免串卡）
  function renderNodeDetail(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    var scope = cardContentEl(id);
    if (!n || !d || !scope) return;
    activeScope = scope;
    if (matTabOwner !== id) { matTab = 'material'; lastQuizShown = null; matTabOwner = id; }
    var shown = (lastQuizShown && lastQuizShown.id === id) ? lastQuizShown.res : null;
    if (shown) matTab = 'quiz';
    var qs = ((d.quiz && d.quiz.questions) || []);
    choiceAns = {};
    var ptsArr = evenPts(qs.length);
    var quizHtml = qs.map(function (q, i) {
      return quizQHtml(q, i, 'opt-', 'ans-', null, ptsArr, true);
    }).join('');
    var prev = state.nodeState[id] || {};
    var prevResult = '';
    var prevOk = prev.completed || !!(prev.lastResult && prev.lastResult.pass);
    if (typeof prev.score === 'number') {
      prevResult = '<div class="result ' + (prevOk ? 'ok' : 'bad') + '">' +
        '<span class="score ' + (prevOk ? 'ok' : 'bad') + '">' + prev.score + '</span> 分' +
        (prev.completed ? ' · 已通过' : (prevOk ? ' · 已通过（待完成）' : ' · 上次未通过')) + '</div>';
    }
    var actions = '';
    if (shown) {
      if (shown.pass && !isDone(id)) actions += '<button class="btn primary" id="complete-node" type="button">完成本节点并解锁下一节点</button>';
      else if (shown.pass && isDone(id)) actions += '<span class="tip">✅ 已完成</span>';
      else actions += '<button class="btn primary" id="redo-quiz" type="button">换新题，再试一次</button>';
    } else {
      if (qs.length && !isDone(id)) {
        actions += '<button class="btn primary" id="submit-quiz" type="button">提交自测</button>';
        actions += '<button class="btn" id="zoom-quiz" type="button">⤢ 放大答题</button>';
      }
      if (qs.length && !isDone(id) && typeof prev.score === 'number') actions += '<button class="btn" id="redo-quiz" type="button">换新题，再试一次</button>';
      if (isDone(id)) actions += '<span class="tip">✅ 已完成</span>';
    }
    var matPane =
      '<div class="panel-sec"><h4>学习正文</h4><div class="notes">' + renderNotes(d.study_notes) + '</div></div>' +
      listSection('要点', d.key_points) +
      listSection('例子', d.examples) +
      listSection('易错点', d.misconceptions);
    var quizPane;
    if (qs.length) {
      quizPane = '<div class="panel-sec"><div class="quiz-head">' +
        '<span class="quiz-title">自测（' + qs.length + ' 题 · 满分 100 分）</span>' +
        '<button class="btn quiet quiz-answers" type="button" data-on="0">查看答案</button></div>' +
        '<div class="quiz-body" id="quiz-body">' + quizHtml + '</div>' +
        prevResult +
        (shown ? resultDetailHtml(id, shown) : '') +
        '<div class="quiz-actions" id="quiz-actions">' + actions + '</div></div>';
    } else {
      quizPane = '<p class="tip">本单元暂无自测题。</p>';
    }
    scope.innerHTML =
      '<div class="mat-tabs-head">' +
        '<button class="mat-tab' + (matTab === 'material' ? ' on' : '') + '" type="button" data-mat="material">学习资料</button>' +
        '<button class="mat-tab' + (matTab === 'quiz' ? ' on' : '') + '" type="button" data-mat="quiz">测验</button>' +
      '</div>' +
      '<div class="mat-pane mat-pane-material"' + (matTab === 'material' ? '' : ' hidden') + '>' + matPane + '</div>' +
      '<div class="mat-pane mat-pane-quiz"' + (matTab === 'quiz' ? '' : ' hidden') + '>' + quizPane + '</div>';
    renderMathIn(scope);
    highlightIn(scope);
    qs.forEach(function (q, i) { bindAutoGrow(scope.querySelector('#ans-' + i)); });

    // 选项卡切换：只切 display、不重渲染 → 不丢已勾选选项 / 已输入文本
    var mtabs = scope.querySelectorAll('.mat-tab');
    for (var ti = 0; ti < mtabs.length; ti++) {
      mtabs[ti].addEventListener('click', function () {
        matTab = this.getAttribute('data-mat');
        for (var k = 0; k < mtabs.length; k++) mtabs[k].classList.toggle('on', mtabs[k] === this);
        var mp = scope.querySelector('.mat-pane-material'), qp = scope.querySelector('.mat-pane-quiz');
        if (mp) mp.hidden = matTab !== 'material';
        if (qp) qp.hidden = matTab !== 'quiz';
      });
    }
    var ansBtn = scope.querySelector('.quiz-answers');
    if (ansBtn) ansBtn.addEventListener('click', function () {
      toggleAnswers(scope, this);
    });
    setFoot('');
    var bSubmit = scope.querySelector('#submit-quiz');
    if (bSubmit) bSubmit.addEventListener('click', function () { submitQuiz(id); });
    var bZoom = scope.querySelector('#zoom-quiz');
    if (bZoom) bZoom.addEventListener('click', function () { openQuizModal(id); });
    var bRedo = scope.querySelector('#redo-quiz');
    if (bRedo) bRedo.addEventListener('click', function () { redoQuiz(id); });
    var bComp = scope.querySelector('#complete-node');
    if (bComp) bComp.addEventListener('click', function () { completeNode(id); });
    requestAnimationFrame(drawEdges);
  }

  // 提交后的逐题结果（渲染在「测验」tab 内；答案块由标题行「查看答案」统一控制）
  function resultDetailHtml(id, res) {
    var d = state.nodeDetail[id];
    var qs = ((d.quiz && d.quiz.questions) || []);
    var per = res.per_question || [];
    var pts = evenPts(qs.length);
    var detail = qs.map(function (q, i) {
      var p = per[i] || {};
      var pv = (q.points != null) ? q.points : pts[i];
      return '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' +
        (pv != null ? '<span class="q-points">（' + pv + ' 分）</span> ' : '') + mdRender(q.q) + '</p>' +
        '<div class="result ' + (p.ok ? 'ok' : 'bad') + '">' +
        '<strong>' + (p.ok ? '✓ 正确' : '✗ 有缺漏') + '</strong> ' + mdRender(p.comment || '') + '</div>' +
        '<div class="q-answer" hidden>' + answerLine(q) + '</div></div>';
    }).join('');
    var cls = res.pass ? 'ok' : 'bad';
    return '<div class="panel-sec"><h4>自测结果</h4>' +
      '<div class="result ' + cls + '"><span class="score ' + cls + '">' + esc(res.score) + '</span> 分 — ' +
      (res.pass ? '通过 ✅' : '未通过 ❌') + '</div>' +
      (res.feedback ? '<p style="font-size:13.5px;margin-top:10px;white-space:pre-wrap">' + mdRender(res.feedback) + '</p>' : '') +
      '<div style="height:10px"></div>' + detail + '</div>';
  }

  // ---------- 放大答题（模态框） ----------
  var modalNodeId = null;
  function openQuizModal(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    modalNodeId = id;
    $('qm-title').textContent = 'NODE ' + dispId(id) + ' · ' + n.title + ' — 自测答题';
    var qs = (d.quiz && d.quiz.questions) || [];
    var ptsArr = evenPts(qs.length);
    var scope = cardContentEl(id);
    var h = qs.map(function (q, i) {
      var el = scope ? scope.querySelector('#ans-' + i) : null;
      var cur = el ? (el.value || '') : '';
      return quizQHtml(q, i, 'qmo-', 'qma-', cur, ptsArr);
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
      var scope = cardContentEl(modalNodeId);
      qs.forEach(function (q, i) {
        var src = $('qma-' + i), dst = scope ? scope.querySelector('#ans-' + i) : null;
        if (src && dst) dst.value = src.value;
      });
      syncChoiceRadios(scope);
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
    var scope = cardContentEl(id);
    var qs = ((d.quiz && d.quiz.questions) || []);
    var answers = qs.map(function (q, i) {
      if (q.options && q.options.length) return choiceAns[i] || '';
      var el = scope ? scope.querySelector('#ans-' + i) : null;
      return el ? (el.value || '').trim() : '';
    });
    if (answers.every(function (a) { return !a; })) { alert('请至少回答一题再提交。'); return; }
    var btn = scope ? scope.querySelector('#submit-quiz') : null;
    if (btn) { btn.disabled = true; btn.textContent = '判分中…'; }
    hideError();
    post('/path/quiz', {
      node: { title: n.title, essence: n.essence, objectives: n.objectives || [] },
      questions: qs.map(function (q) {
        var o = { q: q.q, answer: q.answer };
        if (q.type) o.type = q.type;
        if (q.options && q.options.length) o.options = q.options;
        if (q.points) o.points = q.points;
        return o;
      }),
      answers: answers
    }).then(function (res) {
      var st = state.nodeState[id] || {};
      st.score = res.score;
      st.lastResult = { score: res.score, pass: res.pass, feedback: res.feedback || '',
                        per_question: res.per_question || [] };
      st.lastAnswers = answers.map(function (a) { return String(a == null ? '' : a).slice(0, 600); }).slice(0, 16);
      // pass=true 不自动完成，等用户点「完成本节点并解锁下一节点」
      state.nodeState[id] = st;
      save();
      showQuizResult(id, res);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '提交自测'; }
      showError('判分失败：' + e.message, function () { submitQuiz(id); });
    });
  }

  // 提交后：结果渲染在卡内「测验」tab 并自动切过去（重建卡片后恢复展开）
  function showQuizResult(id, res) {
    lastQuizShown = { id: id, res: res };
    matTab = 'quiz';
    renderPlan();
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
    var scope = cardContentEl(id);
    var btn = scope ? scope.querySelector('#redo-quiz') : null;
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
      lastQuizShown = null;
      matTab = 'quiz';
      save();
      renderPlan();
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
    renderPlan();   // 重建后会自动恢复展开并重渲染卡内内容（状态→已完成）
  }

  // ---------- 生成测验地图（按学习地图 + 学习情况） ----------
  function genQuizMap() {
    if (!(state.stage === 'learning' && state.plan)) return;
    if (!confirm('确认根据这张学习地图和你的学习情况生成一套测验？\n（按知识点出题 8~16 道，合计 100 分；生成后打开「测验地图」作答）')) return;
    var btn = $('quizmap-btn');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…（约 1-2 分钟）'; }
    hideError();
    post('/path/quizmap', { key: storeKey() }).then(function (r) {
      location.href = 'quiz-map.html?t=' + encodeURIComponent(r.slug);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '生成测验'; }
      showError('生成测验失败：' + e.message, genQuizMap);
    });
  }

  // ---------- 重新开始 ----------
  function restart() {
    if (!confirm('确定要清空当前学习路径并重新开始吗？')) return;
    clearSave();
    state = {
      stage: 'intake', topic: '', history: [], spec: null, queries: [], sources: [],
      brief: '', plan: null, nodeDetail: {}, nodeState: {}, aiHist: {}, pending: null
    };
    selectedId = null; busy = false;
    expandedId = null; activeScope = null; generatingNode = null;
    reviewFilter = false; aiBusy = false; resumeAttempts = 0;
    matTab = 'material'; matTabOwner = null; lastQuizShown = null;
    hideResumeBar();
    hideError();
    $('chat-log').innerHTML = '';
    $('spec-card').hidden = true;
    $('research-card').hidden = true;
    panelHead('AGENT', 'AI 学习助手', '点击左侧卡片展开学习，或点卡片上的「AI 辅助」与 AI 交互式学习。');
    $('panel-body').innerHTML = '<p class="tip">选一个单元，AI 会带你交互式学习：讲解、追问、出小题检验你，不直接给答案。</p>';
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
  var QUIZ_PREFIX = 'quiz-map-v1-';
  function fetchQuizMaps() {
    return fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var entries = (j && j.entries) || {}, out = [];
      Object.keys(entries).forEach(function (k) {
        if (k.indexOf(QUIZ_PREFIX) !== 0) return;
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        var d = null;
        try { d = JSON.parse(v); } catch (e) { d = null; }
        if (!d || typeof d !== 'object') return;
        var it = { slug: k.slice(QUIZ_PREFIX.length), title: d.title || k.slice(QUIZ_PREFIX.length),
                   count: (d.questions || []).length, last: null };
        var at = d.attempts || [];
        if (at.length && at[at.length - 1] && typeof at[at.length - 1].score === 'number') {
          it.last = at[at.length - 1].score;
        }
        out.push(it);
      });
      out.sort(function (a, b) { return (b.last || 0) - (a.last || 0); });
      return out;
    }).catch(function () { return []; });
  }
  function libRender() {
    var pop = $('lib-pop');
    if (!pop) return;
    pop.innerHTML = '<p class="lib-h"><span>学习资料库</span><i>服务端数据</i></p><p class="lib-sub">加载中…</p>';
    Promise.all([fetchMaterials(), fetchQuizMaps()]).then(function (res) {
      var items = res[0], quizzes = res[1];
      var cnt = $('lib-count');
      if (cnt) cnt.textContent = ' (' + (items.length + quizzes.length) + ')';
      var h = '<p class="lib-h"><span>学习资料库</span><i>服务端动态扫描</i></p>';
      h += '<p class="lib-sub">学习地图 · ' + items.length + '</p>';
      if (!items.length) {
        h += '<p class="lib-empty">暂无生成的学习地图——去生成一个吧。</p>';
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
      h += '<p class="lib-sub">测验地图 · ' + quizzes.length + '</p>';
      if (!quizzes.length) {
        h += '<p class="lib-empty">暂无测验地图——在学习地图里点「生成测验」。</p>';
      } else {
        for (var j = 0; j < quizzes.length; j++) {
          var q = quizzes[j];
          var qmeta = '共 ' + q.count + ' 题' + (q.last != null ? ' · 最近 ' + q.last + ' 分' : '');
          h += '<div class="lib-row">' +
               '<a class="lib-item" href="quiz-map.html?t=' + encodeURIComponent(q.slug) + '">' +
               '<span class="t">' + esc(q.title) + '</span><span class="m">' + esc(qmeta) + '</span></a>' +
               '<button class="lib-del" type="button" data-slug="' + esc(q.slug) + '" data-topic="' + esc(q.title) + '" data-key="' + esc(QUIZ_PREFIX + q.slug) + '" title="删除这份资料">🗑</button>' +
               '</div>';
        }
      }
      h += '<div class="lib-foot">' +
           '<a href="learning-path.html?new=1">＋ 生成新的学习地图</a>' +
           '</div>';
      pop.innerHTML = h;
    });
  }
  function libBind() {
    var btn = $('lib-btn'), pop = $('lib-pop'), wrap = $('lib-wrap');
    if (!btn || !pop) return;
    Promise.all([fetchMaterials(), fetchQuizMaps()]).then(function (res) {
      var cnt = $('lib-count');
      if (cnt) cnt.textContent = ' (' + (res[0].length + res[1].length) + ')';
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) { libRender(); pop.hidden = false; } else { pop.hidden = true; }
    });
    pop.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.lib-del') : null;
      if (b) { e.stopPropagation(); openDelModal(b.getAttribute('data-slug'), b.getAttribute('data-topic'), b.getAttribute('data-key') || null); }
    });
    document.addEventListener('click', function (e) {
      var dm = $('del-modal');
      if (!pop.hidden && wrap && !wrap.contains(e.target) && !(dm && !dm.hidden && dm.contains(e.target))) pop.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') pop.hidden = true; });
  }

  // ---------- 删除资料（需密码；校验在服务端） ----------
  var delSlug = null, delKey = null;
  function openDelModal(s, topic, fullKey) {
    delSlug = s;
    delKey = fullKey || null;
    $('dm-topic').textContent = topic || s;
    var err = $('dm-err'); if (err) err.hidden = true;
    var inp = $('dm-pass'); if (inp) inp.value = '';
    $('del-modal').hidden = false;
    if (inp) inp.focus();
  }
  function closeDelModal() {
    $('del-modal').hidden = true;
    delSlug = null;
    delKey = null;
  }
  function submitDel() {
    if (!delSlug) return;
    var target = delSlug;
    var key = delKey || (STORE_PREFIX + target);
    var pass = ($('dm-pass') || {}).value || '';
    fetch(API + '/state/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key], password: pass })
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
    document.addEventListener('change', choiceChange);   // 选择题点选（卡内/模态均适用）
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
    $('quizmap-btn').addEventListener('click', genQuizMap);
    var rfb = $('review-filter-btn');
    if (rfb) rfb.addEventListener('click', function () {
      reviewFilter = !reviewFilter;
      updateReviewFilterBtn();
      renderPlan();
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
      renderAgentPanel();
      if (restored) resumeIfPending();   // 上次生成中断→自动取回/重放（节点会自动展开卡片）
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
