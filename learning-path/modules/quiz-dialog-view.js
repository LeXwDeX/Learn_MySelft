/* 题目、历史提交和保存状态视图。 */
define("quiz-dialog.view", ["quiz-dialog.model", "quiz-dialog.drafts", "quiz-dialog.question"], function (deps) {
  'use strict';
  var model = deps["quiz-dialog.model"];
  var drafts = deps["quiz-dialog.drafts"];
  var question = deps["quiz-dialog.question"];

function status(message, bad) {
    model.byId('qd-save').textContent = message;
    model.byId('qd-save').classList.toggle('qd-error', !!bad);
  }

function renderSaveState() {
    var button = model.byId('qd-sync');
    button.hidden = true; button.disabled = true;
    if (!model.session.view || !model.session.view.quiz) return;
    if (model.session.view.busy) { status('正在保存作答并按评分点判分…', false); return; }
    if (model.session.view.config.readOnly) { status('管理员只读查看', false); return; }
    if (model.session.view.readOnly || model.session.view.attempt) { status(model.resultContext().isCurrentRound && model.resultContext().isLatestAttempt ? '本次结果已保存到服务器' : '历史结果已保存，当前仅回看', false); return; }
    var record = drafts.currentRecord();
    if (record && !record.saved) {
      var failed = record.syncState === 'failed';
      button.hidden = !failed; button.disabled = !failed;
      var message = failed ? (record.localSaved ? '草稿已保存在本机，服务器同步失败；可重试保存。' : '服务器保存失败，本机草稿也不可用，请勿关闭页面。') :
        record.retrying ? '正在重试保存…' : record.localSaved ? '已保存在本机，正在同步…' : '正在保存到服务器，请勿关闭页面…';
      status(message, failed);
      return;
    }
    status(record && record.saved ? '已自动保存到服务器' : model.session.view.localRecovery ? '已恢复本机未同步草稿' : model.round().draft ? '已恢复服务器草稿' : '尚未作答；输入后自动保存', false);
  }

function updateProgress() {
    model.byId('qd-progress').textContent = model.session.view.answers.filter(question.hasAnswer).length + ' / ' + model.round().questions.length + ' 题已作答';
  }

function render() {
    var issued = model.round(), config = model.session.view.config, md = config.render || question.esc;
    var result = model.session.view.attempt && (model.session.view.attempt.result || model.session.view.attempt);
    model.byId('qd-title').textContent = config.title || (config.nodeId ? '单元自测' : '综合测验');
    model.byId('qd-round').innerHTML = model.session.view.quiz.rounds.map(function (r, index) {
      return '<option value="' + index + '"' + (index === model.session.view.index ? ' selected' : '') + '>' + question.roundLabel(model.session.view.quiz.rounds, index, model.session.view.quiz.round_id) + '</option>';
    }).join('');
    model.byId('qd-prev').disabled = model.session.view.index === 0 || model.session.view.busy;
    model.byId('qd-next').disabled = model.session.view.index === model.session.view.quiz.rounds.length - 1 || model.session.view.busy;
    model.byId('qd-round').disabled = model.session.view.busy;
    model.byId('qd-attempt').innerHTML = '<option value="draft">当前草稿</option>' + (issued.attempts || []).map(function (a, index) {
      var res = a.result || a;
      return '<option value="' + index + '"' + (model.session.view.attempt === a ? ' selected' : '') + '>第 ' + (index + 1) + ' 次提交 · ' + question.esc(res.score) + ' 分</option>';
    }).join('');
    model.byId('qd-attempt').disabled = model.session.view.busy;
    var context = model.resultContext(), action = config.resultReturn;
    var returnButton = model.byId('qd-return');
    returnButton.hidden = !result || !action;
    returnButton.disabled = !!model.session.view.busy;
    if (result && action) returnButton.textContent = typeof action.label === 'function' ? action.label(context) : action.label || '返回学习';
    model.byId('qd-body').innerHTML = (result ? '<div class="qd-result"><strong>' + question.esc(result.score) + ' / 100 分</strong><span>' + (context.isCurrentRound && context.isLatestAttempt ? '本次结果 · ' : '历史结果 · ') + (result.pass ? '已通过' : '未通过，建议先复习失分内容') + ' · ' + question.esc(result.feedback || '') + '</span></div>' : '') +
      issued.questions.map(function (q, i) {
        var grade = result && (result.per_question || [])[i];
        var html = '<fieldset class="qd-question"><legend>第 ' + (i + 1) + ' 题 · ' + question.esc(q.points) + ' 分</legend><div class="qd-stem">' + md(q.q) + '</div>';
        var rubric = q.rubric || [];
        html += '<div class="qd-scoring">' + question.esc(question.scoringLabel(q)) + '</div>';

        if (q.options && q.options.length) {
          html += q.options.map(function (option, j) {
            var letter = String.fromCharCode(65 + j);
            return '<label class="qd-option"><input type="radio" name="qd-answer-' + i + '" value="' + letter + '"' + (model.session.view.answers[i] === letter ? ' checked' : '') + (model.session.view.readOnly || model.session.view.busy ? ' disabled' : '') + '><span>' + letter + '. ' + md(option) + '</span></label>';
          }).join('');
        } else if (q.type === 'fill') {
          var values = question.fillValues(q, model.session.view.answers[i]);
          html += '<div class="qd-blanks">' + question.fillBlanks(q).map(function (blank, j) {
            var id = 'qd-answer-' + i + '-blank-' + j;
            var label = '第 ' + (j + 1) + ' 空' + ((q.scoring || {}).mode === 'per_blank' ? ' · ' + blank.points + ' 分' : ' · 整题计分');
            if (q.blanks) label += blank.match === 'text' ? ' · 按文字匹配' : ' · 允许数值等价';
            var blankGrade = grade && (grade.blanks || [])[j];
            return '<div class="qd-blank"><label class="qd-input-label" for="' + id + '">' + question.esc(label) + '</label>' +
              '<textarea class="qd-blank-input" id="' + id + '" maxlength="' + Math.floor(20000 / values.length) + '" rows="1"' + (model.session.view.readOnly || model.session.view.busy ? ' readonly' : '') + ' placeholder="填写第 ' + (j + 1) + ' 空">' + question.esc(values[j]) + '</textarea>' +
              (blankGrade ? '<div class="qd-blank-grade">' + question.esc(blankGrade.comment) + (blankGrade.earned == null ? '（整题计分）' : ' · ' + question.esc(blankGrade.earned) + ' / ' + question.esc(blankGrade.max_points) + ' 分') + '</div>' : '') + '</div>';
          }).join('') + '</div>';
        } else {
          html += '<label class="qd-input-label" for="qd-answer-' + i + '">你的作答</label><textarea id="qd-answer-' + i + '" maxlength="20000" rows="' + (q.type === 'short' ? 6 : 3) + '"' + (model.session.view.readOnly || model.session.view.busy ? ' readonly' : '') + ' placeholder="' + (q.type === 'short' ? '写下你的思路与结论…' : '写下你的答案…') + '">' + question.esc(model.session.view.answers[i]) + '</textarea>';
        }
        if (grade) html += '<div class="qd-grade"><b>得分 ' + question.esc(grade.earned == null ? '旧记录未提供' : grade.earned) + ' / ' + question.esc(grade.max_points == null ? q.points : grade.max_points) + '</b><div>' + md(grade.comment || '') + '</div></div>';
        html += '<div class="qd-reference"><button type="button" class="btn qd-reveal" aria-expanded="false" aria-controls="qd-reference-' + i + '">查看答案与思路</button>' +
          '<div id="qd-reference-' + i + '" class="qd-reference-content" hidden><h3>参考答案</h3><div>' + question.referenceHtml(q, md) + '</div>' +
          '<h3>解题思路</h3><div>' + md(q.explain || '这道旧题尚未提供解题思路。') + '</div>' +
          '<div class="qd-rubric"><b>评分标准</b> ' + (rubric.length ? rubric.map(function (c) { return question.esc(c.description) + '（' + question.esc(c.points) + '分）'; }).join('；') : question.esc(question.scoringLabel(q))) + '</div></div></div></fieldset>';
        return html;
      }).join('');
    model.byId('qd-submit').hidden = model.session.view.readOnly;
    model.byId('qd-submit').disabled = !!(model.session.view.busy || model.session.view.recovering);
    model.byId('qd-submit').textContent = model.session.view.busy ? '逐项判分中…' : '提交本套';
    model.byId('qd-history').querySelector('summary').textContent = '题集与历史作答 · ' + model.session.view.quiz.rounds.length + ' 套';
    model.byId('qd-retry').hidden = model.session.view.config.readOnly || !model.session.view.readOnly;
    model.byId('qd-retry').disabled = !!model.session.view.busy;
    model.byId('qd-error').hidden = true;
    updateProgress();
    renderSaveState();
    if (config.decorate) config.decorate(model.byId('qd-body'));
  }

  return Object.freeze({status: status, renderSaveState: renderSaveState, updateProgress: updateProgress, render: render});
});
