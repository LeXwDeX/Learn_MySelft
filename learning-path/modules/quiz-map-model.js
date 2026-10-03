/* 当前试卷和成绩视图的数据。 */
define("quiz-map.model", [], function (deps) {
  'use strict';

  var session = {};

session.API = window.LearnUser.apiBase;

session.TIMEOUT = 360000;

session.USER_PATH = window.LearnUser.userId + '/';

session.QUIZ_PREFIX = 'quiz-map-v1-';

session.MAP_PREFIX = 'learn-path-v1-';

session.LAST_KEY = 'learn-path-v1-last';

// ============================ 查看/作答模式 ============================

session.currentQs = null;

session.currentSlug = null;

session.currentD = null;

session.currentRes = null;

session.currentEntries = null;

  return Object.freeze({session: session, });
});
