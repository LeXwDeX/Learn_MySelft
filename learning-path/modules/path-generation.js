/* 材料请求、批量生成、暂停和重试。 */
define("path.generation", ["path.model", "path.format", "path.persistence", "path.domain", "path.workflow", "path.hooks"], function (deps) {
  'use strict';
  var model = deps["path.model"];
  var format = deps["path.format"];
  var persistence = deps["path.persistence"];
  var domain = deps["path.domain"];
  var workflow = deps["path.workflow"];
  var hooks = deps["path.hooks"];
  var session = {};

// ---------- Part H：一键生成全部节点（含未解锁节点） ----------

session.genAllRunning = false;

// 批量生成进行中

session.genAllPaused = false;

// 用户请求暂停（当前节点完成后停）

session.genAllQueue = [];

// 本轮待处理队列（失败会移出队列、留在 remaining）

session.genAllRemaining = [];

// 尚未成功生成的节点 id（含失败）

session.genAllTotal = 0;

// 本轮起始缺失总数

session.genAllIdx = 0;

// 已开始处理的序号

session.genAllTimer = null;

// Counts for the current batch summary.
session.genAllSucceeded = 0;
session.genAllFailed = 0;
session.genAllManualRetry = false;

// 按钮短暂文案计时器

  // 缺失节点：state.plan.nodes 中 nodeDetail 为空的（含未解锁）

function missingNodeIds() {
    var nodes = (model.state.plan && model.state.plan.nodes) || [];
    return nodes.filter(function (n) { return !model.state.nodeDetail[n.id]; }).map(function (n) { return n.id; });
  }

function genAllBtnSet(text) { var b = format.$('gen-all-btn'); if (b) b.textContent = text; }

function genAllBtnIdleLater(ms, text) {
    genAllBtnSet(text);
    if (session.genAllTimer) clearTimeout(session.genAllTimer);
    session.genAllTimer = setTimeout(function () {
      session.genAllTimer = null;
      if (!session.genAllRunning) genAllBtnSet('一键生成全部节点');
    }, ms);
  }

function showGenAllError(message) {
    if (window.LearnUI) window.LearnUI.set('gen-all-error', '批量生成失败：' + message, 'error');
  }

function genAllSyncPending() {
    if (!session.genAllRemaining.length) { model.state.pending = null; }
    else {
      var previous = model.state.pending;
      model.state.pending = {kind: 'nodes', nid: null, at: Date.now(), remaining: session.genAllRemaining.slice(),
        requestId: previous && previous.kind === 'nodes' && previous.requestId || window.LearnJobs.requestId()};
    }
    persistence.save();
  }

// 卡片头部「生成中…」态（逐卡切换）

function setCardGenState(id, on) {
    var card = format.$('node-' + id);
    if (!card) return;
    var st = card.querySelector('.status');
    if (!st) return;
    if (on) {
      if (st.classList.contains('generating')) return;
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

function requestNodeDetail(id, manualRetry) {
    var n = domain.nodeById(id);
    return persistence.post('/path/node', {
      spec: model.state.spec,
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      dep_titles: domain.depTitles(id),
      key: format.storeKey()
    }, manualRetry ? {manualRetry: true} : undefined);
  }

function genAllStart(ids, options) {
    if (!ids || !ids.length) return;
    session.genAllRunning = true; session.genAllPaused = false;
    session.genAllQueue = ids.slice();
    session.genAllRemaining = ids.slice();
    ids.forEach(function (id) { model.session.nodeMaterialStatus[id] = 'generating'; hooks.syncAiMaterial(id); });
    session.genAllTotal = ids.length;
    session.genAllIdx = 0;
    session.genAllSucceeded = 0;
    session.genAllFailed = 0;
    session.genAllLastError = '';
    if (window.LearnUI) window.LearnUI.clear('gen-all-error');
    session.genAllManualRetry = !!(options && options.manualRetry);
    if (session.genAllTimer) { clearTimeout(session.genAllTimer); session.genAllTimer = null; }
    workflow.showResumeBar('正在批量生成学习材料（' + ids.length + ' 个节点）…');
    genAllSyncPending();
    genAllStep();
  }

function genAllStep() {
    if (session.genAllPaused) { genAllFinish('paused'); return; }
    while (session.genAllQueue.length && model.state.nodeDetail[session.genAllQueue[0]]) {   // 跳过已生成的
      var doneId = session.genAllQueue.shift();
      var ri = session.genAllRemaining.indexOf(doneId);
      if (ri >= 0) session.genAllRemaining.splice(ri, 1);
    }
    if (!session.genAllQueue.length) { genAllFinish('done'); return; }
    var id = session.genAllQueue[0];
    session.genAllIdx++;
    genAllBtnSet('生成中 ' + session.genAllIdx + '/' + session.genAllTotal + '（点击暂停）');
    setCardGenState(id, true);
    requestNodeDetail(id, session.genAllManualRetry).then(function (detail) {
      setCardGenState(id, false);
      model.state.nodeDetail[id] = detail;
      hooks.syncAiMaterial(id);
      var i0 = session.genAllRemaining.indexOf(id); if (i0 >= 0) session.genAllRemaining.splice(i0, 1);
      session.genAllSucceeded++;
      session.genAllQueue.shift();
      genAllSyncPending();
      if (model.session.expandedId === id) hooks.renderNodeDetail(id);
      genAllStep();
    }).catch(function (error) {
      setCardGenState(id, false);
      model.session.nodeMaterialStatus[id] = 'failed';
      hooks.syncAiMaterial(id);
      session.genAllFailed++;
      session.genAllLastError = error && error.message ? error.message : '任务失败';
      showGenAllError(session.genAllLastError);
      genAllSyncPending();
      session.genAllQueue.shift();   // 失败：留在 genAllRemaining，继续下一个
      genAllStep();
    });
  }

function genAllFinish(reason) {
    session.genAllRunning = false;
    if (reason === 'paused') {
      session.genAllRemaining.forEach(function (id) { model.session.nodeMaterialStatus[id] = 'missing'; hooks.syncAiMaterial(id); });
      session.genAllPaused = false;
      model.state.pending = null; persistence.save();
      workflow.hideResumeBar();
      genAllBtnSet('一键生成全部节点');
      return;
    }
    if (session.genAllRemaining.length) {   // 结束但有失败：保留 pending，按钮短暂提示，再点=重试剩余
      genAllSyncPending();
      workflow.hideResumeBar();
      genAllBtnIdleLater(6000, '成功 ' + session.genAllSucceeded + '，失败 ' + session.genAllFailed + '；重试剩余');
    } else {
      model.state.pending = null; persistence.save();
      if (window.LearnUI) window.LearnUI.clear('gen-all-error');
      workflow.hideResumeBar();
      genAllBtnIdleLater(4000, '本轮成功 ' + session.genAllSucceeded + ' 个，失败 0 个 ✓');
    }
  }

function onGenAllClick() {
    if (!(model.state.stage === 'learning' && model.state.plan)) return;
    if (session.genAllRunning) {   // 运行中再点 = 暂停（当前节点完成后停）
      session.genAllPaused = true;
      genAllBtnSet('暂停中…（等待当前节点完成）');
      return;
    }
    var ids = missingNodeIds();
    if (!ids.length) { genAllBtnIdleLater(2000, '已全部生成 ✓'); return; }
    genAllStart(ids, {manualRetry: true});
  }

  function isRunning() { return session.genAllRunning; }

  return Object.freeze({isRunning: isRunning, missingNodeIds: missingNodeIds, genAllBtnSet: genAllBtnSet, genAllBtnIdleLater: genAllBtnIdleLater, genAllSyncPending: genAllSyncPending, setCardGenState: setCardGenState, requestNodeDetail: requestNodeDetail, genAllStart: genAllStart, genAllStep: genAllStep, genAllFinish: genAllFinish, onGenAllClick: onGenAllClick});
});
