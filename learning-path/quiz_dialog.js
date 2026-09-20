/* Shared, single-file-embedded quiz workspace. Drafts are scoped to issued rounds. */
(function () {
  'use strict';
  var dialog, view, returnFocus, opening = 0;
  var records = {}, chains = {};
  var clientId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) { return dialog.querySelector('#' + id); }
  function round() { return view.quiz.rounds[view.index]; }
  function roundConfig() { return Object.assign({}, view.config, {key: round().storageKey || view.config.key}); }
  function localKey(config, id) { return 'quiz-draft-v1:' + JSON.stringify([config.key, config.nodeId || '', id]); }
  function fillBlanks(q) {
    if (q.blanks && q.blanks.length) return q.blanks;
    var count = Math.max(1, (q.q.match(/(?<![A-Za-z0-9_])_{3,}(?![A-Za-z0-9_])|＿{3,}|[（(][ \t　]*[)）]/g) || []).length);
    return Array.from({length: count}, function (_, i) { return {id: 'b' + (i + 1)}; });
  }
  function fillValues(q, answer) {
    if (Array.isArray(answer)) return answer;
    var count = fillBlanks(q).length, text = String(answer || '');
    if (count === 1) return [text];
    var separators = [/[;；]/, /\r?\n/, /[,，]/];
    for (var i = 0; i < separators.length; i++) {
      var parts = text.split(separators[i]);
      if (parts.length === count) return parts;
    }
    return [text].concat(Array(count - 1).fill(''));
  }
  function hasAnswer(answer) {
    return Array.isArray(answer) ? answer.some(function (a) { return a.trim(); }) : !!String(answer || '').trim();
  }
  function scoringLabel(q) {
    var mode = (q.scoring || {}).mode;
    if (q.type === 'choice') return '选择题 · 整题计分：选对得 ' + q.points + ' 分，选错或未选得 0 分';
    if (q.type === 'short') return '简答题 · 按评分点计分，合计 ' + q.points + ' 分';
    if (mode === 'per_blank') return '填空题 · 按空计分：' + fillBlanks(q).map(function (b, i) { return '第 ' + (i + 1) + ' 空 ' + b.points + ' 分'; }).join('，') + '；合计 ' + q.points + ' 分';
    if (mode === 'all_or_nothing') return '填空题 · 整题计分：全部空答对得 ' + q.points + ' 分，否则 0 分；各空不单独计分';
    return '填空题 · 旧题整题计分：符合预设整题答案得 ' + q.points + ' 分，否则 0 分；未设置每空分值';
  }
  function roundLabel(rounds, index, currentId) {
    var round = rounds[index];
    var editionSource = round && round.migration && round.migration.source_round_id;
    var suffix = '';
    if (typeof editionSource === 'string' && editionSource) suffix = ' · 修订版';
    else if (rounds.some(function (r) {
      return r && r.migration && r.migration.source_round_id === round.id;
    })) suffix = ' · 原版';
    return '第 ' + (index + 1) + ' 套' + suffix + (round.id === currentId ? ' · 最新' : '');
  }
  function referenceHtml(q, md) {
    if (q.type !== 'fill' || !q.blanks) return md(q.answer || '');
    return q.blanks.map(function (blank, i) {
      return '<div><b>第 ' + (i + 1) + ' 空：</b>' + md(blank.answer) + '</div>';
    }).join('');
  }
  function api(config, endpoint, body, keepalive) {
    if (endpoint === '/path/quiz' && window.LearnJobs) {
      return window.LearnJobs.run(endpoint, body, {onStatus: function (message) {
        if (view && dialog.open && roundConfig().key === config.key) status(message, false);
      }});
    }
    var payload = JSON.stringify(body);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, endpoint === '/path/quiz' ? 240000 : 20000);
    return window.LearnUser.fetch(config.api + endpoint, {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: payload,
      keepalive: !!keepalive && new Blob([payload]).size <= 60000
    }).then(function (response) {
      return response.json().then(function (result) {
        if (!response.ok || result.ok === false || result.error) throw new Error(result.error || '请求失败');
        return result;
      });
    }).finally(function () { clearTimeout(timeout); });
  }
  function status(message, bad) {
    byId('qd-save').textContent = message;
    byId('qd-save').classList.toggle('qd-error', !!bad);
  }
  function currentRecord() {
    return view && view.quiz ? records[localKey(roundConfig(), round().id)] : null;
  }
  function renderSaveState() {
    var button = byId('qd-sync');
    button.hidden = true; button.disabled = true;
    if (!view || !view.quiz) return;
    if (view.busy) { status('正在保存作答并按评分点判分…', false); return; }
    if (view.config.readOnly) { status('管理员只读查看', false); return; }
    if (view.readOnly || view.attempt) { status('历史提交已保存，此视图只读', false); return; }
    var record = currentRecord();
    if (record && !record.saved) {
      var failed = record.syncState === 'failed';
      button.hidden = !failed; button.disabled = !failed;
      var message = failed ? (record.localSaved ? '草稿已保存在本机，服务器同步失败；可重试保存。' : '服务器保存失败，本机草稿也不可用，请勿关闭页面。') :
        record.retrying ? '正在重试保存…' : record.localSaved ? '已保存在本机，正在同步…' : '正在保存到服务器，请勿关闭页面…';
      status(message, failed);
      return;
    }
    status(record && record.saved ? '已自动保存到服务器' : view.localRecovery ? '已恢复本机未同步草稿' : round().draft ? '已恢复服务器草稿' : '输入后自动保存，可随时关闭', false);
  }
  function reportRecord(record) {
    if (view && dialog.open && !view.busy && !view.readOnly && !view.attempt && currentRecord() === record) renderSaveState();
  }
  function retrySave() {
    var record = currentRecord();
    if (!view || !dialog.open || view.busy || view.readOnly || view.config.readOnly || view.attempt || !record || record.saved || record.syncState !== 'failed') return;
    record.retrying = true;
    return transmit(record);
  }
  function transmit(record) {
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    if (record.queued === record.version) return chains[record.key] || Promise.resolve();
    var version = record.version, answers = record.answers.slice();
    record.queued = version;
    record.syncState = 'saving';
    reportRecord(record);
    var previous = chains[record.key] || Promise.resolve();
    var pending = previous.catch(function () {}).then(function () {
      return api(record.config, '/path/quiz/draft', {
        key: record.config.key, node: { id: record.config.nodeId || '' }, round_id: record.roundId,
        answers: answers, client_id: clientId, sequence: version
      }, true);
    }).then(function (result) {
      if (records[record.key] === record && record.version === version) {
        record.saved = true;
        record.syncState = 'saved'; record.retrying = false;
        try {
          var current = JSON.parse(localStorage.getItem(record.key) || 'null');
          if (current && current.version === version) localStorage.removeItem(record.key);
        } catch (error) { /* Server acknowledgement is authoritative even if local storage is unavailable. */ }
        record.round.draft = result.draft;
        reportRecord(record);
      }
      return true;
    }).catch(function (error) {
      if (records[record.key] === record && record.version === version) {
        record.queued = null; record.syncState = 'failed'; record.retrying = false;
        reportRecord(record);
      }
      return false;
    });
    chains[record.key] = pending;
    return pending;
  }
  function captureDraft() {
    if (!view || view.readOnly || view.busy) return;
    var issued = round();
    var answers = issued.questions.map(function (q, i) {
      if (q.type === 'fill') return fillBlanks(q).map(function (_, j) { return byId('qd-answer-' + i + '-blank-' + j).value; });
      var field = dialog.querySelector('[name="qd-answer-' + i + '"]:checked') || byId('qd-answer-' + i);
      return field ? field.value : '';
    });
    var config = roundConfig();
    var key = localKey(config, issued.id);
    var record = records[key] || { key: key, config: config, roundId: issued.id, round: issued, version: 0 };
    record.version = Math.max(Date.now(), record.version + 1);
    record.answers = answers; record.saved = false;
    record.syncState = 'pending'; record.retrying = false;
    view.answers = answers;
    issued.draft = { answers: answers };
    try {
      localStorage.setItem(key, JSON.stringify({ answers: answers, version: record.version }));
      record.localSaved = true;
    } catch (error) {
      record.localSaved = false;
    }
    records[key] = record;
    renderSaveState();
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(function () { transmit(record); }, 400);
    updateProgress();
  }
  function flushCurrent() {
    if (!view || !view.quiz) return Promise.resolve(true);
    var record = records[localKey(roundConfig(), round().id)];
    return record && !record.saved ? transmit(record) : Promise.resolve(true);
  }
  function flushAll() {
    Object.keys(records).forEach(function (key) { if (!records[key].saved) transmit(records[key]); });
  }
  function updateProgress() {
    byId('qd-progress').textContent = view.answers.filter(hasAnswer).length + ' / ' + round().questions.length + ' 题已作答';
  }
  function chooseDraft() {
    var issued = round(), stored;
    if (!view.config.readOnly) {
      try { stored = JSON.parse(localStorage.getItem(localKey(roundConfig(), issued.id)) || 'null'); } catch (error) {}
    }
    var attempts = issued.attempts || [];
    var draft = stored || issued.draft;
    view.attempt = draft ? null : (attempts.length ? attempts[attempts.length - 1] : null);
    view.readOnly = view.config.readOnly || !!view.attempt;
    view.answers = ((draft || view.attempt || {}).answers || []).slice();
    while (view.answers.length < issued.questions.length) view.answers.push('');
    view.localRecovery = !!stored;
    if (stored) {
      var config = roundConfig();
      var key = localKey(config, issued.id);
      var record = records[key] || { key: key, config: config, roundId: issued.id, round: issued };
      record.answers = stored.answers; record.version = stored.version; record.localSaved = true; record.saved = false;
      record.round = issued;
      record.syncState = record.syncState || 'pending';
      records[key] = record;
    }
  }
  function render() {
    var issued = round(), config = view.config, md = config.render || esc;
    var result = view.attempt && (view.attempt.result || view.attempt);
    byId('qd-title').textContent = config.title || '测验';
    byId('qd-round').innerHTML = view.quiz.rounds.map(function (r, index) {
      return '<option value="' + index + '"' + (index === view.index ? ' selected' : '') + '>' + roundLabel(view.quiz.rounds, index, view.quiz.round_id) + '</option>';
    }).join('');
    byId('qd-prev').disabled = view.index === 0 || view.busy;
    byId('qd-next').disabled = view.index === view.quiz.rounds.length - 1 || view.busy;
    byId('qd-round').disabled = view.busy;
    byId('qd-attempt').innerHTML = '<option value="draft">当前草稿</option>' + (issued.attempts || []).map(function (a, index) {
      var res = a.result || a;
      return '<option value="' + index + '"' + (view.attempt === a ? ' selected' : '') + '>第 ' + (index + 1) + ' 次提交 · ' + esc(res.score) + ' 分</option>';
    }).join('');
    byId('qd-attempt').disabled = view.busy;
    byId('qd-body').innerHTML = (result ? '<div class="qd-result"><strong>' + esc(result.score) + ' / 100 分</strong><span>' + (result.pass ? '已通过' : '继续巩固') + ' · ' + esc(result.feedback || '') + '</span></div>' : '') +
      issued.questions.map(function (q, i) {
        var grade = result && (result.per_question || [])[i];
        var html = '<fieldset class="qd-question"><legend>第 ' + (i + 1) + ' 题 · ' + esc(q.points) + ' 分</legend><div class="qd-stem">' + md(q.q) + '</div>';
        var rubric = q.rubric || [];
        html += '<div class="qd-scoring">' + esc(scoringLabel(q)) + '</div>';

        if (q.options && q.options.length) {
          html += q.options.map(function (option, j) {
            var letter = String.fromCharCode(65 + j);
            return '<label class="qd-option"><input type="radio" name="qd-answer-' + i + '" value="' + letter + '"' + (view.answers[i] === letter ? ' checked' : '') + (view.readOnly || view.busy ? ' disabled' : '') + '><span>' + letter + '. ' + md(option) + '</span></label>';
          }).join('');
        } else if (q.type === 'fill') {
          var values = fillValues(q, view.answers[i]);
          html += '<div class="qd-blanks">' + fillBlanks(q).map(function (blank, j) {
            var id = 'qd-answer-' + i + '-blank-' + j;
            var label = '第 ' + (j + 1) + ' 空' + ((q.scoring || {}).mode === 'per_blank' ? ' · ' + blank.points + ' 分' : ' · 整题计分');
            if (q.blanks) label += blank.match === 'text' ? ' · 按文字匹配' : ' · 允许数值等价';
            var blankGrade = grade && (grade.blanks || [])[j];
            return '<div class="qd-blank"><label class="qd-input-label" for="' + id + '">' + esc(label) + '</label>' +
              '<textarea class="qd-blank-input" id="' + id + '" maxlength="' + Math.floor(20000 / values.length) + '" rows="1"' + (view.readOnly || view.busy ? ' readonly' : '') + ' placeholder="填写第 ' + (j + 1) + ' 空">' + esc(values[j]) + '</textarea>' +
              (blankGrade ? '<div class="qd-blank-grade">' + esc(blankGrade.comment) + (blankGrade.earned == null ? '（整题计分）' : ' · ' + esc(blankGrade.earned) + ' / ' + esc(blankGrade.max_points) + ' 分') + '</div>' : '') + '</div>';
          }).join('') + '</div>';
        } else {
          html += '<label class="qd-input-label" for="qd-answer-' + i + '">你的作答</label><textarea id="qd-answer-' + i + '" maxlength="20000" rows="' + (q.type === 'short' ? 6 : 3) + '"' + (view.readOnly || view.busy ? ' readonly' : '') + ' placeholder="' + (q.type === 'short' ? '写下你的思路与结论…' : '写下你的答案…') + '">' + esc(view.answers[i]) + '</textarea>';
        }
        if (grade) html += '<div class="qd-grade"><b>得分 ' + esc(grade.earned == null ? '旧记录未提供' : grade.earned) + ' / ' + esc(grade.max_points == null ? q.points : grade.max_points) + '</b><div>' + md(grade.comment || '') + '</div></div>';
        html += '<div class="qd-reference"><button type="button" class="btn qd-reveal" aria-expanded="false" aria-controls="qd-reference-' + i + '">查看答案与思路</button>' +
          '<div id="qd-reference-' + i + '" class="qd-reference-content" hidden><h3>参考答案</h3><div>' + referenceHtml(q, md) + '</div>' +
          '<h3>解题思路</h3><div>' + md(q.explain || '这道旧题尚未提供解题思路。') + '</div>' +
          '<div class="qd-rubric"><b>评分标准</b> ' + (rubric.length ? rubric.map(function (c) { return esc(c.description) + '（' + esc(c.points) + '分）'; }).join('；') : esc(scoringLabel(q))) + '</div></div></div></fieldset>';
        return html;
      }).join('');
    byId('qd-submit').hidden = view.readOnly;
    byId('qd-submit').disabled = !!view.busy;
    byId('qd-submit').textContent = view.busy ? '逐项判分中…' : '提交本套';
    byId('qd-retry').hidden = view.config.readOnly || !view.readOnly;
    byId('qd-retry').disabled = !!view.busy;
    byId('qd-error').hidden = true;
    updateProgress();
    renderSaveState();
    if (config.decorate) config.decorate(byId('qd-body'));
  }
  function navigate(index) {
    if (!view || view.busy) return;
    flushCurrent();
    view.index = index;
    chooseDraft(); render();
    byId('qd-body').scrollTop = 0;
    if (view.localRecovery) flushCurrent();
  }
  function close() {
    flushCurrent();
    opening += 1;
    dialog.close();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  function submit() {
    if (!view || view.busy || view.readOnly) return;
    captureDraft();
    if (!view.answers.some(hasAnswer)) { byId('qd-error').textContent = '请至少回答一题再提交'; byId('qd-error').hidden = false; return; }
    var active = view, config = roundConfig(), id = round().id, answers = view.answers.slice();
    view.busy = true; render();
    flushCurrent().then(function () {
      return api(config, '/path/quiz', {key: config.key, node: {id: config.nodeId || ''}, round_id: id, answers: answers});
    }).then(function (result) {
      active.busy = false;
      result.quiz.rounds.forEach(function (r) { r.storageKey = config.key; });
      active.quiz.rounds = active.quiz.rounds.map(function (r) {
        return result.quiz.rounds.find(function (updated) { return updated.id === r.id; }) || r;
      });
      active.index = active.quiz.rounds.findIndex(function (r) { return r.id === id; });
      var issued = active.quiz.rounds[active.index];
      active.attempt = issued.attempts.find(function (a) { return a.id === result.attempt_id; }) || issued.attempts[issued.attempts.length - 1];
      active.readOnly = true; active.answers = answers;
      var key = localKey(config, id);
      delete records[key];
      try { localStorage.removeItem(key); } catch (error) {}
      if (active.config.onResult) active.config.onResult(result, config.key);
      if (view === active) render();
    }).catch(function (error) {
      active.busy = false;
      if (view === active) {
        render(); byId('qd-error').textContent = '提交未完成，作答已保留：' + error.message; byId('qd-error').hidden = false;
      }
    });
  }
  function create() {
    if (dialog) return;
    var style = document.createElement('style');
    style.textContent = '#quiz-workspace{padding:0;border:1px solid #d9dce3;border-radius:10px;width:min(1120px,94vw);height:92vh;max-width:none;max-height:none;color:var(--text,#2d3142);background:#fff;box-shadow:0 20px 70px #17203433}#quiz-workspace::backdrop{background:#24293866}#quiz-workspace .qd-layout{height:100%;display:flex;flex-direction:column}#quiz-workspace .qd-head{padding:18px 24px;border-bottom:1px solid #e6e8ed;display:flex;align-items:center;gap:18px}#quiz-workspace h2{margin:0;font-size:21px}#quiz-workspace .qd-close{margin-left:auto}#quiz-workspace .qd-nav{display:flex;align-items:center;gap:10px;padding:12px 24px;background:#fafbfc;border-bottom:1px solid #e6e8ed}#quiz-workspace select{padding:7px 10px;border:1px solid #d9dce3;border-radius:5px;background:#fff;font:inherit}#quiz-workspace #qd-attempt{margin-left:auto}#quiz-workspace #qd-body{overflow:auto;flex:1;padding:20px 32px;scrollbar-gutter:stable}#quiz-workspace .qd-question{border:1px solid #e1e4ea;border-radius:7px;padding:20px;margin:0 0 24px;min-width:0}#quiz-workspace legend{font-weight:650;padding:0 8px;color:#616c83}#quiz-workspace .qd-stem{font-size:16px;line-height:1.8;margin-bottom:12px}#quiz-workspace .qd-rubric{font-size:13px;line-height:1.6;color:#667085;background:#f6f7f9;padding:10px 12px;margin-bottom:14px}#quiz-workspace .qd-option{display:flex;gap:10px;border:1px solid #e1e4ea;border-radius:5px;margin:8px 0;padding:12px;align-items:flex-start;cursor:pointer}#quiz-workspace .qd-option:has(input:checked){border-color:var(--accent,#ef6c3e);background:#fff8f4}#quiz-workspace input[type=radio]{margin-top:5px;flex:none}#quiz-workspace .qd-input-label{display:block;font-size:13px;color:#667085;margin:10px 0 6px}#quiz-workspace textarea{box-sizing:border-box;width:100%;font-family:inherit;font-size:15px;line-height:1.7;padding:12px;resize:vertical;border:1px solid #cbd0db;border-radius:5px;min-height:90px}#quiz-workspace textarea:focus{outline:2px solid var(--accent,#ef6c3e);outline-offset:2px}#quiz-workspace .qd-reference{margin-top:14px;font-size:14px;line-height:1.8}#quiz-workspace .qd-reference-content h3{font-size:14px;margin:14px 0 6px}#quiz-workspace .qd-reference-content .qd-rubric{margin-top:14px}#quiz-workspace .qd-grade{border-left:3px solid var(--accent,#ef6c3e);padding:8px 12px;margin-top:14px;line-height:1.7}#quiz-workspace .qd-result{display:flex;gap:20px;align-items:center;padding:16px;background:#f6f7f9;margin-bottom:24px}#quiz-workspace .qd-result strong{font-size:24px;white-space:nowrap}#quiz-workspace .qd-foot{width:100%;max-width:none;box-sizing:border-box;margin:0;flex:none;border-top:1px solid #e6e8ed;padding:14px 24px;display:flex;gap:12px;align-items:center;background:#fafbfc}#quiz-workspace #qd-save{margin-right:auto;font-size:13px;color:#667085}#quiz-workspace .qd-error{color:#b42318!important}#quiz-workspace #qd-error{padding:10px 24px;background:#fff1ef;color:#b42318}#quiz-workspace [hidden]{display:none!important}#quiz-workspace button:focus-visible,#quiz-workspace select:focus-visible{outline:2px solid var(--accent,#ef6c3e);outline-offset:2px}';
    style.textContent += '@media(max-width:600px){#quiz-workspace .qd-head{padding:12px;gap:8px;flex-wrap:wrap}#quiz-workspace h2{font-size:17px}#quiz-workspace .qd-nav{padding:10px;gap:6px;flex-wrap:wrap}#quiz-workspace #qd-attempt{margin-left:0}#quiz-workspace #qd-body{padding:12px}#quiz-workspace .qd-question{padding:12px}#quiz-workspace .qd-foot{padding:12px;gap:8px;flex-wrap:wrap}#quiz-workspace #qd-save{flex-basis:100%}}';
    style.textContent += '#quiz-workspace .qd-scoring{font-size:13px;line-height:1.8;padding:8px 12px;background:#f6f7f9;border-radius:5px;overflow-wrap:anywhere}#quiz-workspace .qd-blanks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}#quiz-workspace .qd-blank{min-width:0}#quiz-workspace textarea.qd-blank-input{min-height:48px}#quiz-workspace .qd-blank-grade{font-size:13px;line-height:1.8;margin-top:6px}';
    document.head.appendChild(style);
    dialog = document.createElement('dialog'); dialog.id = 'quiz-workspace'; dialog.setAttribute('aria-labelledby', 'qd-title');
    dialog.innerHTML = '<div class="qd-layout"><header class="qd-head"><h2 id="qd-title">测验</h2><span id="qd-progress"></span><button class="btn qd-close" id="qd-close" aria-label="保存并关闭测验">保存并关闭</button></header><nav class="qd-nav" aria-label="题集翻页"><button class="btn" id="qd-prev">上一套</button><select id="qd-round" aria-label="选择题集"></select><button class="btn" id="qd-next">下一套</button><select id="qd-attempt" aria-label="选择历史作答"></select></nav><div id="qd-body"></div><div id="qd-error" role="alert" hidden></div><footer class="qd-foot"><span id="qd-save" role="status" aria-live="polite"></span><button class="btn" id="qd-sync">重试保存</button><button class="btn" id="qd-retry" hidden>再做本套</button><button class="btn primary" id="qd-submit">提交本套</button></footer></div>';
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    byId('qd-close').onclick = close;
    byId('qd-prev').onclick = function () { navigate(view.index - 1); };
    byId('qd-next').onclick = function () { navigate(view.index + 1); };
    byId('qd-round').onchange = function () { navigate(Number(this.value)); };
    byId('qd-attempt').onchange = function () {
      if (!view || view.busy) return;
      flushCurrent();
      if (this.value === 'draft') {
        view.attempt = null; view.readOnly = !!view.config.readOnly;
        view.answers = (round().draft || {}).answers || round().questions.map(function () { return ''; });
      } else {
        view.attempt = round().attempts[Number(this.value)]; view.readOnly = true;
        view.answers = view.attempt.answers || round().questions.map(function () { return ''; });
      }
      render();
    };
    byId('qd-retry').onclick = function () {
      if (!view || view.busy) return;
      view.attempt = null; view.readOnly = !!view.config.readOnly; view.answers = round().questions.map(function () { return ''; });
      render(); captureDraft();
    };
    byId('qd-sync').hidden = true;
    byId('qd-sync').onclick = retrySave;
    byId('qd-submit').onclick = submit;
    byId('qd-body').addEventListener('click', function (event) {
      var button = event.target.closest('.qd-reveal');
      if (!button) return;
      var content = byId(button.getAttribute('aria-controls'));
      if (content.hidden && !window.confirm('确定查看本题的参考答案与解题思路吗？建议先独立作答。')) return;
      content.hidden = !content.hidden;
      if (!content.hidden && view.config.decorate) view.config.decorate(content);
      button.setAttribute('aria-expanded', String(!content.hidden));
      button.textContent = content.hidden ? '查看答案与思路' : '收起答案与思路';
    });
    byId('qd-body').addEventListener('input', captureDraft);
    byId('qd-body').addEventListener('change', captureDraft);
    window.addEventListener('pagehide', flushAll);
    window.addEventListener('online', flushAll);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushAll(); });
  }
  window.QuizDialog = {
    open: function (config) {
      create();
      if (view && view.busy) { if (!dialog.open) dialog.showModal(); return Promise.resolve(); }
      flushCurrent();
      view = null;
      byId('qd-sync').hidden = true;
      byId('qd-sync').disabled = true;
      status('正在恢复题集与草稿…', false);
      var request = ++opening;
      returnFocus = document.activeElement;
      if (!dialog.open) dialog.showModal();
      byId('qd-title').textContent = config.title || '测验';
      byId('qd-body').textContent = '正在恢复题集与草稿…';
      ['qd-prev', 'qd-next', 'qd-round', 'qd-attempt', 'qd-submit', 'qd-retry'].forEach(function (id) { byId(id).disabled = true; });
      var keys = config.relatedKeys || [config.key];
      return Promise.all(keys.map(function (key) {
        var scoped = Object.assign({}, config, {key: key});
        return api(scoped, '/path/quiz/state', {key: key, node: {id: config.nodeId || ''}}).then(function (quiz) {
          quiz.rounds.forEach(function (r) { r.storageKey = key; });
          return quiz;
        });
      })).then(function (quizzes) {
        if (request !== opening || !dialog.open) return;
        var quiz = quizzes[keys.indexOf(config.key)];
        if (config.onLoad) config.onLoad(quiz);
        quiz = Object.assign({}, quiz, {rounds: quizzes.reduce(function (all, q) { return all.concat(q.rounds); }, [])});
        view = {config: config, quiz: quiz, index: Math.max(0, quiz.rounds.findIndex(function (r) { return r.id === (config.roundId || quiz.round_id); })), busy: false};
        chooseDraft(); render();
        if (view.localRecovery) flushCurrent();
        byId('qd-close').focus();
        if (window.LearnJobs && !config.readOnly) {
          var active = view;
          window.LearnJobs.list().then(function (jobs) {
            if (view !== active || !dialog.open) return;
            var job = jobs.find(function (item) {
              return item.operation === '/path/quiz' && item.key === roundConfig().key &&
                item.round_id === round().id && (item.status === 'queued' || item.status === 'running');
            });
            if (!job) return;
            active.busy = true; render();
            return window.LearnJobs.watch(job, {onStatus: function (message) {
              if (view === active && dialog.open) status(message, false);
            }}).then(function () {
              active.busy = false;
              if (view === active && dialog.open) return window.QuizDialog.open(config);
            }).catch(function (error) {
              active.busy = false;
              if (view === active && dialog.open) { render(); status(error.message, true); }
            });
          }).catch(function (error) { if (view === active && dialog.open) status('任务状态暂时无法读取：' + error.message, true); });
        }
      }).catch(function (error) {
        if (request !== opening || !dialog.open) return;
        byId('qd-body').textContent = '无法打开题集：' + error.message;
      });
    }
  };
})();
