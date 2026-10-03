/* 薄弱点诊断和学习地图补习。 */
define("quiz-map.diagnosis", ["quiz-map.format", "quiz-map.model", "quiz-map.network", "quiz-map.identity"], function (deps) {
  'use strict';
  var format = deps["quiz-map.format"];
  var model = deps["quiz-map.model"];
  var network = deps["quiz-map.network"];
  var identityModule = deps["quiz-map.identity"];

function renderGaps(resp) {
    var box = format.$('gaps-area');
    if (!box) return;
    if (!resp || !resp.gaps || !resp.gaps.length) { box.innerHTML = '<p class="tip">诊断未返回缺漏点。</p>'; return; }
    var h = '<div class="gaps-section"><h4 class="gaps-heading">AI 诊断缺漏</h4>';
    if (resp.summary) h += '<p class="gaps-summary">' + format.mdRender(resp.summary) + '</p>';
    resp.gaps.forEach(function (g) {
      h += '<div class="quiz-box"><p class="q">' + format.esc(g.unit || '综合') + '</p>';
      if (g.points && g.points.length) {
        h += '<ul class="gaps-points">' +
             g.points.map(function (p) { return '<li>' + format.mdRender(p) + '</li>'; }).join('') + '</ul>';
      }
      if (g.advice) h += '<div class="result">' + format.mdRender(g.advice) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    box.innerHTML = h;
    format.renderMathIn(box);
    format.highlightIn(box);
  }

function runGaps(onDone) {
    var items = identityModule.collectGapItems();
    if (!items.length) {
      alert('本卷没有失分题，无需诊断。');
      if (onDone) onDone(null);
      return;
    }
    var identity = identityModule.attemptIdentity(), owner = model.session.currentD;
    if (!identity) { alert('请先提交并保存本次作答'); if (onDone) onDone(null); return; }
    var btn = format.$('gaps-btn'), old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '诊断中…'; }
    network.post('/path/gaps', {key: model.session.USER_PATH + model.session.QUIZ_PREFIX + model.session.currentSlug, round_id: identity.round_id, attempt_id: identity.attempt_id}).then(function (resp) {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      if (model.session.currentD !== owner || !identityModule.sameIdentity(identity, identityModule.attemptIdentity())) { if (onDone) onDone(null); return; }
      model.session.currentD.gaps = resp;
      model.session.currentD.diagnosis = resp.diagnosis;
      renderGaps(resp);
      if (onDone) onDone(resp);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      var box = format.$('gaps-area');
      if (box) box.innerHTML = '<div class="lerr">诊断失败：' + format.esc(e.message) + '</div>';
      if (onDone) onDone(null);
    });
  }

function runRefine() {
    var btn = format.$('refine-btn');
    if (!model.session.currentD) return;
    if (!identityModule.collectGapItems().length) { alert('本次作答没有失分题，无需补习。'); return; }
    var srcSlug = model.session.currentD.sourceSlug;
    if (!srcSlug) { alert('这张测验地图没有关联的学习地图，无法细化。'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '细化中…'; }
    var restore = function () { if (btn) { btn.disabled = false; btn.textContent = '按薄弱点细化学习地图'; } };
    var fail = function (msg) {
      restore();
      var box = format.$('refine-area');
      if (box) box.innerHTML = '<div class="lerr">细化失败：' + format.esc(msg) + '</div>';
    };
    var go = function () {
      return network.fetchEntries().then(function (entries) {
        model.session.currentEntries = entries;
        var mraw = format.entryVal(entries || {}, model.session.MAP_PREFIX + srcSlug);
        var m = null;
        try { m = JSON.parse(mraw); } catch (e) { m = null; }
        if (!m || !m.plan || !m.plan.nodes || !m.plan.nodes.length) { fail('找不到对应学习地图的路径'); return; }
        var identity = identityModule.attemptIdentity();
        if (!identity || !identityModule.currentDiagnosis()) { fail('作答已更新，请重新诊断'); return; }
        return network.post('/path/refine', {
          key: model.session.USER_PATH + model.session.MAP_PREFIX + srcSlug,
          quiz_key: model.session.USER_PATH + model.session.QUIZ_PREFIX + model.session.currentSlug,
          round_id: identity.round_id, attempt_id: identity.attempt_id
        }).then(function (r) {
          restore();
          var box = format.$('refine-area');
          if (box) box.innerHTML =
            '<div class="result ok">' + (r.reused ? '本次作答的补习单元已经创建，未重复追加。' : '已为本次作答准备 ' + ((r && r.added) || 0) + ' 个补习单元，重复操作不会再次追加。') + '</div>' +
            '<div class="foot"><a class="btn" href="learning-path.html?t=' + encodeURIComponent(srcSlug) + '">去学习地图 →</a></div>';
        });
      }).catch(function (e) { fail(e.message); });
    };
    if (identityModule.currentDiagnosis()) { go(); return; }
    // 没有诊断数据：先自动跑一次诊断，成功后再细化
    runGaps(function (resp) { if (resp) go(); else restore(); });
  }

  return Object.freeze({renderGaps: renderGaps, runGaps: runGaps, runRefine: runRefine});
});
