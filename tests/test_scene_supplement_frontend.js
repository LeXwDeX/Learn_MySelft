'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'learning-path/modules/path-assessment.js'), 'utf8');
const sceneNotes = '原有正文\n\n```learn-scene\n{"version":1,"type":"linear_transform","title":"变换","summary":"观察向量。","matrix":[[1,0],[0,1]]}\n```';
const manimNotes = '原有正文\n\n```learn-manim\n{"version":1,"asset_id":"' + 'a'.repeat(32) + '","title":"变换","summary":"观察向量。"}\n```';
const marker = {version: 1, source_sha256: 'a'.repeat(64), notes_sha256: 'b'.repeat(64)};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function harness({readOnly = false, key = 'u0/topic-a'} = {}) {
  const quiz = {round_id: 'r1', questions: [{q: 'preserve'}], rounds: [{id: 'r1'}], attempts: [{id: 'a1'}]};
  const nodeState = {score: 80, completed: true, lastResult: {score: 80, pass: true, round_id: 'r1'}};
  const detail = {study_notes: '原有正文', sceneSupplement: {version: 1, source_sha256: 'old'}, quiz};
  const model = {
    state: {plan: {nodes: [{id: 'n1', title: '节点', objectives: []}, {id: 'n2', title: '另一个节点', objectives: []}]}, nodeDetail: {n1: detail, n2: {study_notes: '另一个正文', quiz: {round_id: 'r2', questions: [{q: 'second'}]}}}, nodeState: {n1: nodeState}, topic: '测试'},
    session: {expandedId: 'n1', materialSlug: 'topic-a'}
  };
  const status = {textContent: ''};
  const button = {disabled: false, listener: null, addEventListener(name, listener) { if (name === 'click') this.listener = listener; }};
  function tab(value) {
    return {value, listener: null, on: false, classList: {toggle(name, enabled) { if (name === 'on') this.owner.on = enabled; }, owner: null},
      getAttribute(name) { return name === 'data-mat' ? value : null; },
      addEventListener(name, listener) { if (name === 'click') this.listener = listener; },
      click() { if (this.listener) this.listener.call(this); }};
  }
  const tabs = [tab('material'), tab('quiz')];
  tabs.forEach(item => { item.classList.owner = item; });
  const materialPane = {hidden: false}, quizPane = {hidden: true};
  const scope = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; tabs[0].on = /class="mat-tab on"[^>]*data-mat="material"/.test(value); tabs[1].on = /class="mat-tab on"[^>]*data-mat="quiz"/.test(value); materialPane.hidden = /mat-pane-material" hidden/.test(value); quizPane.hidden = /mat-pane-quiz" hidden/.test(value); },
    querySelector(selector) {
      if (selector === '.scene-supplement-status') return status;
      if (selector === '.scene-supplement-btn') return /scene-supplement-btn/.test(this._html) ? button : null;
      if (selector === '.notes') return {textContent: ''};
      if (selector === '.mat-pane-material') return materialPane;
      if (selector === '.mat-pane-quiz') return quizPane;
      if (selector === '#quiz-round-select') return {value: 'r1'};
      return null;
    },
    querySelectorAll(selector) { return selector === '.mat-tab' ? tabs : []; }
  };
  const calls = {post: [], save: 0, sync: [], errors: []};
  let currentKey = key;
  let postImpl = () => Promise.reject(new Error('Unexpected post'));
  const persistence = {
    post(...args) { calls.post.push(args); return postImpl(...args); },
    save() { calls.save++; }
  };
  const format = {
    mdRender: value => String(value || ''), esc: value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    storeKey: () => currentKey, renderMathIn() {}, highlightIn() {}, bindAutoGrow() {},
    dispId: id => id, $: () => null
  };
  const domain = {nodeById: id => model.state.plan.nodes.find(node => node.id === id) || null, isDone: () => false, canRefine: () => false};
  let api;
  const cards = {cardContentEl: id => model.state.nodeDetail[id] ? scope : null, drawEdges() {}, renderPlan() { if (api && model.session.expandedId) api.renderNodeDetail(model.session.expandedId); }};
  const assistant = {setFoot() {}, syncAiMaterial(id) { calls.sync.push(id); }};
  const shell = {showError(message) { calls.errors.push(message); }, hideError() {}};
  const window = {LearnUser: {readOnly}, LearnTitles: {document: () => '测试资料'}, QuizDialog: {open(options) { window.quizDialogOptions = options; }}};
  const context = {window, define(name, deps, factory) { context.factory = factory; }, requestAnimationFrame() {}, alert() {}, Promise, console};
  vm.runInNewContext(source, context, {filename: 'path-assessment.js'});
  const deps = {'path.format': format, 'path.model': model, 'path.domain': domain, 'path.cards': cards,
    'path.assistant': assistant, 'path.persistence': persistence, 'path.shell': shell};
  api = context.factory(deps);
  return {api, calls, model, detail, quiz, nodeState, scope, status, button, window, persistence,
    tabs, materialPane, quizPane,
    clickTab(value) { tabs.find(item => item.value === value).click(); },
    expand(id) { model.session.expandedId = id; api.renderNodeDetail(id); },
    setKey(value) { currentKey = value; }, setPost(fn) { postImpl = fn; }};
}

async function tick() { await Promise.resolve(); await Promise.resolve(); }

function assertMaterialSelected(h, message) {
  assert.equal(h.tabs[0].on, true, message + ': material tab remains selected');
  assert.equal(h.tabs[1].on, false, message + ': quiz tab remains unselected');
}

(async function main() {
  {
    const h = harness();
    h.detail.study_notes = sceneNotes;
    const beforeQuiz = JSON.stringify(h.quiz), beforeState = JSON.stringify(h.nodeState);
    h.setPost(() => Promise.resolve({node_id:'n1', source_notes:sceneNotes, study_notes:manimNotes}));
    h.api.renderNodeDetail('n1');
    assert.match(h.scope.innerHTML, /升级教学动画/);
    await h.api.supplementScene('n1');
    assert.equal(h.detail.study_notes, manimNotes, 'real Manim replaces the historical graphic');
    assert.equal(JSON.stringify(h.quiz), beforeQuiz);
    assert.equal(JSON.stringify(h.nodeState), beforeState);
    assert.doesNotMatch(h.scope.innerHTML, /data-scene-supplement=/);
    await h.api.supplementScene('n1');
    assert.equal(h.calls.post.length, 1, 'existing Manim assets are not regenerated');
  }
  {
    const h = harness();
    h.detail.study_notes = '````text\n' + manimNotes + '\n````';
    h.api.renderNodeDetail('n1');
    assert.match(h.scope.innerHTML, /补充教学动画/, 'a quoted example is not a rendered animation');
  }
  {
    const h = harness();
    h.api.renderNodeDetail('n1');
    assert.equal(h.tabs[1].on, true, 'a scored node opens on its existing quiz result');
    h.clickTab('material');
    const pending = deferred();
    h.setPost(() => pending.promise);
    const work = h.api.supplementScene('n1');
    assertMaterialSelected(h, 'supplement start rerender');
    pending.resolve({node_id: 'n1', source_notes: '原有正文', study_notes: sceneNotes, sceneSupplement: marker});
    await work;
    assertMaterialSelected(h, 'supplement success rerender');
  }

  {
    const h = harness();
    h.api.renderNodeDetail('n1');
    h.clickTab('material');
    h.setPost(() => Promise.reject(new Error('network down')));
    await h.api.supplementScene('n1');
    assertMaterialSelected(h, 'supplement failure rerender');
  }

  {
    const h = harness();
    h.api.renderNodeDetail('n1');
    h.clickTab('material');
    h.window.LearnJobs = {list: () => Promise.resolve([{id: 'cancelled', operation: '/path/node/scene', node_id: 'n1', created_ms: 1, status: 'cancelled'}])};
    await h.api.restoreSceneSupplement();
    assertMaterialSelected(h, 'cancelled restore rerender');
  }

  {
    const h = harness();
    h.api.renderNodeDetail('n1');
    h.clickTab('material');
    h.window.LearnJobs = {list: () => Promise.resolve([{id: 'restored', operation: '/path/node/scene', node_id: 'n1', created_ms: 1, status: 'succeeded',
      result: {node_id: 'n1', source_notes: '原有正文', study_notes: sceneNotes, sceneSupplement: marker}}])};
    await h.api.restoreSceneSupplement();
    assertMaterialSelected(h, 'successful restore rerender');
  }

  {
    const h = harness();
    h.api.renderNodeDetail('n1');
    h.clickTab('material');
    h.window.LearnJobs = {
      list: () => Promise.resolve([{id: 'running', operation: '/path/node/scene', node_id: 'n1', created_ms: 1, status: 'running'}]),
      get: () => Promise.resolve({id: 'running', status: 'cancelled'})
    };
    await h.api.restoreSceneSupplement();
    assertMaterialSelected(h, 'running job cancelled during restore');
  }

  {
    const h = harness();
    h.api.renderNodeDetail('n1');
    h.clickTab('material');
    h.api.openQuizModal('n1', 'r1');
    h.window.quizDialogOptions.onResult({quiz: {round_id: 'r1', questions: [{q: 'new'}]}, round_id: 'r1', score: 90, pass: true});
    assert.equal(h.tabs[1].on, true, 'a new quiz result switches the view to the quiz tab');
    h.expand('n2');
    assert.equal(h.tabs[0].on, true, 'switching to another node resets to study material');
    h.expand('n1');
    assert.equal(h.tabs[1].on, true, 'returning to a node with a result shows its quiz');
  }

  {
    const h = harness(), pending = deferred();
    h.setPost((url, body, options) => { assert.equal(url, '/path/node/scene'); assert.equal(JSON.stringify(body), JSON.stringify({key: 'u0/topic-a', node: {id: 'n1'}})); assert.equal(options.newOperation, true); return pending.promise; });
    h.api.renderNodeDetail('n1');
    assert.match(h.scope.innerHTML, /data-scene-supplement="n1"/);
    const beforeQuiz = JSON.stringify(h.quiz), beforeState = JSON.stringify(h.nodeState);
    const work = h.api.supplementScene('n1');
    assert.equal(h.api.supplementScene('n1'), work, 'duplicate clicks share the running operation');
    assert.equal(h.calls.post.length, 1);
    pending.resolve({node_id: 'n1', source_notes: '原有正文', study_notes: sceneNotes, sceneSupplement: marker, reused: false});
    await work;
    assert.equal(h.detail.study_notes, sceneNotes);
    assert.deepEqual(h.detail.sceneSupplement, marker);
    assert.equal(JSON.stringify(h.quiz), beforeQuiz, 'supplement must preserve quiz history');
    assert.equal(JSON.stringify(h.nodeState), beforeState, 'supplement must preserve score and progress');
    assert.equal(h.calls.save, 1);
    assert.deepEqual(h.calls.sync, ['n1']);
    assert.match(h.scope.innerHTML, /升级教学动画/, 'historical scenes remain eligible for a real Manim upgrade');
  }

  {
    const h = harness(), pending = deferred(), original = h.detail.study_notes, oldMarker = h.detail.sceneSupplement;
    h.setPost(() => pending.promise);
    const work = h.api.supplementScene('n1');
    pending.resolve({node_id: 'n1', study_notes: original, reused: true, needed: false, reason: '<img src=x onerror=alert(1)>'});
    await work;
    assert.equal(h.detail.study_notes, original, 'not-needed must leave the original body unchanged');
    assert.equal(h.detail.sceneSupplement, oldMarker, 'not-needed must leave the marker unchanged');
    assert.equal(h.calls.save, 0, 'not-needed must not persist a no-op');
    assert.equal(JSON.stringify(h.quiz), JSON.stringify(h.detail.quiz));
    assert.equal(h.status.textContent, '本单元暂未找到合适图示。 <img src=x onerror=alert(1)>', 'model reason is assigned as text');
    assert.match(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
  }

  {
    const h = harness(), pending = deferred();
    h.setPost(() => pending.promise);
    const work = h.api.supplementScene('n1');
    const replacement = {study_notes: '新主题正文', quiz: {round_id: 'new-round'}, sceneSupplement: {version: 1}};
    h.setKey('u0/topic-b');
    h.model.state.plan = {nodes: [{id: 'n1', title: '新主题节点'}]};
    h.model.state.nodeDetail.n1 = replacement;
    pending.resolve({node_id: 'n1', source_notes: '原有正文', study_notes: sceneNotes, sceneSupplement: marker});
    await work;
    assert.equal(replacement.study_notes, '新主题正文', 'late result from another topic must be ignored');
    assert.equal(h.calls.save, 0);
    assert.deepEqual(h.calls.sync, []);
    assert.deepEqual(h.calls.errors, []);
  }

  {
    const h = harness({readOnly: true});
    await h.api.supplementScene('n1');
    assert.equal(h.calls.post.length, 0, 'read-only views cannot start a supplement');
  }

  {
    const h = harness();
    h.window.LearnJobs = {
      list: () => Promise.resolve([
        {id: 'old-success', operation: '/path/node/scene', node_id: 'n1', created_ms: 1, status: 'succeeded', result: {node_id: 'n1', study_notes: sceneNotes, sceneSupplement: marker}},
        {id: 'latest-failed', operation: '/path/node/scene', node_id: 'n1', created_ms: 2, status: 'failed'}
      ]),
      get: () => Promise.reject(new Error('Failed job must not be fetched'))
    };
    await h.api.restoreSceneSupplement();
    assert.equal(h.status.textContent, '补充失败，可以重试。', 'restore chooses the latest failed job');
    assert.equal(h.detail.study_notes, '原有正文', 'older success must not override latest job state');
  }

  {
    const h = harness(), pending = deferred();
    h.window.LearnJobs = {
      list: () => Promise.resolve([{id: 'running', operation: '/path/node/scene', node_id: 'n1', created_ms: 2, status: 'running'}]),
      get: () => Promise.resolve({id: 'running', operation: '/path/node/scene', status: 'running'}),
      watch: () => pending.promise
    };
    const work = h.api.restoreSceneSupplement();
    await tick();
    assert.match(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
    pending.resolve({node_id: 'n1', source_notes: '原有正文', study_notes: sceneNotes, sceneSupplement: marker});
    await work;
    assert.equal(h.detail.study_notes, sceneNotes, 'restore resumes a running job');
    assert.deepEqual(h.detail.sceneSupplement, marker);
  }

  {
    const h = harness(), oldNotes = '原正文', newerNotes = '已更新的正文';
    h.detail.study_notes = newerNotes;
    h.window.LearnJobs = {
      list: () => Promise.resolve([
        {id: 'old-failed', operation: '/path/node/scene', node_id: 'n1', created_ms: 1, status: 'failed'},
        {id: 'latest-success', operation: '/path/node/scene', node_id: 'n1', created_ms: 2, status: 'succeeded'}
      ]),
      get: () => Promise.resolve({result: {node_id: 'n1', study_notes: oldNotes, needed: false, reason: '旧正文不适用'}})
    };
    await h.api.restoreSceneSupplement();
    assert.equal(h.detail.study_notes, newerNotes, 'stale not-needed results cannot overwrite newer notes');
    assert.equal(h.calls.save, 0);
    assert.equal(h.status.textContent, '', 'stale result is ignored');
    assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
  }

  {
    const h = harness();
    h.detail.study_notes = '同主题更新后的正文';
    h.window.LearnJobs = {
      list: () => Promise.resolve([{id: 'old-success', operation: '/path/node/scene', node_id: 'n1', created_ms: 2, status: 'succeeded',
        result: {node_id: 'n1', source_notes: '同主题旧正文', study_notes: sceneNotes, sceneSupplement: marker}}]),
      get: () => Promise.reject(new Error('Result was already in the list'))
    };
    await h.api.restoreSceneSupplement();
    assert.equal(h.detail.study_notes, '同主题更新后的正文', 'same-key old success must not replace newer source text');
    assert.equal(h.calls.save, 0);
    assert.deepEqual(h.calls.sync, []);
    assert.deepEqual(h.calls.errors, []);
    assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
  }

  {
    const h = harness(), pending = deferred();
    h.setPost(() => pending.promise);
    const work = h.api.supplementScene('n1');
    h.detail.study_notes = '同主题运行期间更新的正文';
    pending.resolve({node_id: 'n1', source_notes: '原有正文', study_notes: sceneNotes, sceneSupplement: marker});
    await work;
    assert.equal(h.detail.study_notes, '同主题运行期间更新的正文', 'running result must match its original source');
    assert.equal(h.calls.save, 0);
    assert.deepEqual(h.calls.sync, []);
    assert.deepEqual(h.calls.errors, []);
    assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
  }

  {
    const h = harness();
    h.detail.study_notes = sceneNotes;
    h.window.LearnJobs = {
      list: () => Promise.resolve([{id: 'already-applied', operation: '/path/node/scene', node_id: 'n1', created_ms: 2, status: 'succeeded',
        result: {node_id: 'n1', source_notes: 'older source', study_notes: sceneNotes, sceneSupplement: marker}}]),
      get: () => Promise.reject(new Error('Result was already in the list'))
    };
    await h.api.restoreSceneSupplement();
    assert.equal(h.detail.study_notes, sceneNotes);
    assert.equal(h.calls.save, 0, 'replaying already-applied material must not save again');
    assert.deepEqual(h.calls.sync, [], 'replaying already-applied material must not resync');
  }

  {
    const h = harness(), pending = deferred();
    h.setPost(() => pending.promise);
    const work = h.api.supplementScene('n1');
    pending.resolve({node_id: 'n1', study_notes: sceneNotes, sceneSupplement: marker});
    await work;
    assert.equal(h.detail.study_notes, '原有正文', 'scene result without source_notes is ignored');
    assert.equal(h.calls.save, 0);
    assert.deepEqual(h.calls.sync, []);
    assert.deepEqual(h.calls.errors, []);
    assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
  }

  for (const listedStatus of ['queued', 'running']) {
    for (const status of ['failed', 'interrupted', 'cancelled']) {
      const h = harness();
      const id = 'raced-' + listedStatus + '-' + status;
      h.window.LearnJobs = {
        list: () => Promise.resolve([{id, operation: '/path/node/scene', node_id: 'n1', created_ms: 2, status: listedStatus}]),
        get: () => Promise.resolve({id, status}),
        watch: () => Promise.reject(new Error('Terminal task must not be watched'))
      };
      await h.api.restoreSceneSupplement();
      assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/, listedStatus + '→' + status + ' must not leave the button locked');
      assert.equal(h.status.textContent, status === 'cancelled' ? '' : '补充失败，可以重试。');
    }
  }

  console.log('Frontend scene supplement: source matching, duplicate results, stale-topic guard, read-only, and job recovery passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
