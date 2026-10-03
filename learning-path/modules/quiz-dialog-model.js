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

  return Object.freeze({session: session, byId: byId, round: round, roundConfig: roundConfig});
});
