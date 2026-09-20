/* Persistent job receipts contain identifiers, never login credentials. */
(function () {
  'use strict';
  var operations = new Set(['/path/intake', '/path/research', '/path/plan', '/path/node',
    '/path/requiz', '/path/quizmap', '/path/refine', '/path/gaps', '/path/quiz']);
  var labels = {'/path/intake': '确认学习目标', '/path/research': '研究学习资料',
    '/path/plan': '生成学习路径', '/path/node': '生成单元材料', '/path/requiz': '生成新题',
    '/path/quizmap': '生成综合测验', '/path/refine': '细化学习路径', '/path/gaps': '分析薄弱点', '/path/quiz': '评分'};
  var context = window.LearnUser;
  var running = new Map();
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stable(value[key]);
    }).join(',') + '}';
    return JSON.stringify(value);
  }
  function fingerprint(text) {
    // This locates a local receipt only. The server checks the complete request
    // with SHA-256 before reusing a receipt, so a local collision fails closed.
    var a = 2166136261, b = 3339675911;
    for (var i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619);
      b = Math.imul(b ^ text.charCodeAt(i), 2246822519);
    }
    return (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16) + '-' + text.length;
  }
  function requestId() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }
  function receiptKey(operation, body) {
    return 'learn-job-v1/' + context.userId + '/' + fingerprint(operation + stable(body));
  }
  function readReceipt(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; }
  }
  function saveReceipt(key, receipt) {
    try { localStorage.setItem(key, JSON.stringify(receipt)); } catch (error) { /* Server receipt remains authoritative. */ }
  }
  async function request(path, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 25000);
    try {
      var response = await context.fetch(context.apiBase + path, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)
      });
      var data = await response.json();
      if (!response.ok || data.error) {
        var error = new Error(data.error || '任务请求失败');
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  function delay(milliseconds) { return new Promise(function (resolve) { setTimeout(resolve, milliseconds); }); }
  function showJob(job, message, kind, action, label) {
    if (!window.LearnUI) return;
    var show = job.operation === '/path/requiz' && window.LearnUI.toast ? window.LearnUI.toast : window.LearnUI.set;
    show('job-' + job.id, message, kind, action, label);
  }
  function quizProgress(job) {
    var progress = job.progress;
    if (!progress) return job.status === 'queued' ? '步骤 0/4 · 等待开始' : '正在确认后台步骤';
    return '步骤 ' + progress.step + '/' + progress.total + ' · ' + progress.label +
      (progress.attempt > 1 ? '（第 ' + progress.attempt + ' 次生成）' : '');
  }
  function announce(job, callback) {
    var elapsed = Math.max(0, Math.round((Date.now() - job.created_ms) / 1000));
    var message = (labels[job.operation] || '学习任务') + (job.status === 'queued' ? '：排队中' : '：正在处理');
    message += ' · 已等待 ' + elapsed + ' 秒，离开页面后仍会继续';
    if (job.operation === '/path/requiz') message = '正在准备新的题目，目前进度：' + quizProgress(job) + '\n已等待 ' + elapsed + ' 秒，离开页面后仍会继续。';
    showJob(job, message);
    if (callback) callback(message);
  }
  async function execute(operation, body, options) {
    var key = receiptKey(operation, body);
    var receipt = readReceipt(key) || {requestId: requestId(), created: Date.now()};
    if (options.newOperation && receipt.id) {
      // Only an explicit next exam rotates a completed receipt. Unconfirmed,
      // running and failed work stays resumable with its original identity.
      var previous = (await request('/jobs/' + encodeURIComponent(receipt.id))).job;
      if (previous.status === 'succeeded' || previous.status === 'cancelled') {
        receipt = {requestId: requestId(), created: Date.now()};
      }
    }
    if (options.requestId) receipt.requestId = options.requestId;
    saveReceipt(key, receipt);
    var preparing = {id: 'prepare-' + receipt.requestId, operation: operation};
    if (operation === '/path/requiz') showJob(preparing, '正在准备新的题目，目前进度：步骤 0/4 · 提交任务');
    var accepted;
    try {
      accepted = await request('/jobs', {operation: operation, body: body, request_id: receipt.requestId});
    } catch (error) {
      if (operation === '/path/requiz') showJob(preparing, (error.status ? '本程序请求错误（HTTP ' + error.status + '）' : '网络连接或超时错误') + '\n任务提交未确认，请重试；原题和作答已保留。', 'error');
      throw error;
    }
    if (window.LearnUI) window.LearnUI.clear('job-' + preparing.id);
    var job = accepted.job;
    receipt.id = job.id;
    saveReceipt(key, receipt);
    // A fresh user operation or resumed page is one retry opportunity. Polling
    // never resubmits a failed job on its own.
    if (job.status === 'failed' || job.status === 'interrupted') job = (await request('/jobs/' + job.id + '/retry', {})).job;
    return watch(job, options);
  }
  async function watch(job, options) {
    var deadline = Date.now() + 3600000;
    while (job.status === 'queued' || job.status === 'running') {
      announce(job, options.onStatus);
      if (Date.now() > deadline) throw new Error('任务仍在后台处理，请稍后从资料库继续');
      await delay(1500);
      try { job = (await request('/jobs/' + job.id)).job; }
      catch (error) {
        if (error.status && error.status < 500) throw error;
        showJob(job, '网络连接或超时错误：暂时无法读取任务进度，后台任务仍会继续；正在重新连接…', 'error');
        await delay(3500);
      }
    }
    if (job.status !== 'succeeded') {
      var detail = job.error || '任务未完成，请重试';
      if (job.response_status >= 500 && !/错误|校验/.test(detail)) detail = '服务端错误（HTTP ' + job.response_status + '）：' + detail;
      var failed = new Error(detail);
      failed.jobId = job.id;
      var message = job.operation === '/path/requiz' ? '新题准备失败 · ' + quizProgress(job) + '\n' + failed.message + '\n旧题和作答已保留。' : failed.message;
      showJob(job, message, 'error', function () {
        if (options.onRetry) return options.onRetry();
        return request('/jobs/' + job.id + '/retry', {}).then(function () { location.reload(); });
      }, '继续原任务');
      throw failed;
    }
    if (job.operation === '/path/requiz') {
      showJob(job, '新的题目已准备好，目前进度：步骤 4/4 · 保存完成', 'success');
      setTimeout(function () { if (window.LearnUI) window.LearnUI.clear('job-' + job.id); }, 8000);
    } else if (window.LearnUI) window.LearnUI.clear('job-' + job.id);
    return job.result;
  }
  context.ready.then(function () {
    var prefix = 'learn-job-v1/' + context.userId + '/';
    try { Object.keys(localStorage).forEach(function (key) {
      if (key.startsWith(prefix)) {
        var receipt = readReceipt(key);
        if (!receipt || receipt.created < Date.now() - 30 * 86400000) localStorage.removeItem(key);
      }
    }); } catch (error) {}
  });
  window.LearnJobs = {
    supports: function (operation) { return operations.has(operation); },
    label: function (operation) { return labels[operation] || '学习任务'; },
    requestId: requestId,
    list: function (key) { return request('/jobs' + (key ? '?key=' + encodeURIComponent(key) : '')).then(function (data) { return data.jobs; }); },
    get: function (id) { return request('/jobs/' + encodeURIComponent(id)).then(function (data) { return data.job; }); },
    retry: function (id, options) {
      if (context.readOnly) return Promise.reject(new Error('当前视图只读'));
      return request('/jobs/' + encodeURIComponent(id) + '/retry', {}).then(function (data) { return watch(data.job, options || {}); });
    },
    watch: function (job, options) { return watch(job, options || {}); },
    run: function (operation, body, options) {
      if (context.readOnly) return Promise.reject(new Error('管理员查看其他用户资料时只读'));
      var key = receiptKey(operation, body);
      if (running.has(key)) return running.get(key);
      var work = execute(operation, body, options || {});
      running.set(key, work);
      work.finally(function () { running.delete(key); }).catch(function () {});
      return work;
    }
  };
})();
