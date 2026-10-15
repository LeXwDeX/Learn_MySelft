/* Ordered state writes with visible errors and user-scoped emergency recovery. */
(function () {
  'use strict';
  var context = window.LearnUser;
  var pending = {}, queue = Promise.resolve(), storageKey, lastFailure = null, recovering = false, retrying = false, outstanding = 0;
  var deleted = {}, leaving = false, sessionExpired = false;
  // Extend only when /state/put already protects the corresponding field.
  // Unprotected and unknown fields must continue to reveal real edit differences.
  var protectedMaterialFields = ['quizMaterials', 'refinementReceipts', 'title'];
  function confirmed(response, data) {
    return response.ok && data && data.ok === true && !data.read_only && !data.error;
  }
  function readOnlyResponse() {
    return new Response(JSON.stringify({ok:false, read_only:true, error:'管理员查看其他用户资料时只读，修改不会保存'}),
      {status:403, headers:{'Content-Type':'application/json'}});
  }
  function persist() {
    if (!storageKey) return;
    try {
      if (Object.keys(pending).length) localStorage.setItem(storageKey, JSON.stringify(pending));
      else localStorage.removeItem(storageKey);
      return true;
    } catch (error) { return false; }
  }
  function notice(message, failed) {
    if (!window.LearnUI || leaving) return;
    if (sessionExpired) {
      window.LearnUI.set('state-save', '登录已失效，未同步内容仍保留在本机，请重新登录。', 'error', function () { return context.logout(); }, '重新登录');
      return;
    }
    window.LearnUI.set('state-save', message, failed ? 'error' : 'info', failed ? retry : null, '重试保存');
  }
  function removed(entries, key) {
    if (Object.prototype.hasOwnProperty.call(entries, key) && entries[key] === null) return true;
    if (key.indexOf(context.userId + '/learn-ai-v1-') === 0) {
      var parent = key.replace('/learn-ai-v1-', '/learn-path-v1-');
      return Object.prototype.hasOwnProperty.call(entries, parent) && entries[parent] === null;
    }
    return false;
  }
  function reconcile(entries) {
    var discarded = 0, prefix = context.userId + '/';
    Object.keys(entries).forEach(function (key) {
      if (key.indexOf(prefix) === 0 && entries[key] === null) deleted[key] = true;
    });
    Object.keys(pending).forEach(function (key) {
      if (removed(entries, key)) { deleted[key] = true; delete pending[key]; discarded++; }
      else if (Object.prototype.hasOwnProperty.call(entries, key) && sameValue(key, pending[key], entries[key])) delete pending[key];
    });
    // Only remove quiz drafts whose own material has an explicit server tombstone.
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      keys.forEach(function (key) {
        if (!key || key.indexOf('quiz-draft-v1:') !== 0) return;
        var identity; try { identity = JSON.parse(key.slice('quiz-draft-v1:'.length)); } catch (error) { return; }
        if (Array.isArray(identity) && typeof identity[0] === 'string' && identity[0].indexOf(prefix) === 0 && removed(entries, identity[0])) localStorage.removeItem(key);
      });
    } catch (error) { /* An unavailable local store must not block server state loading. */ }
    persist();
    if (!Object.keys(pending).length) {
      recovering = false;
      if (window.LearnUI) window.LearnUI.clear('state-save');
    }
    if (discarded && window.LearnUI) window.LearnUI.set('state-deleted', '这些资料已在服务器删除，对应旧草稿已清理，不会重新恢复。', 'info');
    return discarded;
  }
  async function refresh() {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 5000);
    try {
      var response = await context.fetch(context.apiBase + '/state/all', {cache:'no-store', signal:controller.signal});
      if (!response.ok) return;
      var data = await response.json();
      if (data.entries) { sessionExpired = false; reconcile(data.entries); }
    } catch (error) { /* Missing network evidence is never treated as deletion. */ }
    finally { clearTimeout(timer); }
  }
  function deletedResponse() {
    return new Response(JSON.stringify({error:'资料已删除，旧页面的修改不会保存。请返回首页。'}), {status:409, headers:{'Content-Type':'application/json'}});
  }
  function retry() {
    var entries = {};
    Object.keys(pending).forEach(function (key) { entries[key] = pending[key]; });
    if (!Object.keys(entries).length) return Promise.resolve();
    retrying = true;
    var work = context.fetch(context.apiBase + '/state/put', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({entries: entries})
    }).then(async function (response) {
      var data = await response.clone().json();
      if (!confirmed(response, data)) throw new Error(data && data.error || lastFailure || '保存未获确认，内容仍待同步');
      // Keep the old page locked: its pagehide save may contain stale content.
      // The replacement page starts unlocked after the recovery is acknowledged.
      if (recovering) location.reload();
    });
    retrying = false;
    return work;
  }
  function assertReady() {
    if (!recovering) return;
    notice('请先恢复上次未保存的内容，再继续编辑。', true);
    var error = new Error('请先点击页面顶部的“重试保存”恢复内容，再重试生成。');
    error.code = 'state_recovery_required';
    throw error;
  }
  function send(options, dispatch) {
    if (context.readOnly) return Promise.resolve(readOnlyResponse());
    var entries;
    if (recovering && !retrying) {
      notice('请先恢复上次未保存的内容，再继续编辑。', true);
      return Promise.resolve(new Response(JSON.stringify({error: '请先点击页面顶部的“重试保存”恢复内容，再继续编辑。', code: 'state_recovery_required'}), {status: 409, headers: {'Content-Type': 'application/json'}}));
    }
    try { entries = JSON.parse(options.body).entries; } catch (error) { return dispatch(); }
    if (!entries || typeof entries !== 'object') return dispatch();
    Object.keys(entries).forEach(function (key) { if (deleted[key]) delete entries[key]; });
    if (!Object.keys(entries).length) return Promise.resolve(deletedResponse());
    options.body = JSON.stringify(Object.assign({}, JSON.parse(options.body), {entries:entries}));
    Object.keys(entries).forEach(function (key) { pending[key] = entries[key]; });
    var backedUp = persist();
    notice(backedUp ? '正在保存…' : '正在保存；本机备份不可用，请保持页面打开');
    // Every save starts after earlier saves settle, including an earlier failure.
    var idle = outstanding === 0;
    outstanding += 1;
    async function dispatchRequest() {
      Object.keys(entries).forEach(function (key) { if (deleted[key]) delete entries[key]; });
      if (!Object.keys(entries).length) return deletedResponse();
      options.body = JSON.stringify(Object.assign({}, JSON.parse(options.body), {entries:entries}));
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 25000);
      options.signal = controller.signal;
      try {
        var response = await dispatch();
        // An acknowledgement includes the JSON body, not just response headers.
        var data = await response.clone().json();
        if (response.ok && !confirmed(response, data)) {
          var readOnly = data && data.read_only;
          return new Response(JSON.stringify({ok:false, read_only:!!readOnly,
            error:data && data.error || (readOnly ? '当前页面只读，修改未保存' : '服务器未确认保存，内容仍待同步'),
            code:readOnly ? 'state_read_only' : 'state_save_unconfirmed'}),
            {status:readOnly ? 403 : 502, headers:{'Content-Type':'application/json'}});
        }
        return response;
      } finally { clearTimeout(timer); }
    }
    // During pagehide, starting an idle keepalive request must happen before
    // returning to the browser; a later promise continuation can be discarded.
    var delivery = idle ? dispatchRequest() : queue.catch(function () {}).then(dispatchRequest);
    var request = delivery.then(async function (response) {
      if (!response.ok) {
        if (response.status === 401) sessionExpired = true;
        if (response.status === 409) await refresh();
        if (!Object.keys(pending).length) return response;
        var data = await response.clone().json().catch(function () { return {}; });
        lastFailure = data.error || '保存失败（' + response.status + '）';
        notice(lastFailure + '，未保存的内容已保留。', true);
        return response;
      }
      Object.keys(entries).forEach(function (key) {
        if (pending[key] === entries[key]) delete pending[key];
      });
      persist();
      lastFailure = null;
      if (!Object.keys(pending).length && window.LearnUI) window.LearnUI.clear('state-save');
      return response;
    }).catch(function (error) {
      lastFailure = '网络中断，内容尚未保存到服务器';
      notice(lastFailure + '，请重试。', true);
      throw error;
    }).finally(function () { outstanding -= 1; });
    queue = request;
    return request;
  }
  window.LearnSaves = {
    send: send,
    retry: retry,
    assertReady: assertReady,
    pending: function () { return Object.keys(pending).length > 0; },
    drain: function () { return queue; },
    refresh: refresh,
    prepareExit: function () {
      if (Object.keys(pending).length) {
        if (!persist()) throw new Error('本机草稿保存失败，请保留当前页面并复制未保存内容后再退出。');
        if (localStorage.getItem(storageKey) !== JSON.stringify(pending)) throw new Error('无法确认本机草稿已保存，请勿关闭页面。');
      }
      leaving = true;
    },
    cancelExit: function () { leaving = false; },
    forget: function (keys) {
      keys.forEach(function (key) { delete pending[key]; });
      persist();
      if (!Object.keys(pending).length && window.LearnUI) window.LearnUI.clear('state-save');
    }
  };
  context.attachPersistence(window.LearnSaves);
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + canonical(value[key]);
    }).join(',') + '}';
    return JSON.stringify(value);
  }
  function sameValue(key, left, right) {
    if (left === right) return true;
    try {
      var before = JSON.parse(left), after = JSON.parse(right);
      if (/^[^/]+\/learn-path-v1-/.test(key) && !key.endsWith('/learn-path-v1-last') &&
          before && after && typeof before === 'object' && typeof after === 'object') {
        protectedMaterialFields.forEach(function (field) {
          delete before[field]; delete after[field];
        });
        // Match /state/put's protected plan and additive node merge. A stale
        // acknowledged browser snapshot cannot remove server-generated nodes.
        // Existing editable notes, marks, references and unknown fields still
        // have to match; this is not a whole-document "server wins" comparison.
        if (after.plan && typeof after.plan === 'object' && !Array.isArray(after.plan)) {
          delete before.plan; delete after.plan;
        }
        ['nodeDetail', 'nodeState'].forEach(function (field) {
          if (!before[field]) before[field] = {};
          if (!after[field]) after[field] = {};
          Object.keys(after[field]).forEach(function (id) {
            if (!Object.prototype.hasOwnProperty.call(before[field], id)) {
              before[field][id] = JSON.parse(JSON.stringify(after[field][id]));
            }
          });
        });
        Object.keys(after.nodeDetail).forEach(function (id) {
          var server = after.nodeDetail[id], local = before.nodeDetail[id];
          // Once issued, the entire quiz is authoritative at this endpoint.
          if (local && server && server.quiz && Array.isArray(server.quiz.rounds) && server.quiz.rounds.length) {
            delete local.quiz; delete server.quiz;
          }
        });
        [before.nodeState, after.nodeState].forEach(function (states) {
          Object.keys(states).forEach(function (id) {
            if (!states[id] || typeof states[id] !== 'object') return;
            ['score', 'lastResult', 'lastAnswers'].forEach(function (field) { delete states[id][field]; });
          });
        });
        // Protected generated notes can change after a save has been dispatched.
        // Compare editable fields; keep genuine reference and progress edits.
        Object.keys(after.nodeDetail || {}).forEach(function (id) {
          var server = after.nodeDetail[id], local = (before.nodeDetail || {})[id];
          var marker = server && server.sceneSupplement;
          if (!local || typeof local !== 'object' || !marker || marker.version !== 1 ||
              typeof marker.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.source_sha256) ||
              typeof marker.notes_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.notes_sha256)) return;
          delete local.study_notes; delete server.study_notes;
          delete local.sceneSupplement; delete server.sceneSupplement;
        });
        if (!Object.prototype.hasOwnProperty.call(before, 'materials')) before.materials = [];
        if (!Object.prototype.hasOwnProperty.call(after, 'materials')) after.materials = [];
      }
      if (/^[^/]+\/quiz-map-v1-/.test(key) && before && after && typeof before === 'object' && typeof after === 'object') {
        delete before.title; delete after.title;
      }
      return canonical(before) === canonical(after);
    }
    catch (error) { return false; }
  }
  context.ready = context.ready.then(async function () {
    if (!context.user || context.readOnly) return context;
    storageKey = 'learn-unsaved-v1/' + context.userId;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (error) {}
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      Object.keys(saved).forEach(function (key) {
        if (key.startsWith(context.userId + '/') && typeof saved[key] === 'string') pending[key] = saved[key];
      });
      if (Object.keys(pending).length) {
        // A page can disappear after the server commits but before its fetch
        // promise handles the acknowledgement. Confirm before showing recovery.
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 5000);
        try {
          var response = await context.fetch(context.apiBase + '/state/all', {cache: 'no-store', signal: controller.signal});
          var data = await response.json();
          if (response.ok && data.entries) reconcile(data.entries);
        } catch (error) { /* Keep the local copy when confirmation is unavailable. */ }
        finally { clearTimeout(timeout); }
        persist();
      }
      recovering = Object.keys(pending).length > 0;
      if (recovering) notice('发现上次未保存的内容，请重试同步后继续。', true);
    }
    return context;
  });
  window.addEventListener('beforeunload', function (event) {
    if (!leaving && Object.keys(pending).length) { event.preventDefault(); event.returnValue = ''; }
  });
})();
