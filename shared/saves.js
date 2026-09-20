/* Ordered state writes with visible errors and user-scoped emergency recovery. */
(function () {
  'use strict';
  var context = window.LearnUser;
  var pending = {}, queue = Promise.resolve(), storageKey, lastFailure = null, recovering = false, retrying = false, outstanding = 0;
  function persist() {
    if (!storageKey) return;
    try {
      if (Object.keys(pending).length) localStorage.setItem(storageKey, JSON.stringify(pending));
      else localStorage.removeItem(storageKey);
      return true;
    } catch (error) { return false; }
  }
  function notice(message, failed) {
    if (!window.LearnUI) return;
    window.LearnUI.set('state-save', message, failed ? 'error' : 'info', failed ? retry : null, '重试保存');
  }
  function retry() {
    var entries = {};
    Object.keys(pending).forEach(function (key) { entries[key] = pending[key]; });
    if (!Object.keys(entries).length) return Promise.resolve();
    retrying = true;
    var work = context.fetch(context.apiBase + '/state/put', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({entries: entries})
    }).then(function (response) {
      if (!response.ok) throw new Error(lastFailure || '保存失败，内容仍待同步');
      if (recovering) { recovering = false; location.reload(); }
    });
    retrying = false;
    return work;
  }
  function send(options, dispatch) {
    var entries;
    if (recovering && !retrying) {
      notice('请先恢复上次未保存的内容，再继续编辑。', true);
      return Promise.resolve(new Response(JSON.stringify({error: '请先恢复上次未保存的内容'}), {status: 409}));
    }
    try { entries = JSON.parse(options.body).entries; } catch (error) { return dispatch(); }
    if (!entries || typeof entries !== 'object') return dispatch();
    Object.keys(entries).forEach(function (key) { pending[key] = entries[key]; });
    var backedUp = persist();
    notice(backedUp ? '正在保存…' : '正在保存；本机备份不可用，请保持页面打开');
    // Every save starts after earlier saves settle, including an earlier failure.
    var idle = outstanding === 0;
    outstanding += 1;
    async function dispatchRequest() {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 25000);
      options.signal = controller.signal;
      try {
        var response = await dispatch();
        // An acknowledgement includes the JSON body, not just response headers.
        await response.clone().json();
        return response;
      } finally { clearTimeout(timer); }
    }
    // During pagehide, starting an idle keepalive request must happen before
    // returning to the browser; a later promise continuation can be discarded.
    var delivery = idle ? dispatchRequest() : queue.catch(function () {}).then(dispatchRequest);
    var request = delivery.then(async function (response) {
      if (!response.ok) {
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
    pending: function () { return Object.keys(pending).length > 0; },
    drain: function () { return queue; },
    forget: function (keys) {
      keys.forEach(function (key) { delete pending[key]; });
      persist();
      if (!Object.keys(pending).length && window.LearnUI) window.LearnUI.clear('state-save');
    }
  };
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
        // This field is saved independently by /materials/quiz-draft and is
        // protected from whole-document browser writes by the server.
        delete before.quizMaterials; delete after.quizMaterials;
        if (!Object.prototype.hasOwnProperty.call(before, 'materials')) before.materials = [];
        if (!Object.prototype.hasOwnProperty.call(after, 'materials')) after.materials = [];
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
          if (response.ok && data.entries) Object.keys(pending).forEach(function (key) {
            if (sameValue(key, pending[key], data.entries[key])) delete pending[key];
          });
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
    if (Object.keys(pending).length) { event.preventDefault(); event.returnValue = ''; }
  });
})();
