'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const events = [];
let finishSave;
const src = fs.readFileSync(path.join(root, 'learning-path/path_app.js'), 'utf8');
const context = {
  location: {protocol: 'http:', hostname: 'localhost'},
  document: {readyState: 'loading', addEventListener() {}},
  window: {addEventListener() {}},
  console, setTimeout, clearTimeout, Blob,
  navigator: {sendBeacon() { throw new Error('Deleted data must not reach pagehide beacon'); }},
  fetch(url, options) {
    const body = JSON.parse(options.body);
    events.push({url, body, keepalive: options.keepalive});
    if (url.endsWith('/state/put')) return new Promise(resolve => { finishSave = () => resolve({ok: true}); });
    return Promise.resolve({json: () => Promise.resolve({ok: true})});
  }
};
context.window.LearnUser = {userId: 'u0', apiBase: 'http://localhost:8101', readOnly: false, fetch: context.fetch};
vm.createContext(context);require('./load_uikit.cjs')(context);
vm.runInContext(src, context);
(async () => {
  const get = context.window.LearnPathApp.get;
  const api = {...get('path.domain'), ...get('path.persistence'), ...get('path.library'), state: get('path.model').state};
  const key = 'u0/learn-path-v1-test';
  api.state.topic = 'test';
  api.state.plan = {nodes: [{id: 'n1', deps: []}, {id: 'n2', deps: []}, {id: 'n3', deps: ['n2']}]};
  api.state.nodeState = {n1: {score: 30, completed: false}};
  assert.equal(api.isUnlocked('n2'), true);
  assert.equal(api.isUnlocked('n3'), false);
  api.state.nodeState.n2 = {completed: true};
  assert.equal(api.isUnlocked('n3'), true);
  api.state.plan.nodes.push({id: 'n4', deps: ['n1'], refine: true}, {id: 'n5', deps: ['n4'], refine: true});
  assert.equal(api.isUnlocked('n4'), true, 'legacy remediation must remain accessible');
  assert.equal(api.isUnlocked('n5'), false, 'legacy chained remediation must still require completion');
  api.save();
  const writing = api.putState({[key]: '{"topic":"test"}'});
  const deleting = api.deleteState([key, 'u0/learn-path-v1-last'], 'test-password');
  await Promise.resolve();
  assert.equal(events.length, 1, 'delete must wait for the outstanding save');
  assert.equal(events[0].keepalive, true, 'small saves must survive navigation');
  finishSave();
  await writing;
  await deleting;
  assert.equal(events[1].url.endsWith('/state/delete'), true);
  api.save();
  api.flushBeacon();
  await api.putState({[key]: 'late callback'});
  assert.equal(events.length, 2, 'late saves must not resurrect a deleted material');
  let conflictRequests = 0;
  context.window.LearnUser.fetch = async () => {
    conflictRequests++;
    return {ok:false,status:409,json:async () => ({error:'资料已更新，请刷新后重试'})};
  };
  await assert.rejects(api.putState({'u0/learn-path-v1-other':'draft'}), error => error.status === 409 && error.message.includes('资料已更新'));
  assert.equal(conflictRequests, 1, 'a state conflict must not be blindly retried');
  let jobRequests = 0;
  context.window.LearnJobs = {supports:() => true, run:async () => { jobRequests++; return {ok:true}; }};
  context.window.LearnSaves = {assertReady() { const error = new Error('请先重试保存'); error.code = 'state_recovery_required'; throw error; }};
  await assert.rejects(api.post('/path/node', {key}), error => error.code === 'state_recovery_required');
  assert.equal(jobRequests, 0, 'a recovery lock must block generation before model work');
  context.window.LearnSaves.assertReady = () => {};
  assert.equal((await api.post('/path/node', {key})).ok, true);
  assert.equal(jobRequests, 1, 'generation resumes after explicit recovery');
  console.log('Frontend: remedial gate, chained gate, ordered deletion, late-save suppression passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
