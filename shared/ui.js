/* Shared accessible status messages. Text and callbacks are never HTML. */
(function () {
  'use strict';
  var items = new Map(), views = new Map(), dialogs = new WeakMap(), errorSequence = 0;
  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character];
    });
  }
  function byId(id) { return document.getElementById(id); }
  function text(element, value) {
    value = String(value == null ? '' : value);
    if (element.textContent !== value) element.textContent = value;
  }
  function showError(id, message, input) {
    var element = typeof id === 'string' ? byId(id) : id;
    text(element, message);
    element.hidden = !message;
    input = typeof input === 'string' ? byId(input) : input;
    if (!input) return;
    if (!element.id) {
      var generatedId;
      do { generatedId = 'learn-field-error-' + (++errorSequence); } while (byId(generatedId));
      element.id = generatedId;
    }
    var descriptions = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    descriptions = descriptions.filter(function (token) { return token !== element.id; });
    if (message) {
      descriptions.push(element.id);
      input.setAttribute('aria-invalid', 'true');
    } else input.removeAttribute('aria-invalid');
    if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
    else input.removeAttribute('aria-describedby');
  }
  function ready(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback);
    else callback();
  }
  function closingCycle(state, cancelEvent) {
    return {cycle: state.cycle, returnFocus: state.cycle && state.cycle.returnFocus,
      onClose: state.onClose, cancelEvent: cancelEvent};
  }
  function dialogState(element) {
    if (dialogs.has(element)) return dialogs.get(element);
    var state = {cancelButtons: new WeakSet(), onClose: null, cycle: null, closing: []};
    dialogs.set(element, state);
    element.addEventListener('cancel', function (event) {
      // Inspect defaultPrevented when close arrives: later business listeners
      // may still prevent this Escape (for example, during submission).
      state.closing.push(closingCycle(state, event));
    });
    element.addEventListener('close', function () {
      while (state.closing.length && state.closing[0].cancelEvent && state.closing[0].cancelEvent.defaultPrevented) state.closing.shift();
      var closed = state.closing.shift() || closingCycle(state);
      if (element.open || closed.cycle !== state.cycle) return;
      if (element.querySelectorAll) element.querySelectorAll('input[type="password"]').forEach(function (input) { input.value = ''; });
      state.cycle = null;
      var target = closed.returnFocus, active = document.activeElement;
      try { if (closed.onClose) closed.onClose(); }
      finally {
        if (!element.open && document.activeElement === active && target &&
            target.isConnected !== false && !target.disabled && target.focus) target.focus();
      }
    });
    return state;
  }
  function openDialog(element, focus) {
    var state = dialogState(element);
    if (!element.open) {
      var target = document.activeElement;
      element.showModal();
      state.cycle = {returnFocus: target};
    }
    if (focus) focus.focus();
  }
  function closeDialog(element) {
    if (!element.open) return;
    var state = dialogState(element);
    state.closing.push(closingCycle(state));
    element.close();
  }
  function bindDialog(element, cancel, onClose) {
    var state = dialogState(element);
    state.onClose = onClose || null;
    if (cancel && !state.cancelButtons.has(cancel)) {
      state.cancelButtons.add(cancel);
      cancel.addEventListener('click', function () { closeDialog(element); });
    }
  }
  function statusArea(id, className, label) {
    var area = byId(id);
    if (area) return area;
    area = document.createElement('section');
    area.id = id; area.className = className;
    area.setAttribute('aria-label', label); area.setAttribute('aria-live', 'polite');
    var bar = id === 'learn-status-area' && document.querySelector('.user-bar');
    if (bar) bar.after(area);
    else if (id === 'learn-status-area') document.body.prepend(area);
    else document.body.appendChild(area);
    return area;
  }
  function remove(element) { if (element && element.parentNode) element.remove(); }
  function button(className) {
    var element = document.createElement('button');
    element.type = 'button'; element.className = className;
    return element;
  }
  function createView(key) {
    var view = {row: document.createElement('div'), text: document.createElement('span'), busy: false};
    view.row.className = 'learn-status'; view.row.dataset.statusKey = key;
    view.text.className = 'learn-status-text'; view.row.appendChild(view.text);
    view.primary = button('learn-action');
    view.secondary = button('learn-action learn-job-detail-button');
    view.dismiss = button('learn-action');
    text(view.dismiss, '关闭'); view.dismiss.setAttribute('aria-label', '关闭任务提示');
    view.dismiss.onclick = function () { window.LearnUI.clear(key); };
    [view.primary, view.secondary, view.dismiss].forEach(function (control) { view.row.appendChild(control); });
    function run(secondary, event) {
      if (view.busy || views.get(key) !== view) return;
      var item = items.get(key), action = secondary ? (item.options || {}).secondaryAction : item.action;
      if (!action) return;
      view.busy = true; render();
      var work;
      // Invoke while currentTarget is still available to existing detail actions.
      try { work = action(event); } catch (error) { work = Promise.reject(error); }
      Promise.resolve(work).catch(function (error) {
        // A later poll, clear, or new operation owns the visible result now.
        if (views.get(key) !== view || items.get(key) !== item) return;
        update(key, error && error.message || '操作失败，请重试', 'error', item.action, item.label, item.options, item.toast);
      }).finally(function () {
        view.busy = false;
        if (views.get(key) === view) render();
      });
    }
    view.primary.onclick = function (event) { run(false, event); };
    view.secondary.onclick = function (event) { run(true, event); };
    return view;
  }
  function mount(parent, element, visible) {
    if (visible) { if (element.parentNode !== parent) parent.appendChild(element); }
    else remove(element);
  }
  function render() {
    if (!document.body) return;
    var area = statusArea('learn-status-area', 'learn-status-area', '保存和任务状态');
    var toasts = statusArea('learn-toast-area', 'learn-toast-area', '任务进度');
    views.forEach(function (view, key) {
      if (!items.has(key)) { remove(view.row); views.delete(key); }
    });
    items.forEach(function (item, key) {
      var view = views.get(key);
      if (!view) { view = createView(key); views.set(key, view); }
      view.row.dataset.kind = item.kind;
      text(view.text, item.message);
      text(view.primary, item.label || '重试');
      text(view.secondary, (item.options || {}).secondaryLabel || '查看详情');
      view.primary.disabled = view.busy; view.secondary.disabled = view.busy;
      if (view.busy) view.row.setAttribute('aria-busy', 'true');
      else view.row.removeAttribute('aria-busy');
      view.primary.hidden = !item.action;
      view.secondary.hidden = !(item.options && item.options.secondaryAction);
      view.dismiss.hidden = !(item.toast && item.kind !== 'info');
      mount(item.toast ? toasts : area, view.row, true);
    });
  }
  function update(key, message, kind, action, label, options, toast) {
    items.set(key, {message: message, kind: kind || 'info', action: action, label: label, options: options, toast: !!toast});
    render();
  }
  window.LearnUI = {
    set: function (key, message, kind, action, label, options) { update(key, message, kind, action, label, options, false); },
    toast: function (key, message, kind, action, label, options) { update(key, message, kind, action, label, options, true); },
    clear: function (key) { items.delete(key); render(); },
    ready: render,
    dom: Object.freeze({byId: byId, escapeHTML: escapeHTML, showError: showError, ready: ready}),
    dialog: Object.freeze({open: openDialog, close: closeDialog, bind: bindDialog})
  };
  document.addEventListener('DOMContentLoaded', render);
})();
