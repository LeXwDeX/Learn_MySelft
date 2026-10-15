/* 按题集隔离的草稿、保存版本和重试。 */
define("quiz-dialog.drafts", ["quiz-dialog.model", "quiz-dialog.question", "quiz-dialog.hooks", "quiz-dialog.network"], function (deps) {
  'use strict';
  var model = deps["quiz-dialog.model"];
  var question = deps["quiz-dialog.question"];
  var hooks = deps["quiz-dialog.hooks"];
  var network = deps["quiz-dialog.network"];
  var session = {};

session.records = {};

session.chains = {};

session.clientId = Date.now().toString(36) + Math.random().toString(36).slice(2);

function currentRecord() {
    return model.session.view && model.session.view.quiz ? session.records[question.localKey(model.roundConfig(), model.round().id)] : null;
  }

function reportRecord(record) {
    if (model.session.view && model.session.dialog.open && !model.session.view.busy && !model.session.view.readOnly && !model.session.view.attempt && currentRecord() === record) hooks.renderSaveState();
  }

function retrySave() {
    var record = currentRecord();
    if (!model.session.view || !model.session.dialog.open || model.session.view.busy || model.session.view.readOnly || model.session.view.config.readOnly || model.session.view.attempt || !record || record.saved || record.syncState !== 'failed') return;
    record.retrying = true;
    return transmit(record);
  }

function transmit(record) {
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    if (record.queued === record.version) return session.chains[record.key] || Promise.resolve();
    var version = record.version, answers = record.answers.slice();
    record.queued = version;
    record.syncState = 'saving';
    reportRecord(record);
    var previous = session.chains[record.key] || Promise.resolve();
    var pending = previous.catch(function () {}).then(function () {
      return network.api(record.config, '/path/quiz/draft', {
        key: record.config.key, node: { id: record.config.nodeId || '' }, round_id: record.roundId,
        answers: answers, client_id: session.clientId, sequence: version
      }, true);
    }).then(function (result) {
      if (session.records[record.key] === record && record.version === version) {
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
      if (session.records[record.key] === record && record.version === version) {
        record.queued = null; record.syncState = 'failed'; record.retrying = false;
        reportRecord(record);
      }
      return false;
    });
    session.chains[record.key] = pending;
    return pending;
  }

function captureDraft() {
    if (!model.session.view || model.session.view.readOnly || model.session.view.busy) return;
    var issued = model.round();
    var answers = issued.questions.map(function (q, i) {
      if (q.type === 'fill') return question.fillBlanks(q).map(function (_, j) { return model.byId('qd-answer-' + i + '-blank-' + j).value; });
      var field = model.session.dialog.querySelector('[name="qd-answer-' + i + '"]:checked') || model.byId('qd-answer-' + i);
      return field ? field.value : '';
    });
    var config = model.roundConfig();
    var key = question.localKey(config, issued.id);
    var record = session.records[key] || { key: key, config: config, roundId: issued.id, round: issued, version: 0 };
    record.version = Math.max(Date.now(), record.version + 1);
    record.answers = answers; record.saved = false;
    record.syncState = 'pending'; record.retrying = false;
    model.session.view.answers = answers;
    issued.draft = { answers: answers };
    try {
      localStorage.setItem(key, JSON.stringify({ answers: answers, version: record.version }));
      record.localSaved = true;
    } catch (error) {
      record.localSaved = false;
    }
    storeRecord(record);
    hooks.renderSaveState();
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(function () { transmit(record); }, 400);
    hooks.updateProgress();
  }

function flushCurrent() {
    if (!model.session.view || !model.session.view.quiz) return Promise.resolve(true);
    var record = session.records[question.localKey(model.roundConfig(), model.round().id)];
    return record && !record.saved ? transmit(record) : Promise.resolve(true);
  }

function flushAll() {
    Object.keys(session.records).forEach(function (key) { if (!session.records[key].saved) transmit(session.records[key]); });
  }

function chooseDraft() {
    var issued = model.round(), stored;
    if (!model.session.view.config.readOnly) {
      try { stored = JSON.parse(localStorage.getItem(question.localKey(model.roundConfig(), issued.id)) || 'null'); } catch (error) {}
    }
    var attempts = issued.attempts || [];
    var memory = session.records[question.localKey(model.roundConfig(), issued.id)];
    var memoryRecovery = memory && !memory.saved && (!stored || memory.version >= stored.version);
    if (memoryRecovery) stored = null;
    var draft = memoryRecovery ? {answers: memory.answers} : stored || issued.draft;
    model.session.view.attempt = draft ? null : (attempts.length ? attempts[attempts.length - 1] : null);
    model.session.view.readOnly = model.session.view.config.readOnly || !!model.session.view.attempt;
    model.session.view.answers = ((draft || model.session.view.attempt || {}).answers || []).slice();
    while (model.session.view.answers.length < issued.questions.length) model.session.view.answers.push('');
    model.session.view.localRecovery = !!stored;
    if (stored) {
      var config = model.roundConfig();
      var key = question.localKey(config, issued.id);
      var record = session.records[key] || { key: key, config: config, roundId: issued.id, round: issued };
      record.answers = stored.answers; record.version = stored.version; record.localSaved = true; record.saved = false;
      record.round = issued;
      record.syncState = record.syncState || 'pending';
      storeRecord(record);
    }
  }

  function storeRecord(record) { session.records[record.key] = record; }
  function discardRecord(key) { delete session.records[key]; }

  return Object.freeze({storeRecord: storeRecord, discardRecord: discardRecord, currentRecord: currentRecord, reportRecord: reportRecord, retrySave: retrySave, transmit: transmit, captureDraft: captureDraft, flushCurrent: flushCurrent, flushAll: flushAll, chooseDraft: chooseDraft});
});
