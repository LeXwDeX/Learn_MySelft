/* 试卷、作答入口和成绩视图。 */
define("quiz-map.view", ["quiz-map.model", "quiz-map.format", "quiz-map.network", "quiz-map.identity", "quiz-map.hooks"], function (deps) {
  'use strict';
  var model = deps["quiz-map.model"];
  var format = deps["quiz-map.format"];
  var network = deps["quiz-map.network"];
  var identityModule = deps["quiz-map.identity"];
  var hooks = deps["quiz-map.hooks"];

var renderVersion = 0;
function renderView(slug) {
    var version = ++renderVersion;
    var main = format.$('main');
    main.innerHTML = '<p class="tip">加载综合测验…</p>';
    return network.fetchEntries().then(function (entries) {
      if (version !== renderVersion) return;
      var raw = format.entryVal(entries, model.session.QUIZ_PREFIX + slug);
      if (typeof raw !== 'string') {
        main.innerHTML = '<div class="lerr">找不到这张综合测验（' + format.esc(slug) + '）。<br><a href="quiz-map.html">返回综合测验列表</a></div>';
        return;
      }
      var d = null;
      try { d = JSON.parse(raw); } catch (e) { d = null; }
      if (!d || !d.questions || !d.questions.length) {
        main.innerHTML = '<div class="lerr">这张综合测验数据为空或已损坏。</div>';
        return;
      }
      var names = window.LearnTitles.quiz(d, entries);
      var sourceTitle = names.source;
      d.displayTitle = names.title;
      document.title = names.title;
      format.$('document-title').textContent = names.title;
      var tm = format.$('to-map');
      var source = identityModule.reviewTargets(d, entries);
      tm.hidden = !source.sourceHref;
      if (source.sourceHref) tm.href = source.sourceHref;
      format.$('brand-sub').textContent = '来自《' + sourceTitle + '》 · 共 ' + d.questions.length + ' 题 · 满分 100 分';

      var qs = d.questions;
      model.session.currentQs = qs;
      model.session.currentSlug = slug; model.session.currentD = d; model.session.currentEntries = entries;
      model.session.currentRes = (d.lastResult && typeof d.lastResult.score === 'number') ? d.lastResult : null;
      main.innerHTML =
        '<div class="card"><h2>' + format.esc(d.displayTitle) + '</h2>' +
        '<p class="muted">来自《' + format.esc(sourceTitle) + '》 · 共 ' + qs.length + ' 题 · 满分 100 分' +
        (d.lastResult && typeof d.lastResult.score === 'number' ? ' · 上次 ' + d.lastResult.score + ' 分' : '') + '</p></div>' +
        '<div id="q-area"><p class="tip">在测验窗口中继续作答或查看结果。题集与历史作答可按需展开。</p></div>' +
        '<div class="foot"><button class="btn primary" id="submit" type="button">打开综合测验</button>' +
        '<span class="tip">答案与详细标准需确认后展开</span></div>' +
        '<div id="result-area"></div>';
      format.renderMathIn(format.$('q-area'));
      format.highlightIn(format.$('q-area'));
      format.$('submit').addEventListener('click', function () { openExam(slug, d); });
      if (model.session.currentRes) showResult(model.session.currentRes);   // 重看历史 lastResult：直接展示结果页与飞轮按钮
    }).catch(function () {
      if (version !== renderVersion) return;
      main.innerHTML = '<div class="lerr" role="alert">综合测验读取失败，请检查连接后重试。</div><button class="btn" id="quiz-reload">重新读取测验</button>';
      format.$('quiz-reload').onclick = function () { renderView(slug); };
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
      try { return key.indexOf(model.session.USER_PATH + model.session.QUIZ_PREFIX) === 0 && d.sourceKey && JSON.parse(model.session.currentEntries[key]).sourceKey === d.sourceKey; } catch (error) { return false; }
    }).sort(function (a, b) { return (JSON.parse(model.session.currentEntries[a]).created || 0) - (JSON.parse(model.session.currentEntries[b]).created || 0); });
    if (related.indexOf(model.session.USER_PATH + model.session.QUIZ_PREFIX + slug) === -1) related.push(model.session.USER_PATH + model.session.QUIZ_PREFIX + slug);
    var owner = d;
    return window.QuizDialog.open({readOnly: window.LearnUser.readOnly, relatedKeys: related, api: model.session.API, key: model.session.USER_PATH + model.session.QUIZ_PREFIX + slug, title: d.displayTitle || d.title,
      render: format.mdRender, decorate: function (el) { format.renderMathIn(el); format.highlightIn(el); },
      restoreFocus: function () { return format.$('submit'); },
      resultReturn: {label: function (context) { return context.result && !context.result.pass ? '返回学习资料复习' : '返回学习资料'; },
        onReturn: function (context) {
          var target = identityModule.reviewTargets(owner, model.session.currentEntries, context.result, context.questions);
          var href = !context.result.pass && target.units.length ? target.units[0].href : target.sourceHref;
          if (href) location.href = href;
        }},
      onLoad: function (quiz) { if (model.session.currentD === owner) syncQuiz(d, quiz); },
      onResult: function (res, key) { if (model.session.currentD !== owner || key !== model.session.USER_PATH + model.session.QUIZ_PREFIX + slug) return; syncQuiz(d, res.quiz); }
    });
  }

function showResult(res) {
    var cls = res.pass ? 'ok' : 'bad';
    model.session.currentRes = res;
    var targets = identityModule.reviewTargets(), readOnly = window.LearnUser.readOnly;
    var links = targets.sourceHref ? '<a class="btn primary" href="' + format.esc(!res.pass && targets.units.length ? targets.units[0].href : targets.sourceHref) + '">' + (res.pass ? '返回学习资料' : targets.units.length ? '返回薄弱单元复习' : '返回学习资料复习') + '</a>' : '<p class="tip">关联学习资料已不可用，可在窗口回看逐题反馈。</p>';
    if (!res.pass && targets.units.length) links += '<ul class="quiz-review-units">' + targets.units.map(function (unit) { return '<li><a href="' + format.esc(unit.href) + '">' + format.esc(unit.title) + '</a></li>'; }).join('') + '</ul>';
    if (!res.pass && targets.hasUnmapped) links += '<p class="tip">部分旧题缺少单元对应关系。请结合逐题反馈与已有诊断回看源资料。</p>';
    format.$('result-area').innerHTML =
      '<section class="card quiz-result-panel" aria-label="综合测验结果"><h2>综合测验结果</h2>' +
      '<div class="result ' + cls + '"><span class="score ' + cls + '">' + format.esc(res.score) + '</span> 分 — ' +
      (res.pass ? '已通过' : '未通过，先复习失分内容') + '</div>' +
      (res.feedback ? '<p class="quiz-feedback">' + format.mdRender(res.feedback) + '</p>' : '') +
      '<p class="tip">逐题得分、作答与判分依据可在测验窗口中回看。</p>' +
      '<div class="quiz-result-return">' + links + '</div>' +
      (readOnly ? '<p class="tip">管理员只读查看，可回看已有结果；不能生成、诊断或细化学习资料。</p>' : '<details class="quiz-secondary"><summary>换题与补习</summary><div class="foot">' +
        '<button class="btn" id="again" type="button">换新题，再测一次</button>' +
        '<button class="btn" id="gaps-btn" type="button">AI 诊断缺漏</button>' +
        '<button class="btn" id="refine-btn" type="button">按薄弱点细化学习地图</button>' +
      '</div></details>') +
      '<div id="gaps-area"></div>' +
      '<div id="refine-area"></div>' +
      '</section>';
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
