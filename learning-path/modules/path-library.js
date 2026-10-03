/* 资料库、新建学习和删除窗口。 */
define("path.library", ["path.persistence", "path.shell", "path.model", "path.format"], function (deps) {
  'use strict';
  var persistence = deps["path.persistence"];
  var shell = deps["path.shell"];
  var model = deps["path.model"];
  var format = deps["path.format"];
  var session = {};

// ---------- 重新开始 ----------

function restart() {
    if (!confirm('确定要重新开始吗？当前学习资料会保留在资料库。')) return;
    persistence.save(); persistence.flushSave();
    return persistence.waitForWrites().then(function () {
      location.href = location.pathname + '?new=1';
    }).catch(function (error) { shell.showError('保存失败，请重试保存后再新建学习：' + error.message); });
  }

// ---------- 学习资料库（服务端数据动态扫描） ----------

function fetchMaterials() {
    return window.LearnUser.fetch(model.session.API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var entries = (j && j.entries) || {}, out = [];
      Object.keys(entries).forEach(function (k) {
        var biz = format.stripUser(k);   // 先剥用户前缀，再按原业务键逻辑处理
        if (biz.indexOf(model.session.STORE_PREFIX) !== 0 || biz === 'learn-path-v1-last') return;
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        var d = null;
        try { d = JSON.parse(v); } catch (e) { d = null; }
        var it = { key: k, slug: biz.slice(model.session.STORE_PREFIX.length), topic: '', stage: '', total: 0, done: 0 };
        if (d && typeof d === 'object') {
          if (!d.topic && !d.plan && (!d.history || !d.history.length)) return;   // 跳过历史空壳
          it.topic = window.LearnTitles.document(d);
          it.stage = d.stage || '';
          if (d.plan && d.plan.nodes) it.total = d.plan.nodes.length;
          var ns = d.nodeState || {};
          for (var id in ns) { if (ns[id] && ns[id].completed) it.done++; }
        } else { it.topic = it.slug; }
        out.push(it);
      });
      out.sort(function (a, b) {
        var pa = a.stage === 'learning' ? 0 : 1, pb = b.stage === 'learning' ? 0 : 1;
        return pa - pb || b.done - a.done;
      });
      return out;
    }).catch(function () { return []; });
  }

session.QUIZ_PREFIX = 'quiz-map-v1-';

function fetchQuizMaps() {
    return window.LearnUser.fetch(model.session.API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var entries = (j && j.entries) || {}, out = [];
      Object.keys(entries).forEach(function (k) {
        var biz = format.stripUser(k);   // 先剥用户前缀
        if (biz.indexOf(session.QUIZ_PREFIX) !== 0) return;
        var v = entries[k];
        if (typeof v !== 'string') return;   // 跳过已删除（墓碑）键
        var d = null;
        try { d = JSON.parse(v); } catch (e) { d = null; }
        if (!d || typeof d !== 'object') return;
        var it = { key: k, slug: biz.slice(session.QUIZ_PREFIX.length), title: window.LearnTitles.quiz(d, entries).title,
                   count: (d.questions || []).length, last: null };
        var at = d.attempts || [];
        if (at.length && at[at.length - 1] && typeof at[at.length - 1].score === 'number') {
          it.last = at[at.length - 1].score;
        }
        out.push(it);
      });
      out.sort(function (a, b) { return (b.last || 0) - (a.last || 0); });
      return out;
    }).catch(function () { return []; });
  }

function libRender() {
    var pop = format.$('lib-pop');
    if (!pop) return;
    pop.innerHTML = '<p class="lib-h"><span>学习资料库</span><i>服务端数据</i></p><p class="lib-sub">加载中…</p>';
    Promise.all([fetchMaterials(), fetchQuizMaps()]).then(function (res) {
      var items = res[0], quizzes = res[1];
      var cnt = format.$('lib-count');
      if (cnt) cnt.textContent = ' (' + (items.length + quizzes.length) + ')';
      var h = '<p class="lib-h"><span>学习资料库</span><i>服务端动态扫描</i></p>';
      h += '<p class="lib-sub">学习地图 · ' + items.length + '</p>';
      if (!items.length) {
        h += '<p class="lib-empty">暂无生成的学习地图——去生成一个吧。</p>';
      } else {
        for (var i = 0; i < items.length; i++) {
          var it = items[i], meta = model.session.STAGE_LABEL[it.stage] || it.stage || '';
          if (it.stage === 'learning') meta = it.total ? (it.done + '/' + it.total + ' 节点完成') : '路径已生成';
          h += '<div class="lib-row">' +
               '<a class="lib-item" href="learning-path.html?t=' + encodeURIComponent(it.slug) + '">' +
               '<span class="t">' + format.esc(it.topic) + '</span><span class="m">' + format.esc(meta) + '</span></a>' +
               '<button class="lib-del" type="button" data-slug="' + format.esc(it.slug) + '" data-topic="' + format.esc(it.topic) + '" data-key="' + format.esc(it.key) + '" title="删除这份资料">🗑</button>' +
               '</div>';
        }
      }
      h += '<p class="lib-sub">测验地图 · ' + quizzes.length + '</p>';
      if (!quizzes.length) {
        h += '<p class="lib-empty">暂无测验地图——在学习地图里点「生成测验」。</p>';
      } else {
        for (var j = 0; j < quizzes.length; j++) {
          var q = quizzes[j];
          var qmeta = '共 ' + q.count + ' 题' + (q.last != null ? ' · 最近 ' + q.last + ' 分' : '');
          h += '<div class="lib-row">' +
               '<a class="lib-item" href="quiz-map.html?t=' + encodeURIComponent(q.slug) + '">' +
               '<span class="t">' + format.esc(q.title) + '</span><span class="m">' + format.esc(qmeta) + '</span></a>' +
               '<button class="lib-del" type="button" data-slug="' + format.esc(q.slug) + '" data-topic="' + format.esc(q.title) + '" data-key="' + format.esc(q.key) + '" title="删除这份资料">🗑</button>' +
               '</div>';
        }
      }
      h += '<div class="lib-foot">' +
           '<a href="learning-path.html?new=1">＋ 生成新的学习地图</a>' +
           '</div>';
      pop.innerHTML = h;
    });
  }

function libBind() {
    var btn = format.$('lib-btn'), pop = format.$('lib-pop'), wrap = format.$('lib-wrap');
    if (!btn || !pop) return;
    Promise.all([fetchMaterials(), fetchQuizMaps()]).then(function (res) {
      var cnt = format.$('lib-count');
      if (cnt) cnt.textContent = ' (' + (res[0].length + res[1].length) + ')';
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) { libRender(); pop.hidden = false; } else { pop.hidden = true; }
    });
    pop.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.lib-del') : null;
      if (b) { e.stopPropagation(); openDelModal(b.getAttribute('data-slug'), b.getAttribute('data-topic'), b.getAttribute('data-key') || null); }
    });
    document.addEventListener('click', function (e) {
      var dm = format.$('del-modal');
      if (!pop.hidden && wrap && !wrap.contains(e.target) && !(dm && !dm.hidden && dm.contains(e.target))) pop.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') pop.hidden = true; });
  }

// ---------- 删除资料（需密码；校验在服务端） ----------

session.delSlug = null;

session.delKey = null;

function openDelModal(s, topic, fullKey) {
    session.delSlug = s;
    session.delKey = fullKey || null;
    format.$('dm-topic').textContent = topic || s;
    var err = format.$('dm-err'); if (err) err.hidden = true;
    var inp = format.$('dm-pass'); if (inp) inp.value = '';
    format.$('del-modal').hidden = false;
    if (inp) inp.focus();
  }

function closeDelModal() {
    format.$('del-modal').hidden = true;
    session.delSlug = null;
    session.delKey = null;
  }

function submitDel() {
    if (!session.delSlug) return;
    var target = session.delSlug;
    var key = session.delKey || (model.session.USER_PATH + model.session.STORE_PREFIX + target);
    var pass = (format.$('dm-pass') || {}).value || '';
    var wasCurrent = key === format.storeKey();
    var keys = wasCurrent ? [key, model.session.LAST_KEY, format.aiKey()] : [key];
    persistence.deleteState(keys, pass).then(function (j) {
      if (j && j.ok) {
        closeDelModal();
        if (wasCurrent) { location.href = location.pathname + '?new=1'; return; }
        libRender();
        var pop = format.$('lib-pop'); if (pop) pop.hidden = false;
      } else {
        var err = format.$('dm-err');
        if (err) { err.textContent = (j && j.error) || '删除失败'; err.hidden = false; }
      }
    }).catch(function (error) {
      var err = format.$('dm-err');
      if (err) { err.textContent = error.message || '网络错误，请重试'; err.hidden = false; }
    });
  }

  return Object.freeze({restart: restart, fetchMaterials: fetchMaterials, fetchQuizMaps: fetchQuizMaps, libRender: libRender, libBind: libBind, openDelModal: openDelModal, closeDelModal: closeDelModal, submitDel: submitDel});
});
