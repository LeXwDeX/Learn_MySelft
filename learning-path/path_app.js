/* 学习路径 · 前端逻辑
 * 三阶段状态机：intake → research → learning
 * 后端契约：/path/intake /path/research /path/plan /path/node /path/quiz
 * 依赖：无（纯原生 JS，无 CDN）
 */
(function () {
  'use strict';

  var API = window.LearnUser.apiBase;
  var TIMEOUT = 25000;                // 短请求；长操作使用可恢复后台任务
  var USER_PATH = window.LearnUser.userId + '/';
  var STORE_PREFIX = 'learn-path-v1-';
  var LAST_KEY = USER_PATH + 'learn-path-v1-last'; // 指向最近一次会话的 slug（带用户前缀）

  var state = {
    stage: 'intake',                  // intake | research | learning
    topic: '',
    title: '',
    materials: [],
    history: [],                      // [{role:'assistant'|'user', content}]
    spec: null,
    queries: [],
    sources: [],
    research_version: 0,
    brief: '',
    plan: null,
    nodeDetail: {},                   // {id: NodeDetail}
    nodeState: {},                    // {id: {completed, score, mark}}
    aiHist: {},                       // {id: [{role, content}]} —— 每单元独立的 AI 辅助对话
    pending: null                     // {kind:'research'|'plan'|'node', nid?, at} —— 生成防中断
  };
  var materialsPanel = null;
  var quizCreation = false;
  var materialSlug = null;            // Stable document identity, independent of its title
  var selectedId = null;
  var busy = false;
  var retryFn = null;
  var expandedId = null;              // 手风琴：当前展开的卡片（同时只展开一张）
  var activeScope = null;             // 当前展开卡片的 .node-content（测验交互的作用域根）
  var generatingNode = null;          // 正在生成材料的节点 id（防重复请求）
  var nodeMaterialStatus = {};
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
  // 服务端状态键统一带固定用户前缀；做前缀匹配/列表扫描前先剥掉它再按原业务键逻辑处理
  function stripUser(k) {
    return (typeof k === 'string' && k.indexOf(USER_PATH) === 0) ? k.slice(USER_PATH.length) : k;
  }
  // 读状态：优先固定前缀键，兼容无前缀旧键（迁移未覆盖时的兜底）
  function entryVal(entries, bizKey) {
    if (typeof entries[USER_PATH + bizKey] === 'string') return entries[USER_PATH + bizKey];
    if (typeof entries[bizKey] === 'string') return entries[bizKey];
    return undefined;
  }
  // KaTeX：把 $...$ / $$...$$ 渲染成公式（失败不影响正文）
  function renderMathIn(el) {
    if (window.LearnMarkdown) window.LearnMarkdown.enhance(el);
    if (!el || typeof window.renderMathInElement !== 'function') return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        ignoredClasses: ['learn-markdown', 'katex', 'md-math-fallback'],
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
  function mdRender(text, options) {
    return window.LearnMarkdown ? window.LearnMarkdown.render(text, options) : mdText(String(text || ''));
  }

  function storeKey() { return USER_PATH + STORE_PREFIX + (materialSlug || slug(state.topic)); }
  function aiKey() { return USER_PATH + 'learn-ai-v1-' + (materialSlug || slug(state.topic)); }
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
  var stateWrites = [], blockedStateKeys = {};
  function putState(entries) {
    if (window.LearnUser.readOnly) return Promise.resolve();
    function send(keepalive) {
      var allowed = {};
      Object.keys(entries).forEach(function (key) {
        if (!blockedStateKeys[key]) allowed[key] = entries[key];
      });
      if (!Object.keys(allowed).length) return Promise.resolve();
      var body = JSON.stringify({ entries: allowed });
      return window.LearnUser.fetch(API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body, keepalive: !!keepalive && new Blob([body]).size <= 60000
      }).then(function (r) {
        if (!r.ok) throw new Error('保存失败（' + r.status + '）');
      });
    }
    var write = send(true).catch(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () { return send(false); });
    });
    stateWrites.push(write);
    write.finally(function () { stateWrites = stateWrites.filter(function (item) { return item !== write; }); }).catch(function () {});
    return write;
  }
  function deleteState(keys, password) {
    keys.forEach(function (key) {
      blockedStateKeys[key] = true;
      if (pendingEntries) delete pendingEntries[key];
    });
    if (pendingEntries && !Object.keys(pendingEntries).length) pendingEntries = null;
    // Drain earlier saves before the tombstone; subsequent callbacks cannot resurrect it.
    return Promise.all(stateWrites.slice()).then(function () {
      return window.LearnUser.fetch(API + '/state/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keys, password: password })
      });
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (!result.ok) throw new Error(result.error || '删除失败');
      return result;
    }).catch(function (error) {
      keys.forEach(function (key) { delete blockedStateKeys[key]; });
      if (keys.indexOf(storeKey()) >= 0) save();
      throw error;
    });
  }
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!pendingEntries) return Promise.resolve();
    var entries = pendingEntries; pendingEntries = null;
    return putState(entries);
  }
  function flushBeacon() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!pendingEntries) return;
    var payload = JSON.stringify({ entries: pendingEntries }); pendingEntries = null;
    try {
      window.LearnUser.fetch(API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: payload, keepalive: new Blob([payload]).size <= 60000
      }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushBeacon(); });

  function save() {
    if (window.LearnUser.readOnly) return;
    try {
      // 没有主题就不写：防止把空状态写进 learn-path-v1-untitled（历史 bug 的根源）
      if (!state.topic || blockedStateKeys[storeKey()]) return;
      var payload = {
        stage: state.stage, title: state.title, topic: state.topic, history: state.history, materials: state.materials,
        spec: state.spec, queries: state.queries, sources: state.sources,
        brief: state.brief, research_version: state.research_version, plan: state.plan,
        nodeDetail: state.nodeDetail, nodeState: state.nodeState,
        pending: state.pending || null
      };
      pendingEntries = {};
      pendingEntries[storeKey()] = JSON.stringify(payload);
      pendingEntries[LAST_KEY] = materialSlug || slug(state.topic);
      if (!saveTimer) saveTimer = setTimeout(function () { flushSave().catch(function () {}); }, 350);
    } catch (e) { console.warn('save failed', e); }
  }
  // AI 辅助对话单独一个 key（learn-ai-v1-<slug>），与材料 save() 互不干扰
  function saveAi() {
    try {
      if (!state.topic) return;
      var o = {};
      o[aiKey()] = JSON.stringify(state.aiHist || {});
      putState(o).catch(function () {});
    } catch (e) { console.warn('saveAi failed', e); }
  }
  function serverLoad() {
    return window.LearnUser.fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.entries) return false;
      var entries = j.entries;
      // 支持 ?t=<slug> 深链（从「学习资料库」直接打开某份资料）；无参则从零开始新生成
      var s = null;
      try { s = new URLSearchParams(location.search).get('t'); } catch (e2) { s = null; }
      if (s && typeof entryVal(entries, STORE_PREFIX + s) !== 'string') s = null;   // 指定的资料不存在则回退
      if (!s) return false;   // 无参数 = 全新开始；已有资料请从「学习资料库」进入
      var raw = entryVal(entries, STORE_PREFIX + s);
      if (typeof raw !== 'string') return false;
      var d; try { d = JSON.parse(raw); } catch (e3) { return false; }
      if (!d || typeof d !== 'object') return false;
      materialSlug = s;
      state.stage = d.stage || 'intake';
      state.title = window.LearnTitles.document(d);
      renderDocumentTitle();
      // 兼容修复：历史状态可能缺 topic 字段 → 依次从 plan/spec 恢复，而不是拒绝加载
      state.topic = d.topic || (d.plan && d.plan.title) || (d.spec && d.spec.topic) || '';
      if (!state.topic) return false;
      state.history = Array.isArray(d.history) ? d.history : [];
      state.materials = d.materials || [];
      state.spec = d.spec || null;
      state.queries = d.queries || [];
      state.sources = d.sources || [];
      state.research_version = d.research_version || 0;
      state.brief = d.brief || '';
      state.plan = d.plan || null;
      state.nodeDetail = d.nodeDetail || {};
      state.nodeState = d.nodeState || {};
      state.pending = (d.pending && typeof d.pending === 'object') ? d.pending : null;
      state.aiHist = {};
      var aiRaw = entryVal(entries, 'learn-ai-v1-' + s);
      if (typeof aiRaw === 'string') {
        var aiD = null; try { aiD = JSON.parse(aiRaw); } catch (e4) { aiD = null; }
        if (aiD && typeof aiD === 'object') state.aiHist = aiD;
      }
      // 状态自洽性：learning 必须有 plan
      if (state.stage === 'learning' && !state.plan) state.stage = 'research';
      if (state.stage === 'research' && !state.spec) state.stage = 'intake';
      // 历史键修复：先保存正确键；旧副本保留，用户可通过密码删除。
      var fixSlug = slug(state.topic);
      if (s === 'untitled' && fixSlug && fixSlug !== 'untitled') {
        materialSlug = fixSlug;
        save();
        s = fixSlug;
      }
      if (entryVal(entries, 'learn-path-v1-last') !== s) {
        var o = {}; o[LAST_KEY] = s; putState(o).catch(function () {});
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
  function post(path, body, jobOptions) {
    if (window.LearnJobs && window.LearnJobs.supports(path)) {
      if (!body.key) body.key = storeKey();
      var expectedKind = {'/path/intake': 'intake', '/path/research': 'research', '/path/plan': 'plan', '/path/node': 'node'}[path];
      var pending = state.pending, options = Object.assign({}, jobOptions || {});
      if (pending && pending.requestId && (pending.kind === expectedKind || (path === '/path/node' && pending.kind === 'nodes'))) {
        options.requestId = pending.requestId + (pending.kind === 'nodes' ? ':' + body.node.id : '');
      }
      return flushSave().then(function () { return Promise.all(stateWrites.slice()); }).then(function () {
        return window.LearnJobs.run(path, body, options);
      });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    return window.LearnUser.fetch(API + path, {
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
      throw new Error(e && e.name === 'AbortError' ? '请求超时，请重试' : '网络错误：' + (e && e.message || e));
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
    if (materialsPanel) materialsPanel.lock(s !== 'intake' || busy);
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
    var ga = $('gen-all-btn');
    if (ga) ga.hidden = !(s === 'learning' && state.plan);
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
    var node = nodeById(id);
    if (!node) return false;
    return depsOf(id).every(function (dependency) {
      if (isDone(dependency)) return true;
      var parent = nodeById(dependency);
      // Older refine-marked units point at the failed parent. Chained
      // remediation still requires the preceding remedial unit to pass.
      return !!(node.refine && parent && !parent.refine && depsOf(dependency).every(isDone));
    });
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
    var follow = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    var d = document.createElement('div');
    d.className = 'bubble ' + (role === 'user' ? 'me' : 'ai');
    d.innerHTML = '<span class="who">' + (role === 'user' ? '你' : 'AI') + '</span>' + esc(text);
    log.appendChild(d);
    if (role === 'user' || follow) log.scrollTop = log.scrollHeight;
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
    $('chat-send').disabled = off;
    $('chat-send').textContent = off ? '回复中…' : '发送';
    if (materialsPanel) materialsPanel.lock(off || state.stage !== 'intake');
  }

  function sendMessage() {
    if (busy || (materialsPanel && materialsPanel.busy())) return;
    var el = $('chat-input');
    var text = (el.value || '').trim();
    if (!text) return;
    el.value = '';
    el.focus({ preventScroll: true });
    hideError();
    if (!state.topic) {
      // 首次输入：作为学习主题
      state.topic = text;
      materialSlug = slug(text) + '-' + window.LearnJobs.requestId().slice(0, 8);
      var currentURL = new URL(location.href);
      currentURL.searchParams.delete('new');
      currentURL.searchParams.set('t', materialSlug);
      window.history.replaceState(null, '', currentURL.pathname + currentURL.search);
      appendBubble('user', text);
      save();
    } else {
      state.history.push({ role: 'user', content: text });
      appendBubble('user', text);
      save();
    }
    callIntake(true);
  }

  function callIntake(newMessage) {
    if (newMessage === true) state.pending = null;
    setPending('intake');
    busy = true; setChatDisabled(true);
    var log = $('chat-log');
    var thinking = document.createElement('div');
    thinking.className = 'bubble ai';
    thinking.innerHTML = '<span class="who">AI</span><span class="spinner"></span>思考中…';
    var follow = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    log.appendChild(thinking);
    if (follow) log.scrollTop = log.scrollHeight;

    post('/path/intake', { key: storeKey(), topic: state.topic, history: state.history })
      .then(function (r) {
        thinking.remove();
        state.title = window.LearnTitles.document(r);
        renderDocumentTitle();
        clearPending();
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
      return '<tr><th scope="row">' + esc(k) + '</th><td>' + esc(v || '—') + '</td></tr>';
    }
    card.innerHTML = '<h3 id="spec-heading">需求单（Spec）</h3><table class="spec-table" aria-labelledby="spec-heading"><tbody>' +
      row('主题', sp.topic) + row('目标', sp.goal) + row('现有基础', sp.level) +
      row('期望深度', sp.depth) +
      row('偏好形式', (sp.preferences || []).join('、')) +
      row('约束', sp.constraints) + row('大纲线索', (sp.outline_hint || []).join('；')) +
      '</tbody></table>';
    card.hidden = false;
  }

  // ---------- 生成防中断（pending 标记 + 自动恢复） ----------
  function setPending(kind, nid) {
    var previous = state.pending;
    var same = previous && previous.kind === kind && (previous.nid || null) === (nid || null);
    state.pending = {kind: kind, at: same ? previous.at : Date.now(),
      requestId: same && previous.requestId || window.LearnJobs.requestId()};
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
    if (p.kind === 'intake') callIntake();
    else if (p.kind === 'research') startResearch();
    else if (p.kind === 'plan') continuePlan();
    else if (p.kind === 'node' && p.nid) selectNode(p.nid);
    else { hideResumeBar(); }
  }
  // serverLoad 完成后调用：结果已存在→仅清 pending；否则重放对应阶段
  function resumeIfPending() {
    var p = state.pending;
    if (!p || !p.kind) return false;
    if (!pendingAlive(p, Date.now())) { state.pending = null; save(); return false; }
    if (p.kind === 'nodes') {   // 批量生成中断：剔除已完成的，继续生成剩余
      var rem = (p.remaining || []).filter(function (id) { return id && !state.nodeDetail[id]; });
      if (!rem.length) { state.pending = null; save(); hideResumeBar(); return false; }
      showResumeBar('上次批量生成未完成，继续生成剩余 ' + rem.length + ' 个节点…');
      genAllStart(rem);
      return true;
    }
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
        state.research_version = r.research_version || 0;
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
        if (quizCreation) genQuizMap();
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

    plan.summary = plan.summary || '';
  }

  function renderResearch() {
    var checked = state.research_version === 2;
    $('research-recheck').hidden = checked || window.LearnUser.readOnly;
    $('research-source-note').textContent = checked ? '仅展示通过主题相关性筛选的来源。' : '这些是旧版检索记录，尚未核验主题相关性。可重新核验，不会重建现有学习路径。';
    var chips = state.queries.map(function (q) { return '<span class="chip">' + esc(q) + '</span>'; }).join('');
    $('query-chips').innerHTML = chips || '<span class="empty-note">无检索式</span>';
    var srcs = state.sources.map(function (s, i) {
      return '<div class="src"><span class="no">[' + (i + 1) + ']</span><div>' +
        '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a>' +
        ' <span class="dom">' + esc(domain(s.url)) + '</span>' +
        (s.snippet ? '<span class="snip">' + esc(s.snippet) + '</span>' : '') +
        '</div></div>';
    }).join('');
    $('source-list').innerHTML = srcs || '<p class="empty-note">未找到通过相关性筛选的来源；后续内容基于已有资料和模型知识，未获网络来源验证。</p>';
    $('brief-text').textContent = state.brief || '（无简报）';
    renderMathIn($('brief-text'));
    $('research-card').hidden = false;
  }
  function recheckResearch() {
    var button = $('research-recheck');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '正在核验…';
    post('/path/research', { spec: state.spec, key: storeKey() }).then(function (r) {
      state.queries = r.queries || []; state.sources = r.sources || [];
      state.brief = r.brief || ''; state.research_version = r.research_version || 0;
      save(); renderResearch();
    }).catch(function (e) { showError('来源核验失败：' + e.message, recheckResearch); })
      .finally(function () { button.disabled = false; button.textContent = '重新核验来源'; });
  }

  // ---------- 阶段 C：路径图 ----------
  function renderDocumentTitle() {
    var title = window.LearnTitles.document(state);
    document.title = title;
    $('document-title').textContent = title;
    $('plan-title').textContent = title;
  }
  function renderPlan() {
    var plan = state.plan;
    renderDocumentTitle();
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
    showAgent();
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
    if (genAllRunning) {   // 批量进行中：忽略单节点生成并轻提示
      scope.innerHTML = '<p class="tip">批量生成进行中，请稍候…</p>';
      return;
    }
    if (generatingNode === id) {   // 已在生成：重建后仍显示卡内 loading，不重复请求
      scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
      return;
    }
    if (!isUnlocked(id) && !isDone(id)) {
      var missing = depsOf(id).filter(function (dependency) { return !isDone(dependency); });
      scope.innerHTML = '<p class="tip">本单元尚未解锁。请先通过前置单元测验，并点击“完成本节点并解锁下一节点”。“已掌握”等手动标记不会自动解锁。</p>' +
        missing.map(function (dependency) {
          var parent = nodeById(dependency);
          return '<button class="btn prerequisite" type="button" data-node="' + esc(dependency) + '">前往 ' + esc(dispId(dependency) + ' · ' + (parent ? parent.title : '前置单元')) + '</button>';
        }).join('');
      scope.querySelectorAll('.prerequisite').forEach(function (button) {
        button.onclick = function () { selectNode(button.dataset.node); };
      });
      return;
    }
    scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
    requestAnimationFrame(drawEdges);
    generatingNode = id;
    nodeMaterialStatus[id] = 'generating';
    syncAiMaterial(id);
    setPending('node', id);
    requestNodeDetail(id).then(function (detail) {
      generatingNode = null;
      state.nodeDetail[id] = detail;
      syncAiMaterial(id);
      state.pending = null; resumeAttempts = 0; hideResumeBar();
      save();
      if (expandedId === id) renderNodeDetail(id);
    }).catch(function (e) {
      generatingNode = null;
      nodeMaterialStatus[id] = 'failed';
      syncAiMaterial(id);
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
      $('plan-current-unit').textContent = '选择单元开始学习';
      panelHead('AGENT', 'AI 学习助手', '点击左侧卡片展开学习，或点卡片上的「AI 辅助」与 AI 交互式学习。');
      $('panel-body').innerHTML = '<p class="tip">选一个单元，AI 会带你交互式学习：讲解、追问、出小题检验你，不直接给答案。</p>';
      setFoot('');
      refreshAgentLayout();
      return;
    }
    var n = nodeById(selectedId);
    $('plan-current-unit').textContent = dispId(selectedId) + ' · ' + n.title;
    panelHead('正在辅导', dispId(selectedId) + ' · ' + n.title, n.essence || '');
    renderAiPanel(selectedId);
    refreshAgentLayout();
  }
  var aiViews = new Map();
  var aiViewKey = null;
  var activeAiView = null;
  var aiBusy = false;
  var refreshAgentLayout = function () {};

  function bindAgentLayout() {
    var dialog = $('agent-dialog'), panel = $('node-panel');
    var workspace = panel.parentElement;
    var oldOverflow = '', oldAnchor = '', readingX = 0, readingY = 0;
    var readingFrame = null;
    function updateLayout() {
      var mobile = window.matchMedia('(max-width:800px)').matches;
      if (!mobile && dialog.open) dialog.close();
      var toolbar = document.querySelector('.toolbar');
      var top = toolbar.offsetHeight + 16;
      document.documentElement.style.setProperty('--agent-top', top + 'px');
      if (!mobile && panel.parentElement === workspace) {
        var visibleTop = Math.max(top, panel.getBoundingClientRect().top);
        panel.style.setProperty('--agent-height', Math.max(240, window.innerHeight - visibleTop - 16) + 'px');
      }
    }
    refreshAgentLayout = updateLayout;
    $('agent-launch').addEventListener('click', showAgent);
    $('agent-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () {
      workspace.appendChild(panel);
      if (activeAiView) {
        activeAiView.box.scrollTop = activeAiView.scrollTop;
        if (activeAiView.follow) aiScroll(activeAiView, true);
      }
      document.body.style.overflow = oldOverflow;
      updateLayout();
      window.scrollTo(readingX, readingY);
      // Reparenting the panel changes layout. Keep browser scroll anchoring off
      // until that layout has settled so it cannot undo the restored position.
      readingFrame = requestAnimationFrame(function () {
        if (dialog.open) { readingFrame = null; return; }
        window.scrollTo(readingX, readingY);
        // The first callback still runs before layout. Restore anchoring only
        // after a frame has painted the panel in its original container.
        readingFrame = requestAnimationFrame(function () {
          readingFrame = null;
          if (dialog.open) return;
          window.scrollTo(readingX, readingY);
          document.documentElement.style.overflowAnchor = oldAnchor;
        });
      });
    });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
    dialog.openAgent = function () {
      if (dialog.open) return;
      if (readingFrame !== null) {
        cancelAnimationFrame(readingFrame);
        readingFrame = null;
        document.documentElement.style.overflowAnchor = oldAnchor;
      }
      readingX = window.scrollX;
      readingY = window.scrollY;
      oldAnchor = document.documentElement.style.overflowAnchor;
      document.documentElement.style.overflowAnchor = 'none';
      oldOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.appendChild(panel);
      dialog.showModal();
      if (activeAiView) {
        activeAiView.box.scrollTop = activeAiView.scrollTop;
        if (activeAiView.follow) aiScroll(activeAiView, true);
      }
    };
    window.addEventListener('resize', updateLayout);
    var layoutFrame = null;
    window.addEventListener('scroll', function () {
      if (layoutFrame !== null) return;
      layoutFrame = requestAnimationFrame(function () { layoutFrame = null; updateLayout(); });
    }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(updateLayout).observe(document.querySelector('.toolbar'));
    updateLayout();
  }
  function showAgent() {
    if (window.matchMedia('(max-width:800px)').matches) $('agent-dialog').openAgent();
    else if ($('ai-input')) $('ai-input').focus({ preventScroll: true });
  }
  var AI_SUGGEST = ['讲讲本单元的重点', '出个小题目考我', '本单元有哪些常见误区？'];
  var AI_PREVIEW_SUGGEST = ['学习这个单元前需要哪些基础？', '帮我理解这个单元的学习目标', '等待材料时，我可以怎样预习？'];

  // ---------- Part H：一键生成全部节点（含未解锁节点） ----------
  var genAllRunning = false;      // 批量生成进行中
  var genAllPaused = false;       // 用户请求暂停（当前节点完成后停）
  var genAllQueue = [];           // 本轮待处理队列（失败会移出队列、留在 remaining）
  var genAllRemaining = [];       // 尚未成功生成的节点 id（含失败）
  var genAllTotal = 0;            // 本轮起始缺失总数
  var genAllIdx = 0;              // 已开始处理的序号
  var genAllTimer = null;         // 按钮短暂文案计时器

  // 缺失节点：state.plan.nodes 中 nodeDetail 为空的（含未解锁）
  function missingNodeIds() {
    var nodes = (state.plan && state.plan.nodes) || [];
    return nodes.filter(function (n) { return !state.nodeDetail[n.id]; }).map(function (n) { return n.id; });
  }
  function genAllBtnSet(text) { var b = $('gen-all-btn'); if (b) b.textContent = text; }
  function genAllBtnIdleLater(ms, text) {
    genAllBtnSet(text);
    if (genAllTimer) clearTimeout(genAllTimer);
    genAllTimer = setTimeout(function () {
      genAllTimer = null;
      if (!genAllRunning) genAllBtnSet('一键生成全部节点');
    }, ms);
  }
  function genAllSyncPending() {
    if (!genAllRemaining.length) { state.pending = null; }
    else {
      var previous = state.pending;
      state.pending = {kind: 'nodes', nid: null, at: Date.now(), remaining: genAllRemaining.slice(),
        requestId: previous && previous.kind === 'nodes' && previous.requestId || window.LearnJobs.requestId()};
    }
    save();
  }
  // 卡片头部「生成中…」态（逐卡切换）
  function setCardGenState(id, on) {
    var card = $('node-' + id);
    if (!card) return;
    var st = card.querySelector('.status');
    if (!st) return;
    if (on) {
      st.dataset.prevCls = st.className;
      st.dataset.prevHtml = st.innerHTML;
      st.className = 'status generating';
      st.innerHTML = '<span class="spinner"></span>生成中…';
    } else if (st.dataset.prevHtml != null) {
      st.className = st.dataset.prevCls || 'status';
      st.innerHTML = st.dataset.prevHtml;
      delete st.dataset.prevHtml;
      delete st.dataset.prevCls;
    }
  }
  // 纯请求：生成某节点的学习材料（不含 UI，供单卡与批量复用）
  function requestNodeDetail(id) {
    var n = nodeById(id);
    return post('/path/node', {
      spec: state.spec,
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      dep_titles: depTitles(id),
      key: storeKey()
    });
  }
  function genAllStart(ids) {
    if (!ids || !ids.length) return;
    genAllRunning = true; genAllPaused = false;
    genAllQueue = ids.slice();
    genAllRemaining = ids.slice();
    ids.forEach(function (id) { nodeMaterialStatus[id] = 'generating'; syncAiMaterial(id); });
    genAllTotal = ids.length;
    genAllIdx = 0;
    if (genAllTimer) { clearTimeout(genAllTimer); genAllTimer = null; }
    showResumeBar('正在批量生成学习材料（' + ids.length + ' 个节点）…');
    genAllSyncPending();
    genAllStep();
  }
  function genAllStep() {
    if (genAllPaused) { genAllFinish('paused'); return; }
    while (genAllQueue.length && state.nodeDetail[genAllQueue[0]]) {   // 跳过已生成的
      var doneId = genAllQueue.shift();
      var ri = genAllRemaining.indexOf(doneId);
      if (ri >= 0) genAllRemaining.splice(ri, 1);
    }
    if (!genAllQueue.length) { genAllFinish('done'); return; }
    var id = genAllQueue[0];
    genAllIdx++;
    genAllBtnSet('生成中 ' + genAllIdx + '/' + genAllTotal + '（点击暂停）');
    setCardGenState(id, true);
    requestNodeDetail(id).then(function (detail) {
      setCardGenState(id, false);
      state.nodeDetail[id] = detail;
      syncAiMaterial(id);
      var i0 = genAllRemaining.indexOf(id); if (i0 >= 0) genAllRemaining.splice(i0, 1);
      genAllQueue.shift();
      genAllSyncPending();
      if (expandedId === id) renderNodeDetail(id);
      genAllStep();
    }).catch(function () {
      setCardGenState(id, false);
      nodeMaterialStatus[id] = 'failed';
      syncAiMaterial(id);
      genAllQueue.shift();   // 失败：留在 genAllRemaining，继续下一个
      genAllStep();
    });
  }
  function genAllFinish(reason) {
    genAllRunning = false;
    if (reason === 'paused') {
      genAllRemaining.forEach(function (id) { nodeMaterialStatus[id] = 'missing'; syncAiMaterial(id); });
      genAllPaused = false;
      state.pending = null; save();
      hideResumeBar();
      genAllBtnSet('一键生成全部节点');
      return;
    }
    if (genAllRemaining.length) {   // 结束但有失败：保留 pending，按钮短暂提示，再点=重试剩余
      genAllSyncPending();
      hideResumeBar();
      genAllBtnIdleLater(4000, '生成完成（' + genAllRemaining.length + ' 个失败，可重试）');
    } else {
      state.pending = null; save();
      hideResumeBar();
      genAllBtnIdleLater(2000, '已全部生成 ✓');
    }
  }
  function onGenAllClick() {
    if (!(state.stage === 'learning' && state.plan)) return;
    if (genAllRunning) {   // 运行中再点 = 暂停（当前节点完成后停）
      genAllPaused = true;
      genAllBtnSet('暂停中…（等待当前节点完成）');
      return;
    }
    var ids = missingNodeIds();
    if (!ids.length) { genAllBtnIdleLater(2000, '已全部生成 ✓'); return; }
    genAllStart(ids);
  }
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
      notes: d.study_notes ? String(d.study_notes).slice(0, 6000) : '',
      material_status: aiMaterialStatus(id)
    };
  }  // (aiUnit end)
  function aiMaterialStatus(id) {
    if (state.nodeDetail[id]) return 'ready';
    if (nodeMaterialStatus[id]) return nodeMaterialStatus[id];
    return state.pending && state.pending.kind === 'node' && state.pending.nid === id ? 'generating' : 'missing';
  }
  function syncAiMaterial(id) {
    var view = aiViews.get(id);
    if (!view) return;
    var status = aiMaterialStatus(id);
    var ready = status === 'ready';
    var label = ready ? '学习材料已就绪' : status === 'generating' ? '学习材料正在生成' : status === 'failed' ? '学习材料生成失败，请在左侧重试' : '学习材料尚未生成';
    view.root.querySelector('.ai-intro').textContent = label + (ready ? '，可以结合正文讲解和练习。' : '。可以先聊前置知识和学习目标。');
    view.root.querySelector('.ai-note').textContent = ready ? 'AI 可参考本单元材料；个人薄弱点需结合你的实际作答判断。' : 'AI 当前仅有单元标题和学习目标，还没有本单元正文。';
    view.input.placeholder = ready ? '就本单元提问，Enter 发送 / Shift+Enter 换行' : '可以先问学习目标或前置知识';
    var methods = view.root.querySelector('.ai-methods');
    if (methods && !methods.childNodes.length) {
      ['画图解释', '用表格对比', '举个例子', '分步推导'].forEach(function (method) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'ai-method'; button.textContent = method;
        button.onclick = function () {
          var available = aiMaterialStatus(id) === 'ready';
          sendAi(id, (available ? '结合本单元及当前对话，' : '正文尚未就绪，请仅对前置知识做预习说明：') + method + '，选择适合讲解的内容；不要透露我正在作答题目的答案。');
        };
        methods.appendChild(button);
      });
    }
    var empty = view.box.querySelector('.ai-empty');
    if (empty) {
      empty.replaceChildren();
      var heading = document.createElement('p');
      heading.textContent = ready ? '可以问我：' : '材料就绪前，可以先问：';
      empty.appendChild(heading);
      (ready ? AI_SUGGEST : AI_PREVIEW_SUGGEST).forEach(function (text) {
        var button = document.createElement('button');
        button.className = 'ai-chip'; button.type = 'button'; button.textContent = text;
        button.addEventListener('click', function () { sendAi(id, text); });
        empty.appendChild(button);
      });
    }
  }
  function aiScroll(view, force) {
    view = view || activeAiView;
    if (!view) return;
    if (force) view.follow = true;
    if (view.follow && view.root.isConnected && view.box.clientHeight) {
      view.box.scrollTop = view.box.scrollHeight;
      view.scrollTop = view.box.scrollTop;
      view.more.hidden = true;
    } else if (!force) view.more.hidden = false;
  }
  function syncAiBusy() {
    aiViews.forEach(function (view) {
      view.send.disabled = aiBusy;
      view.send.textContent = aiBusy ? '回复中…' : '发送';
      view.send.title = aiBusy ? 'AI 正在回复，可以继续编辑下一条问题' : '';
    });
  }
  function aiRenderInto(el, text, streaming) {
    if (!el) return;
    el.innerHTML = mdRender(text, {streaming:!!streaming});
    if (!streaming && window.LearnMarkdown) window.LearnMarkdown.exportButton(el, text, "AI讲解.md");
    renderMathIn(el);
    highlightIn(el);
  }
  function aiBubble(role, content) {
    var d = document.createElement('div');
    d.className = 'ai-msg ' + (role === 'user' ? 'user' : 'assistant');
    var b = document.createElement('div');
    b.className = 'ai-bubble';
    if (role === 'user') b.textContent = content;
    else {
      b.innerHTML = mdRender(content);
      if (content && window.LearnMarkdown) window.LearnMarkdown.exportButton(b, content, 'AI讲解.md');
    }
    d.appendChild(b);
    return d;
  }

  function renderAiPanel(id) {
    var n = nodeById(id);
    if (!n) return;
    if (aiViewKey !== aiKey()) {
      aiViews.clear();
      activeAiView = null;
      aiViewKey = aiKey();
    }
    if (activeAiView && activeAiView.box.clientHeight) activeAiView.scrollTop = activeAiView.box.scrollTop;
    var cached = aiViews.get(id);
    if (cached) {
      $('panel-body').replaceChildren(cached.root);
      activeAiView = cached;
      syncAiMaterial(id);
      cached.box.scrollTop = cached.scrollTop;
      if (cached.follow) aiScroll(cached, true);
      syncAiBusy();
      return;
    }
    var root = document.createElement('div');
    root.className = 'agent-view';
    root.innerHTML =
      '<p class="ai-intro">AI 辅助 · 交互式学习 —— 会讲解、追问、出小题检验你；不会直接给答案。</p>' +
      '<div class="ai-methods" aria-label="换种讲法"></div>' +
      '<div class="ai-msgs" id="ai-msgs"></div>' +
      '<button class="btn quiet ai-new-reply" type="button" hidden>有新回复 ↓</button>' +
      '<div class="ai-compose"><textarea id="ai-input" placeholder="就本单元提问，Enter 发送 / Shift+Enter 换行"></textarea>' +
      '<button class="btn primary" id="ai-send" type="button">发送</button></div>' +
      '<p class="ai-note">AI 知道本单元内容，会引导你思考、不会直接给答案。</p>';
    $('panel-body').replaceChildren(root);
    setFoot('');
    var msgs = state.aiHist[id] || [];
    var box = $('ai-msgs');
    if (!msgs.length) {
      box.innerHTML = '<div class="ai-empty"></div>';
    } else {
      msgs.forEach(function (m) { box.appendChild(aiBubble(m.role, m.content)); });
    }
    renderMathIn(box);
    highlightIn(box);
    var input = $('ai-input');
    bindAutoGrow(input);
    var send = $('ai-send');
    var view = { root: root, box: box, input: input, send: send, more: root.querySelector('.ai-new-reply'), follow: true, scrollTop: 0 };
    aiViews.set(id, view);
    activeAiView = view;
    syncAiMaterial(id);
    box.addEventListener('scroll', function () {
      if (!box.clientHeight) return;
      view.scrollTop = box.scrollTop;
      view.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
      if (view.follow) view.more.hidden = true;
    });
    view.more.addEventListener('click', function () { aiScroll(view, true); });
    function doSend() { sendAi(id, (input.value || '').trim()); }
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); }
    });
    syncAiBusy();
    aiScroll(view, true);
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
    var view = aiViews.get(id);
    var input = view.input;
    if (input) { input.value = ''; input.style.height = ''; }
    var box = view.box;
    if (box) { var em = box.querySelector('.ai-empty'); if (em) em.remove(); box.appendChild(aiBubble('user', q)); }
    aiScroll(view, true);
    aiBusy = true;
    syncAiBusy();
    input.focus({ preventScroll: true });
    var target = aiBubble('assistant', '');
    var body = target.querySelector('.ai-bubble');
    body.innerHTML = '<span class="spinner"></span>思考中…';
    if (box) box.appendChild(target);
    aiScroll(view, true);
    var acc = '';
    window.LearnUser.fetch(API + '/ask', {
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
            if (obj.delta) { acc += obj.delta; aiRenderInto(body, acc, true); aiScroll(view); }
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      if (!acc) acc = '（没有返回内容，请重试。）';
      aiFinish(id, body, acc, view);
    }).catch(function (e) {
      if (!acc) acc = '请求失败：' + ((e && e.message) || e);
      aiFinish(id, body, acc, view);
    });
  }
  function aiFinish(id, body, acc, view) {
    aiRenderInto(body, acc);
    var msgs = state.aiHist[id] || (state.aiHist[id] = []);
    msgs.push({ role: 'assistant', content: acc });
    aiHistTrim(msgs, 60);
    state.aiHist[id] = msgs;
    saveAi();
    aiBusy = false;
    syncAiBusy();
    aiScroll(view);
  }
  function renderNotes(s) { return mdRender(s); }
  function listSection(title, arr) {
    if (!arr || !arr.length) return '';
    return '<div class="panel-sec"><h4>' + esc(title) + '</h4><ul class="mdlist">' +
      arr.map(function (x) { return '<li>' + mdRender(x) + '</li>'; }).join('') + '</ul></div>';
  }

  // ---------- 自测题渲染（选择题点选 / 填空·简答文本作答） ----------
  var matTab = 'material';     // 单元内选项卡：material | quiz（仅前端内存）
  var matTabOwner = null;      // 当前选项卡归属的节点
  var lastQuizShown = null;    // {id, res} 最近一次提交结果（展示在「测验」tab 内）
  // 卡内渲染：所有查询都从卡片内容元素向下查（作用域隔离，避免串卡）
  function renderNodeDetail(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    var scope = cardContentEl(id);
    if (!n || !d || !scope) return;
    activeScope = scope;
    if (matTabOwner !== id) { matTab = 'material'; lastQuizShown = null; matTabOwner = id; }
    var shown = (lastQuizShown && lastQuizShown.id === id) ? lastQuizShown.res : null;
    var persisted = (state.nodeState[id] || {}).lastResult;
    if (!shown && persisted && persisted.round_id === (d.quiz || {}).round_id) shown = persisted;
    if (shown) matTab = 'quiz';
    var qs = ((d.quiz && d.quiz.questions) || []);
    var prev = state.nodeState[id] || {};
    // 自测未过（<60）：按薄弱点细化学习地图
    var lowScore = (typeof prev.score === 'number' && prev.score < 60) ||
      !!(prev.lastResult && typeof prev.lastResult.score === 'number' && prev.lastResult.score < 60);
    var matPane =
      '<div class="panel-sec"><h4>学习正文</h4><div class="notes">' + renderNotes(d.study_notes) + '</div></div>' +
      listSection('要点', d.key_points) +
      listSection('例子', d.examples) +
      listSection('易错点', d.misconceptions);
    var quizPane;
    if (qs.length) {
      var rounds = (d.quiz || {}).rounds || [];
      var latest = (state.nodeState[id] || {}).lastResult;
      if (latest && latest.round_id && latest.round_id !== d.quiz.round_id) latest = null;
      quizPane = '<div class="panel-sec"><h4>单元测验</h4>' +
        '<p class="tip">' + qs.length + '题 · 满分100分 · ' + (rounds.length || 1) + '套题已保存。完整题目、作答与批改在测验窗口查看。</p>' +
        (latest ? '<p>最近成绩：<b>' + esc(latest.score) + '/100</b></p>' : '') +
        '<div class="quiz-actions"><select id="quiz-round-select" aria-label="选择题集">' +
          (rounds.length ? rounds.map(function (r, index) {
            return '<option value="' + esc(r.id) + '"' + (r.id === d.quiz.round_id ? ' selected' : '') + '>第' + (index + 1) + '套' + (r.id === d.quiz.round_id ? ' · 最新' : '') + '</option>';
          }).join('') : '<option value="">第1套</option>') + '</select>' +
        '<button class="btn primary" id="open-quiz-workspace">打开测验</button>' +
        '<button class="btn" id="redo-quiz">出一套新题</button>' +
        (latest && latest.pass && !isDone(id) ? '<button class="btn" id="complete-node">完成本节点并解锁下一节点</button>' : '') +
        (lowScore ? '<button class="btn" id="refine-node">按薄弱点细化</button>' : '') + '</div></div>';
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
    var notes = scope.querySelector('.notes');
    if (notes && window.LearnMarkdown) {
      var materialMd = '# ' + (n.title || '未命名单元') + '\n\n' + (d.study_notes || '');
      [['要点', d.key_points], ['例子', d.examples], ['易错点', d.misconceptions]].forEach(function (part) {
        if (part[1] && part[1].length) materialMd += '\n\n## ' + part[0] + '\n\n' + part[1].join('\n\n');
      });
      var unitIndex = (state.plan.nodes || []).findIndex(function (node) { return node.id === id; }) + 1;
      var filename = window.LearnMarkdown.unitFilename(window.LearnTitles.document(state), unitIndex, n.title);
      window.LearnMarkdown.exportButton(notes, materialMd, filename);
    }
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
    setFoot('');
    var openQuiz = scope.querySelector('#open-quiz-workspace');
    if (openQuiz) openQuiz.addEventListener('click', function () { openQuizModal(id, scope.querySelector('#quiz-round-select').value); });
    var bRedo = scope.querySelector('#redo-quiz');
    if (bRedo) {
      bRedo.disabled = !!requizWork[id];
      if (requizWork[id]) bRedo.textContent = '正在出新题…';
      bRedo.addEventListener('click', function () { redoQuiz(id); });
    }
    var bComp = scope.querySelector('#complete-node');
    if (bComp) bComp.addEventListener('click', function () { completeNode(id); });
    var bRefine = scope.querySelector('#refine-node');
    if (bRefine) bRefine.addEventListener('click', function () { refineNode(id); });
    requestAnimationFrame(drawEdges);
  }

  // 所有题目、作答和历史批改均由共享弹窗呈现。
  function openQuizModal(id, roundId) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    return window.QuizDialog.open({
      readOnly: window.LearnUser.readOnly, api: API, key: storeKey(), nodeId: id, roundId: roundId, title: n.title + ' · 单元测验',
      render: mdRender, decorate: function (el) { renderMathIn(el); highlightIn(el); },
      onLoad: function (quiz) { d.quiz = quiz; },
      onResult: function (res) {
        d.quiz = res.quiz;
        if (res.round_id === d.quiz.round_id) {
          var st = state.nodeState[id] || {};
          st.score = res.score;
          st.lastResult = {score: res.score, pass: res.pass, feedback: res.feedback,
                           per_question: res.per_question, round_id: res.round_id};
          state.nodeState[id] = st;
        }
        save(); renderPlan();
      }
    });
  }
  // A receipt survives navigation; only the current server snapshot updates the view.
  var requizWork = Object.create(null);
  function trackRequiz(id, start) {
    if (requizWork[id]) return requizWork[id];
    var key = storeKey();
    var work = Promise.resolve().then(start).then(function () {
      return post('/path/quiz/state', {key: key, node: {id: id}});
    }).then(function (quiz) {
      if (storeKey() !== key || !state.nodeDetail[id]) return;
      state.nodeDetail[id].quiz = quiz;
      lastQuizShown = null;
      // No state write: the server already saved the authoritative new round.
    }).catch(function (error) {
      if (storeKey() === key && !error.jobId) showError('读取新题状态失败：' + error.message, restoreRequiz);
    }).finally(function () {
      delete requizWork[id];
      if (storeKey() === key && expandedId === id) renderNodeDetail(id);
    });
    requizWork[id] = work;
    if (expandedId === id) renderNodeDetail(id);
    return work;
  }
  function restoreRequiz() {
    if (!window.LearnJobs || window.LearnUser.readOnly || !state.plan) return Promise.resolve();
    var key = storeKey();
    return window.LearnJobs.list(key).then(function (jobs) {
      if (key !== storeKey()) return;
      var latest = Object.create(null);
      jobs.forEach(function (job) {
        if (job.operation !== '/path/requiz' || !job.node_id) return;
        var previous = latest[job.node_id];
        if (!previous || job.created_ms > previous.created_ms) latest[job.node_id] = job;
      });
      return Promise.all(Object.keys(latest).map(function (id) {
        if (!state.nodeDetail[id]) return;
        var job = latest[id];
        if (job.status === 'cancelled') return;
        function retry() {
          return trackRequiz(id, function () { return window.LearnJobs.retry(job.id, {onRetry: retry}); });
        }
        return trackRequiz(id, function () {
          return window.LearnJobs.get(job.id).then(function (fresh) {
            if (fresh.status === 'succeeded') return; // Avoid replaying a success toast on every visit.
            return window.LearnJobs.watch(fresh, {onRetry: retry});
          });
        });
      }));
    }).catch(function (error) {
      if (key === storeKey()) showError('无法恢复换题状态：' + error.message, restoreRequiz);
    });
  }
  function redoQuiz(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d || window.LearnUser.readOnly) return;
    var quiz = d.quiz || {}, st = state.nodeState[id] || {};
    hideError();
    matTab = 'quiz'; matTabOwner = id;
    return trackRequiz(id, function () {
      return post('/path/requiz', {
        node: {id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || []},
        spec: state.spec, round_id: quiz.round_id, feedback: st.lastResult || null, key: storeKey()
      }, {onRetry: function () { return redoQuiz(id); }});
    });
  }

  function completeNode(id) {
    var st = state.nodeState[id] || {};
    st.completed = true;
    state.nodeState[id] = st;
    save();
    renderPlan();   // 重建后会自动恢复展开并重渲染卡内内容（状态→已完成）
  }

  // 卡内「按薄弱点细化」：把本节点自测的薄弱点提交给 /path/refine（key 必须为学习地图键）
  function perQuestionSummary(per) {
    if (!per || !per.length) return '';
    var parts = [];
    per.forEach(function (p, i) {
      if (p && p.ok === false) parts.push('第 ' + (i + 1) + ' 题：' + (p.comment || '有缺漏'));
    });
    return parts.length ? '；错题：' + parts.join('；') : '';
  }
  function refineNode(id) {
    var n = nodeById(id);
    var st = state.nodeState[id] || {};
    var lr = st.lastResult || {};
    var scope = cardContentEl(id);
    var btn = scope ? scope.querySelector('#refine-node') : null;
    var reason = ((lr.feedback || '') + perQuestionSummary(lr.per_question)).slice(0, 500);
    if (!reason) reason = '本单元自测未通过（' + (typeof st.score === 'number' ? st.score : '') + ' 分）';
    if (btn) { btn.disabled = true; btn.textContent = '细化中…'; }
    var quiz = (state.nodeDetail[id] || {}).quiz || {};
    var issued = (quiz.rounds || []).find(function (round) { return round.id === quiz.round_id; });
    var attempts = (issued && issued.attempts) || [];
    post('/path/refine', {
      key: storeKey(), node_id: id, round_id: quiz.round_id,
      attempt_id: quiz.lastAttemptId || (attempts.length ? attempts[attempts.length - 1].id : undefined),
      spec: state.spec,
      plan: state.plan,
      weaknesses: [{ nid: id, title: n ? n.title : '', reason: reason, points: [] }]
    }).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = '按薄弱点细化'; }
      if (r && r.plan) {
        normalizePlan(r.plan);
        state.plan = r.plan;
        save();
        renderPlan();
        alert(r.reused ? '本次作答的补习单元已经创建，已显示最新学习地图。' : '已为本次作答准备 ' + ((r.added) || 0) + ' 个补习单元，重复操作不会再次追加。');
      }
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '按薄弱点细化'; }
      showError('细化失败：' + e.message, function () { refineNode(id); });
    });
  }

  // ---------- 生成测验地图（按学习地图 + 学习情况） ----------
  function genQuizMap() {
    if (!(state.stage === 'learning' && state.plan)) return;
    window.LearnMaterials.quiz(storeKey(), submitQuizMap);
  }
  function submitQuizMap() {
    var btn = $('quizmap-btn');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…（约 1-2 分钟）'; }
    hideError();
    post('/path/quizmap', { key: storeKey() }, {newOperation: true}).then(function (r) {
      location.href = 'quiz-map.html?t=' + encodeURIComponent(r.slug);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '生成测验'; }
      showError('生成测验失败：' + e.message, genQuizMap);
    });
  }

  // ---------- 重新开始 ----------
  function restart() {
    if (!confirm('确定要重新开始吗？当前学习资料会保留在资料库。')) return;
    save(); flushSave();
    return Promise.all(stateWrites.slice()).then(function () {
      location.href = location.pathname + '?new=1';
    }).catch(function (error) { showError('保存失败，请重试保存后再新建学习：' + error.message); });
  }

  // ---------- 学习资料库（服务端数据动态扫描） ----------
  function fetchMaterials() {
    return window.LearnUser.fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var entries = (j && j.entries) || {}, out = [];
      Object.keys(entries).forEach(function (k) {
        var biz = stripUser(k);   // 先剥用户前缀，再按原业务键逻辑处理
        if (biz.indexOf(STORE_PREFIX) !== 0 || biz === 'learn-path-v1-last') return;
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        var d = null;
        try { d = JSON.parse(v); } catch (e) { d = null; }
        var it = { key: k, slug: biz.slice(STORE_PREFIX.length), topic: '', stage: '', total: 0, done: 0 };
        if (d && typeof d === 'object') {
          if (!d.topic && !d.plan && (!d.history || !d.history.length)) return;   // 跳过历史空壳
          it.topic = window.LearnTitles.document(d);
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
    return window.LearnUser.fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var entries = (j && j.entries) || {}, out = [];
      Object.keys(entries).forEach(function (k) {
        var biz = stripUser(k);   // 先剥用户前缀
        if (biz.indexOf(QUIZ_PREFIX) !== 0) return;
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        var d = null;
        try { d = JSON.parse(v); } catch (e) { d = null; }
        if (!d || typeof d !== 'object') return;
        var it = { key: k, slug: biz.slice(QUIZ_PREFIX.length), title: window.LearnTitles.quiz(d, entries).title,
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
               '<button class="lib-del" type="button" data-slug="' + esc(it.slug) + '" data-topic="' + esc(it.topic) + '" data-key="' + esc(it.key) + '" title="删除这份资料">🗑</button>' +
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
               '<button class="lib-del" type="button" data-slug="' + esc(q.slug) + '" data-topic="' + esc(q.title) + '" data-key="' + esc(q.key) + '" title="删除这份资料">🗑</button>' +
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
    var key = delKey || (USER_PATH + STORE_PREFIX + target);
    var pass = ($('dm-pass') || {}).value || '';
    var wasCurrent = key === storeKey();
    var keys = wasCurrent ? [key, LAST_KEY, aiKey()] : [key];
    deleteState(keys, pass).then(function (j) {
      if (j && j.ok) {
        closeDelModal();
        if (wasCurrent) { location.href = location.pathname + '?new=1'; return; }
        libRender();
        var pop = $('lib-pop'); if (pop) pop.hidden = false;
      } else {
        var err = $('dm-err');
        if (err) { err.textContent = (j && j.error) || '删除失败'; err.hidden = false; }
      }
    }).catch(function (error) {
      var err = $('dm-err');
      if (err) { err.textContent = error.message || '网络错误，请重试'; err.hidden = false; }
    });
  }

  // ---------- 初始化 ----------
  // 页面不做任何本地保存；每次打开都从服务端远程加载
  function init() { window.LearnUser.ready.then(boot); }
  function boot() {
    quizCreation = new URLSearchParams(location.search).get("mode") === "quiz";
    bindAgentLayout();
    materialsPanel = window.LearnMaterials.mount($('learning-materials'), {
      get: function () { return state.materials; },
      set: async function (next) {
        state.materials = next;
        if (!state.topic && next.length) {
          state.topic = next[0].name.replace(/\.[^.]+$/, '');
          materialSlug = slug(state.topic) + '-' + window.LearnJobs.requestId().slice(0, 8);
          var url = new URL(location.href); url.searchParams.delete('new'); url.searchParams.set('t', materialSlug);
          window.history.replaceState(null, '', url.pathname + url.search);
          renderChat();
        }
        save(); await flushSave(); await Promise.all(stateWrites.slice());
      },
      busy: function (off) { setChatDisabled(off); }
    });
    if (quizCreation) {
      $('stage-intake').querySelector('h2').textContent = '用自己的资料创建测验地图';
      $('chat-input').placeholder = '说明测验范围、难度和目标，回车开始…';
    }
    $('chat-send').addEventListener('click', sendMessage);
    $('research-recheck').addEventListener('click', recheckResearch);
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendMessage(); }
    });
    $('restart-btn').addEventListener('click', restart);
    bindStageNav();
    $('errretry').addEventListener('click', function () { var f = retryFn; hideError(); if (f) f(); });
    window.addEventListener('resize', function () { if (state.plan) drawEdges(); });
    $('backend-label').textContent = API;
    $('dm-cancel').addEventListener('click', closeDelModal);
    $('dm-ok').addEventListener('click', submitDel);
    $('dm-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitDel(); });
    $('del-modal').addEventListener('click', function (e) { if (e.target === this) closeDelModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('del-modal').hidden) closeDelModal();
    });
    $('quizmap-btn').addEventListener('click', genQuizMap);
    var gab = $('gen-all-btn');
    if (gab) gab.addEventListener('click', onGenAllClick);
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
      materialsPanel.render();
      renderProgress();
      renderAgentPanel();
      if (restored) restoreRequiz();
      if (restored && !window.LearnUser.readOnly) resumeIfPending();   // 上次生成中断→自动取回/重放（节点会自动展开卡片）
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
