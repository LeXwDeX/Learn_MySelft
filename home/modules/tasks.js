define('home.tasks', ["home.platform", "home.library"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var jobDetails = platform.jobDetails;
  var $ = ui.dom.byId;
  var taskTimer = null, loadVersion = 0, hasError = false;
  var rows = new Map(), retrying = new Set();
  var statuses = {queued: '排队中', running: '正在处理', succeeded: '已完成', failed: '未完成', interrupted: '等待恢复', cancelled: '已取消'};

  function retryLabel(job) { return job.operation === '/path/requiz' ? '重新生成新题' : '重试此任务'; }

  function retryTask(view) {
    var job = view.job;
    if (context.readOnly || retrying.has(job.id)) return;
    retrying.add(job.id);
    updateRow(view, job);
    ui.set('retry-' + job.id, '正在重新提交：' + platform.jobs.label(job.operation));
    context.request('/jobs/' + job.id + '/retry', {}).then(function (result) {
      platform.jobs.watch(result.job).then(loadTasks).catch(loadTasks);
      return loadTasks();
    }).catch(function (cause) {
      hasError = true;
      ui.set('tasks', cause.message, 'error', loadTasks, '刷新状态');
    }).finally(function () {
      retrying.delete(job.id);
      ui.clear('retry-' + job.id);
      if (rows.get(job.id) === view) updateRow(view, view.job);
    });
  }

  function createRow(job) {
    var row = document.createElement('div'); row.className = 'learn-task';
    var info = document.createElement('div'); info.className = 'learn-task-info';
    var title = document.createElement('strong'), detail = document.createElement('small'), failure = document.createElement('small');
    info.append(title, detail, failure);
    var actions = document.createElement('div'); actions.className = 'actions';
    var details = document.createElement('button'); details.type = 'button'; details.className = 'btn learn-job-detail-button';
    details.textContent = '查看详情'; details.setAttribute('aria-haspopup', 'dialog'); details.dataset.jobId = job.id;
    var link = document.createElement('a'); link.className = 'btn'; link.textContent = '继续查看';
    var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn';
    actions.append(details, link, retry); row.append(info, actions);
    var view = {row: row, title: title, detail: detail, failure: failure, details: details, link: link, retry: retry, job: job};
    details.addEventListener('click', function (event) { jobDetails.open(view.job, null, event.currentTarget); });
    retry.onclick = function () { retryTask(view); };
    return view;
  }

  function updateRow(view, job) {
    view.job = job;
    view.title.textContent = platform.titles.document(job);
    view.detail.textContent = platform.jobs.label(job.operation) + ' · ' + (statuses[job.status] || job.status) + ' · ' + new Date(job.created_ms).toLocaleString('zh-CN');
    view.failure.textContent = job.error || ''; view.failure.hidden = !job.error;
    var business = (job.key || '').slice(context.userId.length + 1);
    var page = business.startsWith('quiz-map-v1-') ? 'quiz-map.html' : 'learning-path.html';
    var slug = business.replace(/^(?:learn-path|quiz-map)-v1-/, '');
    view.link.href = context.link(page) + '?t=' + encodeURIComponent(slug);
    view.retry.hidden = context.readOnly || (!['failed', 'interrupted'].includes(job.status) && !retrying.has(job.id));
    view.retry.disabled = retrying.has(job.id);
    view.retry.textContent = retrying.has(job.id) ? '正在重新提交…' : retryLabel(job);
  }

  function renderTasks(jobs) {
    var list = $('task-list'), focused = list.contains(document.activeElement) ? document.activeElement : null;
    var current = new Set(jobs.map(function (job) { return job.id; }));
    rows.forEach(function (view, id) { if (!current.has(id)) { view.row.remove(); rows.delete(id); } });
    jobs.forEach(function (job, index) {
      jobDetails.observe(job);
      var view = rows.get(job.id);
      if (!view) { view = createRow(job); rows.set(job.id, view); }
      updateRow(view, job);
      if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
    });
    $('tasks-panel').hidden = !jobs.length;
    if (focused) {
      if (focused.isConnected && !focused.hidden && !focused.disabled) focused.focus({preventScroll: true});
      else if (jobs.length) $('refresh-tasks').focus({preventScroll: true});
      else $('refresh-library').focus({preventScroll: true});
    }
  }

  function loadTasks() {
    if (taskTimer) clearTimeout(taskTimer);
    var version = ++loadVersion;
    var library = deps['home.library'].load();
    var tasks = context.request('/jobs?view=recent').then(function (result) {
      if (version !== loadVersion) return;
      if (!Array.isArray(result.jobs)) throw new Error('任务响应不完整，请重新读取。');
      var jobs = result.jobs.slice(0, 8);
      renderTasks(jobs);
      if (hasError) { ui.clear('tasks'); hasError = false; }
      if (jobs.some(function (job) { return ['queued', 'running'].includes(job.status); })) taskTimer = setTimeout(loadTasks, 5000);
    }).catch(function (cause) {
      if (version !== loadVersion) return;
      hasError = true;
      ui.set('tasks', '任务状态暂时不可用：' + cause.message, 'error', loadTasks, '重新连接');
    });
    return Promise.all([library, tasks]);
  }
  $('refresh-tasks').onclick = loadTasks;

  return {load: loadTasks};
});
