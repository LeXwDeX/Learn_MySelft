/* 单元 AI 对话、流式输出和手机辅导窗口。 */
define("path.assistant", ["path.format", "path.model", "path.domain", "path.persistence"], function (deps) {
  'use strict';
  var format = deps["path.format"];
  var model = deps["path.model"];
  var domain = deps["path.domain"];
  var persistence = deps["path.persistence"];
  var session = {};

// ---------- 右面板：节点详情 ----------

function panelHead(id, title, ess, sub) {
    format.$('panel-id').textContent = sub || id;
    format.$('panel-title').textContent = title;
    format.$('panel-ess').textContent = ess || '';
  }

function setFoot(html) {
    var f = format.$('panel-foot');
    if (html) { f.innerHTML = html; f.hidden = false; } else { f.innerHTML = ''; f.hidden = true; }
  }

// ---------- 右侧面板：纯 Agent 区（只做 AI 对话；正文/测验在卡片里） ----------

function renderAgentPanel() {
    if (!model.session.selectedId || !domain.nodeById(model.session.selectedId)) {
      format.$('plan-current-unit').textContent = '选择单元开始学习';
      panelHead('AGENT', 'AI 学习助手', '点击左侧卡片展开学习，或点卡片上的「AI 辅助」与 AI 交互式学习。');
      format.$('panel-body').innerHTML = '<p class="tip">选一个单元，AI 会带你交互式学习：讲解、追问、出小题检验你，不直接给答案。</p>';
      setFoot('');
      session.refreshAgentLayout();
      return;
    }
    var n = domain.nodeById(model.session.selectedId);
    format.$('plan-current-unit').textContent = domain.dispId(model.session.selectedId) + ' · ' + n.title;
    panelHead('正在辅导', domain.dispId(model.session.selectedId) + ' · ' + n.title, n.essence || '');
    renderAiPanel(model.session.selectedId);
    session.refreshAgentLayout();
  }

session.aiViews = new Map();

session.aiViewKey = null;

session.activeAiView = null;

session.aiBusy = false;

session.aiLayoutMoving = false;

session.refreshAgentLayout = function () {};

function bindAgentLayout() {
    var dialog = format.$('agent-dialog'), panel = format.$('node-panel');
    var workspace = panel.parentElement;
    var oldOverflow = '', oldAnchor = '', readingX = 0, readingY = 0;
    var readingFrame = null, viewFrame = null, expanded = false, priorFocus = null, returnView = null, movingView = null;
    var expandButton = format.$('agent-expand'), closeButton = format.$('agent-close');
    function captureView(useStored) {
      var view = session.activeAiView;
      session.aiLayoutMoving = true;
      if (!view) return null;
      return {view: view, top: !useStored && view.box.clientHeight ? view.box.scrollTop : view.scrollTop,
        follow: view.follow, start: view.input.selectionStart, end: view.input.selectionEnd,
        direction: view.input.selectionDirection,
        anchor: movingView && movingView.view === view ? movingView.anchor : view.box.style.overflowAnchor};
    }
    function restoreView(saved) {
      if (viewFrame !== null) cancelAnimationFrame(viewFrame);
      if (!saved) { session.aiLayoutMoving = false; return; }
      movingView = saved;
      saved.view.box.style.overflowAnchor = 'none';
      function restore() {
        saved.view.box.scrollTop = saved.top;
        // A wider window can shorten the conversation. Keep the requested
        // position for return even when the browser temporarily clamps it.
        saved.view.scrollTop = saved.top;
        saved.view.follow = saved.follow;
        saved.view.input.setSelectionRange(saved.start, saved.end, saved.direction);
      }
      restore();
      viewFrame = requestAnimationFrame(function () {
        restore();
        viewFrame = requestAnimationFrame(function () {
          viewFrame = null;
          restore();
          saved.view.box.style.overflowAnchor = saved.anchor;
          movingView = null;
          session.aiLayoutMoving = false;
        });
      });
    }
    function updateLayout() {
      var mobile = window.matchMedia('(max-width:800px)').matches;
      if (!mobile && dialog.open && !expanded) {
        returnView = captureView(true);
        window.LearnUI.dialog.close(dialog);
      }
      var toolbar = document.querySelector('.toolbar');
      var top = Math.max(0, toolbar.getBoundingClientRect().bottom);
      document.documentElement.style.setProperty('--agent-top', top + 'px');
      if (!mobile && panel.parentElement === workspace) {
        var visibleTop = Math.max(top, panel.getBoundingClientRect().top);
        panel.style.setProperty('--agent-height', Math.max(0, window.innerHeight - visibleTop) + 'px');
      }
    }
    session.refreshAgentLayout = updateLayout;
    format.$('agent-launch').addEventListener('click', showAgent);
    expandButton.addEventListener('click', function () { dialog.openAgent(true); });
    closeButton.addEventListener('click', function () { window.LearnUI.dialog.close(dialog); });
    dialog.addEventListener('close', function () {
      var saved = returnView || captureView();
      returnView = null;
      workspace.appendChild(panel);
      expanded = false;
      expandButton.hidden = false;
      closeButton.hidden = true;
      document.body.style.overflow = oldOverflow;
      updateLayout();
      window.scrollTo(readingX, readingY);
      if (priorFocus && priorFocus.isConnected) priorFocus.focus({preventScroll: true});
      restoreView(saved);
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
    dialog.addEventListener('click', function (e) {
      if (e.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) window.LearnUI.dialog.close(dialog);
    });
    dialog.openAgent = function (enlarge) {
      if (dialog.open) return;
      var saved = captureView();
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
      priorFocus = document.activeElement;
      // WebKit mouse clicks can leave body focused instead of the opener.
      if (!priorFocus || priorFocus === document.body) priorFocus = enlarge ? expandButton : format.$('agent-launch');
      expanded = !!enlarge;
      expandButton.hidden = true;
      closeButton.hidden = false;
      dialog.appendChild(panel);
      window.LearnUI.dialog.open(dialog, closeButton);
      restoreView(saved);
    };
    window.addEventListener('resize', function () {
      if (dialog.open && expanded) restoreView(captureView(true));
      updateLayout();
    });
    var layoutFrame = null;
    window.addEventListener('scroll', function () {
      if (layoutFrame !== null) return;
      layoutFrame = requestAnimationFrame(function () { layoutFrame = null; updateLayout(); });
    }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(updateLayout).observe(document.querySelector('.toolbar'));
    updateLayout();
  }

function showAgent() {
    if (window.matchMedia('(max-width:800px)').matches) format.$('agent-dialog').openAgent();
    else if (format.$('ai-input')) format.$('ai-input').focus({ preventScroll: true });
  }

session.AI_SUGGEST = ['讲讲本单元的重点', '出个小题目考我', '本单元有哪些常见误区？'];

session.AI_PREVIEW_SUGGEST = ['学习这个单元前需要哪些基础？', '帮我理解这个单元的学习目标', '等待材料时，我可以怎样预习？'];

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
    var n = domain.nodeById(id) || {};
    var d = model.state.nodeDetail[id] || {};
    var kp = (d.key_points && d.key_points.length) ? d.key_points : (n.objectives || []);
    var traps = (d.traps && d.traps.length) ? d.traps : (d.misconceptions || []);
    var quizzes = ((d.quiz && d.quiz.questions) || []).slice(0, 6).map(function (q) {
      return { q: q.q, a: q.answer, answer: q.answer };
    });
    return {
      unit_id: domain.dispId(id), unit_title: n.title || '', domain: model.state.topic || '',
      learner_level: String((model.state.spec || {}).level || '').slice(0, 200),
      learning_goal: String((model.state.spec || {}).goal || '').slice(0, 400),
      essence: n.essence || '', musts: kp, traps: traps, quizzes: quizzes,
      notes: d.study_notes ? String(d.study_notes).slice(0, 6000) : '',
      material_status: aiMaterialStatus(id)
    };
  }

// (aiUnit end)

function aiMaterialStatus(id) {
    if (model.state.nodeDetail[id]) return 'ready';
    if (model.session.nodeMaterialStatus[id]) return model.session.nodeMaterialStatus[id];
    return model.state.pending && model.state.pending.kind === 'node' && model.state.pending.nid === id ? 'generating' : 'missing';
  }

function syncAiMaterial(id) {
    var view = session.aiViews.get(id);
    if (!view) return;
    var status = aiMaterialStatus(id);
    var ready = status === 'ready';
    var label = ready ? '学习材料已就绪' : status === 'generating' ? '学习材料正在生成' : status === 'failed' ? '学习材料生成失败，请在左侧重试' : '学习材料尚未生成';
    view.root.querySelector('.ai-intro').textContent = label + (ready ? '，可以结合正文讲解和练习。' : '。可以先聊前置知识和学习目标。');
    view.root.querySelector('.ai-note').textContent = ready ? 'AI 可参考本单元材料；个人薄弱点需结合你的实际作答判断。可用图形和动画讲解关系、变化过程与推导。' : 'AI 当前仅有单元标题和学习目标，还没有本单元正文。材料就绪后，可用图形和动画讲解关系、变化过程与推导。';
    view.input.placeholder = ready ? '就本单元提问，Enter 发送 / Shift+Enter 换行' : '可以先问学习目标或前置知识';
    var methods = view.root.querySelector('.ai-methods');
    if (methods && !methods.childNodes.length) {
      ['画图解释', '动画演示', '用表格对比', '举个例子', '分步推导'].forEach(function (method) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'ai-method'; button.textContent = method;
        button.onclick = function () {
          var available = aiMaterialStatus(id) === 'ready';
          var request = method === '动画演示' ? '用本系统已有的交互动画分步解释本单元最适合观察的概念，让我能操作参数或控制步骤；先讲清概念与图形的关系。' : method + '，选择适合讲解的内容；';
          sendAi(id, (available ? '结合本单元及当前对话，' : '正文尚未就绪，请仅对前置知识做预习说明：') + request + '不要透露我正在作答题目的答案。');
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
      (ready ? session.AI_SUGGEST : session.AI_PREVIEW_SUGGEST).forEach(function (text) {
        var button = document.createElement('button');
        button.className = 'ai-chip'; button.type = 'button'; button.textContent = text;
        button.addEventListener('click', function () { sendAi(id, text); });
        empty.appendChild(button);
      });
    }
  }

function aiScroll(view, force) {
    view = view || session.activeAiView;
    if (!view) return;
    if (session.aiLayoutMoving) return;
    if (force) view.follow = true;
    if (view.follow && view.root.isConnected && view.box.clientHeight) {
      view.box.scrollTop = view.box.scrollHeight;
      view.scrollTop = view.box.scrollTop;
      view.more.hidden = true;
    } else if (!force) view.more.hidden = false;
  }

function syncAiBusy() {
    session.aiViews.forEach(function (view) {
      view.send.disabled = session.aiBusy;
      view.send.textContent = session.aiBusy ? '回复中…' : '发送';
      view.send.title = session.aiBusy ? 'AI 正在回复，可以继续编辑下一条问题' : '';
    });
  }

function aiRenderInto(el, text, streaming) {
    if (!el) return;
    if (window.LearnMarkdown && window.LearnMarkdown.dispose) window.LearnMarkdown.dispose(el);
    el.innerHTML = format.mdRender(text, {streaming:!!streaming});
    if (!streaming && window.LearnMarkdown) window.LearnMarkdown.exportButton(el, text, "AI讲解.md");
    format.renderMathIn(el);
    format.highlightIn(el);
  }

function aiBubble(role, content) {
    var d = document.createElement('div');
    d.className = 'ai-msg ' + (role === 'user' ? 'user' : 'assistant');
    var b = document.createElement('div');
    b.className = 'ai-bubble';
    if (role === 'user') b.textContent = content;
    else {
      b.innerHTML = format.mdRender(content);
      if (content && window.LearnMarkdown) window.LearnMarkdown.exportButton(b, content, 'AI讲解.md');
    }
    d.appendChild(b);
    return d;
  }

function renderAiPanel(id) {
    var n = domain.nodeById(id);
    if (!n) return;
    if (session.aiViewKey !== format.aiKey()) {
      session.aiViews.clear();
      session.activeAiView = null;
      session.aiViewKey = format.aiKey();
    }
    if (session.activeAiView && session.activeAiView.box.clientHeight) session.activeAiView.scrollTop = session.activeAiView.box.scrollTop;
    var cached = session.aiViews.get(id);
    if (cached) {
      format.$('panel-body').replaceChildren(cached.root);
      session.activeAiView = cached;
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
    format.$('panel-body').replaceChildren(root);
    setFoot('');
    var msgs = model.state.aiHist[id] || [];
    var box = format.$('ai-msgs');
    if (!msgs.length) {
      box.innerHTML = '<div class="ai-empty"></div>';
    } else {
      msgs.forEach(function (m) { box.appendChild(aiBubble(m.role, m.content)); });
    }
    format.renderMathIn(box);
    format.highlightIn(box);
    var input = format.$('ai-input');
    format.bindAutoGrow(input);
    var send = format.$('ai-send');
    var view = { root: root, box: box, input: input, send: send, more: root.querySelector('.ai-new-reply'), follow: true, scrollTop: 0 };
    session.aiViews.set(id, view);
    session.activeAiView = view;
    syncAiMaterial(id);
    box.addEventListener('scroll', function () {
      if (!box.clientHeight || session.aiLayoutMoving) return;
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
    if (session.aiBusy) return;
    var q = String(text == null ? '' : text).trim();
    if (!q) return;
    var msgs = model.state.aiHist[id] || (model.state.aiHist[id] = []);
    var hist = aiHistTail(msgs, 16);
    msgs.push({ role: 'user', content: aiClip(q, 4000) });
    aiHistTrim(msgs, 60);
    model.state.aiHist[id] = msgs;
    persistence.saveAi();
    var view = session.aiViews.get(id);
    var input = view.input;
    if (input) { input.value = ''; input.style.height = ''; }
    var box = view.box;
    if (box) { var em = box.querySelector('.ai-empty'); if (em) em.remove(); box.appendChild(aiBubble('user', q)); }
    aiScroll(view, true);
    session.aiBusy = true;
    syncAiBusy();
    input.focus({ preventScroll: true });
    var target = aiBubble('assistant', '');
    var body = target.querySelector('.ai-bubble');
    body.innerHTML = '<span class="spinner"></span>思考中…';
    var generationStatus = document.createElement('p');
    generationStatus.className = 'learn-manim-status';
    generationStatus.setAttribute('role', 'status');
    generationStatus.hidden = true;
    target.appendChild(generationStatus);
    if (box) box.appendChild(target);
    aiScroll(view, true);
    var acc = '';
    window.LearnUser.fetch(model.session.API + '/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: format.storeKey(), node: { id: id }, unit: aiUnit(id), question: q, history: hist })
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
            if (typeof obj.status === 'string' && obj.status) {
              generationStatus.textContent = obj.status;
              generationStatus.hidden = false;
              aiScroll(view);
            }
            if (obj.error) acc += '\n[出错] ' + obj.error;
            if (obj.delta) { acc += obj.delta; aiRenderInto(body, acc, true); aiScroll(view); }
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      generationStatus.remove();
      if (!acc) acc = '（没有返回内容，请重试。）';
      aiFinish(id, body, acc, view);
    }).catch(function (e) {
      generationStatus.remove();
      if (!acc) acc = '请求失败：' + ((e && e.message) || e);
      aiFinish(id, body, acc, view);
    });
  }

function aiFinish(id, body, acc, view) {
    aiRenderInto(body, acc);
    var msgs = model.state.aiHist[id] || (model.state.aiHist[id] = []);
    msgs.push({ role: 'assistant', content: acc });
    aiHistTrim(msgs, 60);
    model.state.aiHist[id] = msgs;
    persistence.saveAi();
    session.aiBusy = false;
    syncAiBusy();
    aiScroll(view);
  }

  return Object.freeze({panelHead: panelHead, setFoot: setFoot, renderAgentPanel: renderAgentPanel, bindAgentLayout: bindAgentLayout, showAgent: showAgent, aiClip: aiClip, aiHistTail: aiHistTail, aiHistTrim: aiHistTrim, aiUnit: aiUnit, aiMaterialStatus: aiMaterialStatus, syncAiMaterial: syncAiMaterial, aiScroll: aiScroll, syncAiBusy: syncAiBusy, aiRenderInto: aiRenderInto, aiBubble: aiBubble, renderAiPanel: renderAiPanel, sendAi: sendAi, aiFinish: aiFinish});
});
