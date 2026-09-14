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
            window.LearnUI.set(key, error.message, 'error', item.action, item.label);
          });
        };
        row.appendChild(button);
      }
      area.appendChild(row);
    });
  }
  window.LearnUI = {
    set: function (key, message, kind, action, label) {
      items.set(key, {message: message, kind: kind || 'info', action: action, label: label});
      render();
    },
    clear: function (key) { items.delete(key); render(); },
    ready: render
  };
  document.addEventListener('DOMContentLoaded', render);
})();
