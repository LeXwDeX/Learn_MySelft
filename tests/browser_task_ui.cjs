/* Real deployed pages with synthetic HTTP responses. No model or learning-data writes. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const environment = process.env.RELEASE_ENV || 'test';
const engine = process.env.BROWSER_ENGINE || 'chromium';
assert(['test', 'production'].includes(environment));
assert(['chromium', 'webkit'].includes(engine));
const phone = process.env.PHONE_MODE === '1';
const source = process.env.TASK_UI_SOURCE === '1';
assert(!source || environment === 'test', 'source overrides only run in the test environment');
const revision = process.env.RELEASE_REVISION;
assert.match(revision || '', /^[0-9a-f]{40}$/);
const output = process.env.TASK_UI_OUTPUT;
assert(path.isAbsolute(output || '') && path.resolve(output) !== '/');
const repository = path.resolve(__dirname, '..');
assert(!path.resolve(output).startsWith(repository + path.sep), 'reports stay outside the repository');
fs.mkdirSync(output, {recursive:true, mode:0o700});
const site = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const uid = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const credentials = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'root@192.168.33.146',
  'cat /opt/study-assistant/regression-credentials/' + environment + '.json'], {encoding:'utf8'}));
const slug = 'task-ui-synthetic';
const key = uid + '/learn-path-v1-' + slug;
const nodes = Array.from({length:24}, (_, i) => ({id:'n' + (i + 1), title:'合成任务单元 ' + (i + 1),
  essence:'合成内容。用于检查任务窗口。', objectives:['检查任务窗口'], deps:[]}));
const material = {stage:'learning', title:'合成任务交互回归', topic:'合成任务交互回归',
  spec:{topic:'合成任务交互回归', goal:'检查任务交互'}, plan:{title:'合成任务交互回归', summary:'合成学习路径。', nodes},
  nodeDetail:{n1:{study_notes:'合成正文。', quiz:{questions:[]}, manim_review:{status:'not_needed'}}}, nodeState:{}, pending:null};
const entries = {[key]:JSON.stringify(material)};
const jobs = Array.from({length:8}, (_, i) => ({id:(i + 1).toString(16).padStart(32,'0'), user_id:uid,
  key, node_id:'n' + (i + 1), node_title:nodes[i].title, title:material.title, operation:'/path/node',
  created_ms:Date.now() - i * 1000, updated_ms:Date.now(), status:i === 0 ? 'running' : 'succeeded', attempt:1, timeout_seconds:300}));
const attack = '<img src=x onerror="window.__taskInjection=1">';
const events = [{id:1, kind:'model_request', content:attack}, {id:2, kind:'model_response', content:'合成隐藏答案 ' + attack},
  ...Array.from({length:40}, (_, i) => ({id:i+3, kind:'phase', phase:'合成阶段 ' + i, content:'合成任务日志 ' + i + '\n' + '这是纯文本任务记录。'.repeat(15)}))];
let failDetails = false, batchRelease = false, batchSerial = 0;
const batchJobs = new Map();
const detailRequests = [];
const report = {environment, expected_revision:revision, browser:engine, phone_mode:phone,
  mode:'deployed-pages-with-controlled-http-fixtures', source_overrides:source,
  passed:false, model_calls:0, server_learning_writes:0, fixture_state_writes:0, cases:[], source_assets:[], errors:[]};
let phase = 'setup', browser, page;
function save() {fs.writeFileSync(path.join(output,'report.json'), JSON.stringify(report,null,2) + '\n', {mode:0o600});}
function passed(name) {report.cases.push(name); save();}
function response(route, status, body) {
  return route.fulfill({status, contentType:'application/json; charset=utf-8', headers:{
    'Access-Control-Allow-Origin':site, 'Access-Control-Allow-Credentials':'true',
    'Access-Control-Allow-Headers':'Content-Type, X-Learn-User', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS'},
  body:status === 204 ? '' : JSON.stringify(body)});
}
async function taskWindow() {
  const dialog = page.locator('dialog.learn-job-detail-panel[open]');
  await dialog.waitFor();
  await dialog.locator('.learn-job-event').first().waitFor();
  assert.equal(await dialog.count(),1,'one active shared task dialog');
  assert.equal(await dialog.evaluate(el => el.parentElement === document.body),true,'dialog mounts under body');
  const bounds = await dialog.boundingBox();
  assert(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= (phone ? 390 : 1440)+1 &&
    bounds.y + bounds.height <= (phone ? 844 : 1000)+1,'dialog fits viewport');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),'no horizontal overflow');
  return dialog;
}
async function scrollPosition() {return page.evaluate(() => scrollY);}
async function checkScroll(y, label) {assert(Math.abs(await scrollPosition() - y) <= 2, label);}
async function injectNotification(job) {
  await page.evaluate(job => {
    window.LearnJobDetails.observe(job);
    window.LearnUI.toast('job-' + job.id, '合成任务提示', 'info', null, null, {secondaryLabel:'查看详情',
      secondaryAction:event => window.LearnJobDetails.open(job,null,event.currentTarget)});
  },job);
}
(async () => {
  try {
    phase = 'fixed-account-and-revisions';
    browser = await playwright[engine].launch({headless:true,
      ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
    const context = await browser.newContext({viewport:phone ? {width:390,height:844} : {width:1440,height:1000},
      isMobile:phone, hasTouch:phone});
    const login = await context.request.post(api + '/auth/login', {data:{username:'regression_bot',password:credentials.password}});
    assert.equal(login.status(),200);
    assert.equal((await login.json()).user.id,uid,'real fixed-account UID');
    const health = await context.request.get(api + '/health');
    assert.equal((await health.json()).revision,revision,'backend revision');
    const staticRevision = await context.request.get(site + '/learn/revision.json');
    assert.equal((await staticRevision.json()).revision,revision,'static revision');
    passed('real-fixed-account-and-full-backend-static-revision');
    await context.route(api + '/**', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (method === 'OPTIONS') return response(route,204);
      if (url.pathname.startsWith('/auth/')) return source
        ? route.fulfill({response:await route.fetch()}) : route.continue();
      if (url.pathname === '/state/all' && method === 'GET') return response(route,200,{ok:true,entries});
      if (url.pathname === '/state/put' && method === 'POST') {
        report.fixture_state_writes++;
        const body = request.postDataJSON();
        assert(Object.keys(body.entries).every(k => k.startsWith(uid + '/')),'fixture writes stay within fixed UID');
        Object.assign(entries,body.entries); return response(route,200,{ok:true});
      }
      if (url.pathname === '/jobs' && method === 'GET') return response(route,200,{ok:true,jobs:[...batchJobs.values(),...jobs]});
      if (url.pathname === '/jobs' && method === 'POST') {
        const body = request.postDataJSON();
        assert.equal(body.operation,'/path/node','synthetic batch only submits node jobs');
        const job = {...jobs[0], id:(100 + ++batchSerial).toString(16).padStart(32,'0'),
          node_id:body.body.node.id, node_title:body.body.node.title, status:'running', created_ms:Date.now()};
        batchJobs.set(job.id,job); return response(route,200,{ok:true,job});
      }
      if (/^\/jobs\/[^/]+(?:\/details)?$/.test(url.pathname) && method === 'GET') {
        const id = url.pathname.split('/')[2];
        const job = batchJobs.get(id) || jobs.find(j => j.id === id);
        if (!job) return response(route,404,{error:'合成任务不存在'});
        if (url.pathname.endsWith('/details')) {
          detailRequests.push(id);
          return failDetails ? response(route,503,{error:'合成读取暂时失败'}) :
            response(route,200,{ok:true,job,details:{available:true,events}});
        }
        if (batchJobs.has(id) && batchRelease) {job.status='failed';job.error='合成失败。任务日志保留。';}
        return response(route,200,{ok:true,job});
      }
      report.model_calls++;
      return response(route,409,{error:'合成回归拒绝模型或未声明接口'});
    });
    const assets = {'/learn/':'home/index.html',
      ['/learn/u/' + uid + '/']:'home/index.html',
      ['/learn/u/' + uid + '/learning-path.html']:'learning-path/learning-path.html',
      '/learn/assets/home.css':'home/home.css',
      '/learn/assets/job-details.js':'shared/job-details.js','/learn/assets/ui.css':'shared/ui.css',
      '/learn/assets/home.js':'home/home.js','/learn/home.js':'home/home.js',
      '/diagram-design/learning-path/path_app.js':'learning-path/path_app.js',
      '/diagram-design/learning-path/path.css':'learning-path/path.css'};
    if (source) await context.route(site + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname, file = assets[pathname];
      if (!file) return route.fulfill({response:await route.fetch()});
      report.source_assets.push(pathname);
      return route.fulfill({contentType:file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript',body:fs.readFileSync(path.join(repository,file),'utf8')});
    });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.name));
    phase = 'home-task-details';
    await page.goto(site + '/learn/u/' + uid + '/');
    await page.locator('#task-list .learn-job-detail-button').first().waitFor();
    const homeButton = page.locator('#task-list .learn-job-detail-button').first();
    await homeButton.scrollIntoViewIfNeeded();
    const homeY = await scrollPosition();
    await homeButton.click();
    let dialog = await taskWindow();
    await checkScroll(homeY,'opening home details preserves scroll');
    assert.equal(await dialog.locator('.learn-job-conversation').first().isVisible(),false,'model text starts hidden');
    await dialog.getByRole('button',{name:'确认显示模型对话'}).click();
    assert((await dialog.locator('.learn-job-conversation').first().textContent()).includes(attack),'raw injection stays text');
    assert.equal(await dialog.locator('img').count(),0,'no markup from model output');
    assert.equal(await page.evaluate(() => window.__taskInjection || 0),0);
    passed('home-open-shared-dialog-hidden-model-confirmation-and-text-safety');
    phase = 'log-scroll-and-home-refresh-focus';
    const body = dialog.locator('.learn-task-dialog-body');
    await body.evaluate(el => {el.scrollTop=el.scrollHeight;});
    if (engine === 'chromium') {await body.hover();await page.mouse.wheel(0,600);await page.waitForTimeout(150);}
    else await body.evaluate(el => el.dispatchEvent(new WheelEvent('wheel',{deltaY:600,bubbles:true})));
    await checkScroll(homeY,'log scroll does not move background');
    await page.evaluate(async () => {
      window.__oldTaskButton=document.querySelector('#task-list .learn-job-detail-button');
      await window.LearnHomeModules.get('home.tasks').load();
    });
    assert.equal(await page.evaluate(() => document.querySelector('#task-list .learn-job-detail-button') === window.__oldTaskButton),true,'refresh preserves the details trigger');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#task-list .learn-job-detail-button'));
    await checkScroll(homeY,'closing home details preserves scroll');
    passed('log-scroll-contained-and-refreshed-home-trigger-focus');
    phase = 'polling-and-failed-read';
    await homeButton.click(); dialog = await taskWindow();
    const title = await dialog.locator('.learn-job-task-name').textContent();
    await page.evaluate(job => window.LearnJobDetails.observe({...job,id:'ffffffffffffffffffffffffffffffff',created_ms:Date.now()+100000,node_title:'合成较新任务'}),jobs[0]);
    await page.waitForTimeout(2700);
    assert.equal(await dialog.locator('.learn-job-task-name').textContent(),title,'polling does not replace selected task');
    assert.equal(detailRequests.at(-1),jobs[0].id,'polling still reads the selected task ID');
    failDetails=true;
    await dialog.getByRole('button',{name:'重新读取详情'}).waitFor({state:'visible',timeout:8000});
    assert.equal(await dialog.locator('.learn-job-event').count(),events.length,'failed read preserves prior events');
    failDetails=false;
    await dialog.getByRole('button',{name:'重新读取详情'}).click();
    await dialog.getByRole('button',{name:'重新读取详情'}).waitFor({state:'hidden'});
    await page.keyboard.press('Escape');
    passed('selected-task-stable-during-polling-and-read-failure-recovery');
    phase = 'path-card-details';
    await page.goto(site + '/learn/u/' + uid + '/learning-path.html?t=' + slug);
    await page.locator('#node-n1 .learn-job-detail-button').waitFor({state:'visible'});
    const card = page.locator('#node-n1');
    const before = await card.getAttribute('class');
    await card.locator('.learn-job-detail-button').scrollIntoViewIfNeeded();
    const cardY = await scrollPosition();
    await card.locator('.learn-job-detail-button').click();dialog = await taskWindow();
    await checkScroll(cardY,'card details preserves scroll');
    assert.equal(await card.getAttribute('class'),before,'task detail does not expand card');
    await page.screenshot({path:path.join(output,'path-details.png')});
    await page.keyboard.press('Escape');
    passed('path-card-same-shared-dialog-without-card-expansion');
    phase = 'batch-list-stacking-and-focus';
    await page.evaluate(() => {window.__batchTest=window.LearnPathApp.get('path.generation').genAllStart(['n2','n3']);});
    const summary = page.locator('.learn-status[data-status-key^="generation-batch-"] .learn-job-detail-button');
    await summary.waitFor();
    await summary.click();
    const list = page.locator('dialog.generation-task-list[open]');
    await list.waitFor();
    const row = list.locator('.learn-job-detail-button').first();
    await row.waitFor({state:'visible'});
    await row.click();dialog=await taskWindow();
    assert.equal(await list.evaluate(el => el.open),true,'underlying batch dialog stays open');
    await page.keyboard.press('Escape');
    assert.equal(await list.evaluate(el => el.open),true,'first Escape only closes detail dialog');
    assert.equal(await row.evaluate(el => el===document.activeElement),true,'detail returns focus to list row');
    batchRelease=true;
    await page.evaluate(() => window.__batchTest);
    assert.equal(await row.evaluate(el => el===document.activeElement),true,'batch updates preserve row focus');
    await page.screenshot({path:path.join(output,'batch-list.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.generation-task-list').open);
    await page.waitForFunction(() => document.activeElement ===
      document.querySelector('.learn-status[data-status-key^="generation-batch-"] .learn-job-detail-button'));
    passed('batch-native-dialog-stacking-two-Escapes-and-current-summary-focus');
    phase = 'path-notification-scroll';
    await injectNotification(jobs[0]);
    await page.evaluate(() => scrollTo(0,500));
    const noticeY = await scrollPosition();assert(noticeY>200,'notification starts away from page top');
    await page.locator('#learn-toast-area .learn-job-detail-button').click();dialog=await taskWindow();
    await checkScroll(noticeY,'notification detail opening does not jump to page top');
    await page.keyboard.press('Escape');await checkScroll(noticeY,'notification detail closing preserves scroll');
    assert.equal(await page.locator('#learn-toast-area .learn-job-detail-button').evaluate(el => el===document.activeElement),true,
      'notification detail returns focus to notification');
    passed('notification-open-and-close-preserves-scrolled-learning-page');
    phase = 'quiz-notification-component';
    await page.goto(site + '/learn/u/' + uid + '/quiz-map.html');
    await page.waitForFunction(() => !!window.LearnJobDetails && !!window.LearnUI && !!window.LearnUser);
    await injectNotification(jobs[0]);
    await page.locator('#learn-toast-area .learn-job-detail-button').click();dialog=await taskWindow();
    assert.equal(await dialog.locator('.learn-job-conversation').first().isVisible(),false,'quiz model text is also hidden');
    await page.screenshot({path:path.join(output,'quiz-details.png')});
    await page.keyboard.press('Escape');
    passed('quiz-notification-uses-same-shared-task-dialog');
    assert.deepEqual(report.errors,[],'no JavaScript errors');
    assert.equal(report.model_calls,0,'no model requests or undeclared API calls');
    if(source) for(const asset of ['/learn/assets/job-details.js','/learn/assets/ui.css','/learn/assets/home.js',
      '/diagram-design/learning-path/path_app.js','/diagram-design/learning-path/path.css'])
      assert(report.source_assets.includes(asset),'source asset used: ' + asset);
    report.passed=true;save();
    console.log(JSON.stringify({passed:true,environment,browser:engine,phone,source,report:path.join(output,'report.json'),cases:report.cases.length,model_calls:0,server_learning_writes:0}));
  } catch(error) {
    report.failure_phase=phase; report.failure=String(error.message);save();
    if(page) await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    console.error(JSON.stringify({passed:false,phase,error:error.message,report:path.join(output,'report.json')}));process.exitCode=1;
  } finally {if(browser) await browser.close();}
})();
