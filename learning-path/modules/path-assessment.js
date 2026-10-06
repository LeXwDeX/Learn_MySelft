/* 单元测验、换题、完成确认和补习。 */
define("path.assessment", ["path.format", "path.model", "path.domain", "path.cards", "path.assistant", "path.persistence", "path.shell"], function (deps) {
  'use strict';
  var format = deps["path.format"];
  var model = deps["path.model"];
  var domain = deps["path.domain"];
  var cards = deps["path.cards"];
  var assistant = deps["path.assistant"];
  var persistence = deps["path.persistence"];
  var shell = deps["path.shell"];
  var session = {};

function renderNotes(s) { return format.mdRender(s); }

function listSection(title, arr) {
    if (!arr || !arr.length) return '';
    return '<div class="panel-sec"><h4>' + format.esc(title) + '</h4><ul class="mdlist">' +
      arr.map(function (x) { return '<li>' + format.mdRender(x) + '</li>'; }).join('') + '</ul></div>';
  }

function hasLearningScene(notes) {
    var lines = String(notes || '').split(/\r?\n/), marker = '', length = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (marker) {
        if (new RegExp('^ {0,3}' + marker + '{' + length + ',}[ \\t]*$').test(line)) { marker = ''; length = 0; }
        continue;
      }
      var opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!opening) continue;
      if (/^learn-scene(?:\s|$)/i.test(opening[2].trim())) return true;
      marker = opening[1][0]; length = opening[1].length;
    }
    return false;
  }

session.sceneWork = Object.create(null);

function sceneWorkKey(key, id) { return key + '#' + id; }

function sceneSupplementSection(id, d) {
    if (hasLearningScene(d.study_notes)) return '';
    var key = format.storeKey(), work = session.sceneWork[sceneWorkKey(key, id)];
    var busy = !!(work && work.status === 'running');
    var notNeeded = !!(work && work.status === 'not-needed' && work.notes === d.study_notes);
    return '<div class="scene-supplement" data-scene-supplement="' + format.esc(id) + '">' +
      '<button class="btn scene-supplement-btn" type="button"' +
      (window.LearnUser.readOnly || busy || notNeeded ? ' disabled' : '') +
      '>' + (busy ? '正在补充…' : '补充图示') + '</button>' +
      '<span class="scene-supplement-status" role="status" aria-live="polite"></span></div>';
  }

function sceneSupplementMessage(id) {
    var work = session.sceneWork[sceneWorkKey(format.storeKey(), id)], detail = model.state.nodeDetail[id];
    if (work && work.status === 'not-needed' && detail && work.notes !== detail.study_notes) return '';
    return work && work.status === 'running' ? '正在补充图示…' : work && work.status === 'error' ? '补充失败，可以重试。' : work && work.status === 'not-needed' ? work.message : '';
  }

// ---------- 自测题渲染（选择题点选 / 填空·简答文本作答） ----------

session.matTab = 'material';

// 单元内选项卡：material | quiz（仅前端内存）

session.matTabOwner = null;

// 当前选项卡归属的节点

session.lastQuizShown = null;

session.quizResultSeen = Object.create(null);

// {id, res} 最近一次提交结果（展示在「测验」tab 内）
  // 卡内渲染：所有查询都从卡片内容元素向下查（作用域隔离，避免串卡）

function renderNodeDetail(id) {
    var n = domain.nodeById(id), d = model.state.nodeDetail[id];
    var scope = cards.cardContentEl(id);
    if (!n || !d || !scope) return;
    model.session.activeScope = scope;
    var ownerChanged = session.matTabOwner !== id;
    if (ownerChanged) { session.matTab = 'material'; session.lastQuizShown = null; session.matTabOwner = id; }
    var shown = (session.lastQuizShown && session.lastQuizShown.id === id) ? session.lastQuizShown.res : null;
    var persisted = (model.state.nodeState[id] || {}).lastResult;
    if (!shown && persisted && persisted.round_id === (d.quiz || {}).round_id) shown = persisted;
    var hasSeenResult = Object.prototype.hasOwnProperty.call(session.quizResultSeen, id);
    var newResult = hasSeenResult && session.quizResultSeen[id] !== shown;
    if (shown && (ownerChanged || newResult)) session.matTab = 'quiz';
    session.quizResultSeen[id] = shown || null;
    var qs = ((d.quiz && d.quiz.questions) || []);
    var prev = model.state.nodeState[id] || {};
    // 自测未过（<60）：按薄弱点细化学习地图
    var lowScore = (typeof prev.score === 'number' && prev.score < 60) ||
      !!(prev.lastResult && typeof prev.lastResult.score === 'number' && prev.lastResult.score < 60);
    var matPane =
      '<div class="panel-sec"><h4>学习正文</h4><div class="notes">' + renderNotes(d.study_notes) + '</div></div>' +
      sceneSupplementSection(id, d) +
      listSection('要点', d.key_points) +
      listSection('例子', d.examples) +
      listSection('易错点', d.misconceptions);
    var quizPane;
    if (qs.length) {
      var rounds = (d.quiz || {}).rounds || [];
      var latest = (model.state.nodeState[id] || {}).lastResult;
      if (latest && latest.round_id && latest.round_id !== d.quiz.round_id) latest = null;
      quizPane = '<div class="panel-sec"><h4>单元测验</h4>' +
        '<p class="tip">' + qs.length + '题 · 满分100分 · ' + (rounds.length || 1) + '套题已保存。完整题目、作答与批改在测验窗口查看。</p>' +
        (latest ? '<p>最近成绩：<b>' + format.esc(latest.score) + '/100</b></p>' : '') +
        '<div class="quiz-actions"><select id="quiz-round-select" aria-label="选择题集">' +
          (rounds.length ? rounds.map(function (r, index) {
            return '<option value="' + format.esc(r.id) + '"' + (r.id === d.quiz.round_id ? ' selected' : '') + '>第' + (index + 1) + '套' + (r.id === d.quiz.round_id ? ' · 最新' : '') + '</option>';
          }).join('') : '<option value="">第1套</option>') + '</select>' +
        '<button class="btn primary" id="open-quiz-workspace">打开测验</button>' +
        '<button class="btn" id="redo-quiz">出一套新题</button>' +
        (latest && latest.pass && !domain.isDone(id) ? '<button class="btn" id="complete-node">完成本节点并解锁下一节点</button>' : '') +
        (lowScore ? (domain.canRefine(id) ? '<button class="btn" id="refine-node">按薄弱点细化</button>' : '<span class="tip">已达四层细化上限，可继续学习或重新测验。</span>') : '') + '</div></div>';
    } else {
      quizPane = '<p class="tip">本单元暂无自测题。</p>';
    }
    scope.innerHTML =
      '<div class="mat-tabs-head">' +
        '<button class="mat-tab' + (session.matTab === 'material' ? ' on' : '') + '" type="button" data-mat="material">学习资料</button>' +
        '<button class="mat-tab' + (session.matTab === 'quiz' ? ' on' : '') + '" type="button" data-mat="quiz">测验</button>' +
      '</div>' +
      '<div class="mat-pane mat-pane-material"' + (session.matTab === 'material' ? '' : ' hidden') + '>' + matPane + '</div>' +
      '<div class="mat-pane mat-pane-quiz"' + (session.matTab === 'quiz' ? '' : ' hidden') + '>' + quizPane + '</div>';
    var sceneStatus = scope.querySelector('.scene-supplement-status');
    if (sceneStatus) sceneStatus.textContent = sceneSupplementMessage(id);
    format.renderMathIn(scope);
    var notes = scope.querySelector('.notes');
    if (notes && window.LearnMarkdown) {
      var materialMd = '# ' + (n.title || '未命名单元') + '\n\n' + (d.study_notes || '');
      [['要点', d.key_points], ['例子', d.examples], ['易错点', d.misconceptions]].forEach(function (part) {
        if (part[1] && part[1].length) materialMd += '\n\n## ' + part[0] + '\n\n' + part[1].join('\n\n');
      });
      var filename = window.LearnMarkdown.unitFilename(window.LearnTitles.document(model.state), domain.dispId(id), n.title);
      window.LearnMarkdown.exportButton(notes, materialMd, filename);
    }
    format.highlightIn(scope);
    qs.forEach(function (q, i) { format.bindAutoGrow(scope.querySelector('#ans-' + i)); });

    // 选项卡切换：只切 display、不重渲染 → 不丢已勾选选项 / 已输入文本
    var mtabs = scope.querySelectorAll('.mat-tab');
    for (var ti = 0; ti < mtabs.length; ti++) {
      mtabs[ti].addEventListener('click', function () {
        session.matTab = this.getAttribute('data-mat');
        for (var k = 0; k < mtabs.length; k++) mtabs[k].classList.toggle('on', mtabs[k] === this);
        var mp = scope.querySelector('.mat-pane-material'), qp = scope.querySelector('.mat-pane-quiz');
        if (mp) mp.hidden = session.matTab !== 'material';
        if (qp) qp.hidden = session.matTab !== 'quiz';
        if (mp && !mp.hidden) format.renderMathIn(mp);
      });
    }
    assistant.setFoot('');
    var sceneButton = scope.querySelector('.scene-supplement-btn');
    if (sceneButton) sceneButton.addEventListener('click', function () { supplementScene(id); });
    var openQuiz = scope.querySelector('#open-quiz-workspace');
    if (openQuiz) openQuiz.addEventListener('click', function () { openQuizModal(id, scope.querySelector('#quiz-round-select').value); });
    var bRedo = scope.querySelector('#redo-quiz');
    if (bRedo) {
      bRedo.disabled = !!session.requizWork[id];
      if (session.requizWork[id]) bRedo.textContent = '正在出新题…';
      bRedo.addEventListener('click', function () { redoQuiz(id); });
    }
    var bComp = scope.querySelector('#complete-node');
    if (bComp) bComp.addEventListener('click', function () { completeNode(id); });
    var bRefine = scope.querySelector('#refine-node');
    if (bRefine) bRefine.addEventListener('click', function () { refineNode(id); });
    requestAnimationFrame(cards.drawEdges);
  }

function applySceneSupplement(id, key, result) {
    if (format.storeKey() !== key || !result || result.node_id !== id || typeof result.study_notes !== 'string') return false;
    var node = domain.nodeById(id), detail = model.state.nodeDetail[id];
    if (!node || !detail || !model.state.plan) return false;
    if (!hasLearningScene(result.study_notes)) {
      if (result.needed !== false || result.study_notes !== detail.study_notes) return false;
      var reason = typeof result.reason === 'string' ? result.reason.slice(0, 300) : '';
      session.sceneWork[sceneWorkKey(key, id)] = {
        status: 'not-needed',
        notes: result.study_notes,
        message: '本单元暂未找到合适图示。' + (reason ? ' ' + reason : '')
      };
      if (model.session.expandedId === id && cards.cardContentEl(id)) renderNodeDetail(id);
      return true;
    }
    if (result.study_notes === detail.study_notes) return true;
    if (typeof result.source_notes !== 'string' || result.source_notes !== detail.study_notes) return false;
    detail.study_notes = result.study_notes;
    if (Object.prototype.hasOwnProperty.call(result, 'sceneSupplement')) detail.sceneSupplement = result.sceneSupplement;
    persistence.save();
    assistant.syncAiMaterial(id);
    if (model.session.expandedId === id && cards.cardContentEl(id)) renderNodeDetail(id);
    return true;
  }

function consumeSceneSupplement(id, key, result, workKey) {
    if (format.storeKey() !== key) return;
    var detail = model.state.nodeDetail[id];
    if (result && result.needed === false && (!detail || result.study_notes !== detail.study_notes)) {
      clearSceneSupplementWork(id, key, workKey);
      return;
    }
    if (!applySceneSupplement(id, key, result)) {
      clearSceneSupplementWork(id, key, workKey);
      return;
    }
    if (result.needed !== false) session.sceneWork[workKey] = {status: 'done'};
  }

function clearSceneSupplementWork(id, key, workKey) {
    if (format.storeKey() !== key) return;
    delete session.sceneWork[workKey || sceneWorkKey(key, id)];
    if (model.session.expandedId === id && cards.cardContentEl(id)) renderNodeDetail(id);
  }

function markSceneSupplementError(id, key) {
    if (format.storeKey() !== key) return;
    session.sceneWork[sceneWorkKey(key, id)] = {status: 'error'};
    if (model.session.expandedId === id && cards.cardContentEl(id)) renderNodeDetail(id);
  }

function supplementScene(id) {
    var key = format.storeKey(), node = domain.nodeById(id), detail = model.state.nodeDetail[id];
    if (!node || !detail || !model.state.plan || window.LearnUser.readOnly || hasLearningScene(detail.study_notes)) return Promise.resolve();
    var workKey = sceneWorkKey(key, id), current = session.sceneWork[workKey];
    if (current && current.status === 'running') return current.promise;
    var work = {status: 'running'};
    session.sceneWork[workKey] = work;
    if (model.session.expandedId === id && cards.cardContentEl(id)) renderNodeDetail(id);
    work.promise = persistence.post('/path/node/scene', {key: key, node: {id: id}}, {
      newOperation: true,
      onRetry: function () { return format.storeKey() === key ? supplementScene(id) : Promise.resolve(); }
    }).then(function (result) {
      if (format.storeKey() !== key) return;
      consumeSceneSupplement(id, key, result, workKey);
    }).catch(function (error) {
      markSceneSupplementError(id, key);
      if (format.storeKey() === key && !error.jobId) shell.showError('补充图示失败：' + error.message, function () { return supplementScene(id); });
    });
    return work.promise;
  }

function restoreSceneSupplement() {
    if (!window.LearnJobs || window.LearnUser.readOnly || !model.state.plan) return Promise.resolve();
    var key = format.storeKey();
    return window.LearnJobs.list(key).then(function (jobs) {
      if (key !== format.storeKey()) return;
      var latest = Object.create(null);
      jobs.forEach(function (job) {
        if (job.operation !== '/path/node/scene' || !job.node_id || !model.state.nodeDetail[job.node_id]) return;
        var previous = latest[job.node_id];
        if (!previous || job.created_ms > previous.created_ms) latest[job.node_id] = job;
      });
      return Promise.all(Object.keys(latest).map(function (id) {
        var job = latest[id];
        if (job.status === 'succeeded') {
          return Promise.resolve(job.result).then(function (result) {
            return result ? result : window.LearnJobs.get(job.id).then(function (fresh) { return fresh.result; });
          }).then(function (result) {
            if (result && key === format.storeKey()) consumeSceneSupplement(id, key, result, sceneWorkKey(key, id));
          }).catch(function () {});
        }
        if (job.status === 'failed' || job.status === 'interrupted') {
          markSceneSupplementError(id, key);
          return;
        }
        if (job.status === 'cancelled') {
          clearSceneSupplementWork(id, key);
          return;
        }
        if (job.status !== 'queued' && job.status !== 'running') return;
        var workKey = sceneWorkKey(key, id), work = {status: 'running'};
        session.sceneWork[workKey] = work;
        if (model.session.expandedId === id && cards.cardContentEl(id)) renderNodeDetail(id);
        work.promise = window.LearnJobs.get(job.id).then(function (fresh) {
          if (fresh.status === 'succeeded') return fresh.result;
          if (fresh.status === 'failed' || fresh.status === 'interrupted') {
            markSceneSupplementError(id, key);
            return null;
          }
          if (fresh.status === 'cancelled') {
            clearSceneSupplementWork(id, key, workKey);
            return null;
          }
          if (fresh.status !== 'queued' && fresh.status !== 'running') {
            clearSceneSupplementWork(id, key, workKey);
            return null;
          }
          return window.LearnJobs.watch(fresh, {onRetry: function () { return format.storeKey() === key ? supplementScene(id) : Promise.resolve(); }});
        }).then(function (result) {
          if (!result || format.storeKey() !== key) return;
          consumeSceneSupplement(id, key, result, workKey);
        }).catch(function () { markSceneSupplementError(id, key); });
        return work.promise;
      }));
    }).catch(function () {
      // A missing jobs response must not block ordinary path restore.
    });
  }

// 所有题目、作答和历史批改均由共享弹窗呈现。

function openQuizModal(id, roundId) {
    var n = domain.nodeById(id), d = model.state.nodeDetail[id];
    if (!n || !d) return;
    return window.QuizDialog.open({
      readOnly: window.LearnUser.readOnly, api: model.session.API, key: format.storeKey(), nodeId: id, roundId: roundId, title: n.title + ' · 单元测验',
      render: format.mdRender, decorate: function (el) { format.renderMathIn(el); format.highlightIn(el); },
      onLoad: function (quiz) { d.quiz = quiz; },
      onResult: function (res) {
        d.quiz = res.quiz;
        if (res.round_id === d.quiz.round_id) {
          var st = model.state.nodeState[id] || {};
          st.score = res.score;
          st.lastResult = {score: res.score, pass: res.pass, feedback: res.feedback,
                           per_question: res.per_question, round_id: res.round_id};
          model.state.nodeState[id] = st;
          session.lastQuizShown = {id: id, res: st.lastResult};
        }
        persistence.save(); cards.renderPlan();
      }
    });
  }

// A receipt survives navigation; only the current server snapshot updates the view.

session.requizWork = Object.create(null);

function trackRequiz(id, start) {
    if (session.requizWork[id]) return session.requizWork[id];
    var key = format.storeKey();
    var work = Promise.resolve().then(start).then(function () {
      return persistence.post('/path/quiz/state', {key: key, node: {id: id}});
    }).then(function (quiz) {
      if (format.storeKey() !== key || !model.state.nodeDetail[id]) return;
      model.state.nodeDetail[id].quiz = quiz;
      session.lastQuizShown = null;
      // No state write: the server already saved the authoritative new round.
    }).catch(function (error) {
      if (format.storeKey() === key && !error.jobId) shell.showError('读取新题状态失败：' + error.message, restoreRequiz);
    }).finally(function () {
      delete session.requizWork[id];
      if (format.storeKey() === key && model.session.expandedId === id) renderNodeDetail(id);
    });
    session.requizWork[id] = work;
    if (model.session.expandedId === id) renderNodeDetail(id);
    return work;
  }

function restoreRequiz() {
    if (!window.LearnJobs || window.LearnUser.readOnly || !model.state.plan) return Promise.resolve();
    restoreSceneSupplement();
    var key = format.storeKey();
    return window.LearnJobs.list(key).then(function (jobs) {
      if (key !== format.storeKey()) return;
      var latest = Object.create(null);
      jobs.forEach(function (job) {
        if (job.operation !== '/path/requiz' || !job.node_id) return;
        var previous = latest[job.node_id];
        if (!previous || job.created_ms > previous.created_ms) latest[job.node_id] = job;
      });
      return Promise.all(Object.keys(latest).map(function (id) {
        if (!model.state.nodeDetail[id]) return;
        var job = latest[id];
        if (job.status === 'cancelled') return;
        function retry() {
          return trackRequiz(id, function () { return window.LearnJobs.retry(job.id, {onRetry: retry}); });
        }
        return trackRequiz(id, function () {
          return window.LearnJobs.get(job.id).then(function (fresh) {
            if (fresh.status === 'succeeded') return; // Avoid replaying a success toast on every visit.
            return window.LearnJobs.watch(fresh, {onRetry: retry});
          });
        });
      }));
    }).catch(function (error) {
      if (key === format.storeKey()) shell.showError('无法恢复换题状态：' + error.message, restoreRequiz);
    });
  }

function redoQuiz(id) {
    var n = domain.nodeById(id), d = model.state.nodeDetail[id];
    if (!n || !d || window.LearnUser.readOnly) return;
    var quiz = d.quiz || {}, st = model.state.nodeState[id] || {};
    shell.hideError();
    session.matTab = 'quiz'; session.matTabOwner = id;
    return trackRequiz(id, function () {
      return persistence.post('/path/requiz', {
        node: {id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || []},
        spec: model.state.spec, round_id: quiz.round_id, feedback: st.lastResult || null, key: format.storeKey()
      }, {onRetry: function () { return redoQuiz(id); }});
    });
  }

function completeNode(id) {
    var st = model.state.nodeState[id] || {};
    st.completed = true;
    model.state.nodeState[id] = st;
    persistence.save();
    cards.renderPlan();   // 重建后会自动恢复展开并重渲染卡内内容（状态→已完成）
  }

// 卡内「按薄弱点细化」：把本节点自测的薄弱点提交给 /path/refine（key 必须为学习地图键）

function perQuestionSummary(per) {
    if (!per || !per.length) return '';
    var parts = [];
    per.forEach(function (p, i) {
      if (p && p.ok === false) parts.push('第 ' + (i + 1) + ' 题：' + (p.comment || '有缺漏'));
    });
    return parts.length ? '；错题：' + parts.join('；') : '';
  }

function refineNode(id) {
    if (!domain.canRefine(id)) { alert('已达四层细化上限，可继续学习或重新测验。'); return; }
    var n = domain.nodeById(id);
    var st = model.state.nodeState[id] || {};
    var lr = st.lastResult || {};
    var scope = cards.cardContentEl(id);
    var btn = scope ? scope.querySelector('#refine-node') : null;
    var reason = ((lr.feedback || '') + perQuestionSummary(lr.per_question)).slice(0, 500);
    if (!reason) reason = '本单元自测未通过（' + (typeof st.score === 'number' ? st.score : '') + ' 分）';
    if (btn) { btn.disabled = true; btn.textContent = '细化中…'; }
    var quiz = (model.state.nodeDetail[id] || {}).quiz || {};
    var issued = (quiz.rounds || []).find(function (round) { return round.id === quiz.round_id; });
    var attempts = (issued && issued.attempts) || [];
    persistence.post('/path/refine', {
      key: format.storeKey(), node_id: id, round_id: quiz.round_id,
      attempt_id: quiz.lastAttemptId || (attempts.length ? attempts[attempts.length - 1].id : undefined),
      spec: model.state.spec,
      plan: model.state.plan,
      weaknesses: [{ nid: id, title: n ? n.title : '', reason: reason, points: [] }]
    }).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = '按薄弱点细化'; }
      if (r && r.plan) {
        domain.normalizePlan(r.plan);
        model.state.plan = r.plan;
        persistence.save();
        cards.renderPlan();
        alert(r.reused ? '本次作答的补习单元已经创建，已显示最新学习地图。' : '已为本次作答准备 ' + ((r.added) || 0) + ' 个补习单元，重复操作不会再次追加。');
      }
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '按薄弱点细化'; }
      shell.showError('细化失败：' + e.message, function () { refineNode(id); });
    });
  }

// ---------- 生成测验地图（按学习地图 + 学习情况） ----------

function genQuizMap() {
    if (!(model.state.stage === 'learning' && model.state.plan)) return;
    window.LearnMaterials.quiz(format.storeKey(), submitQuizMap);
  }

function submitQuizMap() {
    var btn = format.$('quizmap-btn');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…（约 1-2 分钟）'; }
    shell.hideError();
    persistence.post('/path/quizmap', { key: format.storeKey() }, {newOperation: true}).then(function (r) {
      location.href = 'quiz-map.html?t=' + encodeURIComponent(r.slug);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '生成测验'; }
      shell.showError('生成测验失败：' + e.message, genQuizMap);
    });
  }

  return Object.freeze({renderNotes: renderNotes, listSection: listSection, renderNodeDetail: renderNodeDetail, openQuizModal: openQuizModal, trackRequiz: trackRequiz, restoreRequiz: restoreRequiz, restoreSceneSupplement: restoreSceneSupplement, supplementScene: supplementScene, redoQuiz: redoQuiz, completeNode: completeNode, perQuestionSummary: perQuestionSummary, refineNode: refineNode, genQuizMap: genQuizMap, submitQuizMap: submitQuizMap});
});
