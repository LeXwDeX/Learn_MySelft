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
    LearnUser: {attachPersistence(port){this.persistence=port}, userId: 'u0', user: {id: 'u0'}, ready: Promise.resolve(), apiBase: 'http://localhost:8101'}, notices, storage};
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
  const lesson = {...base,nodeDetail:{n1:{study_notes:'original notes',extra:'keep'}}};
  const supplemented = {...base,nodeDetail:{n1:{study_notes:'original notes and diagram',extra:'keep',
    sceneSupplement:{version:1,source_sha256:'a'.repeat(64),notes_sha256:'b'.repeat(64)}}}};
  assert(!(await recoveryCheck(materialKey, lesson, supplemented)).LearnSaves.pending(), 'server-protected notes reconcile an abandoned browser acknowledgement');
  assert((await recoveryCheck(materialKey, {...lesson,materials:[{name:'notes.txt',text:'real edit'}]}, supplemented)).LearnSaves.pending(), 'protected notes do not hide reference edits');
  assert((await recoveryCheck(materialKey, {...lesson,nodeDetail:{n1:{...lesson.nodeDetail.n1,extra:'real edit'}}}, supplemented)).LearnSaves.pending(), 'other node fields remain strict');
  assert((await recoveryCheck(materialKey, lesson, {...base,nodeDetail:{n1:{study_notes:'different notes',extra:'keep'}}})).LearnSaves.pending(), 'unprotected notes remain recoverable');
  assert((await recoveryCheck(materialKey, lesson, {...base,nodeDetail:{n1:{...supplemented.nodeDetail.n1,sceneSupplement:{version:1}}}})).LearnSaves.pending(), 'invalid provenance must not suppress recovery');
  assert((await recoveryCheck('u0/quiz-map-v1-example', lesson, supplemented)).LearnSaves.pending(), 'scene reconciliation applies only to learning materials');
  // The server commits before navigation, but the old page never handles its
  // acknowledgement. Reload must compare browser fields, not server receipts.
  async function committedBeforeAcknowledgement(local, receipts, serverChange = value => value) {
    const original = environment(); load(original, 'shared/saves.js'); await original.LearnUser.ready;
    let serverValue, acknowledge;
    original.LearnUser.fetch = (url, options) => original.LearnSaves.send(options, () => {
      serverValue = serverChange({...JSON.parse(JSON.parse(options.body).entries[materialKey]), refinementReceipts:receipts});
      return new Promise(resolve => { acknowledge = () => resolve(Response.json({ok:true})); });
    });
    const saving = original.LearnUser.fetch('', {body:JSON.stringify({entries:{[materialKey]:JSON.stringify(local)}})});
    assert(original.LearnSaves.pending(), 'unhandled acknowledgement keeps an emergency snapshot');
    const reloaded = environment(Object.fromEntries(original.storage));
    reloaded.LearnUser.fetch = async () => Response.json({entries:{[materialKey]:JSON.stringify(serverValue)}});
    load(reloaded, 'shared/saves.js'); await reloaded.LearnUser.ready;
    // Finish the abandoned VM request only to release its timeout, after reload
    // has already consumed its independent copy of the pending local snapshot.
    acknowledge(); await saving;
    assert(!reloaded.LearnSaves.pending(), 'committed browser fields reconcile despite missing or changed internal receipts');
    assert(!reloaded.notices.has('state-save'), 'acknowledged content must not show a recovery prompt');
    assert.equal(reloaded.storage.get('learn-unsaved-v1/u0'), undefined);
    let dispatched = 0;
    reloaded.LearnUser.fetch = (url, options) => reloaded.LearnSaves.send(options, async () => { dispatched++; return Response.json({ok:true}); });
    const next = await reloaded.LearnUser.fetch('', {body:JSON.stringify({entries:{[materialKey]:JSON.stringify({...local,topic:'next edit'})}})});
    assert.equal(next.status, 200, 'reconciled snapshot must permit the next normal edit');
    assert.equal(dispatched, 1, 'the next edit must reach the server');
  }
  await committedBeforeAcknowledgement(base, {});
  await committedBeforeAcknowledgement({...base,refinementReceipts:{}}, {serverReceipt:{added:1}});
  await committedBeforeAcknowledgement({...base,refinementReceipts:{old:{added:1}}}, {newer:{added:2}});
  const generated = {...base,plan:{nodes:[{id:'n1'}]},nodeDetail:{n1:{study_notes:'editable notes'}},nodeState:{n1:{mark:'mastered',score:50}}};
  const serverGenerated = {...generated,plan:{nodes:[{id:'n1'},{id:'n1.1'}]},
    nodeDetail:{...generated.nodeDetail,'n1.1':{study_notes:'new remedial notes'}},
    nodeState:{n1:{mark:'mastered',score:80,lastResult:{pass:true},lastAnswers:['server result']},'n1.1':{mark:'unlearned'}}};
  await committedBeforeAcknowledgement(generated, {newer:{added:1}}, () => serverGenerated);
  const issued = {...generated,nodeDetail:{n1:{study_notes:'editable notes',quiz:{questions:['old']}}}};
  const issuedServer = {...serverGenerated,nodeDetail:{...serverGenerated.nodeDetail,n1:{study_notes:'editable notes',quiz:{questions:['new'],round_id:'r2',rounds:[{id:'r2'}]}}}};
  await committedBeforeAcknowledgement(issued, {}, () => issuedServer);
  assert((await recoveryCheck(materialKey, {...generated,nodeState:{n1:{mark:'review',score:50}}}, serverGenerated)).LearnSaves.pending(), 'real learner progress stays recoverable beside server grades and generated nodes');
  assert((await recoveryCheck(materialKey, {...generated,nodeDetail:{n1:{study_notes:'real unsaved notes'}}}, serverGenerated)).LearnSaves.pending(), 'ordinary editable notes stay recoverable beside generated nodes');
  assert((await recoveryCheck(materialKey, {...generated,materials:[{name:'notes.txt',text:'real reference edit'}]}, serverGenerated)).LearnSaves.pending(), 'references stay strict beside a protected generated plan');
  assert((await recoveryCheck(materialKey, {...generated,nodeDetail:{...generated.nodeDetail,localOnly:{study_notes:'real local addition'}}}, serverGenerated)).LearnSaves.pending(), 'local-only content is never discarded');
  assert((await recoveryCheck(materialKey, generated, {...generated,plan:null})).LearnSaves.pending(), 'a missing server plan is not evidence of an acknowledged browser plan');
  const changed = {...base,materials:[{name:'notes.txt',text:'real unsaved edit'}],
    nodeDetail:{n1:{study_notes:'recovered lesson notes'}},nodeState:{n1:{mark:'review'}}};
  const protectedRecovery = await recoveryCheck(materialKey, changed, {...base,refinementReceipts:{serverReceipt:{added:1}}});
  assert(protectedRecovery.LearnSaves.pending(), 'real editable differences must survive receipt reconciliation');
  assert.equal(JSON.parse(protectedRecovery.storage.get('learn-unsaved-v1/u0'))[materialKey], JSON.stringify(changed));
  let recoveryDispatches = 0, restoredValue = JSON.stringify(base);
  protectedRecovery.LearnUser.fetch = (url, options) => protectedRecovery.LearnSaves.send(options, async () => {
    recoveryDispatches++; restoredValue = JSON.parse(options.body).entries[materialKey];
    return Response.json({ok:true});
  });
  assert.equal((await protectedRecovery.LearnUser.fetch('', {body:JSON.stringify({entries:{[materialKey]:JSON.stringify(base)}})})).status, 409);
  assert.equal(recoveryDispatches, 0, 'real unsaved content must still block conflicting new edits');
  assert.throws(() => protectedRecovery.LearnSaves.assertReady(), error => error.code === 'state_recovery_required' && error.message.includes('重试保存'));
  await protectedRecovery.LearnSaves.retry();
  assert(protectedRecovery.reloaded, 'successful emergency recovery reloads the page');
  assert(!protectedRecovery.LearnSaves.pending(), 'the restored snapshot is acknowledged before reload');
  // Reload dispatches pagehide on the old page. Its cached whole-document save
  // must not overwrite the recovered notes and progress or recreate pending data.
  const departingSave = await protectedRecovery.LearnUser.fetch('', {
    body:JSON.stringify({entries:{[materialKey]:JSON.stringify(base)}}),keepalive:true});
  assert.equal(departingSave.status, 409, 'old-page keepalive remains blocked until replacement');
  assert.equal(recoveryDispatches, 1, 'only the explicit recovery reaches the server');
  assert.deepEqual(JSON.parse(restoredValue), changed, 'old-page exit cannot overwrite recovered notes and progress');
  assert.equal(protectedRecovery.storage.get('learn-unsaved-v1/u0'), undefined, 'blocked old-page saves must not recreate emergency data');
  assert.throws(() => protectedRecovery.LearnSaves.assertReady(), error => error.code === 'state_recovery_required');
  const replacement = environment(Object.fromEntries(protectedRecovery.storage));
  load(replacement, 'shared/saves.js'); await replacement.LearnUser.ready;
  replacement.LearnUser.fetch = (url, options) => replacement.LearnSaves.send(options, async () => {
    recoveryDispatches++; restoredValue = JSON.parse(options.body).entries[materialKey];
    return Response.json({ok:true});
  });
  assert.doesNotThrow(() => replacement.LearnSaves.assertReady(), 'the replacement page permits normal edits');
  const nextEdit = {...changed,nodeState:{n1:{mark:'learning'}}};
  assert.equal((await replacement.LearnUser.fetch('', {body:JSON.stringify({entries:{[materialKey]:JSON.stringify(nextEdit)}})})).status, 200);
  assert.equal(recoveryDispatches, 2);
  assert.deepEqual(JSON.parse(restoredValue), nextEdit, 'normal edits still save after recovery reload');
  assert((await recoveryCheck('u0/quiz-map-v1-example', base, {...base,refinementReceipts:{serverReceipt:{added:1}}})).LearnSaves.pending(), 'receipt exemption applies only to learning material documents');
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
  const exams = environment();
  let examPosts = [], savedJobs = new Map(), serial = 0;
  exams.LearnUser.fetch = async (url, options) => {
    if (options.method === 'GET') return Response.json({job: savedJobs.get(url.split('/').pop())});
    const body = JSON.parse(options.body); examPosts.push(body.request_id);
    let job = Array.from(savedJobs.values()).find(j => j.requestId === body.request_id);
    if (!job) {
      job = {id: 'exam' + (++serial), requestId: body.request_id, status:'succeeded', operation:'/path/quizmap', result:{slug:'exam' + serial}};
      savedJobs.set(job.id, job);
    }
    return Response.json({job});
  };
  load(exams, 'shared/jobs.js');
  const examBody = {key:'u0/learn-path-v1-map'};
  const one = exams.LearnJobs.run('/path/quizmap', examBody, {newOperation:true});
  assert.strictEqual(one, exams.LearnJobs.run('/path/quizmap', examBody, {newOperation:true}));
  assert.equal((await one).slug, 'exam1');
  assert.equal((await exams.LearnJobs.run('/path/quizmap', examBody, {newOperation:true})).slug, 'exam2');
  assert.notEqual(examPosts[0], examPosts[1]);
  assert.equal((await exams.LearnJobs.run('/path/quizmap', examBody)).slug, 'exam2', 'ordinary recovery still returns the saved exam');
  const resume = environment(Object.fromEntries(exams.storage));
  savedJobs.get('exam2').status = 'running';
  let lookups = 0;
  resume.LearnUser.fetch = async (url, options) => {
    if (options.method === 'GET') {
      lookups++;
      return Response.json({job:{...savedJobs.get('exam2'),status:lookups > 1 ? 'succeeded' : 'running'}});
    }
    examPosts.push(JSON.parse(options.body).request_id);
    return Response.json({job:savedJobs.get('exam2')});
  };
  load(resume, 'shared/jobs.js');
  assert.equal((await resume.LearnJobs.run('/path/quizmap', examBody, {newOperation:true})).slug, 'exam2');
  assert.equal(examPosts.at(-1), examPosts[1], 'running work survives navigation without a new receipt');
  console.log('PASS ordered saves, offline retry, protected recovery, task deduplication and reconnect');
})().catch(error => { console.error(error); process.exitCode = 1; });
