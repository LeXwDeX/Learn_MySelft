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
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
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
    ensureAccess() { return Promise.resolve(true); },
    post(...args) { calls.post.push(args); return postImpl(...args); },
    save() { calls.save++; }
  };
  const format = {
    mdRender: value => String(value || ''), esc: value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    storeKey: () => currentKey, renderMathIn() {}, highlightIn() {}, bindAutoGrow() {},
    dispId: id => id, $: () => null
  };
  const domain = {canAccess: () => true, nodeById: id => model.state.plan.nodes.find(node => node.id === id) || null, isDone: () => false, canRefine: () => false};
  let api;
  const cards = {cardContentEl: id => model.state.nodeDetail[id] ? scope : null, drawEdges() {}, renderPlan() { if (api && model.session.expandedId) api.renderNodeDetail(model.session.expandedId); }};
  const assistant = {setFoot() {}, syncAiMaterial(id) { calls.sync.push(id); }};
  const shell = {showError(message) { calls.errors.push(message); }, hideError() {}};
  const window = {LearnJobs:{list:async()=>[]},LearnUser: {readOnly}, LearnTitles: {document: () => '测试资料'}, QuizDialog: {open(options) { window.quizDialogOptions = options; }}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'shared/learning-scenes.js'), 'utf8'), {window});
  const context = {window, define(name, deps, factory) { context.factory = factory; }, requestAnimationFrame() {}, alert() {}, Promise, console, AbortController, setTimeout, clearTimeout};
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

async function tick() { for(let i=0;i<14;i++)await Promise.resolve(); }

function assertMaterialSelected(h, message) {
  assert.equal(h.tabs[0].on, true, message + ': material tab remains selected');
  assert.equal(h.tabs[1].on, false, message + ': quiz tab remains unselected');
}

(async function main() {
  {
    const h = harness();
    h.detail.manim_review = {status:'pending',retryable:true};
    let reads = 0;
    h.window.LearnUser.fetch = async () => {
      reads++;
      return Response.json({entries:{'u0/topic-a':JSON.stringify({nodeDetail:{n1:{study_notes:'原有正文',manim_review:{status:'failed',retryable:true,failure_code:'render_unavailable'}}}})}});
    };
    h.setPost(() => Promise.reject(Object.assign(new Error('动画失败'),{jobId:'scene-job'})));
    await h.api.supplementScene('n1');
    assert.equal(reads,1,'scene failure refreshes authoritative review without replacing material');
    assert.equal(h.detail.manim_review.failure_code,'render_unavailable');
    assert.equal(h.calls.post[0][1].automatic,undefined,'explicit animation retry must use requested semantics');
    assert.equal(h.calls.post[0][2].manualRetry,true);
    assert.equal(h.detail.study_notes,'原有正文');
    assert.equal(h.quiz.round_id,'r1');
  }
  {
    const h = harness();
    h.detail.manim_review = {status:'pending',retryable:true};
    h.setPost(() => Promise.reject(Object.assign(new Error('读取超时'),{jobId:'running-scene',error_category:'watch_timeout',job:{status:'running'}})));
    await h.api.supplementScene('n1');
    assert.equal(h.detail.manim_review.status,'pending');
    assert.match(h.status.textContent,/结果尚未确认/,'watch timeout is not displayed as terminal animation failure');
  }
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
    assertMaterialSelected(h, 'a scored node initially opens its reading material');
    h.clickTab('quiz');
    assert.equal(h.tabs[1].on, true, 'the learner can explicitly select the existing quiz result');
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
    await h.api.openQuizModal('n1', 'r1');
    h.window.quizDialogOptions.onResult({quiz: {round_id: 'r1', questions: [{q: 'new'}]}, round_id: 'r1', score: 90, pass: true});
    assert.equal(h.tabs[1].on, true, 'a new quiz result switches the view to the quiz tab');
    h.expand('n2');
    assert.equal(h.tabs[0].on, true, 'switching to another node resets to study material');
    h.expand('n1');
    assertMaterialSelected(h, 'returning from another node opens material despite its persisted result');
  }

  {
    const h = harness(), pending = deferred();
    h.setPost((url, body, options) => { assert.equal(url, '/path/node/scene'); assert.equal(JSON.stringify(body), JSON.stringify({key: 'u0/topic-a', node: {id: 'n1'}})); assert.equal(options.newOperation, true); return pending.promise; });
    h.api.renderNodeDetail('n1');
    assert.match(h.scope.innerHTML, /data-scene-supplement="n1"/);
    const beforeQuiz = JSON.stringify(h.quiz), beforeState = JSON.stringify(h.nodeState);
    const work = h.api.supplementScene('n1');
    assert.equal(h.api.supplementScene('n1'), work, 'duplicate clicks share the running operation');
    await tick(); // Access is confirmed before starting the operation.
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
    assert.equal(h.status.textContent, '这次未生成教学动画。正文仍可学习，也可以再次手动请求。 <img src=x onerror=alert(1)>', 'model reason is assigned as text');
    assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/, 'no-animation result must keep manual action available');
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
    assert.equal(h.status.textContent, '动画仍未生成，可以重试。学习正文已保留。', 'restore chooses the latest failed job');
    assert.equal(h.detail.study_notes, '原有正文', 'older success must not override latest job state');
  }

  {
    const h = harness();
    h.detail.manim_review = {status: 'failed', retryable: true, failure_code: 'render_unavailable'};
    h.api.renderNodeDetail('n1'); // simulate a page refresh: only persisted detail is available
    assert.match(h.scope.innerHTML, /重试教学动画/);
    assert.match(h.status.textContent, /学习材料已就绪，动画暂未生成，可单独重试。/);
    assert.equal(h.detail.study_notes, '原有正文', 'failed animation does not hide or remove the saved body');
    assert.doesNotMatch(h.scope.innerHTML + h.status.textContent, /render_unavailable/);

    const beforeQuiz = JSON.stringify(h.quiz), beforeState = JSON.stringify(h.nodeState);
    h.setPost(() => Promise.resolve({node_id: 'n1', source_notes: '原有正文', study_notes: manimNotes,
      manim_review: {status: 'passed', retryable: false, asset_id: 'a'.repeat(32)}}));
    await h.api.supplementScene('n1');
    assert.equal(h.detail.manim_review.status, 'passed', 'retry success updates persisted animation review');
    assert.equal(JSON.stringify(h.quiz), beforeQuiz, 'retry success preserves quiz data');
    assert.equal(JSON.stringify(h.nodeState), beforeState, 'retry success preserves learning progress');

    h.detail.study_notes = '正文已保存';
    h.detail.manim_review = {status: 'failed', retryable: true, failure_code: 'worker_unavailable', error: '<img src=x onerror=alert(1)>'};
    h.api.renderNodeDetail('n1');
    const bodyBeforeFailedRetry = h.detail.study_notes;
    const quizBeforeFailedRetry = JSON.stringify(h.quiz), stateBeforeFailedRetry = JSON.stringify(h.nodeState);
    h.setPost(() => Promise.reject(new Error('<script>alert(1)</script>')));
    await h.api.supplementScene('n1');
    assert.equal(h.detail.study_notes, '正文已保存', 'a failed retry keeps the validated body');
    assert.equal(h.detail.study_notes, bodyBeforeFailedRetry);
    assert.equal(JSON.stringify(h.quiz), quizBeforeFailedRetry, 'retry failure preserves quiz data');
    assert.equal(JSON.stringify(h.nodeState), stateBeforeFailedRetry, 'retry failure preserves learning progress');
    assert.match(h.status.textContent, /动画仍未生成，可以重试。学习正文已保留。/);
    assert.doesNotMatch(h.scope.innerHTML + h.status.textContent + h.calls.errors.join(' '), /<script>|<img|alert\(1\)|worker_unavailable/);
    assert.doesNotMatch(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/, 'failed retry leaves the control available');
  }

  {
    const h = harness(), pending = deferred();
    h.detail.manim_review = {status: 'failed', retryable: true, failure_code: 'render_unavailable'};
    h.setPost(() => pending.promise);
    const work = h.api.supplementScene('n1');
    await tick();
    assert.match(h.status.textContent, /正在生成教学动画/ , 'running work overrides persisted failure text');
    assert.match(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
    pending.reject(new Error('worker unavailable'));
    await work;
  }

  {
    const h = harness({readOnly: true});
    h.detail.manim_review = {status: 'failed', retryable: true, failure_code: 'render_unavailable'};
    h.api.renderNodeDetail('n1');
    assert.match(h.scope.innerHTML, /scene-supplement-btn[^>]*disabled/);
    assert.match(h.scope.innerHTML, /重试教学动画/);
  }

  {
    const h = harness();
    h.detail.study_notes = manimNotes;
    h.detail.manim_review = {status: 'passed', retryable: false, asset_id: 'a'.repeat(32)};
    h.api.renderNodeDetail('n1');
    assert.doesNotMatch(h.scope.innerHTML, /data-scene-supplement=/, 'a valid Manim asset hides the retry control');
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
      assert.equal(h.status.textContent, status === 'cancelled' ? '' : '动画仍未生成，可以重试。学习正文已保留。');
    }
  }


  for (const listedStatus of ['succeeded','failed','interrupted','cancelled','running']) {
    const h=harness(), oldList=deferred(), manual=deferred();
    let reads=0;h.window.LearnJobs={list:()=>++reads===1?oldList.promise:Promise.resolve([]),get:()=>Promise.resolve({id:'old',status:'succeeded',result:{node_id:'n1',study_notes:'原有正文',needed:false}}),watch:()=>Promise.resolve({node_id:'n1',study_notes:'原有正文',needed:false})};
    const restore=h.api.restoreSceneSupplement();h.setPost(()=>manual.promise);const request=h.api.supplementScene('n1');await tick();
    oldList.resolve([{id:'old',operation:'/path/node/scene',node_id:'n1',created_ms:1,status:listedStatus,result:{node_id:'n1',study_notes:'原有正文',needed:false}}]);await restore;
    assert.match(h.status.textContent,/正在生成教学动画/,'late '+listedStatus+' list cannot replace active manual work');
    assert.match(h.scope.innerHTML,/scene-supplement-btn[^>]*disabled/);
    manual.resolve({node_id:'n1',source_notes:'原有正文',study_notes:manimNotes,sceneSupplement:marker});await request;
    assert.equal(h.detail.study_notes,manimNotes);assert.equal(h.quiz.round_id,'r1');assert.equal(h.nodeState.score,80);
  }
  {
    const h=harness(), oldGet=deferred(), manual=deferred();
    let reads=0;h.window.LearnJobs={list:async()=>++reads===1?[{id:'thin',operation:'/path/node/scene',node_id:'n1',created_ms:1,status:'succeeded'}]:[],get:()=>oldGet.promise};
    const restore=h.api.restoreSceneSupplement();await tick();h.setPost(()=>manual.promise);const request=h.api.supplementScene('n1');await tick();
    oldGet.resolve({id:'thin',status:'succeeded',result:{node_id:'n1',study_notes:'原有正文',needed:false}});await restore;
    assert.match(h.status.textContent,/正在生成教学动画/,'late thin result cannot stop new manual task');
    manual.resolve({node_id:'n1',source_notes:'原有正文',study_notes:manimNotes});await request;assert.equal(h.detail.study_notes,manimNotes);
  }

  for(const oldStatus of ['failed','interrupted','cancelled','unknown','succeeded']) {
    const h=harness(),oldGet=deferred(),manual=deferred();
    let reads=0;h.window.LearnJobs={list:async()=>++reads===1?[{id:'old-get',operation:'/path/node/scene',node_id:'n1',status:oldStatus,created_ms:1}]:[],get:()=>oldGet.promise};
    let refresh;
    if(oldStatus==='failed'||oldStatus==='interrupted')h.window.LearnUser.fetch=()=>new Promise(resolve=>{refresh=resolve;});
    const restore=h.api.restoreSceneSupplement();await tick();h.setPost(()=>manual.promise);const request=h.api.supplementScene('n1');await tick();
    if(refresh)refresh(Response.json({entries:{'u0/topic-a':JSON.stringify({nodeDetail:{n1:{study_notes:'原有正文',manim_review:{status:'failed',failure_code:'old'}}}})}}));
    oldGet.resolve({id:'old-get',status:oldStatus,result:{node_id:'n1',study_notes:'原有正文',needed:false}});await restore;
    assert.match(h.status.textContent,/正在生成教学动画/,'late '+oldStatus+' GET/refresh cannot replace manual work');
    assert.notEqual((h.detail.manim_review||{}).failure_code,'old');manual.resolve({node_id:'n1',source_notes:'原有正文',study_notes:manimNotes});await request;assert.equal(h.detail.study_notes,manimNotes);
  }
  {
    const h=harness(),manual=deferred(),refresh=deferred();h.window.LearnUser.fetch=()=>refresh.promise;h.setPost(()=>manual.promise);
    const request=h.api.supplementScene('n1');await tick();manual.reject(Error('old failure'));await tick();h.detail.study_notes='new source';
    refresh.resolve(Response.json({entries:{'u0/topic-a':JSON.stringify({nodeDetail:{n1:{study_notes:'原有正文',manim_review:{status:'failed',failure_code:'old'}}}})}}));await request;
    assert.equal(h.detail.study_notes,'new source');assert.equal(h.detail.manim_review,undefined);assert.deepEqual(h.calls.errors,[],'old POST failure/refresh cannot report against a newer source');
  }
  {
    const h=harness();h.detail.manim_review={status:'not_needed'};h.api.renderNodeDetail('n1');assert.doesNotMatch(h.scope.innerHTML,/scene-supplement-btn[^>]*disabled/);assert.match(h.status.textContent,/仍可手动/);
    h.setPost(async()=>({node_id:'n1',study_notes:'原有正文',needed:false}));await h.api.supplementScene('n1');await h.api.supplementScene('n1');assert.equal(h.calls.post.length,2,'a completed no-animation response permits another explicit request');
    assert.equal(h.quiz.round_id,'r1');assert.equal(h.nodeState.score,80);
  }

  for(const status of ['failed','interrupted','running','queued']) {
    const h=harness(),gate=deferred(),original={id:'old-automatic',key:'u0/topic-a',operation:'/path/node/scene',node_id:'n1',status,created_ms:1,automatic:true};let retries=0,watches=0;
    h.window.LearnJobs={list:async()=>[original],get:async()=>original,retry:async id=>{assert.equal(id,original.id);retries++;return gate.promise;},watch:async job=>{assert.equal(job.id,original.id);watches++;return gate.promise;}};
    const work=h.api.supplementScene('n1');await tick();assert.equal(h.calls.post.length,0,status+' automatic task must keep its identity');assert.equal(retries,['failed','interrupted'].includes(status)?1:0);assert.equal(watches,['running','queued'].includes(status)?1:0);assert.match(h.status.textContent,/原动画任务/);
    assert.equal(h.api.supplementScene('n1'),work,'repeated clicks share original task work');gate.resolve({node_id:'n1',study_notes:'原有正文',needed:false});await work;
    original.status='succeeded';original.result={node_id:'n1',study_notes:'原有正文',needed:false};h.setPost(async()=>({node_id:'n1',source_notes:'原有正文',study_notes:manimNotes}));await h.api.supplementScene('n1');assert.equal(h.calls.post.length,1);assert.equal(h.calls.post[0][1].automatic,undefined,'only the next explicit action starts requested semantics');assert.equal(original.automatic,true,'retry never rewrites the original automatic intent');
  }
  for(const queryFailure of ['list','get','unknown','thin']) {
    const h=harness(),job={id:'unconfirmed',key:'u0/topic-a',node_id:'n1',operation:'/path/node/scene',status:queryFailure==='unknown'?'mystery':'succeeded',created_ms:1};
    h.window.LearnJobs={list:async()=>{if(queryFailure==='list')throw Error('offline');return [job];},get:async()=>{if(queryFailure==='get')throw Error('offline');return job;}};
    await h.api.supplementScene('n1');assert.equal(h.calls.post.length,0,queryFailure+' does not guess that no prior task exists');assert.match(h.status.textContent,/无法确认原动画任务/);assert.match(h.scope.innerHTML,/重新查询动画任务/);assert.equal(h.detail.study_notes,'原有正文');assert.equal(h.calls.save,0);
    h.window.LearnJobs.list=async()=>[];h.setPost(async()=>({node_id:'n1',study_notes:'原有正文',needed:false}));await h.api.supplementScene('n1');assert.equal(h.calls.post.length,1,'a successful retry query allows the explicit action');
  }
  {
    const h=harness(),oldList=deferred(),gate=deferred(),active={id:'active-before-click',key:'u0/topic-a',node_id:'n1',operation:'/path/node/scene',status:'running',created_ms:2};let lists=0,watches=0;
    h.window.LearnJobs={list:()=>++lists===1?oldList.promise:Promise.resolve([active]),get:async()=>active,watch:async job=>{watches++;assert.equal(job.id,active.id);return gate.promise;}};
    const restore=h.api.restoreSceneSupplement(),manual=h.api.supplementScene('n1');await tick();assert.equal(h.calls.post.length,0);assert.equal(watches,1,'click before old list resolves reads back and watches the original active job');oldList.resolve([active]);await restore;assert.equal(watches,1,'late restore list cannot start a second watcher');gate.resolve({node_id:'n1',study_notes:'原有正文',needed:false});await manual;
  }

  {
    const h=harness(),old=deferred(),fresh=deferred();let posts=0;
    h.setPost(()=>++posts===1?old.promise:fresh.promise);const previous=h.api.supplementScene('n1');await tick();
    h.detail.study_notes='new source';const current=h.api.supplementScene('n1');await tick();assert.equal(posts,2,'changed source can own a separate current work after a fresh empty task lookup');
    old.resolve({node_id:'n1',study_notes:'原有正文',needed:false});await previous;assert.match(h.status.textContent,/正在生成教学动画/,'old POST result cannot replace current work');
    const updated='new source\n\n```learn-manim\n{"version":1,"asset_id":"'+'b'.repeat(32)+'","title":"变换","summary":"观察"}\n```';
    fresh.resolve({node_id:'n1',source_notes:'new source',study_notes:updated});await current;assert.equal(h.detail.study_notes,updated);assert.equal(h.quiz.round_id,'r1');assert.equal(h.nodeState.score,80);
  }

  for(const needed of [undefined,true]) {
    const h=harness();const legacy=sceneNotes.replace('"matrix":[[1,0],[0,1]]','"matrix":[[1,0],[0,1]],"vector":[1,1]');h.detail.study_notes=legacy;
    const old={id:'legacy-success',key:'u0/topic-a',node_id:'n1',operation:'/path/node/scene',created_ms:1,status:'succeeded',result:{node_id:'n1',study_notes:legacy,...(needed===undefined?{}:{needed})}};
    h.window.LearnJobs={list:async()=>[old],get:async()=>old};const gate=deferred();h.setPost(()=>gate.promise);
    const work=h.api.supplementScene('n1');assert.equal(h.api.supplementScene('n1'),work);await tick();assert.equal(h.calls.post.length,1,'a confirmed legacy successful result is a different explicit Manim upgrade intent');assert.equal(h.calls.post[0][1].intent,'upgrade-legacy-scene-to-manim-v1');assert.equal(h.calls.post[0][1].automatic,undefined);
    gate.resolve({node_id:'n1',source_notes:legacy,study_notes:manimNotes});await work;assert.equal(h.detail.study_notes,manimNotes);assert.equal(h.quiz.round_id,'r1');assert.equal(h.nodeState.score,80);
    await h.api.restoreSceneSupplement();assert.equal(h.detail.study_notes,manimNotes,'the old legacy result cannot undo the upgraded material');
  }

  for(const invalid of ['invalid-json','invalid-spec','unclosed','nested-example','mismatch','manim','wrong-identity']) {
    const h=harness(),valid=sceneNotes.replace('"matrix":[[1,0],[0,1]]','"matrix":[[1,0],[0,1]],"vector":[1,1]');let notes=valid;
    if(invalid==='invalid-json')notes='```learn-scene\nnot json\n```';if(invalid==='invalid-spec')notes='```learn-scene\n{"version":1,"type":"unsupported"}\n```';if(invalid==='unclosed')notes=valid.slice(0,-3);if(invalid==='nested-example')notes='````text\n'+valid+'\n````';if(invalid==='manim')notes=manimNotes;
    h.detail.study_notes=notes;const old={id:'legacy-invalid',key:'u0/topic-a',node_id:'n1',operation:'/path/node/scene',status:'succeeded',created_ms:1,result:{node_id:'n1',study_notes:invalid==='mismatch'?'other source':notes,needed:true}};
    h.window.LearnJobs={list:async()=>[old],get:async()=>({...old,...(invalid==='wrong-identity'?{node_id:'other'}:{})})};await h.api.supplementScene('n1');assert.equal(h.calls.post.length,0,invalid+' cannot authorize a separate upgrade intent');
  }
  {
    const h=harness(),valid=sceneNotes.replace('"matrix":[[1,0],[0,1]]','"matrix":[[1,0],[0,1]],"vector":[1,1]');h.detail.study_notes=valid;let retries=0;
    const original={id:'upgrade-failed',key:'u0/topic-a',node_id:'n1',operation:'/path/node/scene',status:'failed',created_ms:2,intent:'upgrade-legacy-scene-to-manim-v1'};
    h.window.LearnJobs={list:async()=>[original],get:async()=>original,retry:async id=>{retries++;assert.equal(id,original.id);return {node_id:'n1',source_notes:valid,study_notes:manimNotes};}};await h.api.supplementScene('n1');assert.equal(retries,1);assert.equal(h.calls.post.length,0,'failed upgrade retries its original identity');assert.equal(h.detail.study_notes,manimNotes);
  }
  console.log('Frontend scene supplement: source matching, duplicate results, stale-topic guard, read-only, and job recovery passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
