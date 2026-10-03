/* 需求采集、研究、计划生成和中断恢复。 */
define("path.workflow", ["path.format", "path.model", "path.persistence", "path.shell", "path.hooks", "path.domain"], function (deps) {
  'use strict';
  var format = deps["path.format"];
  var model = deps["path.model"];
  var persistence = deps["path.persistence"];
  var shell = deps["path.shell"];
  var hooks = deps["path.hooks"];
  var domain = deps["path.domain"];

// ---------- 阶段 A：采集对话 ----------

function appendBubble(role, text) {
    var log = format.$('chat-log');
    var follow = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    var d = document.createElement('div');
    d.className = 'bubble ' + (role === 'user' ? 'me' : 'ai');
    d.innerHTML = '<span class="who">' + (role === 'user' ? '你' : 'AI') + '</span>' + format.esc(text);
    log.appendChild(d);
    if (role === 'user' || follow) log.scrollTop = log.scrollHeight;
  }

function renderChat() {
    var log = format.$('chat-log');
    log.innerHTML = '';
    if (model.state.topic) appendBubble('user', model.state.topic);
    model.state.history.forEach(function (m) { appendBubble(m.role, m.content); });
    if (!model.state.topic) {
      appendBubble('assistant', '你好，我是你的学习助手。先说说你想学什么？例如「Go 语言入门」「Blender 建模」。');
    }
  }

function setChatDisabled(off) {
    format.$('chat-send').disabled = off;
    format.$('chat-send').textContent = off ? '回复中…' : '发送';
    if (model.session.materialsPanel) model.session.materialsPanel.lock(off || model.state.stage !== 'intake');
  }

function sendMessage() {
    if (model.session.busy || (model.session.materialsPanel && model.session.materialsPanel.busy())) return;
    var el = format.$('chat-input');
    var text = (el.value || '').trim();
    if (!text) return;
    el.value = '';
    el.focus({ preventScroll: true });
    shell.hideError();
    if (!model.state.topic) {
      // 首次输入：作为学习主题
      model.state.topic = text;
      model.session.materialSlug = format.slug(text) + '-' + window.LearnJobs.requestId().slice(0, 8);
      var currentURL = new URL(location.href);
      currentURL.searchParams.delete('new');
      currentURL.searchParams.set('t', model.session.materialSlug);
      window.history.replaceState(null, '', currentURL.pathname + currentURL.search);
      appendBubble('user', text);
      persistence.save();
    } else {
      model.state.history.push({ role: 'user', content: text });
      appendBubble('user', text);
      persistence.save();
    }
    callIntake(true);
  }

function callIntake(newMessage) {
    if (newMessage === true) model.state.pending = null;
    setPending('intake');
    model.session.busy = true; setChatDisabled(true);
    var log = format.$('chat-log');
    var thinking = document.createElement('div');
    thinking.className = 'bubble ai';
    thinking.innerHTML = '<span class="who">AI</span><span class="spinner"></span>思考中…';
    var follow = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    log.appendChild(thinking);
    if (follow) log.scrollTop = log.scrollHeight;

    persistence.post('/path/intake', { key: format.storeKey(), topic: model.state.topic, history: model.state.history })
      .then(function (r) {
        thinking.remove();
        model.state.title = window.LearnTitles.document(r);
        hooks.renderDocumentTitle();
        clearPending();
        model.session.busy = false; setChatDisabled(false);
        if (r.done && r.spec) {
          model.state.spec = r.spec; persistence.save();
          renderSpecCard();
          shell.setStage('research');
          startResearch();
        } else {
          model.state.history.push({ role: 'assistant', content: r.question || '请再具体说说你的学习目标？' });
          appendBubble('assistant', r.question || '请再具体说说你的学习目标？');
          persistence.save();
        }
      })
      .catch(function (e) {
        thinking.remove();
        model.session.busy = false; setChatDisabled(false);
        shell.showError('采集失败：' + e.message, callIntake);
      });
  }

function renderSpecCard() {
    var sp = model.state.spec || {};
    var card = format.$('spec-card');
    function row(k, v) {
      return '<tr><th scope="row">' + format.esc(k) + '</th><td>' + format.esc(v || '—') + '</td></tr>';
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
    var previous = model.state.pending;
    var same = previous && previous.kind === kind && (previous.nid || null) === (nid || null);
    model.state.pending = {kind: kind, at: same ? previous.at : Date.now(),
      requestId: same && previous.requestId || window.LearnJobs.requestId()};
    if (nid) model.state.pending.nid = nid;
    persistence.save();
  }

function clearPending() {
    model.state.pending = null;
    model.session.resumeAttempts = 0;
    hideResumeBar();
    persistence.save();
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
    var b = format.$('resume-bar');
    if (!b) return;
    b.innerHTML = '<span class="spinner"></span>' + format.esc(msg || '上次的生成已在服务端继续，正在取回结果…');
    b.hidden = false;
  }

function hideResumeBar() { var b = format.$('resume-bar'); if (b) b.hidden = true; }

// 生成失败且服务端仍在跑：60 秒后自动重试（最多 3 次）。返回 true 表示已接管处理。

function handlePendingFailure(e) {
    if (model.state.pending && isBusyError(e) && model.session.resumeAttempts < 3) {
      model.session.resumeAttempts++;
      showResumeBar('服务端仍在生成，' + 60 + ' 秒后自动重试（第 ' + model.session.resumeAttempts + '/3 次）…');
      setTimeout(replayPending, 60000);
      return true;
    }
    if (model.state.pending) hideResumeBar();   // 失败但保留 pending，下次刷新再试
    return false;
  }

function replayPending() {
    var p = model.state.pending;
    if (!p) { hideResumeBar(); return; }
    if (p.kind === 'intake') callIntake();
    else if (p.kind === 'research') startResearch();
    else if (p.kind === 'plan') continuePlan();
    else if (p.kind === 'node' && p.nid) hooks.selectNode(p.nid);
    else { hideResumeBar(); }
  }

// serverLoad 完成后调用：结果已存在→仅清 pending；否则重放对应阶段

function resumeIfPending() {
    var p = model.state.pending;
    if (!p || !p.kind) return false;
    if (!pendingAlive(p, Date.now())) { model.state.pending = null; persistence.save(); return false; }
    if (p.kind === 'nodes') {   // 批量生成中断：剔除已完成的，继续生成剩余
      var rem = (p.remaining || []).filter(function (id) { return id && !model.state.nodeDetail[id]; });
      if (!rem.length) { model.state.pending = null; persistence.save(); hideResumeBar(); return false; }
      showResumeBar('上次批量生成未完成，继续生成剩余 ' + rem.length + ' 个节点…');
      hooks.genAllStart(rem);
      return true;
    }
    if (pendingHasResult(p, model.state)) {
      var wasNode = (p.kind === 'node' && p.nid && model.state.nodeDetail[p.nid]);
      model.state.pending = null; model.session.resumeAttempts = 0; persistence.save();
      if (wasNode) hooks.selectNode(p.nid);   // 结果已取回：自动展开对应卡片
      return false;
    }
    showResumeBar();
    replayPending();
    return true;
  }

// ---------- 阶段 B：研究 ----------

function startResearch() {
    setPending('research');
    format.$('research-card').hidden = true;
    format.$('research-status').hidden = false;
    format.$('research-status').innerHTML = '<span class="spinner"></span>正在生成检索式并查询资料…';
    shell.hideError();
    return persistence.post('/path/research', { spec: model.state.spec, key: format.storeKey() })
      .then(function (r) {
        model.state.queries = r.queries || [];
        model.state.sources = r.sources || [];
        model.state.research_version = r.research_version || 0;
        model.state.brief = r.brief || '';
        persistence.save();
        renderResearch();
        return continuePlan();
      })
      .catch(function (e) {
        format.$('research-status').innerHTML = '研究失败：' + format.esc(e.message);
        if (handlePendingFailure(e)) { format.$('research-status').hidden = true; return; }
        shell.showError('研究失败：' + e.message, function () {
          format.$('research-status').hidden = false;
          startResearch();
        });
      });
  }

// 只跑「生成路径」一段（research 成功后或自动恢复 plan 时复用）

function continuePlan() {
    setPending('plan');
    format.$('research-status').hidden = false;
    format.$('research-status').innerHTML = '<span class="spinner"></span>研究完成，正在生成学习路径…';
    return persistence.post('/path/plan', { spec: model.state.spec, brief: model.state.brief, key: format.storeKey() })
      .then(function (plan) {
        if (!plan || !plan.nodes || plan.nodes.length < 6) throw new Error('路径节点不足 6 个，请重试');
        domain.normalizePlan(plan);
        model.state.plan = plan;
        model.state.pending = null; model.session.resumeAttempts = 0; hideResumeBar();
        persistence.save();
        format.$('research-status').hidden = true;
        shell.setStage('learning');
        hooks.renderPlan();
        if (model.session.quizCreation) hooks.genQuizMap();
      })
      .catch(function (e) {
        format.$('research-status').innerHTML = '生成路径失败：' + format.esc(e.message);
        if (handlePendingFailure(e)) { format.$('research-status').hidden = true; return; }
        shell.showError('生成学习路径失败：' + e.message, function () {
          format.$('research-status').hidden = false;
          continuePlan();
        });
      });
  }

function renderResearch() {
    var checked = model.state.research_version === 2;
    format.$('research-recheck').hidden = checked || window.LearnUser.readOnly;
    format.$('research-source-note').textContent = checked ? '仅展示通过主题相关性筛选的来源。' : '这些是旧版检索记录，尚未核验主题相关性。可重新核验，不会重建现有学习路径。';
    var chips = model.state.queries.map(function (q) { return '<span class="chip">' + format.esc(q) + '</span>'; }).join('');
    format.$('query-chips').innerHTML = chips || '<span class="empty-note">无检索式</span>';
    var srcs = model.state.sources.map(function (s, i) {
      return '<div class="src"><span class="no">[' + (i + 1) + ']</span><div>' +
        '<a href="' + format.esc(s.url) + '" target="_blank" rel="noopener">' + format.esc(s.title || s.url) + '</a>' +
        ' <span class="dom">' + format.esc(format.domain(s.url)) + '</span>' +
        (s.snippet ? '<span class="snip">' + format.esc(s.snippet) + '</span>' : '') +
        '</div></div>';
    }).join('');
    format.$('source-list').innerHTML = srcs || '<p class="empty-note">未找到通过相关性筛选的来源；后续内容基于已有资料和模型知识，未获网络来源验证。</p>';
    format.$('brief-text').textContent = model.state.brief || '（无简报）';
    format.renderMathIn(format.$('brief-text'));
    format.$('research-card').hidden = false;
  }

function recheckResearch() {
    var button = format.$('research-recheck');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '正在核验…';
    persistence.post('/path/research', { spec: model.state.spec, key: format.storeKey() }).then(function (r) {
      model.state.queries = r.queries || []; model.state.sources = r.sources || [];
      model.state.brief = r.brief || ''; model.state.research_version = r.research_version || 0;
      persistence.save(); renderResearch();
    }).catch(function (e) { shell.showError('来源核验失败：' + e.message, recheckResearch); })
      .finally(function () { button.disabled = false; button.textContent = '重新核验来源'; });
  }

  return Object.freeze({appendBubble: appendBubble, renderChat: renderChat, setChatDisabled: setChatDisabled, sendMessage: sendMessage, callIntake: callIntake, renderSpecCard: renderSpecCard, setPending: setPending, clearPending: clearPending, pendingAlive: pendingAlive, pendingHasResult: pendingHasResult, isBusyError: isBusyError, showResumeBar: showResumeBar, hideResumeBar: hideResumeBar, handlePendingFailure: handlePendingFailure, replayPending: replayPending, resumeIfPending: resumeIfPending, startResearch: startResearch, continuePlan: continuePlan, renderResearch: renderResearch, recheckResearch: recheckResearch});
});
