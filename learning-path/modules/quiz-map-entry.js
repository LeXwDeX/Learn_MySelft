/* 测验页装配。 */
define("quiz-map.entry", ["quiz-map.format", "quiz-map.view", "quiz-map.catalog", "quiz-map.hooks", "quiz-map.diagnosis"], function (deps) {
  'use strict';
  deps["quiz-map.hooks"].connect({renderGaps: deps["quiz-map.diagnosis"].renderGaps, runGaps: deps["quiz-map.diagnosis"].runGaps, runRefine: deps["quiz-map.diagnosis"].runRefine});
  var format = deps["quiz-map.format"];
  var view = deps["quiz-map.view"];
  var catalog = deps["quiz-map.catalog"];


// ============================ 入口 ============================

function boot() {
    var slug = format.param('t');
    if (slug) { view.renderView(slug); } else { catalog.renderSelect(); }
  }

function init() { window.LearnUser.ready.then(boot); }

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return Object.freeze({boot: boot, init: init});
});
