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

function genAllBtnSet(text) { var b = format.$('gen-all-btn'); if (b) b.textContent = text; }

function genAllBtnIdleLater(ms, text) {
    genAllBtnSet(text);
    if (session.genAllTimer) clearTimeout(session.genAllTimer);
    session.genAllTimer = setTimeout(function () {
      session.genAllTimer = null;
      if (!session.genAllRunning) genAllBtnSet('一键生成全部节点');
    }, ms);
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

function visualPending(detail) {
    return !!(detail && detail.manim_review && /^(pending|failed)$/.test(detail.manim_review.status));
  }

function readyDetail(detail) { return !!detail && !visualPending(detail); }

function missingNodeIds() {
    return ((model.state.plan && model.state.plan.nodes) || []).filter(function (node) {
      return !readyDetail(model.state.nodeDetail[node.id]);
    }).map(function (node) { return node.id; });
  }

function recoveryError() {
    var error = new Error('上次任务尚未提交或无法确认。请点击重试，继续准备。');
    error.error_category = 'recovery_required'; return error;
  }

function uncertain(error) {
    return !!(error && (error.error_category === 'watch_timeout' || error.error_category === 'recovery_required' ||
      error.job && (error.job.status === 'queued' || error.job.status === 'running')));
  }

function latestJob(jobs, operation, id) {
    return (jobs || []).filter(function (job) { return job.operation === operation && job.node_id === id; }).sort(function (a, b) {
      return (b.created_ms || 0) - (a.created_ms || 0);
    })[0];
  }

function refreshReview(id, key) {
    var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 10000);
    return window.LearnUser.fetch(window.LearnUser.apiBase + '/state/all', {cache: 'no-store', signal: controller.signal}).then(function (response) {
      if (!response.ok) return;
      return response.json();
    }).then(function (data) {
      if (key !== format.storeKey() || !data || !data.entries) return;
      var raw = data.entries[key], saved;
      try { saved = typeof raw === 'string' ? JSON.parse(raw) : null; } catch (error) { return; }
      var remote = saved && saved.nodeDetail && saved.nodeDetail[id], current = model.state.nodeDetail[id];
      if (remote && current && remote.study_notes === current.study_notes && remote.manim_review) current.manim_review = remote.manim_review;
    }).catch(function () {
      // A failed diagnostic read must not hide the material or erase the error.
    }).finally(function () { clearTimeout(timeout); });
  }

function requestNodeDetail(id, manualRetry, options) {
    options = options || {};
    if (window.LearnUser.readOnly) return Promise.reject(new Error('当前视图只读'));
    var key = format.storeKey(), node = domain.nodeById(id);
    if (!node) return Promise.reject(new Error('单元已不存在'));
    var recovering = !!(options.recovering || model.session.recoveringGeneration), jobsPromise;
    var baseRequest = model.state.pending && model.state.pending.requestId;
    function live() { return format.storeKey() === key && !!domain.nodeById(id); }
    function jobOptions(stage) {
      return {manualRetry: !!manualRetry, notifications: options.notifications,
        requestId: stage === 'visual' && baseRequest ? baseRequest + ':scene:' + id : undefined,
        onRetry: function () { return requestNodeDetail(id, true, Object.assign({}, options, {recovering: false})); },
        onJob: function (job, notice) { if (live() && options.onJob) options.onJob(job, notice, stage); }};
    }
    function run(operation, body, stage) {
      var opts = jobOptions(stage);
      if (!recovering) return persistence.post(operation, body, opts);
      if (!window.LearnJobs) return Promise.reject(recoveryError());
      if (!jobsPromise) jobsPromise = window.LearnJobs.list(key);
      return jobsPromise.then(function (jobs) {
        if (!live()) throw recoveryError();
        var job = latestJob(jobs, operation, id);
        if (!job) throw recoveryError();
        return window.LearnJobs.get(job.id).then(function (fullJob) {
          if (!live()) throw recoveryError();
          return window.LearnJobs.watch(fullJob, opts);
        });
      });
    }
    var existing = model.state.nodeDetail[id];
    var material = existing ? Promise.resolve(existing) : run('/path/node', {
      spec: model.state.spec, node: {id: node.id, title: node.title, essence: node.essence, objectives: node.objectives || []},
      dep_titles: domain.depTitles(id), key: key, defer_visual: true
    }, 'material');
    return material.then(function (detail) {
      if (!live()) throw recoveryError();
      if (!detail || typeof detail.study_notes !== 'string') throw new Error('学习材料格式无效');
      model.state.nodeDetail[id] = detail;
      model.session.nodeMaterialStatus[id] = 'ready'; hooks.syncAiMaterial(id);
      persistence.save(); if (model.session.expandedId === id) hooks.renderNodeDetail(id);
      if (!visualPending(detail)) return detail;
      model.session.nodeMaterialStatus[id] = 'generating-animation';
      if (model.session.expandedId === id) hooks.renderNodeDetail(id);
      return run('/path/node/scene', {key: key, node: {id: id}, automatic: true}, 'visual').then(function (result) {
        if (!live()) return detail;
        var current = model.state.nodeDetail[id];
        if (!current || !result || result.node_id !== id || typeof result.study_notes !== 'string' ||
          result.study_notes !== current.study_notes && result.source_notes !== current.study_notes) throw recoveryError();
        current.study_notes = result.study_notes;
        if (result.sceneSupplement) current.sceneSupplement = result.sceneSupplement;
        if (result.manim_review) current.manim_review = result.manim_review;
        else if (result.needed === false) current.manim_review = {status: 'not_needed'};
        model.session.nodeMaterialStatus[id] = 'ready'; hooks.syncAiMaterial(id); persistence.save();
        if (model.session.expandedId === id) hooks.renderNodeDetail(id);
        return current;
      }).catch(function (error) {
        if (!live()) return detail;
        return refreshReview(id, key).then(function () {
          if (!live()) return detail;
          var current = model.state.nodeDetail[id] || detail;
          if (!uncertain(error) && current.manim_review && current.manim_review.status === 'pending') current.manim_review = Object.assign({}, current.manim_review, {status: 'failed', retryable: true});
          model.session.nodeMaterialStatus[id] = 'ready'; hooks.syncAiMaterial(id);
          if (options.onFailure) options.onFailure(error, 'visual');
          if (model.session.expandedId === id) hooks.renderNodeDetail(id);
          return current;
        });
      });
    });
  }

session.batchRows = new Map();
session.batchOutcomes = new Map();
session.batchKey = null;
session.batchPanel = null;
session.batchSerial = 0;

function batchPanel() {
    if (session.batchPanel && session.batchPanel.isConnected) return session.batchPanel;
    var anchor = format.$('resume-bar');
    if (!anchor || !anchor.ownerDocument) return null;
    var doc = anchor.ownerDocument, panel = doc.createElement('details'); panel.className = 'generation-task-list';
    var summary = doc.createElement('summary'); summary.textContent = '查看批量任务';
    var list = doc.createElement('ol'); panel.appendChild(summary); panel.appendChild(list); anchor.after(panel);
    session.batchPanel = panel; session.batchSummary = summary; session.batchList = list; return panel;
  }

function taskRow(id, stage, job, notice) {
    if (!batchPanel()) return;
    var rowKey = id + ':' + stage, item = session.batchRows.get(rowKey), doc = session.batchPanel.ownerDocument;
    if (!item) {
      item = {row: doc.createElement('li'), text: doc.createElement('p'), button: doc.createElement('button')};
      item.button.className = 'btn'; item.button.type = 'button'; item.button.textContent = '查看详情';
      item.button.addEventListener('click', function (event) { if (item.job && window.LearnJobDetails) window.LearnJobDetails.open(item.job, null, event.currentTarget); });
      item.row.appendChild(item.text); item.row.appendChild(item.button); session.batchList.appendChild(item.row); session.batchRows.set(rowKey, item);
    }
    if (job) item.job = job;
    var node = domain.nodeById(id);
    item.text.textContent = (node ? node.title : id) + ' · ' + (stage === 'visual' ? '教学动画' : '学习材料') + '：' + (notice && notice.message || '正在准备');
    item.button.hidden = !item.job || !window.LearnJobDetails;
  }

function showBatchSummary(current) {
    if (!window.LearnUI || !session.batchKey) return;
    var counts = {success: 0, failed: 0, pending: 0};
    session.batchOutcomes.forEach(function (state) { counts[state]++; });
    session.genAllSucceeded = counts.success; session.genAllFailed = counts.failed;
    var message = '批量准备：已完成 ' + counts.success + '/' + session.genAllTotal + '，失败 ' + counts.failed +
      (counts.pending ? '，待确认 ' + counts.pending : '') + '。' + (current ? ' 当前：' + current : session.genAllRunning ? '' : '可展开任务列表查看结果。');
    var retry = !session.genAllRunning && session.genAllRemaining.length && !window.LearnUser.readOnly ? function () { return genAllStart(session.genAllRemaining.slice(), {manualRetry: true}); } : null;
    window.LearnUI.set(session.batchKey, message, counts.failed ? 'error' : session.genAllRunning || counts.pending ? 'info' : 'success', retry, '重试未完成节点', {
      secondaryLabel: '查看任务列表', secondaryAction: function () { if (batchPanel()) { session.batchPanel.open = true; session.batchSummary.focus(); } }
    });
    if (session.batchSummary) session.batchSummary.textContent = '批量任务：已完成 ' + counts.success + '，失败 ' + counts.failed + (counts.pending ? '，待确认 ' + counts.pending : '');
  }

function genAllStart(ids, options) {
    options = options || {};
    if (window.LearnUser.readOnly || session.genAllRunning || !ids || !ids.length) return Promise.resolve();
    var key = format.storeKey(), serial = ++session.batchSerial;
    if (session.batchKey) window.LearnUI && window.LearnUI.clear(session.batchKey);
    session.batchKey = 'generation-batch-' + key;
    session.batchRows.clear(); session.batchOutcomes.clear();
    if (batchPanel()) session.batchList.replaceChildren();
    session.genAllRunning = true; session.genAllPaused = false;
    session.genAllQueue = ids.slice(); session.genAllRemaining = ids.slice(); session.genAllTotal = ids.length; session.genAllIdx = 0;
    session.genAllSucceeded = 0; session.genAllFailed = 0; session.genAllManualRetry = !!options.manualRetry;
    session.genAllRecovering = !!options.recovering;
    if (window.LearnUI) window.LearnUI.clear('gen-all-error');
    if (session.genAllTimer) { clearTimeout(session.genAllTimer); session.genAllTimer = null; }
    workflow.hideResumeBar(); genAllSyncPending(); showBatchSummary();
    return genAllStep(key, serial);
  }

function genAllStep(key, serial) {
    key = key || format.storeKey(); serial = serial || session.batchSerial;
    if (key !== format.storeKey() || serial !== session.batchSerial) { session.genAllRunning = false; return Promise.resolve(); }
    if (session.genAllPaused) { genAllFinish('paused'); return Promise.resolve(); }
    while (session.genAllQueue.length && readyDetail(model.state.nodeDetail[session.genAllQueue[0]])) {
      var doneId = session.genAllQueue.shift(), ri = session.genAllRemaining.indexOf(doneId);
      if (ri >= 0) session.genAllRemaining.splice(ri, 1); session.batchOutcomes.set(doneId, 'success');
    }
    if (!session.genAllQueue.length) { genAllFinish('done'); return Promise.resolve(); }
    var id = session.genAllQueue[0], stageError = null;
    session.genAllIdx++; genAllBtnSet('生成中 ' + session.genAllIdx + '/' + session.genAllTotal + '（点击暂停）'); setCardGenState(id, true);
    function active() { return key === format.storeKey() && serial === session.batchSerial; }
    return requestNodeDetail(id, session.genAllManualRetry, {recovering: session.genAllRecovering, notifications: false,
      onJob: function (job, notice, stage) {
        if (!active()) return;
        if (window.LearnUI) window.LearnUI.clear('job-' + job.id);
        taskRow(id, stage, job, notice); showBatchSummary((domain.nodeById(id) || {}).title + ' · ' + notice.message);
      }, onFailure: function (error, stage) {
        stageError = error; taskRow(id, stage, error.job, {message: uncertain(error) ? '结果尚未确认。' + error.message : '失败。' + error.message});
      }
    }).then(function (detail) {
      if (!active()) return;
      if (readyDetail(detail)) { session.batchOutcomes.set(id, 'success'); var index = session.genAllRemaining.indexOf(id); if (index >= 0) session.genAllRemaining.splice(index, 1); }
      else session.batchOutcomes.set(id, uncertain(stageError) ? 'pending' : 'failed');
    }).catch(function (error) {
      if (!active()) return;
      session.batchOutcomes.set(id, uncertain(error) ? 'pending' : 'failed');
      model.session.nodeMaterialStatus[id] = 'failed'; hooks.syncAiMaterial(id);
      taskRow(id, 'material', error.job, {message: error.message});
    }).then(function () {
      if (!active()) { session.genAllRunning = false; return; }
      setCardGenState(id, false); session.genAllQueue.shift(); genAllSyncPending(); showBatchSummary();
      return genAllStep(key, serial);
    });
  }

function genAllFinish(reason) {
    session.genAllRunning = false; session.genAllPaused = false;
    if (reason === 'paused') { model.state.pending = null; persistence.save(); }
    else genAllSyncPending();
    workflow.hideResumeBar(); genAllBtnSet(session.genAllRemaining.length ? '继续准备未完成节点' : '一键生成全部节点'); showBatchSummary();
  }

function onGenAllClick() {
    if (window.LearnUser.readOnly || !(model.state.stage === 'learning' && model.state.plan)) return;
    if (session.genAllRunning) { session.genAllPaused = true; genAllBtnSet('暂停中…（等待当前节点完成）'); return; }
    var ids = missingNodeIds(); if (!ids.length) { genAllBtnIdleLater(2000, '已全部生成 ✓'); return; }
    return genAllStart(ids, {manualRetry: true});
  }

  function isRunning() { return session.genAllRunning; }

  return Object.freeze({isRunning: isRunning, missingNodeIds: missingNodeIds, genAllBtnSet: genAllBtnSet, genAllBtnIdleLater: genAllBtnIdleLater, genAllSyncPending: genAllSyncPending, setCardGenState: setCardGenState, requestNodeDetail: requestNodeDetail, genAllStart: genAllStart, genAllStep: genAllStep, genAllFinish: genAllFinish, onGenAllClick: onGenAllClick});
});
