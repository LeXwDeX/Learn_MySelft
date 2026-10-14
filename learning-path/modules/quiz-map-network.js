/* 测验页网络请求。 */
define("quiz-map.network", ["quiz-map.model"], function (deps) {
  'use strict';
  var model = deps["quiz-map.model"];

function post(path, body, options) {
    if (window.LearnUser.readOnly) return Promise.reject(new Error('只读模式不能修改资料'));
    if (window.LearnJobs && window.LearnJobs.supports(path)) {
      if (!body.key && model.session.currentSlug) body.key = model.session.USER_PATH + model.session.QUIZ_PREFIX + model.session.currentSlug;
      return window.LearnJobs.run(path, body, options || {});
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, model.session.TIMEOUT);
    return window.LearnUser.fetch(model.session.API + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    }, function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? '请求超时（360s）' : '网络错误：' + (e && e.message || e));
    });
  }

function fetchEntries() {
    return window.LearnUser.fetch(model.session.API + '/state/all', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('资料加载失败（HTTP ' + response.status + '），请重试');
        return response.json();
      }).then(function (snapshot) {
        if (!snapshot || !snapshot.entries || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries)) throw new Error('资料响应异常，请重试');
        return snapshot.entries;
      });
  }

  return Object.freeze({post: post, fetchEntries: fetchEntries});
});
