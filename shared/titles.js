/* Display names use established topics without changing saved requests or quiz data. */
(function () {
  "use strict";
  function quizNames(quiz, entries) {
    var source = {};
    try { source = JSON.parse(entries[quiz.sourceKey] || '{}') || {}; } catch (error) {}
    var sourceTitle = (source.plan && source.plan.title) || (source.spec && source.spec.topic) || '';
    var rawTopic = String(source.topic || '').trim();
    var requestText = /^(请|帮我|我想|我希望|你能|能不能)/;
    if (!sourceTitle && !requestText.test(rawTopic)) sourceTitle = rawTopic;
    sourceTitle = String(sourceTitle || '学习资料').trim();
    var subject = sourceTitle.replace(/(?:系统学习路径|学习路径|知识点地图|知识地图|学习地图)[。！.!！\s]*$/, '').trim();
    var title = String(quiz.title || '').trim();
    var legacy = !title || requestText.test(title) || (rawTopic && title === rawTopic + ' · 测验');
    return {source: sourceTitle, title: legacy ? (subject || '学习资料') + '综合测验' : title};
  }
  window.LearnTitles = {quiz: quizNames};
})();
