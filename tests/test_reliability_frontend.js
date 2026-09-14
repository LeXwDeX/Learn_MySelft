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
  const recovered = environment({'learn-unsaved-v1/u0': JSON.stringify({'u0/test': 'recover me'})});
  load(recovered, 'shared/saves.js'); await Promise.resolve();
  recovered.LearnUser.fetch = (url, options) => recovered.LearnSaves.send(options, async () => Response.json({ok: true}));
  assert.equal((await recovered.LearnUser.fetch('', {body: JSON.stringify({entries: {'u0/test': 'stale'}})})).status, 409);
  assert.equal(JSON.parse(recovered.storage.get('learn-unsaved-v1/u0'))['u0/test'], 'recover me');
  await recovered.LearnSaves.retry(); assert(recovered.reloaded); assert(!recovered.LearnSaves.pending());
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
