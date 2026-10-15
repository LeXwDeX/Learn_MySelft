/* Read-only task diagnostics. Model messages stay hidden until confirmed. */
(function () {
  'use strict';
  var context = window.LearnUser;
  var receipts = new Map();
  var mounts = new Map();
  var lists = new Map();
  var serial = 0;
  var cleanupTimer = null;
  var activeView = null;
  var statusLabels = {queued: '排队中', running: '生成中…', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消'};
  var kindLabels = {queued: '已排队', start: '开始处理', phase: '处理阶段', model_request: '模型请求', model_response: '模型回复', model_error: '模型调用失败', error: '任务错误', retry: '自动重试', status: '状态更新', restart: '服务重启', manual_retry: '手动重试'};
  function element(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function button(text, action, cls) {
    var node = element('button', 'learn-action ' + (cls || ''), text);
    node.type = 'button';
    node.addEventListener('click', function (event) { event.stopPropagation(); action(); });
    return node;
  }
  function identity(options) { return [context.userId, options.key || '', options.nodeId || '', options.operation || '', options.scope || ''].join('\n'); }
  function matches(job, options) {
    return (!options.key || job.key === options.key) && (!options.nodeId || job.node_id === options.nodeId) &&
      (!options.operation || job.operation === options.operation) && (!options.jobId || job.id === options.jobId);
  }
  function active(job) { return job && (job.status === 'running' || job.status === 'queued'); }
  async function get(path, signal) {
    var response = await context.fetch(context.apiBase + path, {method: 'GET', cache: 'no-store', signal: signal});
    var data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || '读取失败（HTTP ' + response.status + '）');
    return data;
  }
  function updateHeading(view) {
    var job = view.job;
    var guidance = {
      queued: '任务已排队，可以返回继续阅读。',
      running: '正在准备内容。可以关闭此窗口，稍后查看结果。',
      succeeded: '内容处理完成，请返回学习页面查看结果。',
      failed: '任务未完成，请返回原入口查看重试操作。已有内容仍保留。',
      interrupted: '任务已中断，请返回原入口继续处理。已有内容仍保留。',
      cancelled: '任务已取消，已有内容仍保留。'
    };
    view.summary.textContent = guidance[job.status] || '暂时无法确认任务状态，请稍后重新查看。';
    view.technical.textContent = '任务状态：' + (statusLabels[job.status] || job.status || '未知') +
      ' · 每次尝试最多 ' + (Number(job.timeout_seconds) || 300) + ' 秒' +
      (job.attempt ? ' · 第 ' + job.attempt + ' 次尝试' : '') +
      (job.response_status ? ' · HTTP ' + job.response_status : '') +
      (job.failure_phase ? ' · 失败阶段：' + job.failure_phase : '') +
      (job.status === 'queued' && job.retry_at_ms ? ' · 等待自动重试（约 ' + Math.max(0, Math.ceil((job.retry_at_ms - Date.now()) / 1000)) + ' 秒）' : '');
    view.failure.textContent = job.error || (job.error_category === 'timeout' ? '任务已超时。已记录的对话和日志保留在下面。' : '');
    view.failure.hidden = !view.failure.textContent;
  }
  function resetDisclosure(view) {
    view.diagnostics.open = false;
    view.revealed = false;
    view.reveal.textContent = '确认显示模型对话'; view.reveal.disabled = false;
    view.timeline.querySelectorAll('.learn-job-model-message').forEach(function (node) { node.hidden = true; });
  }
  function cancelRead(view) {
    clearTimeout(view.timer); view.timer = null;
    if (view.controller) view.controller.abort();
    view.controller = null; view.loading = false; view.epoch++;
  }
  function close(view, focus) {
    view.open = false;
    view.button.setAttribute('aria-expanded', 'false');
    cancelRead(view);
    resetDisclosure(view);
    window.LearnUI.dialog.close(view.panel);
    if (activeView === view) activeView = null;
    if (focus) {
      var target = view.returnFocus || view.button;
      if (!target.isConnected) document.querySelectorAll('.learn-job-detail-button').forEach(function (button) {
        if (!button.hidden && button.dataset.jobId === view.job.id) target = button;
      });
      if (!target.isConnected) document.querySelectorAll('.learn-status').forEach(function (row) {
        if (row.dataset.statusKey === 'job-' + view.job.id) target = row.querySelector('.learn-job-detail-button') || target;
      });
      if (target.isConnected) target.focus({preventScroll: true});
    }
  }
  function eventBody(event) {
    var parts = [];
    if (Array.isArray(event.messages)) event.messages.forEach(function (message) {
      parts.push('[' + String(message.role || 'message') + ']\n' + String(message.content == null ? '' : message.content));
    });
    if (event.content != null) parts.push(String(event.content));
    return parts.join('\n\n');
  }
  function renderEvents(view, details) {
    view.note.textContent = !details.available ? '这条旧任务没有对话或日志记录，无法补回。' :
      details.truncated ? '记录已达到保存上限。部分对话或日志已截断。' : '这里只显示实际模型请求、回复和任务日志。';
    view.disclosure.hidden = !(details.events || []).some(function (event) {
      return event.kind === 'model_request' || event.kind === 'model_response';
    });
    (details.events || []).forEach(function (event, index) {
      var id = event.id == null ? 'event-' + index : String(event.id);
      var signature = JSON.stringify(event);
      var previous = view.rows.get(id);
      if (previous && previous.signature === signature) return;
      var row = previous ? previous.node : element('li', 'learn-job-event');
      var title = (event.at_ms ? new Date(event.at_ms).toLocaleString() + ' · ' : '') +
        (kindLabels[event.kind] || event.kind || '任务记录') +
        (event.attempt ? ' · 第 ' + event.attempt + ' 次尝试' : '') +
        (event.phase ? ' · ' + event.phase : '') +
        (event.generation_attempt ? ' · 第 ' + event.generation_attempt + ' 次验题' : '') +
        (event.status ? ' · ' + (typeof event.status === 'number' ? 'HTTP ' + event.status : statusLabels[event.status] || event.status) : '') +
        (event.error_category ? ' · ' + event.error_category : '');
      row.replaceChildren(element('p', 'learn-job-event-title', title));
      if (event.label) row.appendChild(element('p', 'learn-job-event-label', event.label));
      if (event.call_id) row.appendChild(element('p', 'learn-job-event-label', '模型调用：' + event.call_id));
      var body = eventBody(event);
      if (body) {
        var modelMessage = event.kind === 'model_request' || event.kind === 'model_response';
        var text = element('pre', 'learn-job-conversation' + (modelMessage ? ' learn-job-model-message' : ''), body);
        text.hidden = modelMessage && !view.revealed;
        row.appendChild(text);
      }
      if (event.frames != null) row.appendChild(element('pre', 'learn-job-error-frames',
        '错误位置\n' + (typeof event.frames === 'string' ? event.frames : JSON.stringify(event.frames, null, 2))));
      if (event.truncated) row.appendChild(element('p', 'learn-job-event-label', '这条记录已截断。'));
      if (!previous) view.timeline.appendChild(row);
      view.rows.set(id, {node: row, signature: signature});
    });
  }
  async function read(view) {
    if (!view.open || view.loading || !view.job) return;
    if (!view.panel.isConnected) { close(view, false); mounts.delete(identity(view.options)); return; }
    clearTimeout(view.timer);
    var epoch = view.epoch;
    var controller = new AbortController();
    view.controller = controller; view.loading = true;
    var timeout = setTimeout(function () { controller.abort(); }, 20000);
    view.retry.disabled = true;
    try {
      var data = await get('/jobs/' + encodeURIComponent(view.job.id) + '/details', controller.signal);
      if (!view.open || epoch !== view.epoch) return;
      view.job = data.job || view.job;
      receipts.set(view.job.id, view.job);
      updateHeading(view);
      renderEvents(view, data.details || {available: false, events: []});
      view.readError.hidden = true;
      if (document.activeElement === view.retry) view.closeButton.focus({preventScroll: true});
      view.retry.hidden = true;
    } catch (error) {
      if (!view.open || epoch !== view.epoch) return;
      view.note.textContent = '无法读取任务详情：' + (error.name === 'AbortError' ? '请求超时' : error.message) + '。已显示的记录仍保留。';
      view.readError.textContent = '暂时无法读取最新进度。已显示的记录仍保留，请重试。'; view.readError.hidden = false;
      view.retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (epoch === view.epoch) {
        view.loading = false; view.controller = null;
        view.retry.disabled = false;
        if (view.open && view.panel.isConnected && active(view.job)) view.timer = setTimeout(function () { read(view); }, 2500);
      }
    }
  }
  function assign(view, job) {
    var changed = view.job && view.job.id !== job.id;
    if (changed) {
      cancelRead(view); view.timeline.replaceChildren(); view.rows.clear(); view.revealed = false;
      resetDisclosure(view);
      view.reveal.textContent = '确认显示模型对话'; view.reveal.disabled = false;
      view.note.textContent = '正在读取任务记录…';
      view.readError.hidden = true; view.retry.hidden = true;
    }
    view.job = job; view.button.hidden = Boolean(view.standalone);
    view.button.dataset.jobId = job.id;
    updateHeading(view);
    if (changed && view.open) read(view);
  }
  function observe(job) {
    if (!job || !job.id || String(job.id).startsWith('prepare-')) return;
    receipts.set(job.id, job);
    mounts.forEach(function (view) {
      // A new receipt must not replace the task the learner is reading.
      if (view.open && view.job && view.job.id !== job.id) return;
      if (matches(job, view.options) && (!view.job || view.job.id === job.id || (job.created_ms || 0) >= (view.job.created_ms || 0))) assign(view, job);
    });
  }
  function mount(host, options) {
    options = options || {};
    var key = identity(options);
    var view = mounts.get(key);
    if (!view) {
      var panel = element('dialog', 'learn-task-dialog learn-job-detail-panel');
      panel.id = 'learn-job-details-' + (++serial); panel.tabIndex = -1;
      var trigger = button('查看详情', function () { if (view.open) close(view, false); else open(view.job, view, view.button); }, 'learn-job-detail-button');
      trigger.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', panel.id);
      trigger.setAttribute('aria-haspopup', 'dialog');
      view = {options: options, panel: panel, button: trigger, rows: new Map(), epoch: 0, open: false, revealed: false};
      var header = element('div', 'learn-job-detail-header');
      view.header = header;
      var title = element('h2', 'learn-task-dialog-title', '任务进度');
      title.id = panel.id + '-title'; panel.setAttribute('aria-labelledby', title.id);
      header.appendChild(title);
      view.closeButton = button('关闭', function () { close(view, true); }, 'btn');
      header.appendChild(view.closeButton);
      view.taskName = element('p', 'learn-job-task-name');
      view.summary = element('p', 'learn-job-detail-summary');
      view.technical = element('p', 'learn-job-detail-technical');
      view.failure = element('p', 'learn-job-detail-error');
      view.note = element('p', 'learn-job-detail-note', '正在读取任务记录…');
      view.readError = element('p', 'learn-job-detail-error'); view.readError.hidden = true; view.readError.setAttribute('role', 'status');
      view.retry = button('重新读取进度', function () { read(view); }); view.retry.hidden = true;
      view.disclosure = element('div', 'learn-job-disclosure'); view.disclosure.hidden = true;
      view.disclosure.appendChild(element('p', '', '模型对话可能包含参考答案和评分标准。确认后显示。'));
      view.reveal = button('确认显示模型对话', function () {
        view.revealed = true; view.reveal.disabled = true; view.reveal.textContent = '已显示模型对话';
        view.timeline.querySelectorAll('.learn-job-conversation').forEach(function (node) { node.hidden = false; });
      });
      view.disclosure.appendChild(view.reveal);
      view.timeline = element('ol', 'learn-job-timeline');
      view.diagnostics = element('details', 'learn-job-diagnostics');
      view.diagnostics.append(element('summary', '', '排查问题：查看技术详情'), view.technical, view.failure, view.note, view.disclosure, view.timeline);
      var body = element('div', 'learn-task-dialog-body');
      body.append(view.taskName, view.summary, view.readError, view.retry, view.diagnostics);
      panel.append(header, body);
      panel.addEventListener('click', function (event) { event.stopPropagation(); });
      panel.addEventListener('keydown', function (event) { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(view, true); } });
      panel.addEventListener('cancel', function (event) { event.preventDefault(); close(view, true); });
      panel.addEventListener('close', function () { if (view.open && !panel.open) close(view, true); });
      trigger.addEventListener('keydown', function (event) { if (event.key === 'Escape' && view.open) { event.stopPropagation(); close(view, true); } });
      mounts.set(key, view);
    }
    host.appendChild(view.button);
    if (!view.panel.isConnected) document.body.appendChild(view.panel);
    receipts.forEach(function (job) { if ((!view.open || !view.job || view.job.id === job.id) && matches(job, options) && (!view.job || (job.created_ms || 0) >= (view.job.created_ms || 0))) assign(view, job); });
    if (options.key && !lists.has(options.key)) {
      var list = context.ready.then(async function () {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 20000);
        try {
          var data = await get('/jobs?key=' + encodeURIComponent(options.key), controller.signal);
          (data.jobs || []).forEach(observe);
        } finally { clearTimeout(timer); }
      });
      lists.set(options.key, list);
      list.catch(function () { lists.delete(options.key); });
    }
    if (cleanupTimer === null) cleanupTimer = setTimeout(function () {
      cleanupTimer = null;
      mounts.forEach(function (candidate, candidateKey) {
        if (!candidate.panel.isConnected || !candidate.button.isConnected && !candidate.open) {
          close(candidate, false); candidate.panel.remove(); mounts.delete(candidateKey);
        }
      });
    }, 0);
    return view;
  }
  function open(job, view, returnFocus) {
    if (!job || !job.id) return;
    var standalone = !view;
    if (!view) {
      view = mount(document.body, {key: job.key, nodeId: job.node_id, operation: job.operation, jobId: job.id, scope: 'status-' + job.id});
      view.standalone = true;
    }
    if (activeView && activeView !== view) close(activeView, false);
    view.returnFocus = returnFocus || document.activeElement || view.button;
    assign(view, job);
    if (standalone) view.button.hidden = true;
    view.taskName.textContent = job.node_title || job.title || job.topic || job.operation || '';
    view.open = true; activeView = view;
    view.button.setAttribute('aria-expanded', 'true');
    window.LearnUI.dialog.open(view.panel);
    view.closeButton.focus({preventScroll: true});
    read(view);
  }
  window.addEventListener('pagehide', function () { mounts.forEach(function (view) { close(view, false); }); });
  window.LearnJobDetails = Object.freeze({observe: observe, mount: mount, open: open});
})();
