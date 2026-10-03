/* 测验目录和测验生成入口。 */
define("quiz-map.catalog", ["quiz-map.model", "quiz-map.format", "quiz-map.network"], function (deps) {
  'use strict';
  var model = deps["quiz-map.model"];
  var format = deps["quiz-map.format"];
  var network = deps["quiz-map.network"];

// ============================ 选择模式 ============================

function renderSelect() {
    var main = format.$('main');
    main.innerHTML = '<p class="tip">加载资料…</p>';
    network.fetchEntries().then(function (entries) {
      var maps = [], quizzes = [];
      Object.keys(entries).forEach(function (k) {
        var biz = format.stripUser(k);   // 先剥用户前缀
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        if (biz.indexOf(model.session.MAP_PREFIX) === 0 && biz !== model.session.LAST_KEY) {
          var d = null; try { d = JSON.parse(v); } catch (e) { d = null; }
          var it = { slug: biz.slice(model.session.MAP_PREFIX.length), topic: '', total: 0, done: 0 };
          if (d && typeof d === 'object') {
            if (!d.topic && !d.plan && (!d.history || !d.history.length)) return;
            it.topic = window.LearnTitles.document(d);
            if (d.plan && d.plan.nodes) it.total = d.plan.nodes.length;
            var ns = d.nodeState || {};
            for (var nid in ns) { if (ns[nid] && ns[nid].completed) it.done++; }
          } else { it.topic = it.slug; }
          maps.push(it);
        } else if (biz.indexOf(model.session.QUIZ_PREFIX) === 0) {
          var qd = null; try { qd = JSON.parse(v); } catch (e) { qd = null; }
          if (!qd || typeof qd !== 'object') return;
          var at = qd.attempts || [];
          quizzes.push({ slug: biz.slice(model.session.QUIZ_PREFIX.length), title: window.LearnTitles.quiz(qd, entries).title,
                         count: (qd.questions || []).length,
                         last: (at.length && at[at.length - 1] && typeof at[at.length - 1].score === 'number')
                               ? at[at.length - 1].score : null });
        }
      });
      maps.sort(function (a, b) { return a.topic.localeCompare(b.topic, 'zh'); });
      quizzes.sort(function (a, b) { return (b.last || 0) - (a.last || 0); });

      var h = '<div class="card"><div class="mode-h"><p class="eyebrow">从学习地图生成测验</p>' +
              '<span class="qcount">' + maps.length + ' 张学习地图</span></div>';
      h += '<p><a class="btn primary" href="learning-path.html?new=1&amp;mode=quiz">上传资料创建测验地图</a></p>';
      h += '<p class="muted">选择一张学习地图，按其知识点与你的学习情况生成一整套测验（8~16 道，合计 100 分）。</p>';
      if (!maps.length) {
        h += '<p class="lempty">暂无学习地图——先去 <a href="learning-path.html?new=1">生成一张学习地图</a>。</p>';
      } else {
        maps.forEach(function (m) {
          h += '<div class="lrow"><span class="lt"><span class="t">' + format.esc(m.topic) + '</span>' +
               '<span class="m">' + m.total + ' 节点 · 已完成 ' + m.done + '</span></span>' +
               '<button class="btn" type="button" data-gen="' + format.esc(model.session.USER_PATH + model.session.MAP_PREFIX + m.slug) + '">生成测验</button></div>';
        });
      }
      h += '</div>';

      h += '<div class="card"><div class="mode-h"><p class="eyebrow">已有测验地图</p>' +
           '<span class="qcount">' + quizzes.length + ' 张测验地图</span></div>';
      if (!quizzes.length) {
        h += '<p class="lempty">暂无测验地图——从上面选一张学习地图生成一套吧。</p>';
      } else {
        quizzes.forEach(function (q) {
          var meta = '共 ' + q.count + ' 题' + (q.last != null ? ' · 最近 ' + q.last + ' 分' : '');
          h += '<a class="lrow" href="quiz-map.html?t=' + encodeURIComponent(q.slug) + '">' +
               '<span class="lt"><span class="t">' + format.esc(q.title) + '</span><span class="m">' + format.esc(meta) + '</span></span>' +
               '<span class="go">打开 →</span></a>';
        });
      }
      h += '</div>';
      main.innerHTML = h;
      main.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-gen]') : null;
        if (b) genQuizMap(b);
      });
    }).catch(function () {
      main.innerHTML = '<div class="lerr">无法连接服务端（' + format.esc(model.session.API) + '）——请稍后刷新重试。</div>';
    });
  }

function genQuizMap(btn) {
    var key = btn.getAttribute('data-gen');
    if (!key) return;
    window.LearnMaterials.quiz(key, function () { submitQuizMap(btn, key); });
  }

function submitQuizMap(btn, key) {
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '生成中…（约 1-2 分钟）';
    network.post('/path/quizmap', { key: key }, {newOperation: true}).then(function (r) {
      location.href = 'quiz-map.html?t=' + encodeURIComponent(r.slug);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = old;
      alert('生成测验失败：' + e.message);
    });
  }

  return Object.freeze({renderSelect: renderSelect, genQuizMap: genQuizMap, submitQuizMap: submitQuizMap});
});
