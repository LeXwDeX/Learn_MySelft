/* Deployed regression_bot browser test for old node receipts and changed bodies.
 * The page and its production JavaScript are real. Only /jobs is a controlled
 * HTTP fixture, so this test never starts model work.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {randomBytes, createHash} = require('node:crypto');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const environment = process.env.RELEASE_ENV || 'test';
assert(['test', 'production'].includes(environment), 'RELEASE_ENV must be test or production');
const browserName = process.env.BROWSER_ENGINE || 'chromium';
assert(['chromium','webkit'].includes(browserName), 'BROWSER_ENGINE must be chromium or webkit');
const phoneMode = /^(1|true|yes)$/i.test(process.env.PHONE_MODE || '');
const viewportInput = process.env.VIEWPORT || (phoneMode ? '390x844' : '1440x1000');
const viewportMatch = /^(\d{3,4})x(\d{3,4})$/.exec(viewportInput);
assert(viewportMatch, 'VIEWPORT must use WIDTHxHEIGHT, for example 390x844');
const viewport = {width:Number(viewportMatch[1]), height:Number(viewportMatch[2])};
assert(viewport.width >= 320 && viewport.height >= 568, 'viewport is too small for the regression page');
const site = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const uid = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const revision = process.env.RELEASE_REVISION;
assert.match(revision || '', /^[0-9a-f]{40}$/, 'RELEASE_REVISION must be a full commit');
const output = path.resolve(process.env.NODE_RECEIPT_OUTPUT || '');
assert(path.isAbsolute(output) && output !== path.parse(output).root,
  'NODE_RECEIPT_OUTPUT must be an absolute, non-root directory');
fs.mkdirSync(output, {recursive:true, mode:0o700});
fs.chmodSync(output, 0o700);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function fingerprint(operation, body) {
  return createHash('sha256').update(operation + '\n' + canonical(body), 'utf8').digest('hex');
}
function localFingerprint(text) {
  let a=2166136261, b=3339675911;
  for (let i=0; i<text.length; i++) {
    a=Math.imul(a ^ text.charCodeAt(i),16777619);
    b=Math.imul(b ^ text.charCodeAt(i),2246822519);
  }
  return (a>>>0).toString(16)+'-'+(b>>>0).toString(16)+'-'+text.length;
}
function oldClientReceiptKey(body) {
  return 'learn-job-v1/' + uid + '/' + localFingerprint('/path/node' + canonical(body));
}
function response(route, status, body, origin) {
  return route.fulfill({status, contentType:'application/json; charset=utf-8',
    headers:{'Access-Control-Allow-Origin':origin, 'Access-Control-Allow-Credentials':'true',
      'Access-Control-Allow-Headers':'Content-Type, X-Learn-User',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS'},
    body:body === undefined ? '' : JSON.stringify(body)});
}
async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const credentials = JSON.parse(execFileSync('ssh', [
  '-o', 'BatchMode=yes', 'root@192.168.33.146',
  'cat /opt/study-assistant/regression-credentials/' + environment + '.json',
], {encoding:'utf8'}));
const fixtureId = 'node-receipt-conflict-' + randomBytes(8).toString('hex');
const key = uid + '/learn-path-v1-' + fixtureId;
const baseRequestId = randomBytes(16).toString('hex');
const ids = ['n1','n2','n3','n4','n5','n6','n7'];
const nodes = ids.map((id, index) => ({
  id, title:'合成回执回归单元 ' + (index + 1),
  essence:'固定合成资料。只用于检查任务回执。', objectives:['检查请求隔离。'], deps:[],
}));
const spec = {topic:'合成回执回归', level:'测试', goal:'检查不同节点的任务回执隔离。'};
const completedQuiz = {round_id:'fixture-round-n1', questions:[], rounds:[]};
const initialMaterial = {
  stage:'learning', topic:spec.topic, spec,
  plan:{title:fixtureId, summary:spec.goal, nodes},
  nodeDetail:{n1:{study_notes:'合成已完成节点。', quiz:completedQuiz, manim_review:{status:'not_needed'}}},
  nodeState:{n1:{status:'review'}},
  pending:{kind:'nodes', nid:null, at:Date.now(), remaining:ids.slice(1), requestId:baseRequestId},
};

const serverReceipts = new Map();
const httpPosts = [];
const conflicts = [];
const accepted = [];
const fixtureJobs = new Map();
let nextJob = 0;
let blockedModelRequests = 0;
let resolveFirstConflict, resolveFirstRebind;
const firstConflictEvent = new Promise(resolve => { resolveFirstConflict = resolve; });
const firstRebindEvent = new Promise(resolve => { resolveFirstRebind = resolve; });
function registerOldReceipt(node, status) {
  const requestId = baseRequestId + ':' + node.id;
  const body = {
    spec,
    node:{id:node.id, title:node.title, essence:node.essence, objectives:node.objectives || []},
    dep_titles:[], key,
  };
  const job = {
    id:randomBytes(16).toString('hex'), user_id:uid, request_id:requestId,
    operation:'/path/node', key, node_id:node.id, status,
    created_ms:Date.now() - 1000, updated_ms:Date.now(), attempt:1, max_attempts:2,
    error:status === 'failed' ? '合成旧任务已失败' : '合成旧任务中断',
    result:null,
  };
  serverReceipts.set(requestId, {operation:'/path/node', body, fingerprint:fingerprint('/path/node', body), job});
}
// One known failed old receipt and one previously unconfirmed (interrupted) receipt.
registerOldReceipt(nodes[1], 'failed');
registerOldReceipt(nodes[2], 'interrupted');

const report = {
  environment, expected_revision:revision, fixture_id:fixtureId,
  passed:false, browser:browserName, viewport, phone_mode:phoneMode,
  mode:'deployed_page_with_controlled_jobs_http_fixture',
  model_calls:0, cases:[], conflicts:[], accepted_jobs:[], errors:[],
};
let activePhase = 'setup';
function casePassed(name, condition) {
  activePhase = name;
  assert(condition, name);
  report.cases.push(name);
  saveReport();
}
function saveReport() {
  const file = path.join(output, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', {mode:0o600});
  fs.chmodSync(file, 0o600);
}

(async () => {
  let browser, context, page, fixtureSaved = false;
  try {
    activePhase = 'browser_launch';
    const launchOptions = {headless:true};
    if (browserName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    browser = await playwright[browserName].launch(launchOptions);
    context = await browser.newContext({viewport, isMobile:phoneMode, hasTouch:phoneMode});
    activePhase = 'fixed_account_login';
    const login = await context.request.post(api + '/auth/login', {
      data:{username:'regression_bot', password:credentials.password}, timeout:20000,
    });
    assert.equal(login.status(), 200, 'fixed regression account login');
    assert.equal((await login.json()).user.id, uid, 'fixed regression account UID');
    const health = await context.request.get(api + '/health');
    assert.equal(health.status(), 200, 'backend health');
    assert.equal((await health.json()).revision, revision, 'exact backend revision');
    const revisionResponse = await context.request.get(site + '/learn/revision.json');
    assert.equal(revisionResponse.status(), 200, 'site revision endpoint');
    assert.equal((await revisionResponse.json()).revision, revision, 'exact site revision');

    const put = await context.request.post(api + '/state/put', {
      headers:{'X-Learn-User':uid},
      data:{entries:{[key]:JSON.stringify(initialMaterial)}},
    });
    assert.equal(put.status(), 200, 'write isolated synthetic fixture');
    fixtureSaved = true;

    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.name));
    const nodeBody = node => ({
      spec, node:{id:node.id,title:node.title,essence:node.essence,objectives:node.objectives || []},
      dep_titles:[], key, defer_visual:true,
    });
    // Model the stale browser receipts from the older client: these current
    // bodies were locally bound to R:node before body-based scoping existed.
    const staleReceipts = ['n2','n3'].map(nodeId => ({
      key:oldClientReceiptKey(nodeBody(nodes.find(node => node.id === nodeId))),
      receipt:{requestId:baseRequestId + ':' + nodeId, created:Date.now()},
    }));
    await page.addInitScript(receipts => {
      for (const item of receipts) localStorage.setItem(item.key, JSON.stringify(item.receipt));
    }, staleReceipts);
    for (const pattern of [api + '/path/**', api + '/ask**']) {
      await page.route(pattern, async route => {
        blockedModelRequests++;
        return response(route, 409, {ok:false, error:'model route blocked by this synthetic browser test'}, site);
      });
    }
    await page.route(api + '/jobs**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'OPTIONS') {
        return route.fulfill({status:204, headers:{
          'Access-Control-Allow-Origin':site, 'Access-Control-Allow-Credentials':'true',
          'Access-Control-Allow-Headers':'Content-Type, X-Learn-User',
          'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
        }});
      }
      if (request.method() === 'GET' && url.pathname === '/jobs') {
        const list = [...serverReceipts.values()].filter(receipt => receipt.job.key === key)
          .map(receipt => ({...receipt.job}));
        return response(route, 200, {ok:true, jobs:list}, site);
      }
      if (request.method() === 'GET' && /^\/jobs\/[0-9a-f-]+$/.test(url.pathname)) {
        const job = fixtureJobs.get(url.pathname.split('/').at(-1)) ||
          [...serverReceipts.values()].find(receipt => receipt.job.id === url.pathname.split('/').at(-1))?.job;
        return job ? response(route, 200, {ok:true, job}, site) : response(route, 404, {ok:false, error:'任务不存在'}, site);
      }
      if (request.method() === 'POST' && url.pathname === '/jobs') {
        const submission = request.postDataJSON();
        const operation = submission.operation, body = submission.body, requestId = submission.request_id;
        assert.equal(operation, '/path/node', 'only node material jobs are exercised');
        const nodeId = body && body.node && body.node.id;
        assert(ids.includes(nodeId), 'job refers to one synthetic node');
        httpPosts.push({node_id:nodeId, request_id:requestId, fingerprint:fingerprint(operation, body), body});
        const previous = serverReceipts.get(requestId);
        if (previous && (previous.operation !== operation || previous.fingerprint !== fingerprint(operation, body))) {
          conflicts.push({node_id:nodeId, request_id:requestId, category:'request_id_conflict'});
          if (conflicts.length === 1) resolveFirstConflict({node_id:nodeId, request_id:requestId});
          return response(route, 409, {ok:false, error:'同一任务回执不能用于不同内容', error_category:'request_id_conflict'}, site);
        }
        if (previous) return response(route, 202, {ok:true, job:previous.job}, site);
        if (conflicts.some(item => item.node_id === 'n2') && nodeId === 'n2' &&
            requestId !== baseRequestId + ':n2') {
          resolveFirstRebind({node_id:nodeId, request_id:requestId});
        }
        nextJob++;
        const jobId = randomBytes(16).toString('hex');
        const result = {
          node_id:nodeId,
          study_notes:'合成新正文：' + nodeId,
          quiz:{round_id:'fixture-round-' + nodeId, questions:[], rounds:[]},
          manim_review:{status:'not_needed'},
        };
        const job = {
          id:jobId, user_id:uid, request_id:requestId, operation, key, node_id:nodeId,
          status:'succeeded', created_ms:Date.now(), updated_ms:Date.now(), attempt:1, max_attempts:2,
          result, error:null,
        };
        const record = {operation, body, fingerprint:fingerprint(operation, body), job};
        serverReceipts.set(requestId, record);
        fixtureJobs.set(jobId, job);
        accepted.push({node_id:nodeId, request_id:requestId, job_id:jobId, fingerprint:record.fingerprint});
        return response(route, 202, {ok:true, job}, site);
      }
      return response(route, 404, {ok:false, error:'未支持的合成任务路由'}, site);
    });

    activePhase = 'load_real_deployed_page';
    await page.goto(site + '/learn/u/' + uid + '/learning-path.html?t=' + encodeURIComponent(fixtureId));
    await page.locator('#gen-all-btn').waitFor({state:'visible'});
    activePhase = 'wait_for_six_node_recovery';
    await page.waitForFunction(() => document.getElementById('gen-all-btn')?.textContent === '继续准备未完成节点', null, {timeout:30000});
    activePhase = 'click_real_batch_button';
    await page.locator('#gen-all-btn').click();
    activePhase = 'wait_for_first_legacy_typed_conflict';
    const firstConflict = await withTimeout(firstConflictEvent, 10000);
    assert(firstConflict && firstConflict.node_id === 'n2', 'first legacy receipt conflicts on n2');
    activePhase = 'assert_one_conflict_rebind';
    const firstRebind = await withTimeout(firstRebindEvent, 3000);
    casePassed('typed_conflict_rebound_once', firstRebind && firstRebind.node_id === 'n2');
    activePhase = 'wait_for_batch_completion';
    await page.waitForFunction(() => ['一键生成全部节点','继续准备未完成节点'].includes(
      document.getElementById('gen-all-btn')?.textContent), null, {timeout:60000});
    assert.equal(await page.locator('#gen-all-btn').textContent(), '一键生成全部节点',
      'all six remaining nodes complete after scoped receipt recovery');

    casePassed('real_page_and_backend_revision_verified', true);
    casePassed('seven_synthetic_nodes_loaded_six_remaining', await page.locator('[id^="node-n"]').count() >= 7);
    report.model_calls = blockedModelRequests;
    casePassed('batch_completed_without_model_calls', blockedModelRequests === 0);
    casePassed('legacy_failed_and_interrupted_receipts_conflicted_once_each',
      conflicts.length === 2 && conflicts.some(item => item.node_id === 'n2') && conflicts.some(item => item.node_id === 'n3'));
    casePassed('old_server_receipts_remain_unchanged', ['n2','n3'].every(nodeId => {
      const old = serverReceipts.get(baseRequestId + ':' + nodeId);
      return old && old.fingerprint === fingerprint('/path/node', {
        spec, node:{id:nodeId,title:nodes.find(node => node.id === nodeId).title,
          essence:nodes.find(node => node.id === nodeId).essence,
          objectives:nodes.find(node => node.id === nodeId).objectives},
        dep_titles:[], key,
      }) && !Object.hasOwn(old.body, 'defer_visual');
    }));
    casePassed('each_conflict_used_one_new_request_id', ['n2','n3'].every(nodeId => {
      const oldId = baseRequestId + ':' + nodeId;
      const sends = httpPosts.filter(item => item.node_id === nodeId);
      return sends.length === 2 && sends[0].request_id === oldId && sends[1].request_id !== oldId &&
        sends[0].fingerprint === sends[1].fingerprint;
    }));
    casePassed('new_node_payloads_are_scoped_and_separate',
      ids.slice(1).every(nodeId => {
        const jobs = accepted.filter(item => item.node_id === nodeId);
        return jobs.length === 1 && jobs[0].request_id.length >= 8;
      }) && new Set(accepted.map(item => item.request_id)).size === accepted.length);
    casePassed('completed_node_was_not_submitted', !httpPosts.some(item => item.node_id === 'n1'));
    casePassed('every_accepted_body_uses_current_two_stage_contract',
      accepted.length === 6 && accepted.every(item => httpPosts.some(post =>
        post.node_id === item.node_id && post.request_id === item.request_id && post.body.defer_visual === true)));
    casePassed('phone_viewport_has_no_horizontal_overflow', await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth + 1));

    let finalState, stateDeadline=Date.now()+10000;
    do {
      const savedResponse = await context.request.get(api + '/state/all', {headers:{'X-Learn-User':uid}});
      assert.equal(savedResponse.status(), 200, 'read back only the synthetic regression document');
      const savedEntries = await savedResponse.json();
      finalState = JSON.parse(savedEntries.entries[key]);
      if (finalState.pending === null && ids.slice(1).every(id => finalState.nodeDetail?.[id])) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < stateDeadline);
    assert.equal(finalState.pending, null, 'completed batch clears its pending marker');
    assert(ids.slice(1).every(id => finalState.nodeDetail?.[id]), 'all missing synthetic materials were saved');
    const completedDetail = finalState.nodeDetail && finalState.nodeDetail.n1;
    assert(completedDetail, 'completed node remains present in saved fixture');
    const completed = {notes:completedDetail.study_notes, round:completedDetail.quiz?.round_id,
      review:completedDetail.manim_review?.status};
    assert.equal(completed.notes, '合成已完成节点。');
    assert.equal(completed.round, 'fixture-round-n1');
    assert.equal(completed.review, 'not_needed');
    casePassed('precompleted_node_and_quiz_were_not_replaced', true);

    const postsBeforeReplay = httpPosts.length;
    const replay = accepted.find(item => item.node_id === 'n2');
    const replayBody = httpPosts.find(item => item.node_id === 'n2' && item.request_id === replay.request_id).body;
    await page.evaluate(({body, requestId}) => window.LearnJobs.run('/path/node', body, {requestId}),
      {body:replayBody, requestId:replay.request_id});
    assert.equal(httpPosts.length, postsBeforeReplay, 'same accepted local receipt is read, not resubmitted');
    casePassed('accepted_receipt_replay_does_not_post_duplicate', true);

    await page.locator('#gen-all-btn').click();
    await page.waitForFunction(() => document.getElementById('gen-all-btn')?.textContent === '已全部生成 ✓', null, {timeout:5000});
    assert.equal(httpPosts.length, postsBeforeReplay, 'completed nodes are skipped on a second batch click');
    casePassed('second_batch_click_skips_all_completed_nodes', true);
    assert.deepEqual(report.errors, []);
    report.posts = httpPosts.map(item => ({node_id:item.node_id, request_id:item.request_id, fingerprint:item.fingerprint}));
    report.conflicts = conflicts;
    report.accepted_jobs = accepted.map(({node_id,request_id,job_id,fingerprint:bodyFingerprint}) =>
      ({node_id,request_id,job_id,fingerprint:bodyFingerprint}));
    report.cases.push('no_page_errors');
    report.passed = true;
    saveReport();
  } catch (error) {
    report.passed = false;
    report.failure_type = error.name;
    report.failure_phase = activePhase;
    report.errors = report.errors.slice(0,10);
    report.model_calls = blockedModelRequests;
    report.posts = httpPosts.map(item => ({node_id:item.node_id, request_id:item.request_id, fingerprint:item.fingerprint}));
    report.conflicts = conflicts;
    report.accepted_jobs = accepted.map(({node_id,request_id,job_id,fingerprint:bodyFingerprint}) =>
      ({node_id,request_id,job_id,fingerprint:bodyFingerprint}));
    saveReport();
    process.exitCode = 1;
  } finally {
    if (page) await page.close().catch(() => {});
    if (fixtureSaved && context) {
      const removed = await context.request.post(api + '/state/put', {
        headers:{'X-Learn-User':uid},
        data:{entries:{[key]:null}, password:credentials.password},
        timeout:20000,
      }).catch(() => null);
      if (removed && removed.status() === 200) {
        report.fixture_deleted = true;
      } else {
        report.fixture_deleted = false;
        report.passed = false;
        report.failure_type = 'FixtureCleanupFailure';
        report.failure_phase = 'fixture_cleanup';
        process.exitCode = 1;
      }
    } else report.fixture_deleted = true;
    if (browser) await browser.close().catch(() => {});
    credentials.password = '';
    if (report.fixture_deleted !== true) report.passed = false;
    saveReport();
  }
  if (report.passed === true && report.fixture_deleted === true) {
    console.log(JSON.stringify({passed:true, environment, revision, browser:browserName, viewport,
      model_calls:report.model_calls, conflicts:conflicts.length, accepted_jobs:accepted.length,
      fixture_deleted:true, report:path.join(output,'report.json')}));
  } else {
    console.error(JSON.stringify({passed:false, failure_type:report.failure_type || 'RegressionFailure',
      failure_phase:report.failure_phase || activePhase, fixture_deleted:report.fixture_deleted,
      report:path.join(output,'report.json')}));
  }
})().catch(error => {
  // Only the error type is emitted. Request and model content stay private.
  console.error(JSON.stringify({passed:false, failure_type:error.name}));
  process.exitCode = 1;
});
