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

session.pendingTarget = null;

session.saveTimer = null;

session.stateWrites = [];

session.blockedStateKeys = {};

function writeBlocked(stale) {
    var error = new Error(stale ? '资料身份已变化，未保存内容仍保留，请恢复后重试' : '资料尚未准备好或当前为只读，未保存内容仍保留');
    error.code = stale ? 'state_write_stale' : 'state_write_blocked';
    return error;
  }

function putState(entries) {
    var generation = model.session.loadGeneration, target = model.session.materialSlug;
    if (window.LearnUser.readOnly || model.session.bootState !== 'ready') return Promise.reject(writeBlocked(false));
    function send(keepalive) {
      if (generation !== model.session.loadGeneration || target !== model.session.materialSlug) return Promise.reject(writeBlocked(true));
      if (window.LearnUser.readOnly || model.session.bootState !== 'ready') return Promise.reject(writeBlocked(false));
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
      if (error.code === 'state_write_stale' || error.code === 'state_write_blocked' || error.status && error.status < 500) throw error;
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
    var entries = session.pendingEntries;
    function preserve(error) {
      if ((error.code === 'state_write_stale' || error.code === 'state_write_blocked') && window.LearnSaves && window.LearnSaves.retain) {
        window.LearnSaves.retain(Object.assign({}, entries, session.pendingEntries || {}));
      }
      throw error;
    }
    if (session.pendingTarget !== model.session.materialSlug) return Promise.reject(writeBlocked(true)).catch(preserve);
    // Keep the pending snapshot until acknowledgement. A blocked or failed write is not a save.
    return putState(entries).then(function () {
      if (session.pendingEntries === entries) { session.pendingEntries = null; session.pendingTarget = null; }
    }).catch(preserve);
  }

function flushBeacon() { flushSave().catch(function () {}); }

window.addEventListener('pagehide', flushBeacon);

document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushBeacon(); });

function save() {
    if (window.LearnUser.readOnly || model.session.bootState !== 'ready') return;
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
      session.pendingTarget = model.session.materialSlug;
      session.pendingEntries = {};
      session.pendingEntries[format.storeKey()] = JSON.stringify(payload);
      session.pendingEntries[model.session.LAST_KEY] = model.session.materialSlug || format.slug(model.state.topic);
      if (!session.saveTimer) session.saveTimer = setTimeout(function () { flushSave().catch(function () {}); }, 350);
    } catch (e) { console.warn('save failed', e); }
  }

// AI 辅助对话单独一个 key（learn-ai-v1-<slug>），与材料 save() 互不干扰

function saveAi() {
    if (window.LearnUser.readOnly || model.session.bootState !== 'ready') return;
    try {
      if (!model.state.topic) return;
      var o = {};
      o[format.aiKey()] = JSON.stringify(model.state.aiHist || {});
      putState(o).catch(function () {});
    } catch (e) { console.warn('saveAi failed', e); }
  }

// Capture identity before any asynchronous work. An old response must never change a newer page.
var activeLoad = null;
function serverLoad() {
    var search = location.search, params = new URLSearchParams(search);
    var generation = ++model.session.loadGeneration;
    if (activeLoad) activeLoad.abort();
    var controller = new AbortController(); activeLoad = controller;
    model.session.bootState = 'loading';
    // Back up the pre-load edit before a fast response can replace the model or debounce queue.
    if (session.pendingEntries) {
      try {
        if (!window.LearnSaves || !window.LearnSaves.retain || !window.LearnSaves.retain(session.pendingEntries)) throw new Error('本机备份不可用，未保存内容仍保留，请重试保存后再读取资料');
      } catch (error) {
        model.session.bootState = 'error';
        return Promise.reject(error);
      }
    }
    function current() { return generation === model.session.loadGeneration && search === location.search; }
    function stale() { var error = new Error('资料读取已被替换'); error.staleLoad = true; return error; }
    var timer, timedOut = false, previousLast;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        timedOut = true; controller.abort(); reject(new Error('读取资料超时，请重试'));
      }, model.session.TIMEOUT);
    });
    var load = Promise.resolve().then(function () {
      if (!current()) throw stale();
      if (params.get('new') === '1' || !params.has('t')) return false;
      var target = params.get('t');
      if (!target || target.indexOf('/') >= 0) throw new Error('资料地址无效，请从资料库重新打开');
      return window.LearnUser.fetch(model.session.API + '/state/all', {cache: 'no-store', signal: controller.signal}).then(function (response) {
        if (!current()) throw stale();
        if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录' : '读取资料失败（' + response.status + '），请重试');
        return response.json();
      }).then(function (snapshot) {
        if (!current() || timedOut) throw stale();
        function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
        if (!record(snapshot) || snapshot.ok !== true || !record(snapshot.entries)) throw new Error('资料响应无效，请重试');
        var entries = snapshot.entries, raw = format.entryVal(entries, model.session.STORE_PREFIX + target);
        if (typeof raw !== 'string') throw new Error('资料不存在或已删除，请返回资料库');
        var data;
        try { data = JSON.parse(raw); } catch (_) { throw new Error('资料内容损坏，请重试'); }
        if (!record(data)) throw new Error('资料内容损坏，请重试');
        var topic = data.topic || (data.plan && data.plan.title) || (data.spec && data.spec.topic);
        if (typeof topic !== 'string' || !topic.trim()) throw new Error('资料缺少学习主题，请重试');
        ['history', 'materials', 'queries', 'sources'].forEach(function (name) {
          if (data[name] != null && !Array.isArray(data[name])) throw new Error('资料内容损坏，请重试');
        });
        ['spec', 'plan', 'nodeDetail', 'nodeState', 'nodeAccess', 'pending'].forEach(function (name) {
          if (data[name] != null && !record(data[name])) throw new Error('资料内容损坏，请重试');
        });
        if (data.stage != null && data.stage !== '' && ['intake', 'research', 'learning'].indexOf(data.stage) < 0 ||
            data.plan && (!Array.isArray(data.plan.nodes) || !data.plan.nodes.every(function (node) { return record(node) && typeof node.id === 'string' && !!node.id; })) ||
            (data.materials || []).some(function (item) { return !record(item) || typeof item.name !== 'string' || typeof item.text !== 'string'; }) ||
            (data.history || []).some(function (item) { return !record(item) || typeof item.content !== 'string'; })) throw new Error('资料内容损坏，请重试');
        function strings(value) { return Array.isArray(value) && value.every(function (item) { return typeof item === 'string'; }); }
        if (data.title != null && typeof data.title !== 'string' || data.brief != null && typeof data.brief !== 'string' ||
            data.queries && !strings(data.queries) ||
            (data.sources || []).some(function (source) { return !record(source) || typeof source.url !== 'string'; }) ||
            data.spec && ['preferences', 'outline_hint'].some(function (name) { return data.spec[name] != null && !strings(data.spec[name]); })) throw new Error('资料内容损坏，请重试');
        var restored = {
          stage: data.stage || 'intake', title: window.LearnTitles.document(data), topic: topic,
          history: data.history || [], materials: data.materials || [], spec: data.spec || null,
          queries: data.queries || [], sources: data.sources || [], research_version: data.research_version || 0,
          brief: data.brief || '', plan: data.plan || null, nodeDetail: data.nodeDetail || {},
          nodeState: data.nodeState || {}, nodeAccess: data.nodeAccess || {}, pending: data.pending || null, aiHist: {}
        };
        var aiRaw = format.entryVal(entries, 'learn-ai-v1-' + target);
        if (typeof aiRaw === 'string') {
          try { var ai = JSON.parse(aiRaw); if (record(ai)) restored.aiHist = ai; } catch (_) {}
        }
        if (restored.stage === 'learning' && !restored.plan) restored.stage = 'research';
        if (restored.stage === 'research' && !restored.spec) restored.stage = 'intake';
        if (!current() || timedOut) throw stale();
        previousLast = format.entryVal(entries, 'learn-path-v1-last');
        Object.assign(model.state, restored);
        model.session.materialSlug = target;
        model.session.accessUnavailable = false;
        return true;
      });
    });
    return Promise.race([load, timeout]).then(function (restored) {
      if (!current()) throw stale();
      if (!restored) { Object.assign(model.state, model.createState()); model.session.materialSlug = null; }
      model.session.bootState = 'ready';
      if (restored) {
        hooks.renderDocumentTitle();
        var target = model.session.materialSlug, fixed = format.slug(model.state.topic);
        if (target === 'untitled' && fixed && fixed !== 'untitled') {
          model.session.materialSlug = fixed; target = fixed; save();
        }
        if (previousLast !== target) {
          var pointer = {}; pointer[model.session.LAST_KEY] = target;
          putState(pointer).catch(function () {});
        }
      }
      return restored;
    }).catch(function (error) {
      if (!current()) throw stale();
      model.session.bootState = 'error';
      if (error.name === 'AbortError') throw new Error('读取资料超时，请重试');
      throw error;
    }).finally(function () {
      clearTimeout(timer);
      if (current() && activeLoad === controller) activeLoad = null;
    });
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
var accessReadSerial = 0, accessRead = null, accessReadKey = null;
function applyNodeAccess(access) { accessReadSerial++; model.state.nodeAccess = access || {}; }
function refreshAccess() {
    var key = format.storeKey();
    if (accessReadKey !== key) { accessReadKey = key; accessReadSerial++; }
    var serial = accessReadSerial;
    if (accessRead && accessRead.key === key && accessRead.serial === serial) return accessRead.promise;
    var read = {key: key, serial: serial}; accessRead = read;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, model.session.TIMEOUT);
    read.promise = window.LearnUser.fetch(model.session.API + '/state/access?key=' + encodeURIComponent(key), {cache: 'no-store', signal: controller.signal}).then(function (response) {
      if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录' : response.status === 404 ? '资料已删除或无法访问，请返回资料库' : '无法确认单元访问状态，请重试');
      return response.json();
    }).then(function (snapshot) {
      if (key !== format.storeKey() || serial !== accessReadSerial) { var stale = new Error('访问状态已更新，请重试'); stale.staleAccess = true; throw stale; }
      if (!validAccessSnapshot(snapshot, key)) throw new Error('无法确认单元访问状态，请重试');
      var saved = snapshot, before = JSON.stringify(model.state.nodeAccess || {}), unavailable = model.session.accessUnavailable, completedChanged = false;
      model.state.nodeAccess = saved.nodeAccess || {};
      model.session.accessUnavailable = false;
      Object.keys(saved.nodeState || {}).forEach(function (id) {
        var remote = saved.nodeState[id], local = model.state.nodeState[id] || {};
        if (remote && remote.completed && !local.completed) { local.completed = true; model.state.nodeState[id] = local; completedChanged = true; }
      });
      if (unavailable || completedChanged || before !== JSON.stringify(model.state.nodeAccess)) hooks.renderPlan();
      return saved;
    }).catch(function (error) {
      if (key !== format.storeKey() || serial !== accessReadSerial) { error = new Error('访问状态已更新，请重试'); error.staleAccess = true; }
      if (error && error.name === 'AbortError') error = new Error('确认单元访问状态超时，请重试');
      if (key === format.storeKey() && serial === accessReadSerial && !error.staleAccess) {
        model.session.accessUnavailable = true;
        hooks.renderPlan();
      }
      throw error;
    }).finally(function () { clearTimeout(timer); if (accessRead === read) accessRead = null; });
    return read.promise;
  }

function validAccessSnapshot(snapshot, key) {
    function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
    return record(snapshot) && snapshot.ok === true && snapshot.key === key && Number.isInteger(snapshot.revision) && snapshot.revision >= 0 &&
      record(snapshot.plan) && Array.isArray(snapshot.plan.nodes) && snapshot.plan.nodes.every(function (node) { return record(node) && typeof node.id === 'string' && !!node.id; }) &&
      record(snapshot.nodeAccess) && Object.keys(snapshot.nodeAccess).every(function (id) { return snapshot.nodeAccess[id] === 'locked' || snapshot.nodeAccess[id] === 'unlocked'; }) &&
      record(snapshot.nodeState) && Object.keys(snapshot.nodeState).every(function (id) { return record(snapshot.nodeState[id]) && typeof snapshot.nodeState[id].completed === 'boolean'; });
  }

function ensureNodeExists(id) {
    var key = format.storeKey();
    return refreshAccess().then(function (saved) {
      if (key !== format.storeKey()) { var stale = new Error('访问状态已更新，请重试'); stale.staleAccess = true; throw stale; }
      if (!saved.plan.nodes.some(function (node) { return node.id === id; })) { model.session.accessUnavailable = true; hooks.renderPlan(); throw new Error('单元已不存在，请返回资料库'); }
      return true;
    });
  }

function ensureAccess(id) {
    return ensureNodeExists(id).then(function () {
      if (!domain.canAccess(id)) throw new Error('本单元已锁定，请返回正文查看访问条件');
      return true;
    });
  }

function post(path, body, jobOptions) {
    if (window.LearnUser.readOnly || model.session.bootState !== 'ready') return Promise.reject(new Error('资料尚未准备好或当前为只读，不能继续写入'));
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

  return Object.freeze({applyNodeAccess: applyNodeAccess, refreshAccess: refreshAccess, ensureNodeExists: ensureNodeExists, ensureAccess: ensureAccess, waitForWrites: waitForWrites, putState: putState, deleteState: deleteState, flushSave: flushSave, flushBeacon: flushBeacon, save: save, saveAi: saveAi, serverLoad: serverLoad, purgeLocalLegacy: purgeLocalLegacy, post: post});
});
