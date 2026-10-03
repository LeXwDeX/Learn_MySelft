define('home.tasks', ["home.platform", "home.library"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  var taskTimer = null;
  function loadTasks() {
    if (taskTimer) clearTimeout(taskTimer);
    context.request('/state/all').then(function (result) {
      deps['home.library'].render(result.entries);
    }).catch(function (e) { error('library-error', e.message); });
    return context.request('/jobs?view=recent').then(function (result) {
      var jobs = result.jobs.slice(0, 8);
      $('tasks-panel').hidden = !jobs.length;
      $('task-list').replaceChildren();
      jobs.forEach(function (job) {
        var row = document.createElement('div'); row.className = 'learn-task';
        var info = document.createElement('div');
        var title = document.createElement('strong'); title.textContent = platform.titles.document(job);
        var detail = document.createElement('small');
        var statuses = {queued: '排队中', running: '正在处理', succeeded: '已完成', failed: '未完成', interrupted: '等待恢复', cancelled: '已取消'};
        detail.textContent = platform.jobs.label(job.operation) + ' · ' + (statuses[job.status] || job.status) + ' · ' + new Date(job.created_ms).toLocaleString('zh-CN');
        info.append(title, detail);
        if (job.error) { var error = document.createElement('small'); error.textContent = job.error; info.appendChild(error); }
        row.appendChild(info);
        var actions = document.createElement('div'); actions.className = 'actions';
        var business = (job.key || '').slice(context.userId.length + 1);
        var page = business.startsWith('quiz-map-v1-') ? 'quiz-map.html' : 'learning-path.html';
        var slug = business.replace(/^(?:learn-path|quiz-map)-v1-/, '');
        var link = document.createElement('a'); link.className = 'btn'; link.href = context.link(page) + '?t=' + encodeURIComponent(slug); link.textContent = '继续查看';
        actions.appendChild(link);
        if (!context.readOnly && ['failed', 'interrupted'].includes(job.status)) {
          var retry = document.createElement('button'); retry.className = 'btn'; retry.textContent = job.operation === '/path/requiz' ? '重新生成新题' : '重试此任务';
          retry.onclick = function () {
            retry.disabled = true; retry.textContent = '正在重新提交…';
            ui.set('retry-' + job.id, '正在重新提交：' + platform.jobs.label(job.operation));
            context.request('/jobs/' + job.id + '/retry', {}).then(function (result) {
              ui.clear('retry-' + job.id);
              platform.jobs.watch(result.job).then(loadTasks).catch(loadTasks);
              return loadTasks();
            }).catch(function (error) {
              retry.disabled = false; retry.textContent = '重试此任务';
              ui.clear('retry-' + job.id);
              ui.set('tasks', error.message, 'error', loadTasks, '刷新状态');
            });
          };
          actions.appendChild(retry);
        }
        row.appendChild(actions); $('task-list').appendChild(row);
      });
      if (jobs.some(function (job) { return ['queued', 'running'].includes(job.status); })) taskTimer = setTimeout(loadTasks, 5000);
    }).catch(function (error) { ui.set('tasks', '任务状态暂时不可用：' + error.message, 'error', loadTasks, '重新连接'); });
  }
  $('refresh-tasks').onclick = loadTasks;

  return {load: loadTasks};
});
