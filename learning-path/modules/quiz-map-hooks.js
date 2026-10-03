/* Explicit callbacks for page composition. Connected once by the entry module. */
define("quiz-map.hooks", [], function (deps) {
  'use strict';
  var handlers = null;
  var names = ["renderGaps","runGaps","runRefine"];
  function connect(next) {
    if (handlers) throw new Error('Hooks already connected: quiz-map');
    names.forEach(function (name) { if (typeof next[name] !== 'function') throw new Error('Missing hook: ' + name); });
    handlers = Object.freeze(Object.assign({}, next));
  }
  var api = {connect: connect};
  names.forEach(function (name) { api[name] = function () {
    if (!handlers) throw new Error('Hooks not connected: quiz-map.' + name);
    return handlers[name].apply(null, arguments);
  }; });
  return Object.freeze(api);
});
