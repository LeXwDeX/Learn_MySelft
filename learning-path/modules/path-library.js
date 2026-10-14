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
    if (window.LearnUser.readOnly) return;
    if (!confirm('确定要重新开始吗？当前学习资料会保留在资料库。')) return;
    persistence.save(); persistence.flushSave();
    return persistence.waitForWrites().then(function () {
      location.href = location.pathname + '?new=1';
    }).catch(function (error) { shell.showError('保存失败，请重试保存后再新建学习：' + error.message); });
  }

// ---------- 学习资料库（服务端数据动态扫描） ----------

function fetchSnapshot() {
    return window.LearnUser.fetch(model.session.API + '/state/all', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('资料库请求失败，请重试');
      return response.json();
    }).then(function (snapshot) {
      if (!snapshot || !snapshot.entries || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries)) throw new Error('资料库响应异常，请重试');
      return snapshot;
    });
  }

function fetchMaterials(snapshot) {
    return (snapshot ? Promise.resolve(snapshot) : fetchSnapshot()).then(function (j) {
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
          if (d.plan && Array.isArray(d.plan.nodes)) it.total = d.plan.nodes.length;
          var ns = d.nodeState || {};
          (d.plan && Array.isArray(d.plan.nodes) ? d.plan.nodes : []).forEach(function (node) { if (node && ns[node.id] && ns[node.id].completed) it.done++; });
        } else { it.topic = it.slug; }
        out.push(it);
      });
      out.sort(function (a, b) {
        var pa = a.stage === 'learning' ? 0 : 1, pb = b.stage === 'learning' ? 0 : 1;
        return pa - pb || b.done - a.done;
      });
      return out;
    });
  }

session.QUIZ_PREFIX = 'quiz-map-v1-';

function fetchQuizMaps(snapshot) {
    return (snapshot ? Promise.resolve(snapshot) : fetchSnapshot()).then(function (j) {
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
    });
  }

var renderVersion = 0;
function libRender() {
    var version = ++renderVersion;
    var pop = format.$('lib-pop');
    if (!pop) return;
    pop.innerHTML = '<p class="lib-h"><span>学习资料库</span><i>服务端数据</i></p><p class="lib-sub">加载中…</p>';
    return fetchSnapshot().then(function (snapshot) { return Promise.all([fetchMaterials(snapshot), fetchQuizMaps(snapshot)]); }).then(function (res) {
      if (version !== renderVersion) return;
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
               (window.LearnUser.readOnly ? '' : '<button class="lib-del" type="button" data-slug="' + format.esc(it.slug) + '" data-topic="' + format.esc(it.topic) + '" data-key="' + format.esc(it.key) + '" title="删除这份资料" aria-label="删除资料">🗑</button>') +
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
               (window.LearnUser.readOnly ? '' : '<button class="lib-del" type="button" data-slug="' + format.esc(q.slug) + '" data-topic="' + format.esc(q.title) + '" data-key="' + format.esc(q.key) + '" title="删除这份资料" aria-label="删除资料">🗑</button>') +
               '</div>';
        }
      }
      if (!window.LearnUser.readOnly) h += '<div class="lib-foot">' +
           '<a href="learning-path.html?new=1">＋ 生成新的学习地图</a>' +
           '</div>';
      pop.innerHTML = h;
    }).catch(function () {
      if (version !== renderVersion) return;
      var count = format.$('lib-count'); if (count) count.textContent = '';
      pop.innerHTML = '<p class="lib-h">学习资料库</p><p role="alert" class="lib-empty">资料库加载失败，请检查连接后重试。</p><button type="button" class="btn lib-retry">重试加载资料库</button>';
    });
  }

function libBind() {
    var btn = format.$('lib-btn'), pop = format.$('lib-pop'), wrap = format.$('lib-wrap');
    if (!btn || !pop) return;
    libRender();
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) { libRender(); pop.hidden = false; } else { pop.hidden = true; }
    });
    pop.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.lib-retry')) { e.stopPropagation(); libRender(); return; }
      var b = e.target && e.target.closest ? e.target.closest('.lib-del') : null;
      if (b) { e.stopPropagation(); openDelModal(b.getAttribute('data-slug'), b.getAttribute('data-topic'), b.getAttribute('data-key') || null, b); }
    });
    document.addEventListener('click', function (e) {
      var dm = format.$('del-modal');
      if (!pop.hidden && wrap && !wrap.contains(e.target) && !(dm && dm.open && dm.contains(e.target))) pop.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      var dialog = format.$('del-modal');
      if (e.key === 'Escape' && !(dialog && dialog.open) && !pop.hidden) {
        pop.hidden = true;
        btn.focus();
      }
    });
  }

// ---------- 删除资料（需密码；校验在服务端） ----------

var deletionVersion = 0, deleting = false, deleteTrigger = null;
session.delSlug = null;
session.delKey = null;

function resetDeletion() {
    if (deleting) return;
    deletionVersion++;
    deleting = false;
    session.delSlug = null;
    session.delKey = null;
    format.$('dm-pass').value = '';
    format.$('dm-cancel').disabled = false;
    format.$('dm-ok').disabled = false;
    format.$('dm-ok').textContent = '确认删除';
    var trigger = deleteTrigger;
    deleteTrigger = null;
    if (trigger && trigger.isConnected !== false) trigger.focus();
  }

function openDelModal(s, topic, fullKey, trigger) {
    if (window.LearnUser.readOnly || deleting) return;
    deletionVersion++;
    deleting = false;
    deleteTrigger = trigger || document.activeElement;
    session.delSlug = s;
    session.delKey = fullKey || null;
    format.$('dm-topic').textContent = topic || s;
    format.$('dm-err').hidden = true;
    format.$('dm-pass').value = '';
    format.$('dm-cancel').disabled = false;
    format.$('dm-ok').disabled = false;
    format.$('dm-ok').textContent = '确认删除';
    window.LearnUI.dialog.open(format.$('del-modal'), format.$('dm-pass'));
  }

function closeDelModal() {
    if (deleting) return;
    window.LearnUI.dialog.close(format.$('del-modal'));
    resetDeletion();
  }

function submitDel() {
    if (window.LearnUser.readOnly || !session.delSlug || deleting) return;
    var target = session.delSlug, version = deletionVersion;
    var key = session.delKey || (model.session.USER_PATH + model.session.STORE_PREFIX + target);
    var pass = format.$('dm-pass').value || '';
    var wasCurrent = key === format.storeKey();
    var keys = wasCurrent ? [key, model.session.LAST_KEY, format.aiKey()] : [key];
    deleting = true;
    format.$('dm-cancel').disabled = true;
    format.$('dm-ok').disabled = true;
    format.$('dm-ok').textContent = '删除中…';
    return Promise.resolve().then(function () { return persistence.deleteState(keys, pass); }).then(function (result) {
      if (version !== deletionVersion) return;
      if (!result || !result.ok) throw new Error((result && result.error) || '删除失败，请重试');
      deleting = false;
      closeDelModal();
      if (wasCurrent) { location.href = location.pathname + '?new=1'; return; }
      var pop = format.$('lib-pop'); if (pop) pop.hidden = false;
      return libRender().then(function () {
        var button = format.$('lib-btn'); if (button) button.focus();
      });
    }).catch(function (error) {
      if (version !== deletionVersion) return;
      var err = format.$('dm-err');
      err.textContent = error.message || '网络错误，请重试'; err.hidden = false;
    }).finally(function () {
      if (version !== deletionVersion) return;
      deleting = false;
      format.$('dm-cancel').disabled = false;
      format.$('dm-ok').disabled = false;
      format.$('dm-ok').textContent = '确认删除';
    });
  }

  return Object.freeze({restart: restart, fetchMaterials: fetchMaterials, fetchQuizMaps: fetchQuizMaps, libRender: libRender, libBind: libBind, openDelModal: openDelModal, closeDelModal: closeDelModal, submitDel: submitDel, resetDeletion: resetDeletion});
});
