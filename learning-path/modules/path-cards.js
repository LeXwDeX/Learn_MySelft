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

// One reading surface; the path is a directory opened only on request.
var accessPending = false, accessNode = null, accessTarget = null, bound = false;
var readingSelection = null;
function anchorKey() { return 'learn-workspace-v1:' + format.storeKey(); }
function rememberNode(id) {
    if (!document.body.classList.contains('workspace-reading')) return;
    try {
      var url = new URL(location.href); url.searchParams.set('node', id);
      window.history.replaceState(null, '', url.pathname + url.search);
      sessionStorage.setItem(anchorKey(), JSON.stringify({node: id, scroll: window.scrollY}));
    } catch (error) { /* Navigation remains usable without browser storage. */ }
  }
function captureReadingPosition() {
    if (!document.body.classList.contains('workspace-reading') || !model.session.selectedId) return;
    model.session.readingScrollY = window.scrollY;
    rememberNode(model.session.selectedId);
  }
function restoredNode() {
    try {
      var requested = new URLSearchParams(location.search).get('node');
      if (domain.nodeById(requested)) return requested;
      var saved = JSON.parse(sessionStorage.getItem(anchorKey()) || 'null');
      if (saved && domain.nodeById(saved.node)) return saved.node;
    } catch (error) {}
    var nodes = model.state.plan.nodes;
    var next = nodes.find(function (node) { return domain.canAccess(node.id) && !domain.isDone(node.id); });
    return next ? next.id : nodes.length ? nodes[0].id : null;
  }
function renderDocumentTitle() {
    var title = window.LearnTitles.document(model.state);
    document.title = title;
    format.$('document-title').textContent = title;
    format.$('plan-title').textContent = title;
  }
function renderPlan() {
    var plan = model.state.plan; if (!plan) return;
    renderDocumentTitle();
    format.$('plan-summary').textContent = plan.summary || '';
    format.$('workspace-goal').hidden = !model.state.spec && !(model.state.history || []).length;
    format.$('workspace-research').hidden = !model.state.spec;
    var key = format.storeKey(), savedPosition = null, changedWorkspace = model.session.workspaceKey !== key;
    if (model.session.workspaceKey !== key) {
      model.session.workspaceKey = key; model.session.selectedId = null; model.session.readingScrollY = null;
      try { savedPosition = JSON.parse(sessionStorage.getItem(anchorKey()) || 'null'); } catch (error) {}
    }
    var id = domain.nodeById(model.session.selectedId) ? model.session.selectedId : restoredNode();
    model.session.selectedId = id; model.session.expandedId = id;
    if (changedWorkspace && id) { selectNode(id, {focus: false, restoreScroll: savedPosition && savedPosition.node === id ? savedPosition.scroll : null}); return; }
    refreshDirectory();
    var layer = format.$('graph-layer'); layer.innerHTML = '';
    if (id) { layer.appendChild(nodeCard(domain.nodeById(id))); renderCardContent(id); rememberNode(id); }
    else layer.innerHTML = '<p class="tip">当前资料尚无学习单元。</p>';
    if (savedPosition && savedPosition.node === id && Number.isFinite(savedPosition.scroll)) requestAnimationFrame(function () { window.scrollTo(0, savedPosition.scroll); });
    shell.renderProgress();
    hooks.renderAgentPanel();
    if (!domain.canAccess(id)) { var dialog = format.$('agent-dialog'); if (dialog.open) window.LearnUI.dialog.close(dialog);
    }
  }
function refreshDirectory() {
    var plan = model.state.plan; if (!plan) return;
    var id = model.session.selectedId;
    var directory = format.$('path-directory'); directory.innerHTML = '';
    domain.planHierarchy(plan.nodes).filter(function (entry) { return !model.session.reviewFilter || domain.markOf(entry.node.id) === 'review'; }).forEach(function (entry) {
      var n = entry.node, button = document.createElement('button');
      button.className = 'workspace-path-unit'; button.type = 'button';
      button.setAttribute('aria-current', String(id === n.id));
      button.innerHTML = '<strong>' + format.esc(domain.dispId(n.id) + ' · ' + n.title) + '</strong><span>' +
        format.esc(domain.isDone(n.id) ? '已完成' : !domain.canAccess(n.id) ? ((model.state.nodeAccess || {})[n.id] === 'locked' ? '已手动锁定' : '前置未完成') : model.state.nodeDetail[n.id] ? '可继续阅读' : '正文尚未生成') + '</span>';
      button.onclick = function () { window.LearnUI.dialog.close(format.$('path-dialog')); selectNode(n.id); };
      directory.appendChild(button);
    });
    if (!directory.children.length) directory.textContent = '没有标记为「需复习」的单元。';
  }
function nodeCard(n) {
    var el = document.createElement('article'); el.className = 'node workspace-unit'; el.id = 'node-' + n.id; el.dataset.id = n.id;
    var entry = domain.hierarchyEntry(n.id);
    el.dataset.group = entry.root_id; el.dataset.depth = entry.depth;
    el.innerHTML = '<header class="workspace-unit-header"><h2 class="workspace-title" tabindex="-1">' + format.esc(n.title) + '</h2>' +
      '<div class="workspace-actions" role="group" aria-label="单元标记与辅助"><div class="marks" role="group" aria-label="学习标记">' + shell.markButtonsHtml(n.id, '') + '</div>' +
      '<span class="workspace-divider" aria-hidden="true">|</span><button class="btn workspace-ai" type="button"' + (!domain.canAccess(n.id) ? ' disabled' : '') + '>AI 辅助</button>' +
      '<button class="btn workspace-access" type="button"' + (window.LearnUser.readOnly || model.session.readingAccessPending ? ' disabled' : '') + '>' + (domain.canAccess(n.id) ? '锁定此单元' : '解锁此单元') + '</button></div>' +
      (domain.isDone(n.id) ? '<p class="workspace-completed">本单元已完成' + (typeof (model.state.nodeState[n.id] || {}).score === 'number' ? ' · 最近自测 ' + format.esc(model.state.nodeState[n.id].score) + ' 分' : '') + '</p>' : '') +
      '</header><div class="node-content"></div>';
    shell.bindMarkButtons(el, n.id);
    el.querySelector('.workspace-ai').onclick = function () { openAiView(n.id); };
    el.querySelector('.workspace-access').onclick = function () { openAccess(n.id); };
    return el;
  }
function selectUnit(id) { if (!domain.nodeById(id)) return; model.session.selectedId = id; model.session.expandedId = id; rememberNode(id); }
function selectionCurrent(selection) {
    return readingSelection === selection && selection.key === format.storeKey() && model.session.selectedId === selection.id &&
      selection.viewSerial === (model.session.readingViewSerial || 0) && document.body.classList.contains('workspace-reading');
  }
function selectNode(id, options) {
    if (!domain.nodeById(id)) return Promise.resolve();
    var key = format.storeKey(), viewSerial = model.session.readingViewSerial || 0;
    if (model.session.workspaceKey !== key) { model.session.workspaceKey = key; model.session.readingScrollY = null; }
    if (readingSelection && !readingSelection.settled && model.session.readingAccessPending === readingSelection && readingSelection.key === key && readingSelection.id === id && readingSelection.viewSerial === viewSerial) {
      readingSelection.recovering = readingSelection.recovering || !!model.session.recoveringGeneration;
      return readingSelection.promise;
    }
    var selection = {id: id, key: key, viewSerial: viewSerial, recovering: !!model.session.recoveringGeneration, focus: !options || options.focus !== false, restoreScroll: options && options.restoreScroll};
    readingSelection = selection; model.session.readingAccessPending = selection;
    selectUnit(id); renderPlan();
    selection.promise = persistence.ensureNodeExists(id).then(function () {
      if (!selectionCurrent(selection)) return;
      model.session.readingAccessPending = null;
      renderPlan();
      if (selection.recovering && !model.state.nodeDetail[id]) renderCardContent(id, {generate: true, recovering: true});
      var card = format.$('node-' + id), title = card && card.querySelector('.workspace-title');
      if (title && selection.focus) { title.focus({preventScroll: true}); title.scrollIntoView({block: 'start'}); }
      if (Number.isFinite(selection.restoreScroll)) requestAnimationFrame(function () { if (selectionCurrent(selection)) window.scrollTo(0, selection.restoreScroll); });
    }).catch(function (error) {
      if (!selectionCurrent(selection)) return;
      if (error.staleAccess) { readingSelection = null; return selectNode(id, options); }
      model.session.readingAccessPending = null;
      model.session.accessUnavailable = true;
      selection.error = error.message; renderPlan();
    }).finally(function () { selection.settled = true; });
    return selection.promise;
  }
function currentAction(id) {
    var key = format.storeKey(), viewSerial = model.session.readingViewSerial || 0, selection = readingSelection;
    return function () { return key === format.storeKey() && model.session.selectedId === id && selection === readingSelection &&
      viewSerial === (model.session.readingViewSerial || 0) && document.body.classList.contains('workspace-reading'); };
  }
function openAiView(id) {
    var current = currentAction(id);
    return persistence.ensureAccess(id).then(function () {
      if (current() && domain.canAccess(id)) hooks.showAgent(true);
    }).catch(function (error) { if (current()) shell.showError(error.message); });
  }
function cardContentEl(id) { var card = format.$('node-' + id); return card ? card.querySelector('.node-content') : null; }
function generateUnit(id) {
    if (window.LearnUser.readOnly) return Promise.resolve();
    var current = currentAction(id);
    return persistence.ensureAccess(id).then(function () { if (current()) renderCardContent(id, {generate: true, manualRetry: true}); }).catch(function (error) { if (current()) shell.showError(error.message); });
  }
function openAccess(id) {
    if (window.LearnUser.readOnly || accessPending || !domain.nodeById(id)) return;
    accessNode = id; accessTarget = domain.canAccess(id) ? 'locked' : 'unlocked';
    format.$('access-title').textContent = accessTarget === 'locked' ? '锁定此单元' : '解锁此单元';
    format.$('access-description').textContent = domain.nodeById(id).title + '：' + (accessTarget === 'locked' ? '锁定后，正文、AI 辅助和自测暂时不可用。已有内容、成绩和草稿会保留。' : '只解锁当前单元，不改变完成状态、成绩或其他单元。');
    format.$('access-confirm').textContent = accessTarget === 'locked' ? '确认锁定' : '确认解锁';
    window.LearnUI.dom.showError('access-error', '', 'access-password');
    window.LearnUI.dialog.open(format.$('access-dialog'), format.$('access-password'));
  }
function submitAccess(event) {
    event.preventDefault();
    if (accessPending || window.LearnUser.readOnly || !accessNode) return;
    var input = format.$('access-password'); if (!input.value) { window.LearnUI.dom.showError('access-error', '请输入当前登录密码', input); input.focus(); return; }
    var key = format.storeKey(), id = accessNode, target = accessTarget;
    accessPending = true; format.$('access-confirm').disabled = true; format.$('access-cancel').disabled = true;
    format.$('access-form').setAttribute('aria-busy', 'true');
    window.LearnUI.dom.showError('access-error', '', input);
    persistence.post('/state/node-access', {key: key, node_id: id, access: target, password: input.value}).then(function (result) {
      if (!result.ok || !result.nodeAccess) throw new Error('服务器未确认访问状态，请重试');
      if (format.storeKey() !== key) return;
      persistence.applyNodeAccess(result.nodeAccess); model.session.accessUnavailable = false;
      window.LearnUI.dialog.close(format.$('access-dialog')); renderPlan();
      var title = format.$('node-' + id); if (title) title.querySelector('.workspace-title').focus({preventScroll:true});
    }).catch(function (error) { window.LearnUI.dom.showError('access-error', error.message, input); input.value = ''; input.focus();
      // Failed authorization, deletion and lost responses must not expose cached content.
      persistence.refreshAccess().catch(function () {});
    }).finally(function () {
      accessPending = false; format.$('access-confirm').disabled = false; format.$('access-cancel').disabled = false;
      format.$('access-form').removeAttribute('aria-busy');
    });
  }
function openDirectory() { window.LearnUI.dialog.open(format.$('path-dialog'), format.$('path-close')); }
function bindWorkspace() {
    if (bound) return; bound = true;
    var path = format.$('path-dialog'), dialog = format.$('access-dialog');
    window.LearnUI.dialog.bind(path, format.$('path-close'));
    format.$('path-open').onclick = openDirectory;
    window.LearnUI.dialog.bind(dialog, null, function () { accessNode = null; accessTarget = null; window.LearnUI.dom.showError('access-error', '', 'access-password'); });
    format.$('access-cancel').onclick = function () { if (!accessPending) window.LearnUI.dialog.close(dialog); };
    dialog.addEventListener('keydown', function (event) { if (event.key === 'Escape' && accessPending) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    dialog.addEventListener('cancel', function (event) { if (accessPending) event.preventDefault(); });
    format.$('access-form').addEventListener('submit', submitAccess);
    window.addEventListener('focus', function () {
      if (!model.state.plan) return;
      var key = format.storeKey(), selection = readingSelection;
      persistence.refreshAccess().catch(function (error) { if (key === format.storeKey() && selection === readingSelection && !error.staleAccess) shell.showError(error.message); });
    });
    window.addEventListener('pagehide', captureReadingPosition);
  }

function renderCardContent(id, options) {
    var scope = cardContentEl(id);
    if (!scope) return;
    model.session.activeScope = scope;
    if (model.session.readingAccessPending && model.session.readingAccessPending.id === id) {
      scope.innerHTML = '<p class="tip" role="status" aria-live="polite"><span class="spinner"></span>正在确认单元访问状态…</p>';
      return;
    }
    if (!domain.canAccess(id)) {
      var manual = (model.state.nodeAccess || {})[id] === 'locked';
      var readError = readingSelection && readingSelection.key === format.storeKey() && readingSelection.id === id ? readingSelection.error : '';
      var missing = domain.depsOf(id).filter(function (dependency) { return !domain.isDone(dependency); });
      scope.innerHTML = '<section class="workspace-empty"><h3>' + (model.session.accessUnavailable ? '暂时无法确认单元访问状态' : manual ? '此单元已手动锁定' : '先完成前置单元') + '</h3><p class="tip">' +
        (model.session.accessUnavailable ? '请连接网络并重新确认。已有正文、成绩和草稿已保留。' : manual ? '正文、AI 辅助和自测暂时不可用。已有内容、成绩和草稿会保留。验证当前登录密码可重新解锁。' : '请先通过前置单元自测，再确认完成。手动标记不影响解锁；也可以验证密码，只解锁当前单元。') + '</p>' +
        (readError ? '<p class="tip access-read-error" role="alert">' + format.esc(readError) + '</p>' : '') +
        (!manual && !model.session.accessUnavailable ? missing.map(function (dependency) {
          var parent = domain.nodeById(dependency);
          return '<button class="btn prerequisite" type="button" data-node="' + format.esc(dependency) + '">前往 ' + format.esc(parent ? parent.title : '前置单元') + '</button>';
        }).join('') : '') +
        (model.session.accessUnavailable ? '<button class="btn refresh-access" type="button">重新确认访问状态</button>' : '<button class="btn access-inline" type="button"' + (window.LearnUser.readOnly ? ' disabled' : '') + '>密码解锁</button>') + '</section>';
      scope.querySelectorAll('.prerequisite').forEach(function (button) { button.onclick = function () { selectNode(button.dataset.node); }; });
      var access = scope.querySelector('.access-inline'); if (access) access.onclick = function () { openAccess(id); };
      var refresh = scope.querySelector('.refresh-access'); if (refresh) refresh.onclick = function () { selectNode(id); };
      return;
    }
    if (model.state.nodeDetail[id]) { hooks.renderNodeDetail(id); return; }
    if (generation.isRunning()) {   // 批量进行中：忽略单节点生成并轻提示
      scope.innerHTML = '<p class="tip">批量生成进行中，请稍候…</p>';
      return;
    }
    if (model.session.generatingNode === id) {
      generation.setCardGenState(id, true);   // 已在生成：重建后仍显示卡内 loading，不重复请求
      scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成并校验学习材料，完成后会自动显示…</p>';
      return;
    }
    if (!options || !options.generate) {
      scope.innerHTML = '<section class="workspace-empty"><h3>' + (model.session.nodeMaterialStatus[id] === 'failed' ? '这次未能生成正文' : '准备学习这个单元') + '</h3><p class="tip">' +
        (model.session.nodeMaterialStatus[id] === 'failed' ? '已有学习记录已保留。你可以重试，或先学习其他可用单元。' : '本单元的正文尚未生成。生成后会显示在这里。') + '</p><button class="btn primary generate-unit" type="button"' + (window.LearnUser.readOnly ? ' disabled' : '') + '>' + (model.session.nodeMaterialStatus[id] === 'failed' ? '重新生成' : '生成本单元内容') + '</button></section>';
      scope.querySelector('.generate-unit').onclick = function () { generateUnit(id); };
      return;
    }
    scope.innerHTML = '<p class="tip"><span class="spinner"></span>正在生成并校验学习材料，完成后会自动显示…</p>';
    model.session.generatingNode = id;
    generation.setCardGenState(id, true);
    model.session.nodeMaterialStatus[id] = 'generating';
    hooks.syncAiMaterial(id);
    workflow.setPending('node', id);
    hooks.requestNodeDetail(id, options && options.manualRetry ? true : false, {recovering: !!(options && options.recovering)}).then(function (detail) {
      model.session.generatingNode = null;
      generation.setCardGenState(id, false);
      model.state.nodeDetail[id] = detail;
      hooks.syncAiMaterial(id);
      model.state.pending = null; model.session.resumeAttempts = 0; workflow.hideResumeBar();
      persistence.save();
      if (model.session.expandedId === id) renderCardContent(id);
    }).catch(function (e) {
      model.session.generatingNode = null;
      generation.setCardGenState(id, false);
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
        generateUnit(id);
      });
      shell.showError('学习材料生成失败：' + e.message, function () {
        generateUnit(id);
      });
    });
  }

  return Object.freeze({bindWorkspace: bindWorkspace, openDirectory: openDirectory, captureReadingPosition: captureReadingPosition, renderDocumentTitle: renderDocumentTitle, renderPlan: renderPlan, refreshDirectory: refreshDirectory, nodeCard: nodeCard, selectNode: selectNode, openAiView: openAiView, cardContentEl: cardContentEl, renderCardContent: renderCardContent});
});
