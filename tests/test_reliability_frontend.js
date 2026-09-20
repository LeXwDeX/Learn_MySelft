'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
function environment(saved) {
  const storage = new Map(Object.entries(saved || {}));
  const notices = new Map();
  const env = {console, Response, AbortController, Uint8Array, crypto: require('crypto').webcrypto,
    setTimeout: (callback, delay) => setTimeout(callback, delay === 1500 || delay === 3500 ? 1 : delay), clearTimeout,
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    location: {reload() { env.reloaded = true; }}, addEventListener() {},
    LearnUI: {set: (key, ...args) => notices.set(key, args), clear: key => notices.delete(key)},
    LearnUser: {userId: 'u0', user: {id: 'u0'}, ready: Promise.resolve(), apiBase: 'http://localhost:8101'}, notices, storage};
  env.window = env; vm.createContext(env); return env;
}
const load = (env, file) => vm.runInContext(fs.readFileSync(file, 'utf8'), env);
(async () => {
  const env = environment(); load(env, 'shared/saves.js'); await Promise.resolve();
  let calls = [], fail = true;
  env.LearnUser.fetch = (url, options) => env.LearnSaves.send(options, async () => {
    calls.push(JSON.parse(options.body).entries);
    if (fail) throw new Error('offline');
    return Response.json({ok: true});
  });
  const save = entries => env.LearnUser.fetch('', {body: JSON.stringify({entries})});
  await assert.rejects(save({'u0/test': 'original'}));
  assert(env.LearnSaves.pending()); assert(env.notices.has('state-save'));
  fail = false; await env.LearnSaves.retry(); assert(!env.LearnSaves.pending());
  await Promise.all([save({'u0/test': 'first'}), save({'u0/test': 'second'})]);
  assert.deepEqual(calls.slice(-2), [{'u0/test': 'first'}, {'u0/test': 'second'}]);
  let dispatched = false;
  const closingSave = env.LearnSaves.send({body: JSON.stringify({entries: {'u0/pagehide': 'last edit'}}), keepalive: true}, () => {dispatched = true; return Promise.resolve(Response.json({ok: true}));});
  assert(dispatched, 'An idle keepalive save must start before pagehide returns');
  await closingSave;
  const recovered = environment({'learn-unsaved-v1/u0': JSON.stringify({'u0/test': 'recover me'})});
  load(recovered, 'shared/saves.js'); await recovered.LearnUser.ready;
  recovered.LearnUser.fetch = (url, options) => recovered.LearnSaves.send(options, async () => Response.json({ok: true}));
  assert.equal((await recovered.LearnUser.fetch('', {body: JSON.stringify({entries: {'u0/test': 'stale'}})})).status, 409);
  assert.equal(JSON.parse(recovered.storage.get('learn-unsaved-v1/u0'))['u0/test'], 'recover me');
  await recovered.LearnSaves.retry(); assert(recovered.reloaded); assert(!recovered.LearnSaves.pending());
  const acknowledged = environment({'learn-unsaved-v1/u0': JSON.stringify({'u0/test': '{"a":1,"b":2}'})});
  acknowledged.LearnUser.fetch = async () => Response.json({entries: {'u0/test': '{"b": 2, "a": 1}'}});
  load(acknowledged, 'shared/saves.js'); await acknowledged.LearnUser.ready;
  assert(!acknowledged.LearnSaves.pending()); assert(!acknowledged.notices.has('state-save'));
  const materialKey = 'u0/learn-path-v1-upload';
  const base = {topic:'saved reference', stage:'learning', materials:[{name:'notes.txt',text:'original'}]};
  async function recoveryCheck(key, local, remote) {
    const check = environment({'learn-unsaved-v1/u0': JSON.stringify({[key]:JSON.stringify(local)})});
    check.LearnUser.fetch = async () => Response.json({entries:{[key]:JSON.stringify(remote)}});
    load(check, 'shared/saves.js'); await check.LearnUser.ready; return check;
  }
  const extra = [{name:'quiz.txt',text:'server-owned supplement'}];
  assert(!(await recoveryCheck(materialKey, base, {...base,quizMaterials:extra})).LearnSaves.pending(), 'independent quiz draft must not masquerade as an unacknowledged save');
  assert(!(await recoveryCheck(materialKey, {topic:'legacy'}, {topic:'legacy',materials:[],quizMaterials:extra})).LearnSaves.pending(), 'absent legacy materials equal the default empty list');
  assert((await recoveryCheck(materialKey, {...base,materials:[{name:'notes.txt',text:'unsaved edit'}]}, {...base,quizMaterials:extra})).LearnSaves.pending(), 'real reference edits remain recoverable');
  assert((await recoveryCheck(materialKey, {...base,topic:'unsaved title'}, {...base,quizMaterials:extra})).LearnSaves.pending(), 'other user fields remain strict');
  assert((await recoveryCheck('u0/quiz-map-v1-example', base, {...base,quizMaterials:extra})).LearnSaves.pending(), 'other document kinds remain strict');
  const jobs = environment(); let submits = 0, polls = 0, requestId;
  jobs.LearnUser.fetch = async (url, options) => {
    if (options.method === 'POST') { submits++; requestId = JSON.parse(options.body).request_id; return Response.json({job: {id: 'j1', status: 'running', created_ms: Date.now(), operation: '/path/intake'}}); }
    polls++;
    if (polls === 1) throw new Error('network disconnected');
    return Response.json({job: {id: 'j1', status: 'succeeded', result: {spec: {topic: 'test'}}}});
  };
  load(jobs, 'shared/jobs.js');
  const first = jobs.LearnJobs.run('/path/intake', {key: 'u0/test', history: []});
  assert.strictEqual(first, jobs.LearnJobs.run('/path/intake', {history: [], key: 'u0/test'}));
  assert.equal((await first).spec.topic, 'test'); assert.equal(submits, 1); assert.equal(polls, 2);
  const oldId = requestId; await jobs.LearnJobs.run('/path/intake', {key: 'u0/test', history: []});
  assert.equal(requestId, oldId);
  jobs.LearnUser.readOnly = true; await assert.rejects(jobs.LearnJobs.run('/path/node', {}));
  console.log('PASS ordered saves, offline retry, protected recovery, task deduplication and reconnect');
})().catch(error => { console.error(error); process.exitCode = 1; });
