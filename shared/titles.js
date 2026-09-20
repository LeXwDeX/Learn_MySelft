/* A document's top-level title is its only display name. */
(function () {
  'use strict';
  function documentTitle(document) {
    var title = document && document.title;
    return typeof title === 'string' && title.trim() ? title.trim() : '学习资料';
  }
  function quizNames(quiz, entries) {
    var source = {};
    try { source = JSON.parse((entries || {})[quiz.sourceKey] || '{}'); } catch (error) {}
    return {source: documentTitle(source), title: documentTitle(quiz)};
  }
  window.LearnTitles = {document: documentTitle, quiz: quizNames};
})();
