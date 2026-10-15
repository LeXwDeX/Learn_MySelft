/* 当前窗口和题集视图的数据与访问器。 */
define("quiz-dialog.model", [], function (deps) {
  'use strict';

  var session = {};

session.dialog = undefined;

session.view = undefined;

session.returnFocus = undefined;

session.opening = 0;

function byId(id) { return session.dialog.querySelector('#' + id); }

function round() { return session.view.quiz.rounds[session.view.index]; }

function roundConfig() { return Object.assign({}, session.view.config, {key: round().storageKey || session.view.config.key}); }

function resultContext() {
    var active = session.view, issued = round();
    var attempt = active.attempt;
    return {key: issued.storageKey || active.config.key, nodeId: active.config.nodeId || '',
      roundId: issued.id, attempt: attempt, result: attempt && (attempt.result || attempt),
      isLatestAttempt: !!attempt && attempt === (issued.attempts || [])[((issued.attempts || []).length - 1)],
      questions: issued.questions, answers: (active.answers || []).slice(),
      isCurrentRound: (issued.storageKey || active.config.key) === active.config.key && issued.id === active.quiz.round_id};
  }

  return Object.freeze({resultContext: resultContext, session: session, byId: byId, round: round, roundConfig: roundConfig});
});
