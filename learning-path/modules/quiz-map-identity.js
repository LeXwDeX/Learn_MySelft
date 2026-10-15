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

function reviewTargets(document, entries, result, questions) {
    document = document || model.session.currentD || {};
    entries = entries || model.session.currentEntries || {};
    result = result || model.session.currentRes || document.lastResult || {};
    questions = questions || document.questions || [];
    var sourceKey = document.sourceKey || (document.sourceSlug && model.session.USER_PATH + model.session.MAP_PREFIX + document.sourceSlug);
    var prefix = model.session.USER_PATH + model.session.MAP_PREFIX;
    if (typeof sourceKey !== 'string' || sourceKey.indexOf(prefix) !== 0) return {sourceHref: '', units: [], hasUnmapped: true};
    var source;
    try { source = JSON.parse(entries[sourceKey]); } catch (error) { return {sourceHref: '', units: [], hasUnmapped: true}; }
    if (!source || !source.plan || !Array.isArray(source.plan.nodes)) return {sourceHref: '', units: [], hasUnmapped: true};
    var sourceHref = 'learning-path.html?t=' + encodeURIComponent(sourceKey.slice(prefix.length));
    var units = [], seen = Object.create(null), unmapped = false;
    questions.forEach(function (q, i) {
      var grade = (result.per_question || [])[i] || {};
      var lost = grade.earned != null && grade.max_points != null ? grade.earned < grade.max_points : grade.ok === false;
      if (!lost) return;
      var node = q.node_id && source.plan.nodes.find(function (item) { return item && item.id === q.node_id; });
      if (!node) { unmapped = true; return; }
      if (seen[node.id]) return;
      seen[node.id] = true;
      units.push({id: node.id, title: node.title || node.id, href: sourceHref + '&node=' + encodeURIComponent(node.id)});
    });
    return {sourceHref: sourceHref, units: units, hasUnmapped: unmapped};
  }

  return Object.freeze({reviewTargets: reviewTargets, attemptIdentity: attemptIdentity, sameIdentity: sameIdentity, currentDiagnosis: currentDiagnosis, collectGapItems: collectGapItems});
});
