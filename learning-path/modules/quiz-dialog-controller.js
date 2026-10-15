/* 窗口事件、轮次导航和作答提交。 */
define("quiz-dialog.controller", ["quiz-dialog.model", "quiz-dialog.drafts", "quiz-dialog.view", "quiz-dialog.question", "quiz-dialog.network"], function (deps) {
  'use strict';
  var model = deps["quiz-dialog.model"];
  var drafts = deps["quiz-dialog.drafts"];
  var view = deps["quiz-dialog.view"];
  var question = deps["quiz-dialog.question"];
  var network = deps["quiz-dialog.network"];


function navigate(index) {
    if (!model.session.view || model.session.view.busy) return;
    drafts.flushCurrent();
    model.session.view.index = index;
    drafts.chooseDraft(); view.render();
    model.byId('qd-body').scrollTop = 0;
    if (model.session.view.localRecovery) drafts.flushCurrent();
  }

function close() {
    drafts.flushCurrent();
    model.session.opening += 1;
    window.LearnUI.dialog.close(model.session.dialog);
    if (model.session.returnFocus && model.session.returnFocus.isConnected) model.session.returnFocus.focus();
  }

function submit() {
    if (!model.session.view || model.session.view.busy || model.session.view.readOnly) return;
    drafts.captureDraft();
    if (!model.session.view.answers.some(question.hasAnswer)) { model.byId('qd-error').textContent = '请至少回答一题再提交'; model.byId('qd-error').hidden = false; return; }
    var active = model.session.view, config = model.roundConfig(), id = model.round().id, answers = model.session.view.answers.slice();
    model.session.view.busy = true; view.render();
    return Promise.resolve().then(function () {
      if (active.config.beforeSubmit) return active.config.beforeSubmit();
    }).then(function (allowed) {
      if (allowed === false) throw new Error('本单元暂时不可访问，请返回正文确认访问状态');
      return drafts.flushCurrent();
    }).then(function () {
      return network.api(config, '/path/quiz', {key: config.key, node: {id: config.nodeId || ''}, round_id: id, answers: answers});
    }).then(function (result) {
      active.busy = false;
      result.quiz.rounds.forEach(function (r) { r.storageKey = config.key; });
      active.quiz.rounds = active.quiz.rounds.map(function (r) {
        return result.quiz.rounds.find(function (updated) { return updated.id === r.id; }) || r;
      });
      active.index = active.quiz.rounds.findIndex(function (r) { return r.id === id; });
      var issued = active.quiz.rounds[active.index];
      active.attempt = issued.attempts.find(function (a) { return a.id === result.attempt_id; }) || issued.attempts[issued.attempts.length - 1];
      active.readOnly = true; active.answers = answers;
      var key = question.localKey(config, id);
      drafts.discardRecord(key);
      try { localStorage.removeItem(key); } catch (error) {}
      if (active.config.onResult) active.config.onResult(result, config.key);
      if (model.session.view === active) view.render();
    }).catch(function (error) {
      active.busy = false;
      if (model.session.view === active) {
        view.render(); model.byId('qd-error').textContent = '提交未完成，作答已保留：' + error.message; model.byId('qd-error').hidden = false;
      }
    });
  }

function create() {
    if (model.session.dialog) return;

    model.session.dialog = document.createElement('dialog'); model.session.dialog.id = 'quiz-workspace'; model.session.dialog.setAttribute('aria-labelledby', 'qd-title');
    model.session.dialog.innerHTML = '<div class="qd-layout"><header class="qd-head"><h2 id="qd-title">测验</h2><span id="qd-progress"></span><button class="btn qd-close" id="qd-close" aria-label="保存并关闭测验">保存并关闭</button></header><nav class="qd-nav" aria-label="题集翻页"><button class="btn" id="qd-prev">上一套</button><select id="qd-round" aria-label="选择题集"></select><button class="btn" id="qd-next">下一套</button><select id="qd-attempt" aria-label="选择历史作答"></select></nav><div id="qd-body"></div><div id="qd-error" role="alert" hidden></div><footer class="qd-foot"><span id="qd-save" role="status" aria-live="polite"></span><button class="btn" id="qd-sync">重试保存</button><button class="btn" id="qd-retry" hidden>再做本套</button><button class="btn primary" id="qd-submit">提交本套</button></footer></div>';
    document.body.appendChild(model.session.dialog);
    model.session.dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    model.byId('qd-close').onclick = close;
    model.byId('qd-prev').onclick = function () { navigate(model.session.view.index - 1); };
    model.byId('qd-next').onclick = function () { navigate(model.session.view.index + 1); };
    model.byId('qd-round').onchange = function () { navigate(Number(this.value)); };
    model.byId('qd-attempt').onchange = function () {
      if (!model.session.view || model.session.view.busy) return;
      drafts.flushCurrent();
      if (this.value === 'draft') {
        model.session.view.attempt = null; model.session.view.readOnly = !!model.session.view.config.readOnly;
        model.session.view.answers = (model.round().draft || {}).answers || model.round().questions.map(function () { return ''; });
      } else {
        model.session.view.attempt = model.round().attempts[Number(this.value)]; model.session.view.readOnly = true;
        model.session.view.answers = model.session.view.attempt.answers || model.round().questions.map(function () { return ''; });
      }
      view.render();
    };
    model.byId('qd-retry').onclick = function () {
      if (!model.session.view || model.session.view.busy) return;
      model.session.view.attempt = null; model.session.view.readOnly = !!model.session.view.config.readOnly; model.session.view.answers = model.round().questions.map(function () { return ''; });
      view.render(); drafts.captureDraft();
    };
    model.byId('qd-sync').hidden = true;
    model.byId('qd-sync').onclick = drafts.retrySave;
    model.byId('qd-submit').onclick = submit;
    model.byId('qd-body').addEventListener('click', function (event) {
      var button = event.target.closest('.qd-reveal');
      if (!button) return;
      var content = model.byId(button.getAttribute('aria-controls'));
      if (content.hidden && !window.confirm('确定查看本题的参考答案与解题思路吗？建议先独立作答。')) return;
      content.hidden = !content.hidden;
      if (!content.hidden && model.session.view.config.decorate) model.session.view.config.decorate(content);
      button.setAttribute('aria-expanded', String(!content.hidden));
      button.textContent = content.hidden ? '查看答案与思路' : '收起答案与思路';
    });
    model.byId('qd-body').addEventListener('input', drafts.captureDraft);
    model.byId('qd-body').addEventListener('change', drafts.captureDraft);
    window.addEventListener('pagehide', drafts.flushAll);
    window.addEventListener('online', drafts.flushAll);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') drafts.flushAll(); });
  }

function open(config) {
      create();
      if (model.session.view && model.session.view.busy) { if (!model.session.dialog.open) window.LearnUI.dialog.open(model.session.dialog); return Promise.resolve(); }
      drafts.flushCurrent();
      model.session.view = null;
      model.byId('qd-sync').hidden = true;
      model.byId('qd-sync').disabled = true;
      view.status('正在恢复题集与草稿…', false);
      var request = ++model.session.opening;
      model.session.returnFocus = document.activeElement;
      if (!model.session.dialog.open) window.LearnUI.dialog.open(model.session.dialog);
      model.byId('qd-title').textContent = config.title || '测验';
      model.byId('qd-body').textContent = '正在恢复题集与草稿…';
      ['qd-prev', 'qd-next', 'qd-round', 'qd-attempt', 'qd-submit', 'qd-retry'].forEach(function (id) { model.byId(id).disabled = true; });
      var keys = config.relatedKeys || [config.key];
      return Promise.all(keys.map(function (key) {
        var scoped = Object.assign({}, config, {key: key});
        return network.api(scoped, '/path/quiz/state', {key: key, node: {id: config.nodeId || ''}}).then(function (quiz) {
          quiz.rounds.forEach(function (r) { r.storageKey = key; });
          return quiz;
        });
      })).then(function (quizzes) {
        if (request !== model.session.opening || !model.session.dialog.open) return;
        var quiz = quizzes[keys.indexOf(config.key)];
        if (config.onLoad) config.onLoad(quiz);
        quiz = Object.assign({}, quiz, {rounds: quizzes.reduce(function (all, q) { return all.concat(q.rounds); }, [])});
        model.session.view = {config: config, quiz: quiz, index: Math.max(0, quiz.rounds.findIndex(function (r) { return r.id === (config.roundId || quiz.round_id); })), busy: false};
        drafts.chooseDraft(); view.render();
        if (model.session.view.localRecovery) drafts.flushCurrent();
        model.byId('qd-close').focus();
        if (window.LearnJobs && !config.readOnly) {
          var active = model.session.view;
          window.LearnJobs.list().then(function (jobs) {
            if (model.session.view !== active || !model.session.dialog.open) return;
            var job = jobs.find(function (item) {
              return item.operation === '/path/quiz' && item.key === model.roundConfig().key &&
                item.round_id === model.round().id && (item.status === 'queued' || item.status === 'running');
            });
            if (!job) return;
            active.busy = true; view.render();
            return window.LearnJobs.watch(job, {onStatus: function (message) {
              if (model.session.view === active && model.session.dialog.open) view.status(message, false);
            }}).then(function () {
              active.busy = false;
              if (model.session.view === active && model.session.dialog.open) return window.QuizDialog.open(config);
            }).catch(function (error) {
              active.busy = false;
              if (model.session.view === active && model.session.dialog.open) { view.render(); view.status(error.message, true); }
            });
          }).catch(function (error) { if (model.session.view === active && model.session.dialog.open) view.status('任务状态暂时无法读取：' + error.message, true); });
        }
      }).catch(function (error) {
        if (request !== model.session.opening || !model.session.dialog.open) return;
        model.byId('qd-body').textContent = '无法打开题集：' + error.message;
      });
    }

  return Object.freeze({navigate: navigate, close: close, submit: submit, create: create, open: open});
});
