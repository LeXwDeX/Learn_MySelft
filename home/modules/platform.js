define('home.platform', [], function (deps) {
  var context = window.LearnUser, ui = window.LearnUI;
  if (!context || !ui || !window.LearnTitles || !window.LearnJobs || !window.LearnJobDetails) throw new Error('首页缺少公共组件');

  return {context: context, ui: ui, titles: window.LearnTitles, jobs: window.LearnJobs, jobDetails: window.LearnJobDetails};
});
