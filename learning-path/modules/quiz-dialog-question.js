/* 题型、填空值、答案参考和评分文案。 */
define("quiz-dialog.question", [], function (deps) {
  'use strict';


function esc(value) { return window.LearnUI.dom.escapeHTML(value); }

function localKey(config, id) { return 'quiz-draft-v1:' + JSON.stringify([config.key, config.nodeId || '', id]); }

function fillBlanks(q) {
    if (q.blanks && q.blanks.length) return q.blanks;
    var count = Math.max(1, (q.q.match(/(?<![A-Za-z0-9_])_{3,}(?![A-Za-z0-9_])|＿{3,}|[（(][ \t　]*[)）]/g) || []).length);
    return Array.from({length: count}, function (_, i) { return {id: 'b' + (i + 1)}; });
  }

function fillValues(q, answer) {
    if (Array.isArray(answer)) return answer;
    var count = fillBlanks(q).length, text = String(answer || '');
    if (count === 1) return [text];
    var separators = [/[;；]/, /\r?\n/, /[,，]/];
    for (var i = 0; i < separators.length; i++) {
      var parts = text.split(separators[i]);
      if (parts.length === count) return parts;
    }
    return [text].concat(Array(count - 1).fill(''));
  }

function hasAnswer(answer) {
    return Array.isArray(answer) ? answer.some(function (a) { return a.trim(); }) : !!String(answer || '').trim();
  }

function scoringLabel(q) {
    var mode = (q.scoring || {}).mode;
    if (q.type === 'choice') return '选择题 · 整题计分：选对得 ' + q.points + ' 分，选错或未选得 0 分';
    if (q.type === 'short') return '简答题 · 按评分点计分，合计 ' + q.points + ' 分';
    if (mode === 'per_blank') return '填空题 · 按空计分：' + fillBlanks(q).map(function (b, i) { return '第 ' + (i + 1) + ' 空 ' + b.points + ' 分'; }).join('，') + '；合计 ' + q.points + ' 分';
    if (mode === 'all_or_nothing') return '填空题 · 整题计分：全部空答对得 ' + q.points + ' 分，否则 0 分；各空不单独计分';
    return '填空题 · 旧题整题计分：符合预设整题答案得 ' + q.points + ' 分，否则 0 分；未设置每空分值';
  }

function roundLabel(rounds, index, currentId) {
    var round = rounds[index];
    var editionSource = round && round.migration && round.migration.source_round_id;
    var suffix = '';
    if (typeof editionSource === 'string' && editionSource) suffix = ' · 修订版';
    else if (rounds.some(function (r) {
      return r && r.migration && r.migration.source_round_id === round.id;
    })) suffix = ' · 原版';
    return '第 ' + (index + 1) + ' 套' + suffix + (round.id === currentId ? ' · 最新' : '');
  }

function referenceHtml(q, md) {
    if (q.type !== 'fill' || !q.blanks) return md(q.answer || '');
    return q.blanks.map(function (blank, i) {
      return '<div><b>第 ' + (i + 1) + ' 空：</b>' + md(blank.answer) + '</div>';
    }).join('');
  }

  return Object.freeze({esc: esc, localKey: localKey, fillBlanks: fillBlanks, fillValues: fillValues, hasAnswer: hasAnswer, scoringLabel: scoringLabel, roundLabel: roundLabel, referenceHtml: referenceHtml});
});
