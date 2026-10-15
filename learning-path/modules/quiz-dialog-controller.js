/* 窗口事件、轮次导航和作答提交。 */
define("quiz-dialog.controller", ["quiz-dialog.model", "quiz-dialog.drafts", "quiz-dialog.view", "quiz-dialog.question", "quiz-dialog.network"], function (deps) {
  'use strict';
  var model = deps["quiz-dialog.model"];
  var drafts = deps["quiz-dialog.drafts"];
  var view = deps["quiz-dialog.view"];
  var question = deps["quiz-dialog.question"];
  var network = deps["quiz-dialog.network"];


function persistCurrent() {
    var record = drafts.currentRecord(), active = model.session.view, index = active && active.index;
    return Promise.resolve(drafts.flushCurrent()).then(function () {
      if (!record || record.saved || record.localSaved) return true;
      if (model.session.view !== active || (active && active.index !== index)) return false;
      view.renderSaveState();
      model.byId('qd-error').textContent = '草稿尚未保存到服务器或本机。请重试保存后再返回。';
      model.byId('qd-error').hidden = false;
      return false;
    });
  }

function navigate(index) {
    var active = model.session.view;
    if (!active || active.busy || index < 0 || index >= active.quiz.rounds.length) return Promise.resolve(false);
    var previous = active.index;
    return persistCurrent().then(function (safe) {
      if (!safe || model.session.view !== active || active.index !== previous) return false;
      active.index = index;
      drafts.chooseDraft(); view.render();
      model.byId('qd-body').scrollTop = 0;
      if (active.localRecovery) drafts.flushCurrent();
      return true;
    });
  }

function close(options) {
    options = options || {};
    var active = model.session.view, index = active && active.index, opening = model.session.opening;
    var pending = model.session.closing;
    if (pending && pending.active === active && pending.index === index && pending.opening === opening) return pending.promise;
    if (!model.session.dialog || !model.session.dialog.open) return Promise.resolve(false);
    var token = {active: active, index: index, opening: opening};
    token.promise = persistCurrent().then(function (safe) {
      if (!safe || model.session.view !== active || (active && active.index !== index) || model.session.opening !== opening || !model.session.dialog.open) return false;
      model.session.opening += 1;
      window.LearnUI.dialog.close(model.session.dialog);
      var target = active && active.config.restoreFocus && active.config.restoreFocus();
      if (!target || !target.isConnected) target = model.session.returnFocus;
      if (options.restoreFocus !== false && target && target.isConnected) target.focus();
      return true;
    }).finally(function () { if (model.session.closing === token) model.session.closing = null; });
    model.session.closing = token;
    return token.promise;
  }

function returnToLearning() {
    var active = model.session.view;
    if (!active || !active.attempt || !active.config.resultReturn) return;
    if (model.session.returning && model.session.returning.active === active) return model.session.returning.promise;
    var context = model.resultContext(), action = active.config.resultReturn, token = {active: active};
    token.promise = close().then(function (closed) { if (closed && action.onReturn) return action.onReturn(context); }).finally(function () { if (model.session.returning === token) model.session.returning = null; });
    model.session.returning = token;
    return token.promise;
  }

function submit() {
    if (!model.session.view || model.session.view.busy || model.session.view.recovering || model.session.view.readOnly) return;
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
      active.busy = false; active.recovering = true;
      if (model.session.view === active) {
        view.render(); model.byId('qd-error').textContent = '提交结果尚未确认，作答仍在窗口中。请重新读取结果或恢复批改任务：' + error.message; model.byId('qd-error').hidden = false;
        model.byId('qd-reload').hidden = false;
      }
    });
  }

function create() {
    if (model.session.dialog) return;

    model.session.dialog = document.createElement('dialog'); model.session.dialog.id = 'quiz-workspace'; model.session.dialog.setAttribute('aria-labelledby', 'qd-title');
    model.session.dialog.innerHTML = '<div class="qd-layout"><header class="qd-head"><h2 id="qd-title">测验</h2><span id="qd-progress"></span><button class="btn qd-close" id="qd-close" aria-label="返回学习页面">返回</button></header><details class="qd-history" id="qd-history"><summary>题集与历史作答</summary><nav class="qd-nav" aria-label="题集与历史作答"><button class="btn" id="qd-prev">上一套</button><select id="qd-round" aria-label="选择题集"></select><button class="btn" id="qd-next">下一套</button><select id="qd-attempt" aria-label="选择历史作答"></select></nav></details><div id="qd-body"></div><div id="qd-error" role="alert" hidden></div><footer class="qd-foot"><span id="qd-save" role="status" aria-live="polite"></span><button class="btn" id="qd-reload" hidden>重新读取题集</button><button class="btn primary" id="qd-return" hidden>返回学习</button><button class="btn" id="qd-sync">重试保存</button><button class="btn" id="qd-retry" hidden>再做本套</button><button class="btn primary" id="qd-submit">提交本套</button></footer></div>';
    document.body.appendChild(model.session.dialog);
    model.session.dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    model.byId('qd-close').onclick = function () { close(); };
    model.byId('qd-return').onclick = returnToLearning;
    model.byId('qd-reload').onclick = function () { if (model.session.loadConfig) open(model.session.loadConfig); };
    model.byId('qd-prev').onclick = function () { navigate(model.session.view.index - 1); };
    model.byId('qd-next').onclick = function () { navigate(model.session.view.index + 1); };
    model.byId('qd-round').onchange = function () { navigate(Number(this.value)); };
    model.byId('qd-attempt').onchange = function () {
      if (!model.session.view || model.session.view.busy) return;
      var active = model.session.view, index = active.index, choice = this.value;
      persistCurrent().then(function (safe) {
      if (!safe || model.session.view !== active || active.index !== index) {
        if (model.session.view === active) model.byId('qd-attempt').value = active.attempt ? String(model.round().attempts.indexOf(active.attempt)) : 'draft';
        return;
      }
      if (choice === 'draft') {
        model.session.view.attempt = null; model.session.view.readOnly = !!model.session.view.config.readOnly;
        model.session.view.answers = (model.round().draft || {}).answers || model.round().questions.map(function () { return ''; });
      } else {
        model.session.view.attempt = model.round().attempts[Number(choice)]; model.session.view.readOnly = true;
        model.session.view.answers = model.session.view.attempt.answers || model.round().questions.map(function () { return ''; });
      }
      view.render();
      });
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
      if (model.session.view && !model.session.view.busy && model.session.dialog.open) {
        return close({restoreFocus: false}).then(function (closed) { if (closed) return load(config); });
      }
      return load(config);
    }

function load(config) {
      if (model.session.view && model.session.view.busy) { if (!model.session.dialog.open) window.LearnUI.dialog.open(model.session.dialog); return Promise.resolve(); }
      model.session.view = null;
      model.session.loadConfig = config;
      model.byId('qd-history').open = false;
      model.byId('qd-reload').hidden = true;
      model.byId('qd-error').hidden = true;
      model.byId('qd-return').hidden = true;
      model.byId('qd-sync').hidden = true;
      model.byId('qd-sync').disabled = true;
      view.status('正在恢复题集与草稿…', false);
      var request = ++model.session.opening;
      model.session.returnFocus = document.activeElement;
      if (!model.session.dialog.open) window.LearnUI.dialog.open(model.session.dialog);
      model.byId('qd-title').textContent = config.title || (config.nodeId ? '单元自测' : '综合测验');
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
          active.busy = true; active.recovering = true; view.render();
          view.status('正在核对已有批改任务…', false);
          window.LearnJobs.list().then(function (jobs) {
            if (model.session.view !== active) return;
            var job = jobs.find(function (item) {
              return item.operation === '/path/quiz' && item.key === model.roundConfig().key &&
                item.round_id === model.round().id && (item.status === 'queued' || item.status === 'running');
            });
            active.recovering = false;
            if (!job) { active.busy = false; if (model.session.dialog.open) view.render(); return; }
            active.busy = true; if (model.session.dialog.open) view.render();
            return window.LearnJobs.watch(job, {onStatus: function (message) {
              if (model.session.view === active && model.session.dialog.open) view.status(message, false);
            }}).then(function () {
              active.busy = false;
              if (model.session.view === active && model.session.dialog.open) return window.QuizDialog.open(config);
            }).catch(function (error) {
              active.busy = false; active.recovering = true;
              if (model.session.view === active && model.session.dialog.open) {
                view.render(); model.byId('qd-reload').hidden = false;
                view.status('批改结果尚未确认，请重新读取：' + error.message, true);
              }
            });
          }).catch(function (error) {
            active.busy = false;
            if (model.session.view === active && model.session.dialog.open) {
              view.render(); model.byId('qd-reload').hidden = false;
              view.status('批改任务状态未确认，请重新读取后再提交：' + error.message, true);
            }
          });
        }
      }).catch(function (error) {
        if (request !== model.session.opening || !model.session.dialog.open) return;
        model.byId('qd-body').textContent = '无法打开题集：' + error.message;
        model.byId('qd-reload').hidden = false;
        view.status('题集尚未读取，可重新读取或返回。', true);
      });
    }

  return Object.freeze({navigate: navigate, close: close, returnToLearning: returnToLearning, submit: submit, create: create, open: open});
});
