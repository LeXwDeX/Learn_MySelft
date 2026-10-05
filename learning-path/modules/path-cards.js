/* 单元卡片、展开状态和学习材料视图。 */
define("path.cards", ["path.model", "path.format", "path.shell", "path.domain", "path.hooks", "path.persistence", "path.workflow", "path.generation"], function (deps) {
  'use strict';
  var model = deps["path.model"];
  var format = deps["path.format"];
  var shell = deps["path.shell"];
  var domain = deps["path.domain"];
  var hooks = deps["path.hooks"];
  var persistence = deps["path.persistence"];
  var workflow = deps["path.workflow"];
  var generation = deps["path.generation"];

// ---------- 阶段 C：路径图 ----------

function renderDocumentTitle() {
    var title = window.LearnTitles.document(model.state);
    document.title = title;
    format.$('document-title').textContent = title;
    format.$('plan-title').textContent = title;
  }

function renderPlan() {
    var plan = model.state.plan;
    renderDocumentTitle();
    format.$('plan-summary').textContent = plan.summary || '';
    var layerEl = format.$('graph-layer');
    layerEl.innerHTML = '';
    var visible = domain.planHierarchy(plan.nodes).filter(function (entry) { return !model.session.reviewFilter || domain.markOf(entry.node.id) === 'review'; });
    if (!visible.length) {
      layerEl.innerHTML = '<p class="empty-note">没有标记为「需复习」的单元</p>';
      model.session.expandedId = null; model.session.activeScope = null;
      shell.renderProgress();
      var svg0 = format.$('graph-svg'); if (svg0) svg0.innerHTML = '';
      return;
    }
    var layer = document.createElement('div');
    layer.className = 'layer';
    visible.forEach(function (entry) { layer.appendChild(nodeCard(entry.node, entry)); });
    layerEl.appendChild(layer);
    shell.renderProgress();
    applyCardStates();
    // 重建后恢复手风琴展开的卡片（含卡内内容重渲染）
    if (model.session.expandedId) {
      if (format.$('node-' + model.session.expandedId)) renderCardContent(model.session.expandedId);
      else { model.session.expandedId = null; model.session.activeScope = null; }
    }
    requestAnimationFrame(drawEdges);
  }

// 卡片结构：标题行 → 说明与状态 → 操作区 → 卡体（选项卡+内容）

function nodeCard(n, entry) {
    var done = domain.isDone(n.id);
    var unlocked = domain.isUnlocked(n.id);
    var st = model.state.nodeState[n.id] || {};
    var cls, label;
    if (done) { cls = 'done'; label = '✅ 已完成'; }
    else if (!unlocked) { cls = 'locked'; label = '🔒 锁定'; }
    else if (typeof st.score === 'number' && st.score < 60) { cls = 'failed'; label = '❌ 自测未过'; }
    else { cls = 'unlocked'; label = '可学习'; }
    var el = document.createElement('article');
    el.className = 'node ' + cls;
    el.id = 'node-' + n.id;
    el.dataset.id = n.id;
    entry = entry || domain.hierarchyEntry(n.id);
    var hues = [212, 354, 155, 275, 32, 186];
    var hue = hues[entry.root_index % hues.length];
    el.dataset.group = entry.root_id;
    el.dataset.depth = entry.depth;
    el.style.setProperty('--group-color', 'hsl(' + hue + ', 58%, ' + (entry.depth === 1 ? 45 : 66 + Math.min(entry.depth - 2, 2) * 5) + '%)');
    el.innerHTML = '<div class="node-head">' +
      '<span class="node-caret">▸</span>' +
      '<span class="node-no">' + format.esc(domain.dispId(n.id)) + '</span>' +
      '<h3 class="node-title">' + format.esc(n.title) + '</h3></div>' +
      '<div class="node-description"><p class="node-ess">' + format.esc(n.essence || '') + '</p>' +
      '<div class="node-state"><span class="status ' + cls + '">' + label + '</span></div></div>' +
      '<div class="node-foot" role="group" aria-label="单元操作"><div class="marks" role="group" aria-label="学习状态">' + shell.markButtonsHtml(n.id, 'mini') + '</div>' +
      '<button class="btn ai-mini" type="button" data-ai="' + format.esc(n.id) + '">AI 辅助</button></div>' +
      '<div class="node-content" hidden></div>';
    el.querySelectorAll('.node-foot .mark-btn').forEach(function (button) {
      button.classList.remove('mini');
      button.classList.add('btn');
    });
    el.addEventListener('click', function () { onCardClick(n.id); });
    shell.bindMarkButtons(el, n.id);
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
    if (!model.state.plan) return;
    model.state.plan.nodes.forEach(function (n) {
      var el = format.$('node-' + n.id);
      if (!el) return;
      el.classList.toggle('selected', n.id === model.session.selectedId);
      el.classList.toggle('expanded', n.id === model.session.expandedId);
      var c = el.querySelector('.node-caret');
      if (c) c.textContent = (n.id === model.session.expandedId) ? '▾' : '▸';
      var content = el.querySelector('.node-content');
      if (content) content.hidden = (n.id !== model.session.expandedId);
    });
  }

// 选中单元（仅更新右侧 Agent 上下文与高亮，不展开）

function selectUnit(id) {
    model.session.selectedId = id;
    applyCardStates();
    hooks.renderAgentPanel();
  }

// 展开卡片（手风琴：不切换）

function expandCard(id) {
    var n = domain.nodeById(id);
    if (!n) return;
    model.session.expandedId = id;
    applyCardStates();
    renderCardContent(id);
    requestAnimationFrame(drawEdges);
  }

function collapseCard() {
    model.session.expandedId = null;
    model.session.activeScope = null;
    applyCardStates();
    requestAnimationFrame(drawEdges);
  }

// 点卡片：选中 + 手风琴切展/收（锁定卡不展开）

function onCardClick(id) {
    selectUnit(id);
    if (model.session.expandedId === id) { collapseCard(); return; }
    var n = domain.nodeById(id);
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
    hooks.showAgent();
  }

// 卡内内容：未生成→卡内 loading 并请求 /path/node；已生成→渲染选项卡正文

function cardContentEl(id) {
    var card = format.$('node-' + id);
    return card ? card.querySelector('.node-content') : null;
  }

function renderCardContent(id) {
    var scope = cardContentEl(id);
    if (!scope) return;
    model.session.activeScope = scope;
    if (model.state.nodeDetail[id]) { hooks.renderNodeDetail(id); return; }
    if (generation.isRunning()) {   // 批量进行中：忽略单节点生成并轻提示
      scope.innerHTML = '<p class="tip">批量生成进行中，请稍候…</p>';
      return;
    }
    if (model.session.generatingNode === id) {   // 已在生成：重建后仍显示卡内 loading，不重复请求
      scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
      return;
    }
    if (!domain.isUnlocked(id) && !domain.isDone(id)) {
      var missing = domain.depsOf(id).filter(function (dependency) { return !domain.isDone(dependency); });
      scope.innerHTML = '<p class="tip">本单元尚未解锁。请先通过前置单元测验，并点击“完成本节点并解锁下一节点”。“已掌握”等手动标记不会自动解锁。</p>' +
        missing.map(function (dependency) {
          var parent = domain.nodeById(dependency);
          return '<button class="btn prerequisite" type="button" data-node="' + format.esc(dependency) + '">前往 ' + format.esc(domain.dispId(dependency) + ' · ' + (parent ? parent.title : '前置单元')) + '</button>';
        }).join('');
      scope.querySelectorAll('.prerequisite').forEach(function (button) {
        button.onclick = function () { selectNode(button.dataset.node); };
      });
      return;
    }
    scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成学习材料（可能需要 30~90 秒）…</p>';
    requestAnimationFrame(drawEdges);
    model.session.generatingNode = id;
    model.session.nodeMaterialStatus[id] = 'generating';
    hooks.syncAiMaterial(id);
    workflow.setPending('node', id);
    hooks.requestNodeDetail(id).then(function (detail) {
      model.session.generatingNode = null;
      model.state.nodeDetail[id] = detail;
      hooks.syncAiMaterial(id);
      model.state.pending = null; model.session.resumeAttempts = 0; workflow.hideResumeBar();
      persistence.save();
      if (model.session.expandedId === id) hooks.renderNodeDetail(id);
    }).catch(function (e) {
      model.session.generatingNode = null;
      model.session.nodeMaterialStatus[id] = 'failed';
      hooks.syncAiMaterial(id);
      if (model.session.expandedId !== id) return;
      if (workflow.handlePendingFailure(e)) {
        scope.innerHTML = '<p class="tip">服务端仍在生成本节点材料，稍后自动重试…</p>';
        return;
      }
      scope.innerHTML = '<p class="tip">生成失败：' + format.esc(e.message) + '</p>' +
        '<button class="btn primary reload-node" type="button">重试生成</button>';
      var rb = scope.querySelector('.reload-node');
      if (rb) rb.addEventListener('click', function (e2) {
        e2.stopPropagation();
        delete model.state.nodeDetail[id]; persistence.save(); renderCardContent(id);
      });
      shell.showError('学习材料生成失败：' + e.message, function () {
        delete model.state.nodeDetail[id]; persistence.save(); renderCardContent(id);
      });
    });
  }

function drawEdges() {
    var wrap = format.$('graph-wrap'), svg = format.$('graph-svg');
    if (!model.state.plan || !wrap || !svg) return;
    var wr = wrap.getBoundingClientRect();
    svg.setAttribute('width', wrap.clientWidth);
    svg.setAttribute('height', wrap.clientHeight);
    var parts = [];
    (model.state.plan.edges || []).forEach(function (e) {
      var a = document.getElementById('node-' + e[0]);
      var b = document.getElementById('node-' + e[1]);
      if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var x1 = ra.left - wr.left + ra.width / 2, y1 = ra.bottom - wr.top;
      var x2 = rb.left - wr.left + rb.width / 2, y2 = rb.top - wr.top;
      var my = (y1 + y2) / 2;
      var d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2;
      var ok = domain.isDone(e[0]);
      parts.push('<path d="' + d + '" fill="none" stroke="' + (ok ? '#2f7d5d' : '#c9ced8') +
        '" stroke-width="2"' + (ok ? '' : ' stroke-dasharray="5 4"') + '/>');
    });
    svg.innerHTML = parts.join('');
  }

  return Object.freeze({renderDocumentTitle: renderDocumentTitle, renderPlan: renderPlan, nodeCard: nodeCard, applyCardStates: applyCardStates, selectUnit: selectUnit, expandCard: expandCard, collapseCard: collapseCard, onCardClick: onCardClick, selectNode: selectNode, openAiView: openAiView, cardContentEl: cardContentEl, renderCardContent: renderCardContent, drawEdges: drawEdges});
});
