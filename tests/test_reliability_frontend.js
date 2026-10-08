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
  const nodeJobs = environment();
  const nodeRequests = [];
  const nodeMessages = [];
  const nodeSet = nodeJobs.LearnUI.set;
  nodeJobs.LearnUI.set = (key, ...args) => { nodeMessages.push(args[0]); nodeSet(key, ...args); };
  let nodePoll = 0;
  const started = Date.now() - 46000;
  nodeJobs.LearnUser.fetch = async (url, options) => {
    nodeRequests.push({url, method:options.method, body:options.body && JSON.parse(options.body)});
    if (options.method === 'POST') return Response.json({job:{id:'node-job', operation:'/path/node', status:'queued',
      created_ms:1, attempt:2, attempt_started_ms:started, retry_at_ms:Date.now() + 30000, max_attempts:2,
      auto_retry:true, progress:{step:3,total:5,label:'正文渲染'}}});
    nodePoll++;
    return Response.json({job:{id:'node-job', operation:'/path/node', status:nodePoll === 1 ? 'running' : 'succeeded',
      attempt:2, attempt_started_ms:started, max_attempts:2, auto_retry:true,
      progress:{step:4,total:5,label:'动画'}, result:{node_detail:'ready'}}});
  };
  load(nodeJobs, 'shared/jobs.js');
  const nodeResult = await nodeJobs.LearnJobs.run('/path/node', {key:'u0/node', node:{id:'n1'}});
  assert.equal(nodeResult.node_detail, 'ready');
  assert.equal(nodeRequests.filter(item => item.method === 'POST').length, 1, 'a queued automatic retry is observed without another job submission');
  assert(nodeRequests.slice(1).every(item => item.method === 'GET' && item.url.endsWith('/jobs/node-job')), 'watch polls the stable job id only');
  assert(nodeMessages.some(message => message.includes('46 秒')), 'elapsed time uses the current attempt start, not the old receipt creation time');
  const failedNode = environment(); let retryPosts = 0, jobPosts = 0;
  failedNode.LearnUser.fetch = async (url, options) => {
    if (options.method === 'POST' && url.endsWith('/retry')) retryPosts++;
    if (options.method === 'POST') {
      jobPosts++;
      return Response.json({job:{id:'failed-node', operation:'/path/node', status:'failed', error:'模型暂时不可用',
        error_category:'upstream_unavailable', response_status:503, attempt:2, max_attempts:2, auto_retry:true}});
    }
    return Response.json({job:{id:'failed-node', operation:'/path/node', status:'failed', error:'模型暂时不可用',
      error_category:'upstream_unavailable', response_status:503, attempt:2, max_attempts:2, auto_retry:true}});
  };
  load(failedNode, 'shared/jobs.js');
  await assert.rejects(failedNode.LearnJobs.run('/path/node', {key:'u0/failed', node:{id:'n2'}}), error =>
    error.status === 'failed' && error.response_status === 503 && error.error_category === 'upstream_unavailable' && error.jobId === 'failed-node');
  const failedReload = environment(Object.fromEntries(failedNode.storage));
  failedReload.LearnUser.fetch = failedNode.LearnUser.fetch;
  load(failedReload, 'shared/jobs.js');
  await assert.rejects(failedReload.LearnJobs.run('/path/node', {key:'u0/failed', node:{id:'n2'}}));
  assert.equal(retryPosts, 0, 'reloading a failed node does not spend the server retry budget again');
  assert.equal(jobPosts, 1, 'recovery reads the original receipt without a new submission');
  const failedNodeFetch=failedReload.LearnUser.fetch;let explicitNodeRetries=0;
  failedReload.LearnUser.fetch=async(url,options)=>{
    if(url.endsWith('/retry')) {explicitNodeRetries++;return Response.json({job:{id:'failed-node',operation:'/path/node',status:'succeeded',result:{repaired:true}}});}
    return failedNodeFetch(url,options);
  };
  assert.equal((await failedReload.LearnJobs.run('/path/node',{key:'u0/failed',node:{id:'n2'}},{manualRetry:true})).repaired,true);
  assert.equal(explicitNodeRetries,1);assert.equal(jobPosts,1,'manual retry resumes the same job without new submission');
  const sceneJobs = environment(); let scenePosts = 0, sceneRetries = 0;
  const sceneBody = {key:'u0/scene',node:{id:'n2'},automatic:true};
  sceneJobs.LearnUser.fetch = async (url, options) => {
    if (url.endsWith('/retry')) { sceneRetries++; return Response.json({job:{id:'scene-failed',operation:'/path/node/scene',status:'succeeded',result:{needed:false}}}); }
    if (options.method === 'POST') scenePosts++;
    return Response.json({job:{id:'scene-failed',operation:'/path/node/scene',status:'failed',error:'动画不可用'}});
  };
  load(sceneJobs,'shared/jobs.js');
  await assert.rejects(sceneJobs.LearnJobs.run('/path/node/scene',sceneBody));
  await assert.rejects(sceneJobs.LearnJobs.run('/path/node/scene',sceneBody,{resumeOnly:true,manualRetry:true}));
  assert.equal(scenePosts,1); assert.equal(sceneRetries,0,'restoring animation never retries even when an option requests retry');
  assert.equal((await sceneJobs.LearnJobs.run('/path/node/scene',sceneBody,{manualRetry:true})).needed,false);
  assert.equal(sceneRetries,1,'explicit animation retry consumes exactly one original attempt');
  const readOnlyJobs = environment(); readOnlyJobs.LearnUser.readOnly = true;
  let readOnlyWrites = 0;
  readOnlyJobs.LearnUser.fetch = async (url, options) => { if (options.method === 'POST') readOnlyWrites++; return Response.json({job:{id:'readonly-job', operation:'/path/node', status:'failed', error:'failed'}}); };
  load(readOnlyJobs, 'shared/jobs.js');
  await assert.rejects(readOnlyJobs.LearnJobs.watch({id:'readonly-job', operation:'/path/node', status:'failed'}));
  assert.equal(readOnlyJobs.notices.get('job-readonly-job')[2], null, 'read-only watch does not expose a retry write action');
  assert.equal(readOnlyWrites, 0, 'watch never writes for a read-only viewer');
  const examsFail = environment(); let examRetry = 0;
  examsFail.LearnUser.fetch = async (url, options) => {
    if (url.endsWith('/retry')) { examRetry++; return Response.json({job:{id:'exam-failed', operation:'/path/requiz', status:'succeeded', result:{round:2}}}); }
    if (options.method === 'POST') return Response.json({job:{id:'exam-failed', operation:'/path/requiz', status:'failed', error:'题目校验失败'}});
    return Response.json({job:{id:'exam-failed', operation:'/path/requiz', status:'failed', error:'题目校验失败'}});
  };
  load(examsFail, 'shared/jobs.js');
  assert.equal((await examsFail.LearnJobs.run('/path/requiz', {key:'u0/quiz'}, {newOperation:true})).round, 2);
  assert.equal(examRetry, 1, 'non-node operations keep their existing automatic recovery behavior');
  const timedWatch = environment();
  let clock = 1000000000, timerCount = 0;
  timedWatch.Date = class extends Date { static now() { return clock; } };
  timedWatch.setTimeout = (callback, delay) => {
    if (delay === 1500) { timerCount++; clock += timerCount === 1 ? 3600001 : delay; return setTimeout(callback, 1); }
    return setTimeout(callback, delay);
  };
  const continuationRequests = [];
  timedWatch.LearnUser.fetch = async (url, options) => {
    continuationRequests.push({url, method: options.method});
    assert.equal(options.method, 'GET', 'continuing a timed-out watch must only read the job');
    return Response.json({job:{id:'timeout-job', operation:'/path/node', status:continuationRequests.length === 1 ? 'running' : 'succeeded', result:{restored:true}}});
  };
  load(timedWatch, 'shared/jobs.js');
  await assert.rejects(timedWatch.LearnJobs.watch({id:'timeout-job', operation:'/path/node', status:'running', created_ms:1}));
  const timeoutNotice = timedWatch.notices.get('job-timeout-job');
  assert.equal(timeoutNotice[3], '继续读取任务');
  assert.deepEqual(await timeoutNotice[2](), {restored:true});
  assert.equal(timedWatch.reloaded, true, 'successful continuation refreshes so the page can restore the saved effect');
  assert.deepEqual(continuationRequests.map(item => item.url), ['http://localhost:8101/jobs/timeout-job', 'http://localhost:8101/jobs/timeout-job']);
  assert.equal(continuationRequests.filter(item => item.method === 'POST').length, 0, 'continuation must not submit or retry a job');
  const baseId='shared-batch-node-id', boundBody={key:'u0/material',node:{id:'n1',title:'one',deps:[]},spec:{goal:'goal'},defer_visual:true};
  const scope=environment();const scopedPosts=[];
  scope.LearnUser.fetch=async(url,options)=>{const data=JSON.parse(options.body);scopedPosts.push(data);return Response.json({job:{id:'bound-'+scopedPosts.length,operation:data.operation,status:'succeeded',result:{ok:true}}});};
  load(scope,'shared/jobs.js');
  for(const [operation,body] of [['/path/node',boundBody],['/path/node',{...boundBody,node:{...boundBody.node,title:'two'}}],['/path/node',{...boundBody,spec:{goal:'other'}}],['/path/node',{...boundBody,node:{...boundBody.node,deps:['n0']}}],['/path/node/scene',boundBody]]) await scope.LearnJobs.run(operation,body,{requestId:baseId});
  assert.equal(new Set(scopedPosts.map(p=>p.request_id)).size,5);
  await scope.LearnJobs.run('/path/node',{key:boundBody.key,node:boundBody.node,spec:boundBody.spec},{requestId:baseId});
  assert.notEqual(scopedPosts.at(-1).request_id,scopedPosts[0].request_id,'defer_visual changes the content identity');
  assert(scopedPosts.every(p=>/^[A-Za-z0-9:_-]{8,120}$/.test(p.request_id)));
  const sameTab=environment();sameTab.LearnUser.fetch=scope.LearnUser.fetch;load(sameTab,'shared/jobs.js');
  await sameTab.LearnJobs.run('/path/node',{defer_visual:true,spec:{goal:'goal'},node:{deps:[],title:'one',id:'n1'},key:'u0/material'},{requestId:baseId});
  assert.equal(scopedPosts.at(-1).request_id,scopedPosts[0].request_id);
  const seed=environment();seed.LearnUser.fetch=async()=>{throw new Error('lost confirmation');};load(seed,'shared/jobs.js');
  await assert.rejects(seed.LearnJobs.run('/path/node',boundBody,{requestId:baseId}));
  const receiptKey=[...seed.storage.keys()][0];seed.storage.set(receiptKey,JSON.stringify({requestId:baseId,created:Date.now()}));
  const saved=Object.fromEntries(seed.storage), conflict=environment(saved), submitted=[];
  conflict.LearnUser.fetch=async(url,options)=>{const data=JSON.parse(options.body);submitted.push(data.request_id);
    if(submitted.length===1)return Response.json({error:'content conflict',error_category:'request_id_conflict'},{status:409});
    assert.equal(JSON.parse(conflict.storage.get(receiptKey)).requestId,data.request_id);throw new Error('ack lost');};
  load(conflict,'shared/jobs.js');await assert.rejects(conflict.LearnJobs.run('/path/node',boundBody,{requestId:baseId}));
  assert.equal(submitted[0],baseId);assert.equal(submitted[1],scopedPosts[0].request_id);
  const reload=environment(Object.fromEntries(conflict.storage));const restored=[];
  reload.LearnUser.fetch=async(url,options)=>{restored.push({url,method:options.method,body:options.body&&JSON.parse(options.body)});return Response.json({job:{id:'accepted-before-ack',operation:'/path/node',status:'succeeded',result:{ok:true}}});};load(reload,'shared/jobs.js');
  await reload.LearnJobs.run('/path/node',boundBody,{requestId:baseId});assert.equal(restored[0].body.request_id,submitted[1]);
  await reload.LearnJobs.run('/path/node',boundBody,{requestId:baseId,resumeOnly:true});assert.equal(restored[1].method,'GET');
  for(const [status,category] of [[409,null],[409,'other_conflict'],[403,'request_id_conflict'],[500,'request_id_conflict']]) {
    const h=environment(saved);let posts=0;h.LearnUser.fetch=async()=>{posts++;return Response.json({error:'rejected',error_category:category},{status});};load(h,'shared/jobs.js');
    await assert.rejects(h.LearnJobs.run('/path/node',boundBody,{requestId:baseId}));assert.equal(posts,1);
  }
  const acceptedOld=environment(saved);let oldPosts=0;
  acceptedOld.LearnUser.fetch=async(url,options)=>{oldPosts++;assert.equal(JSON.parse(options.body).request_id,baseId);return Response.json({job:{id:'old-accepted',operation:'/path/node',status:'succeeded',result:{ok:true}}});};load(acceptedOld,'shared/jobs.js');
  await acceptedOld.LearnJobs.run('/path/node',boundBody,{requestId:baseId});assert.equal(oldPosts,1);
  const noResume=environment(saved);let noResumePosts=0;noResume.LearnUser.fetch=async()=>{noResumePosts++;};load(noResume,'shared/jobs.js');
  await assert.rejects(noResume.LearnJobs.run('/path/node',boundBody,{requestId:baseId,resumeOnly:true}));assert.equal(noResumePosts,0);
  const twice=environment(saved);let conflictPosts=0;
  twice.LearnUser.fetch=async()=>{conflictPosts++;return Response.json({error:'conflict',error_category:'request_id_conflict'},{status:409});};load(twice,'shared/jobs.js');
  await assert.rejects(twice.LearnJobs.run('/path/node',boundBody,{requestId:baseId}));assert.equal(conflictPosts,2,'at most one rebind');
  const twiceReload=environment(Object.fromEntries(twice.storage));let reloadConflicts=0;
  twiceReload.LearnUser.fetch=async()=>{reloadConflicts++;return Response.json({error:'conflict',error_category:'request_id_conflict'},{status:409});};load(twiceReload,'shared/jobs.js');
  await assert.rejects(twiceReload.LearnJobs.run('/path/node',boundBody,{requestId:baseId}));assert.equal(reloadConflicts,1,'stable replacement cannot rotate again after reload');
  const diskFailure=environment(saved);let diskPosts=0;
  diskFailure.localStorage.setItem=()=>{throw new Error('storage full');};
  diskFailure.LearnUser.fetch=async()=>{diskPosts++;return Response.json({error:'conflict',error_category:'request_id_conflict'},{status:409});};load(diskFailure,'shared/jobs.js');
  await assert.rejects(diskFailure.LearnJobs.run('/path/node',boundBody,{requestId:baseId}));assert.equal(diskPosts,1,'no replacement POST without durable local identity');
  const oldScene=environment();oldScene.LearnUser.fetch=async()=>{throw new Error('offline');};load(oldScene,'shared/jobs.js');
  await assert.rejects(oldScene.LearnJobs.run('/path/node/scene',boundBody,{requestId:baseId}));
  const sceneReceiptKey=[...oldScene.storage.keys()][0];oldScene.storage.set(sceneReceiptKey,JSON.stringify({requestId:baseId,created:Date.now()}));
  const sceneConflict=environment(Object.fromEntries(oldScene.storage));const sceneIds=[];
  sceneConflict.LearnUser.fetch=async(url,options)=>{const data=JSON.parse(options.body);sceneIds.push(data.request_id);
    return sceneIds.length===1?Response.json({error:'conflict',error_category:'request_id_conflict'},{status:409}):Response.json({job:{id:'bound-scene',operation:'/path/node/scene',status:'succeeded',result:{ok:true}}});};load(sceneConflict,'shared/jobs.js');
  await sceneConflict.LearnJobs.run('/path/node/scene',boundBody,{requestId:baseId});assert.equal(sceneIds.length,2);assert.notEqual(sceneIds[1],submitted[1],'operation is part of rebound identity');
  const otherOperation=environment();let otherPosts=0;otherOperation.LearnUser.fetch=async()=>{otherPosts++;return Response.json({error:'conflict',error_category:'request_id_conflict'},{status:409});};load(otherOperation,'shared/jobs.js');
  await assert.rejects(otherOperation.LearnJobs.run('/path/plan',boundBody,{requestId:baseId}));assert.equal(otherPosts,1,'no rebind outside two learning operations');
  console.log('PASS ordered saves, offline retry, protected recovery, task deduplication and reconnect');
})().catch(error => { console.error(error); process.exitCode = 1; });
