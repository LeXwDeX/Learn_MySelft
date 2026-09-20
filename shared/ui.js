/* Shared accessible status messages. Text and callbacks are never HTML. */
(function () {
  'use strict';
  var items = new Map();
  function render() {
    if (!document.body) return;
    var area = document.getElementById('learn-status-area');
    if (!area) {
      area = document.createElement('section');
      area.id = 'learn-status-area';
      area.className = 'learn-status-area';
      area.setAttribute('aria-label', '保存和任务状态');
      area.setAttribute('aria-live', 'polite');
      var bar = document.querySelector('.user-bar');
      if (bar) bar.after(area); else document.body.prepend(area);
    }
    area.replaceChildren();
    var toasts = document.getElementById('learn-toast-area');
    if (!toasts) {
      toasts = document.createElement('section'); toasts.id = 'learn-toast-area';
      toasts.className = 'learn-toast-area'; toasts.setAttribute('aria-live', 'polite');
      toasts.setAttribute('aria-label', '任务进度'); document.body.appendChild(toasts);
    }
    toasts.replaceChildren();
    items.forEach(function (item, key) {
      var row = document.createElement('div');
      row.className = 'learn-status';
      row.dataset.kind = item.kind;
      row.dataset.statusKey = key;
      var text = document.createElement('span');
      text.className = 'learn-status-text';
      text.textContent = item.message;
      row.appendChild(text);
      if (item.action) {
        var button = document.createElement('button');
        button.className = 'learn-action';
        button.textContent = item.label || '重试';
        button.onclick = function () {
          button.disabled = true;
          Promise.resolve().then(item.action).catch(function (error) {
            (item.toast ? window.LearnUI.toast : window.LearnUI.set)(key, error.message, 'error', item.action, item.label);
          }).finally(function () {
            if (items.get(key) === item) button.disabled = false;
          });
        };
        row.appendChild(button);
      }
      if (item.toast && item.kind !== 'info') {
        var dismiss = document.createElement('button'); dismiss.className = 'learn-action';
        dismiss.textContent = '关闭'; dismiss.setAttribute('aria-label', '关闭任务提示');
        dismiss.onclick = function () { window.LearnUI.clear(key); }; row.appendChild(dismiss);
      }
      (item.toast ? toasts : area).appendChild(row);
    });
  }
  window.LearnUI = {
    set: function (key, message, kind, action, label) {
      items.set(key, {message: message, kind: kind || 'info', action: action, label: label});
      render();
    },
    toast: function (key, message, kind, action, label) {
      items.set(key, {message: message, kind: kind || 'info', action: action, label: label, toast: true});
      render();
    },
    clear: function (key) { items.delete(key); render(); },
    ready: render
  };
  document.addEventListener('DOMContentLoaded', render);
})();
