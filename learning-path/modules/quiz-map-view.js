/* 试卷、作答入口和成绩视图。 */
define("quiz-map.view", ["quiz-map.model", "quiz-map.format", "quiz-map.network", "quiz-map.identity", "quiz-map.hooks"], function (deps) {
  'use strict';
  var model = deps["quiz-map.model"];
  var format = deps["quiz-map.format"];
  var network = deps["quiz-map.network"];
  var identityModule = deps["quiz-map.identity"];
  var hooks = deps["quiz-map.hooks"];

function renderView(slug) {
    var main = format.$('main');
    main.innerHTML = '<p class="tip">加载测验地图…</p>';
    network.fetchEntries().then(function (entries) {
      var raw = format.entryVal(entries, model.session.QUIZ_PREFIX + slug);
      if (typeof raw !== 'string') {
        main.innerHTML = '<div class="lerr">找不到这张测验地图（' + format.esc(slug) + '）。<br><a href="quiz-map.html">返回测验地图列表</a></div>';
        return;
      }
      var d = null;
      try { d = JSON.parse(raw); } catch (e) { d = null; }
      if (!d || !d.questions || !d.questions.length) {
        main.innerHTML = '<div class="lerr">这张测验地图数据为空或已损坏。</div>';
        return;
      }
      var names = window.LearnTitles.quiz(d, entries);
      var sourceTitle = names.source;
      d.displayTitle = names.title;
      document.title = names.title;
      format.$('document-title').textContent = names.title;
      var tm = format.$('to-map');
      if (d.sourceSlug) { tm.href = 'learning-path.html?t=' + encodeURIComponent(d.sourceSlug); tm.hidden = false; }
      format.$('brand-sub').textContent = '来自《' + sourceTitle + '》 · 共 ' + d.questions.length + ' 题 · 满分 100 分';

      var qs = d.questions;
      model.session.currentQs = qs;
      model.session.currentSlug = slug; model.session.currentD = d; model.session.currentEntries = entries;
      model.session.currentRes = (d.lastResult && typeof d.lastResult.score === 'number') ? d.lastResult : null;
      main.innerHTML =
        '<div class="card"><p class="eyebrow">测验地图</p><h2>' + format.esc(d.displayTitle) + '</h2>' +
        '<p class="muted">来自《' + format.esc(sourceTitle) + '》 · 共 ' + qs.length + ' 题 · 满分 100 分' +
        (d.lastResult && typeof d.lastResult.score === 'number' ? ' · 上次 ' + d.lastResult.score + ' 分' : '') + '</p></div>' +
        '<div id="q-area"><p class="tip">完整题目与作答在测验窗口中展示。支持翻页查看历史题集，草稿自动保存。</p></div>' +
        '<div class="foot"><button class="btn primary" id="submit" type="button">打开测验</button>' +
        '<span class="tip">在大窗口中作答、查看答案和提交</span></div>' +
        '<div id="result-area"></div>';
      format.renderMathIn(format.$('q-area'));
      format.highlightIn(format.$('q-area'));
      format.$('submit').addEventListener('click', function () { openExam(slug, d); });
      if (model.session.currentRes) showResult(model.session.currentRes);   // 重看历史 lastResult：直接展示结果页与飞轮按钮
    }).catch(function () {
      main.innerHTML = '<div class="lerr">无法连接服务端（' + format.esc(model.session.API) + '）——请稍后刷新重试。</div>';
    });
  }

function syncQuiz(d, quiz) {
    ['gaps', 'gapsAt', 'diagnosis', 'lastAttemptId'].forEach(function (field) { delete d[field]; });
    Object.assign(d, quiz); model.session.currentD = d; model.session.currentQs = d.questions;
    model.session.currentRes = d.lastResult || null;
    if (model.session.currentRes) showResult(model.session.currentRes);
  }

function openExam(slug, d) {
    var related = Object.keys(model.session.currentEntries).filter(function (key) {
      try { return JSON.parse(model.session.currentEntries[key]).sourceKey === d.sourceKey; } catch (error) { return false; }
    }).sort(function (a, b) { return (JSON.parse(model.session.currentEntries[a]).created || 0) - (JSON.parse(model.session.currentEntries[b]).created || 0); });
    return window.QuizDialog.open({readOnly: window.LearnUser.readOnly, relatedKeys: related, api: model.session.API, key: model.session.USER_PATH + model.session.QUIZ_PREFIX + slug, title: d.displayTitle || d.title,
      render: format.mdRender, decorate: function (el) { format.renderMathIn(el); format.highlightIn(el); },
      onLoad: function (quiz) { syncQuiz(d, quiz); },
      onResult: function (res, key) { if (key !== model.session.USER_PATH + model.session.QUIZ_PREFIX + slug) return; syncQuiz(d, res.quiz); }
    });
  }

function showResult(res) {
    var cls = res.pass ? 'ok' : 'bad';
    model.session.currentRes = res;
    format.$('result-area').innerHTML =
      '<div class="card"><p class="eyebrow">测验结果</p>' +
      '<div class="result ' + cls + '"><span class="score ' + cls + '">' + format.esc(res.score) + '</span> 分 — ' +
      (res.pass ? '通过 ✅' : '未通过 ❌') + '</div>' +
      (res.feedback ? '<p class="quiz-feedback">' + format.mdRender(res.feedback) + '</p>' : '') +
      '<p class="tip">逐题得分、作答与判分依据可在测验窗口中回看。</p>' +
      '<div class="foot">' +
        '<button class="btn" id="again" type="button">换新题，再测一次</button>' +
        '<button class="btn" id="gaps-btn" type="button">AI 诊断缺漏</button>' +
        '<button class="btn" id="refine-btn" type="button">按薄弱点细化学习地图</button>' +
      '</div>' +
      '<div id="gaps-area"></div>' +
      '<div id="refine-area"></div>' +
      '</div>';
    format.renderMathIn(format.$('result-area'));
    format.highlightIn(format.$('result-area'));
    var b = format.$('submit'); if (b) { b.disabled = false; b.textContent = '查看作答与批改'; }
    var again = format.$('again');
    if (again) again.addEventListener('click', function () {
      if (!model.session.currentD.sourceKey) { alert('找不到关联学习地图'); return; }
      again.disabled = true; again.textContent = '出题与验题中…';
      network.post('/path/quizmap', {key: model.session.currentD.sourceKey}, {newOperation: true}).then(function (result) {
        location.href = 'quiz-map.html?t=' + encodeURIComponent(result.slug);
      }).catch(function (error) {
        again.disabled = false; again.textContent = '换新题，再测一次';
        alert(error.message);
      });
    });
    var gb = format.$('gaps-btn');
    if (gb) gb.addEventListener('click', function () { hooks.runGaps(); });
    var rb = format.$('refine-btn');
    if (rb) rb.addEventListener('click', function () { hooks.runRefine(); });
    if (identityModule.currentDiagnosis()) hooks.renderGaps(model.session.currentD.gaps);   // 已有诊断：直接回显
  }

  return Object.freeze({renderView: renderView, syncQuiz: syncQuiz, openExam: openExam, showResult: showResult});
});
