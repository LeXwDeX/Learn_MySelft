/* 题集和提交身份比对、失分题计算。 */
define("quiz-map.identity", ["quiz-map.model"], function (deps) {
  'use strict';
  var model = deps["quiz-map.model"];

function attemptIdentity() {
    if (!model.session.currentD) return null;
    var issued = (model.session.currentD.rounds || []).find(function (round) { return round.id === model.session.currentD.round_id; });
    var attempts = (issued && issued.attempts) || [];
    var id = model.session.currentD.lastAttemptId || (attempts.length && attempts[attempts.length - 1].id);
    return id ? {round_id: model.session.currentD.round_id, attempt_id: id} : null;
  }

function sameIdentity(a, b) {
    return !!(a && b && a.round_id === b.round_id && a.attempt_id === b.attempt_id);
  }

function currentDiagnosis() { return model.session.currentD && sameIdentity(model.session.currentD.diagnosis, attemptIdentity()) && model.session.currentD.gaps; }

// ============================ 飞轮：诊断缺漏 → 细化学习地图 ============================
  // 本卷失分题：ok=false，或简答题未写出「思路」

function collectGapItems() {
    var qs = model.session.currentQs || [];
    var res = model.session.currentRes || (model.session.currentD && model.session.currentD.lastResult) || null;
    var per = (res && res.per_question) || [];
    var ans = (model.session.currentD && model.session.currentD.lastAnswers) || [];
    var out = [];
    qs.forEach(function (q, i) {
      var p = per[i] || {};
      var mine = Array.isArray(ans[i]) ? ans[i].map(function (a, j) { return '第 ' + (j + 1) + ' 空：' + (a || '未作答'); }).join('；') : ans[i] == null ? '' : String(ans[i]);
      var lost = (p.earned != null && p.max_points != null) ? p.earned < p.max_points : p.ok === false;
      if (!lost) return;
      out.push({ unit: q.point || '', q: q.q || '', mine: mine,
                 correct: q.answer || '', explain: p.comment || '', ok: false });
    });
    return out;
  }

  return Object.freeze({attemptIdentity: attemptIdentity, sameIdentity: sameIdentity, currentDiagnosis: currentDiagnosis, collectGapItems: collectGapItems});
});
