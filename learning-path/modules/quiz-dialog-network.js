/* 题集、草稿和判分网络请求。 */
define("quiz-dialog.network", ["quiz-dialog.model", "quiz-dialog.hooks"], function (deps) {
  'use strict';
  var model = deps["quiz-dialog.model"];
  var hooks = deps["quiz-dialog.hooks"];

function api(config, endpoint, body, keepalive) {
    if (endpoint === '/path/quiz' && window.LearnJobs) {
      return window.LearnJobs.run(endpoint, body, {onStatus: function (message) {
        if (model.session.view && model.session.dialog.open && model.roundConfig().key === config.key) hooks.status(message, false);
      }});
    }
    var payload = JSON.stringify(body);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, endpoint === '/path/quiz' ? 240000 : 20000);
    return window.LearnUser.fetch(config.api + endpoint, {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: payload,
      keepalive: !!keepalive && new Blob([payload]).size <= 60000
    }).then(function (response) {
      return response.json().then(function (result) {
        if (!response.ok || result.ok === false || result.error) throw new Error(result.error || '请求失败');
        return result;
      });
    }).finally(function () { clearTimeout(timeout); });
  }

  return Object.freeze({api: api});
});
