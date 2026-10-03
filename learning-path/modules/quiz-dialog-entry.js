define("quiz-dialog.entry", ["quiz-dialog.controller", "quiz-dialog.hooks", "quiz-dialog.view"], function (deps) {
  'use strict';
  deps['quiz-dialog.hooks'].connect({status: deps['quiz-dialog.view'].status,
    renderSaveState: deps['quiz-dialog.view'].renderSaveState, updateProgress: deps['quiz-dialog.view'].updateProgress});
  window.QuizDialog = Object.freeze({open: deps['quiz-dialog.controller'].open});
  return window.QuizDialog;
});
