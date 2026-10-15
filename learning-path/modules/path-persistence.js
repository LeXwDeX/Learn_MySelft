/* 服务端状态读写、顺序删除和网络请求。 */
define("path.persistence", ["path.model", "path.format", "path.hooks", "path.domain"], function (deps) {
  'use strict';
  var model = deps["path.model"];
  var format = deps["path.format"];
  var hooks = deps["path.hooks"];
  var domain = deps["path.domain"];
  var session = {};

// ---------- 服务端资料读写；待同步恢复由 LearnSaves 管理 ----------

session.pendingEntries = null;

session.saveTimer = null;

session.stateWrites = [];

session.blockedStateKeys = {};

function putState(entries) {
    if (window.LearnUser.readOnly) return Promise.resolve();
    function send(keepalive) {
      var allowed = {};
      Object.keys(entries).forEach(function (key) {
        if (!session.blockedStateKeys[key]) allowed[key] = entries[key];
      });
      if (!Object.keys(allowed).length) return Promise.resolve();
      var body = JSON.stringify({ entries: allowed });
      return window.LearnUser.fetch(model.session.API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body, keepalive: !!keepalive && new Blob([body]).size <= 60000
      }).then(function (r) {
        if (r.ok) return;
        return r.json().catch(function () { return {}; }).then(function (data) {
          var error = new Error(data.error || '保存失败（' + r.status + '）');
          error.status = r.status;
          error.code = data.code;
          throw error;
        });
      });
    }
    var write = send(true).catch(function (error) {
      // A conflict or recovery lock needs its own action, not the same request.
      if (error.status && error.status < 500) throw error;
      return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () { return send(false); });
    });
    session.stateWrites.push(write);
    write.finally(function () { session.stateWrites = session.stateWrites.filter(function (item) { return item !== write; }); }).catch(function () {});
    return write;
  }

function deleteState(keys, password) {
    keys.forEach(function (key) {
      session.blockedStateKeys[key] = true;
      if (session.pendingEntries) delete session.pendingEntries[key];
    });
    if (session.pendingEntries && !Object.keys(session.pendingEntries).length) session.pendingEntries = null;
    // Drain earlier saves before the tombstone; subsequent callbacks cannot resurrect it.
    return Promise.all(session.stateWrites.slice()).then(function () {
      return window.LearnUser.fetch(model.session.API + '/state/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keys, password: password })
      });
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (!result.ok) throw new Error(result.error || '删除失败');
      return result;
    }).catch(function (error) {
      keys.forEach(function (key) { delete session.blockedStateKeys[key]; });
      if (keys.indexOf(format.storeKey()) >= 0) save();
      throw error;
    });
  }

function flushSave() {
    if (session.saveTimer) { clearTimeout(session.saveTimer); session.saveTimer = null; }
    if (!session.pendingEntries) return Promise.resolve();
    var entries = session.pendingEntries; session.pendingEntries = null;
    return putState(entries);
  }

function flushBeacon() {
    if (session.saveTimer) { clearTimeout(session.saveTimer); session.saveTimer = null; }
    if (!session.pendingEntries) return;
    var payload = JSON.stringify({ entries: session.pendingEntries }); session.pendingEntries = null;
    try {
      window.LearnUser.fetch(model.session.API + '/state/put', {
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
      if (!model.state.topic || session.blockedStateKeys[format.storeKey()]) return;
      var payload = {
        stage: model.state.stage, title: model.state.title, topic: model.state.topic, history: model.state.history, materials: model.state.materials,
        spec: model.state.spec, queries: model.state.queries, sources: model.state.sources,
        brief: model.state.brief, research_version: model.state.research_version, plan: model.state.plan,
        nodeDetail: model.state.nodeDetail, nodeState: model.state.nodeState, nodeAccess: model.state.nodeAccess || {},
        pending: model.state.pending || null
      };
      session.pendingEntries = {};
      session.pendingEntries[format.storeKey()] = JSON.stringify(payload);
      session.pendingEntries[model.session.LAST_KEY] = model.session.materialSlug || format.slug(model.state.topic);
      if (!session.saveTimer) session.saveTimer = setTimeout(function () { flushSave().catch(function () {}); }, 350);
    } catch (e) { console.warn('save failed', e); }
  }

// AI 辅助对话单独一个 key（learn-ai-v1-<slug>），与材料 save() 互不干扰

function saveAi() {
    try {
      if (!model.state.topic) return;
      var o = {};
      o[format.aiKey()] = JSON.stringify(model.state.aiHist || {});
      putState(o).catch(function () {});
    } catch (e) { console.warn('saveAi failed', e); }
  }

function serverLoad() {
    return window.LearnUser.fetch(model.session.API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.entries) return false;
      var entries = j.entries;
      // 支持 ?t=<slug> 深链（从「学习资料库」直接打开某份资料）；无参则从零开始新生成
      var s = null;
      try { s = new URLSearchParams(location.search).get('t'); } catch (e2) { s = null; }
      if (s && typeof format.entryVal(entries, model.session.STORE_PREFIX + s) !== 'string') s = null;   // 指定的资料不存在则回退
      if (!s) return false;   // 无参数 = 全新开始；已有资料请从「学习资料库」进入
      var raw = format.entryVal(entries, model.session.STORE_PREFIX + s);
      if (typeof raw !== 'string') return false;
      var d; try { d = JSON.parse(raw); } catch (e3) { return false; }
      if (!d || typeof d !== 'object') return false;
      model.session.materialSlug = s;
      model.state.stage = d.stage || 'intake';
      model.state.title = window.LearnTitles.document(d);
      hooks.renderDocumentTitle();
      // 兼容修复：历史状态可能缺 topic 字段 → 依次从 plan/spec 恢复，而不是拒绝加载
      model.state.topic = d.topic || (d.plan && d.plan.title) || (d.spec && d.spec.topic) || '';
      if (!model.state.topic) return false;
      model.state.history = Array.isArray(d.history) ? d.history : [];
      model.state.materials = d.materials || [];
      model.state.spec = d.spec || null;
      model.state.queries = d.queries || [];
      model.state.sources = d.sources || [];
      model.state.research_version = d.research_version || 0;
      model.state.brief = d.brief || '';
      model.state.plan = d.plan || null;
      model.state.nodeDetail = d.nodeDetail || {};
      model.state.nodeState = d.nodeState || {};
      model.state.nodeAccess = d.nodeAccess || {};
      model.session.accessUnavailable = false;
      model.state.pending = (d.pending && typeof d.pending === 'object') ? d.pending : null;
      model.state.aiHist = {};
      var aiRaw = format.entryVal(entries, 'learn-ai-v1-' + s);
      if (typeof aiRaw === 'string') {
        var aiD = null; try { aiD = JSON.parse(aiRaw); } catch (e4) { aiD = null; }
        if (aiD && typeof aiD === 'object') model.state.aiHist = aiD;
      }
      // 状态自洽性：learning 必须有 plan
      if (model.state.stage === 'learning' && !model.state.plan) model.state.stage = 'research';
      if (model.state.stage === 'research' && !model.state.spec) model.state.stage = 'intake';
      // 历史键修复：先保存正确键；旧副本保留，用户可通过密码删除。
      var fixSlug = format.slug(model.state.topic);
      if (s === 'untitled' && fixSlug && fixSlug !== 'untitled') {
        model.session.materialSlug = fixSlug;
        save();
        s = fixSlug;
      }
      if (format.entryVal(entries, 'learn-path-v1-last') !== s) {
        var o = {}; o[model.session.LAST_KEY] = s; putState(o).catch(function () {});
      }
      return true;
    }).catch(function () { return false; });
  }

// ---------- 浏览器本地清理 ----------
  // 学习资料从服务端恢复，清理旧版资料缓存。临时阅读位置与待同步恢复由各自组件管理。

function purgeLocalLegacy() {
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf(model.session.STORE_PREFIX) === 0 || k.indexOf('__sync') === 0)) kill.push(k);
      }
      for (var j = 0; j < kill.length; j++) { try { localStorage.removeItem(kill[j]); } catch (e) {} }
      try { sessionStorage.removeItem('__sync_reloads'); } catch (e) {}
    } catch (e) {}
  }

// ---------- 网络 ----------

// Read only access and completion facts. Never replace local detail or quiz drafts.
var accessReadSerial = 0, accessRead = null;
function applyNodeAccess(access) { accessReadSerial++; model.state.nodeAccess = access || {}; }
function refreshAccess() {
    var serial = accessReadSerial;
    var key = format.storeKey();
    if (accessRead && accessRead.key === key && accessRead.serial === serial) return accessRead.promise;
    var read = {key: key, serial: serial}; accessRead = read;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, model.session.TIMEOUT);
    read.promise = window.LearnUser.fetch(model.session.API + '/state/all', {cache: 'no-store', signal: controller.signal}).then(function (response) {
      if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录' : '无法确认单元访问状态，请重试');
      return response.json();
    }).then(function (snapshot) {
      if (key !== format.storeKey() || serial !== accessReadSerial) { var stale = new Error('访问状态已更新，请重试'); stale.staleAccess = true; throw stale; }
      if (!snapshot || !snapshot.ok || !snapshot.entries) throw new Error('无法确认单元访问状态，请重试');
      var raw = snapshot.entries[key];
      if (typeof raw !== 'string') throw new Error('资料已删除或无法访问，请返回资料库');
      var saved = JSON.parse(raw), before = JSON.stringify(model.state.nodeAccess || {}), unavailable = model.session.accessUnavailable, completedChanged = false;
      model.state.nodeAccess = saved.nodeAccess || {};
      model.session.accessUnavailable = false;
      Object.keys(saved.nodeState || {}).forEach(function (id) {
        var remote = saved.nodeState[id], local = model.state.nodeState[id] || {};
        if (remote && remote.completed && !local.completed) { local.completed = true; model.state.nodeState[id] = local; completedChanged = true; }
      });
      if (unavailable || completedChanged || before !== JSON.stringify(model.state.nodeAccess)) hooks.renderPlan();
      return saved;
    }).catch(function (error) {
      if (key === format.storeKey() && !error.staleAccess) {
        model.session.accessUnavailable = true;
        hooks.renderPlan();
      }
      throw error;
    }).finally(function () { clearTimeout(timer); if (accessRead === read) accessRead = null; });
    return read.promise;
  }

function ensureAccess(id) {
    return refreshAccess().then(function (saved) {
      if (!saved.plan || !Array.isArray(saved.plan.nodes) || !saved.plan.nodes.some(function (node) { return node.id === id; })) { model.session.accessUnavailable = true; hooks.renderPlan(); throw new Error('单元已不存在，请返回资料库'); }
      if (!domain.canAccess(id)) throw new Error('本单元已锁定，请返回正文查看访问条件');
      return true;
    });
  }

function post(path, body, jobOptions) {
    try {
      if (window.LearnSaves && window.LearnSaves.assertReady) window.LearnSaves.assertReady();
    } catch (error) { return Promise.reject(error); }
    if (window.LearnJobs && window.LearnJobs.supports(path)) {
      if (!body.key) body.key = format.storeKey();
      var expectedKind = {'/path/intake': 'intake', '/path/research': 'research', '/path/plan': 'plan', '/path/node': 'node'}[path];
      var pending = model.state.pending, options = Object.assign({}, jobOptions || {});
      if (pending && pending.requestId && (pending.kind === expectedKind || (path === '/path/node' && pending.kind === 'nodes'))) {
        options.requestId = pending.requestId + (pending.kind === 'nodes' ? ':' + body.node.id : '');
      }
      return flushSave().then(function () { return Promise.all(session.stateWrites.slice()); }).then(function () {
        return window.LearnJobs.run(path, body, options);
      });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, model.session.TIMEOUT);
    return window.LearnUser.fetch(model.session.API + path, {
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

  function waitForWrites() { return Promise.all(session.stateWrites.slice()); }

  return Object.freeze({applyNodeAccess: applyNodeAccess, refreshAccess: refreshAccess, ensureAccess: ensureAccess, waitForWrites: waitForWrites, putState: putState, deleteState: deleteState, flushSave: flushSave, flushBeacon: flushBeacon, save: save, saveAi: saveAi, serverLoad: serverLoad, purgeLocalLegacy: purgeLocalLegacy, post: post});
});
