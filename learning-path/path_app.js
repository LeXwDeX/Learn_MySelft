/* 学习路径 · 前端逻辑
 * 三阶段状态机：intake → research → learning
 * 后端契约：/path/intake /path/research /path/plan /path/node /path/quiz
 * 依赖：无（纯原生 JS，无 CDN）
 */
(function () {
  'use strict';

  var API = 'http://192.168.33.146:8096';
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
  function storeKey() { return STORE_PREFIX + slug(state.topic); }
  function domain(u) { try { return new URL(u).hostname; } catch (e) { return u; } }

  // ---------- 持久化 ----------
  function save() {
    try {
      var payload = {
        stage: state.stage, topic: state.topic, history: state.history,
        spec: state.spec, queries: state.queries, sources: state.sources,
        brief: state.brief, plan: state.plan,
        nodeDetail: state.nodeDetail, nodeState: state.nodeState
      };
      localStorage.setItem(storeKey(), JSON.stringify(payload));
      localStorage.setItem(LAST_KEY, slug(state.topic));
    } catch (e) { console.warn('save failed', e); }
  }
  function clearSave() {
    try { localStorage.removeItem(storeKey()); localStorage.removeItem(LAST_KEY); } catch (e) {}
  }
  function loadSave() {
    try {
      // 支持 ?t=<slug> 深链（从「学习资料库」直接打开某份资料）；无参则恢复最近一次
      var s = null;
      try { s = new URLSearchParams(location.search).get('t'); } catch (e2) { s = null; }
      if (s && !localStorage.getItem(STORE_PREFIX + s)) s = null;   // 指定的资料不存在则回退
      if (!s) s = localStorage.getItem(LAST_KEY);
      if (!s) return false;
      var raw = localStorage.getItem(STORE_PREFIX + s);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (!d || !d.topic) return false;
      state.stage = d.stage || 'intake';
      state.topic = d.topic || '';
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
      try { localStorage.setItem(LAST_KEY, s); } catch (e) {}
      return true;
    } catch (e) { return false; }
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
  var STAGE_LABEL = { intake: '阶段 A · 需求采集', research: '阶段 B · 主动研究', learning: '阶段 C · 学习路径' };
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
    post('/path/research', { spec: state.spec })
      .then(function (r) {
        state.queries = r.queries || [];
        state.sources = r.sources || [];
        state.brief = r.brief || '';
        save();
        renderResearch();
        $('research-status').innerHTML = '<span class="spinner"></span>研究完成，正在生成学习路径…';
        return post('/path/plan', { spec: state.spec, brief: state.brief });
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
      dep_titles: depTitles(id)
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

  // 简单 markdown：## 小标题 + 空行分段；$...$ 保持原样文本
  function renderNotes(s) {
    var lines = String(s || '').split('\n');
    var out = [];
    lines.forEach(function (ln) {
      var t = ln.trim();
      if (/^#{2,3}\s+/.test(t)) out.push('<h5>' + esc(t.replace(/^#{2,3}\s+/, '')) + '</h5>');
      else if (/^\s*[-*]\s+/.test(ln)) out.push('<div style="padding-left:14px">· ' + esc(t.replace(/^\s*[-*]\s+/, '')) + '</div>');
      else if (t === '') out.push('<div style="height:8px"></div>');
      else out.push('<div>' + esc(ln) + '</div>');
    });
    return out.join('');
  }
  function listSection(title, arr) {
    if (!arr || !arr.length) return '';
    return '<div class="panel-sec"><h4>' + esc(title) + '</h4><ul>' +
      arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
  }

  function omLink(n) {
    var prompt = n.title + '。学习目标：' + (n.objectives || []).join('；') + '。本质：' + (n.essence || '');
    return 'http://192.168.33.110:8094/workbench/new?prompt=' + encodeURIComponent(prompt);
  }

  function renderNodeDetail(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    panelHead(id, n.title, n.essence, 'NODE ' + id + (isDone(id) ? ' · 已完成' : ''));
    var qs = ((d.quiz && d.quiz.questions) || []);
    var quizHtml = qs.map(function (q, i) {
      return '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' + esc(q.q) + '</p>' +
        '<textarea id="ans-' + i + '" placeholder="写下你的答案…"></textarea></div>';
    }).join('');
    var prev = state.nodeState[id] || {};
    var prevResult = '';
    if (typeof prev.score === 'number') {
      prevResult = '<div class="result ' + (prev.completed ? 'ok' : 'bad') + '">' +
        '<span class="score ' + (prev.completed ? 'ok' : 'bad') + '">' + prev.score + '</span> 分' +
        (prev.completed ? ' · 已通过' : ' · 上次未通过') + '</div>';
    }
    $('panel-body').innerHTML =
      '<div class="panel-sec"><h4>学习正文</h4><div class="notes">' + renderNotes(d.study_notes) + '</div></div>' +
      listSection('要点', d.key_points) +
      listSection('例子', d.examples) +
      listSection('易错点', d.misconceptions) +
      (qs.length ? '<div class="panel-sec"><h4>自测（' + qs.length + ' 题）</h4>' + quizHtml + '</div>' : '') +
      prevResult;
    renderMathIn($('panel-body'));

    var foot = '';
    if (qs.length && !isDone(id)) foot += '<button class="btn primary" id="submit-quiz" type="button">提交自测</button>';
    if (isDone(id)) foot += '<span class="tip">✅ 已完成</span>';
    foot += '<a class="om-link" target="_blank" rel="noopener" href="' + esc(omLink(n)) + '">用 OpenMAIC 生成这节课 →</a>';
    setFoot(foot);
    if ($('submit-quiz')) $('submit-quiz').addEventListener('click', function () { submitQuiz(id); });
  }

  function submitQuiz(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    var qs = ((d.quiz && d.quiz.questions) || []);
    var answers = qs.map(function (q, i) {
      var el = $('ans-' + i);
      return el ? (el.value || '').trim() : '';
    });
    if (answers.every(function (a) { return !a; })) { alert('请至少回答一题再提交。'); return; }
    var btn = $('submit-quiz');
    btn.disabled = true; btn.textContent = '判分中…';
    hideError();
    post('/path/quiz', {
      node: { title: n.title, essence: n.essence, objectives: n.objectives || [] },
      questions: qs.map(function (q) { return { q: q.q, answer: q.answer }; }),
      answers: answers
    }).then(function (res) {
      var st = state.nodeState[id] || {};
      st.score = res.score;
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
      return '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' + esc(q.q) + '</p>' +
        '<div class="result ' + (p.ok ? 'ok' : 'bad') + '">' +
        '<strong>' + (p.ok ? '✓ 正确' : '✗ 有缺漏') + '</strong> ' + esc(p.comment || '') + '</div></div>';
    }).join('');
    var cls = res.pass ? 'ok' : 'bad';
    $('panel-body').innerHTML =
      '<div class="panel-sec"><h4>自测结果</h4>' +
      '<div class="result ' + cls + '"><span class="score ' + cls + '">' + esc(res.score) + '</span> 分 — ' +
      (res.pass ? '通过 ✅' : '未通过 ❌') + '</div>' +
      (res.feedback ? '<p style="font-size:13.5px;margin-top:10px">' + esc(res.feedback) + '</p>' : '') +
      '<div style="height:10px"></div>' + detail + '</div>';
    renderMathIn($('panel-body'));
    var foot = '';
    if (res.pass && !isDone(id)) {
      foot += '<button class="btn primary" id="complete-node" type="button">完成本节点并解锁下一节点</button>';
    } else if (res.pass && isDone(id)) {
      foot += '<span class="tip">✅ 已完成</span>';
    } else {
      foot += '<button class="btn primary" id="redo-quiz" type="button">再想想，可重做</button>';
    }
    foot += '<a class="om-link" target="_blank" rel="noopener" href="' + esc(omLink(nodeById(id))) + '">用 OpenMAIC 生成这节课 →</a>';
    setFoot(foot);
    if ($('complete-node')) $('complete-node').addEventListener('click', function () { completeNode(id); });
    if ($('redo-quiz')) $('redo-quiz').addEventListener('click', function () { renderNodeDetail(id); });
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

  // ---------- 学习资料库（动态扫描 localStorage） ----------
  function scanMaterials() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(STORE_PREFIX) !== 0 || k === LAST_KEY) continue;
        var d = null;
        try { d = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { d = null; }
        var it = { slug: k.slice(STORE_PREFIX.length), topic: '', stage: '', total: 0, done: 0 };
        if (d && typeof d === 'object') {
          it.topic = d.topic || it.slug;
          it.stage = d.stage || '';
          if (d.plan && d.plan.nodes) it.total = d.plan.nodes.length;
          var ns = d.nodeState || {};
          for (var id in ns) { if (ns[id] && ns[id].completed) it.done++; }
        } else { it.topic = it.slug; }
        out.push(it);
      }
    } catch (e) {}
    out.sort(function (a, b) {
      var pa = a.stage === 'learning' ? 0 : 1, pb = b.stage === 'learning' ? 0 : 1;
      return pa - pb || b.done - a.done;
    });
    return out;
  }
  function libRender() {
    var pop = $('lib-pop');
    if (!pop) return;
    var items = scanMaterials();
    var cnt = $('lib-count');
    if (cnt) cnt.textContent = ' (' + (items.length + 1) + ')';
    var h = '<p class="lib-h"><span>学习资料库</span><i>动态扫描 · 自动同步</i></p>';
    h += '<p class="lib-sub">常驻资料</p>';
    h += '<a class="lib-item" href="junior-math-linalg.html">' +
         '<span class="t">知识地图 · 初中数学到线性代数</span><span class="m">内含命题定理 · 打开知识地图</span></a>';
    h += '<p class="lib-sub">学习路径（动态扫描）</p>';
    if (!items.length) {
      h += '<p class="lib-empty">暂无生成的学习路径——去生成一个吧。</p>';
    } else {
      for (var i = 0; i < items.length; i++) {
        var it = items[i], meta = STAGE_LABEL[it.stage] || it.stage || '';
        if (it.stage === 'learning') meta = it.total ? (it.done + '/' + it.total + ' 节点完成') : '路径已生成';
        h += '<a class="lib-item" href="learning-path.html?t=' + encodeURIComponent(it.slug) + '">' +
             '<span class="t">' + esc(it.topic) + '</span><span class="m">' + esc(meta) + '</span></a>';
      }
    }
    h += '<div class="lib-foot">' +
         '<a href="learning-path.html?new=1">＋ 生成新的学习路径</a>' +
         '</div>';
    pop.innerHTML = h;
  }
  function libBind() {
    var btn = $('lib-btn'), pop = $('lib-pop'), wrap = $('lib-wrap');
    if (!btn || !pop) return;
    var cnt = $('lib-count');
    if (cnt) { var n = scanMaterials().length; cnt.textContent = ' (' + (n + 1) + ')'; }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) { libRender(); pop.hidden = false; } else { pop.hidden = true; }
    });
    document.addEventListener('click', function (e) {
      if (!pop.hidden && wrap && !wrap.contains(e.target)) pop.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') pop.hidden = true; });
  }

  // ---------- 初始化 ----------
  function init() {
    $('chat-send').addEventListener('click', sendMessage);
    $('chat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMessage(); });
    $('restart-btn').addEventListener('click', restart);
    bindStageNav();
    $('errretry').addEventListener('click', function () { var f = retryFn; hideError(); if (f) f(); });
    window.addEventListener('resize', function () { if (state.plan) drawEdges(); });
    $('backend-label').textContent = API;
    libBind();

    // ?new=1：强制新开（不恢复历史；已有资料仍保留在「学习资料库」里）
    var fresh = false;
    try { fresh = !!new URLSearchParams(location.search).get('new'); } catch (e) {}
    var restored = fresh ? false : loadSave();
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
