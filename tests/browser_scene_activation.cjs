/* Natural learning requests, generic diagrams and old-lesson supplements. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const environment = process.env.RELEASE_ENV;
const revision = process.env.RELEASE_REVISION;
const output = process.env.RELEASE_OUTPUT;
assert(['test', 'production'].includes(environment));
assert(/^[0-9a-f]{40}$/.test(revision || ''));
assert(path.isAbsolute(output || '') && !path.resolve(output).startsWith(path.resolve(__dirname, '..') + path.sep));
fs.mkdirSync(output, {recursive:true});
const root = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const user = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const credentials = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'root@192.168.33.146',
  'cat /opt/study-assistant/regression-credentials/' + environment + '.json'], {encoding:'utf8'}));
const scenePattern = /(?:`{3,}|~{3,})learn-scene[^\n]*\n([\s\S]*?)\n(?:`{3,}|~{3,})/g;
const sceneSources = source => Array.from(String(source).matchAll(scenePattern), match => match[1]);
let phase = 'setup';
const report = {environment, revision, cases:[]};
function progress(next) { phase = next; console.log(JSON.stringify({phase})); }

async function main() {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context = await browser.newContext({viewport:{width:1440,height:1000}, acceptDownloads:true});
  const page = await context.newPage();
  const errors = [], assets = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => { if (/\.(?:js|css)(?:\?|$)/.test(response.url()) && response.status() >= 400) assets.push(response.status()); });
  const headers = {'X-Learn-User':user};
  async function get(endpoint) {
    const response = await context.request.get(api + endpoint, {headers, timeout:30000});
    assert.equal(response.status(), 200, 'API read failed');
    return response.json();
  }
  async function put(key, material) {
    assert(key.startsWith(user + '/'));
    const response = await context.request.post(api + '/state/put', {headers, data:{entries:{[key]:JSON.stringify(material)}}});
    assert.equal(response.status(), 200, 'owned fixture write failed');
  }
  async function material(key) { return JSON.parse((await get('/state/all')).entries[key]); }
  async function job(operation, body) {
    const response = await context.request.post(api + '/jobs', {headers,
      data:{operation,body,request_id:randomBytes(16).toString('hex')}});
    assert.equal(response.status(), 202, 'job not accepted');
    let row = (await response.json()).job;
    const deadline = Date.now() + 720000;
    let announced = 0;
    while (['queued','running'].includes(row.status)) {
      assert(Date.now() < deadline, 'job exceeded its bounded deadline');
      if (Date.now() - announced > 30000) { console.log(JSON.stringify({phase,status:row.status})); announced = Date.now(); }
      await new Promise(resolve => setTimeout(resolve, 1500));
      row = (await get('/jobs/' + row.id)).job;
    }
    assert.equal(row.status, 'succeeded', 'model job failed');
    return row.result;
  }
  async function saved() {
    const deadline = Date.now() + 60000;
    let idle = 0;
    while (Date.now() < deadline) {
      if (await page.evaluate(() => LearnSaves.pending())) idle = 0;
      else if (!idle) idle = Date.now();
      else if (Date.now() - idle >= 600) break;
      await page.waitForTimeout(100);
    }
    await page.evaluate(async () => {await LearnSaves.drain();});
    assert.equal(await page.evaluate(() => LearnSaves.pending()), false, 'save not acknowledged');
  }
  function fixture(topic, node, goal) {
    const slug = 'scene-natural-' + Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
    const key = user + '/learn-path-v1-' + slug;
    const spec = {topic,level:'入门',goal};
    const value = {title:'通用图形能力回归',topic,stage:'learning',spec,
      plan:{title:topic,nodes:[node],edges:[]},nodeDetail:{},nodeState:{}};
    fs.appendFileSync(path.join(output,'owned-fixtures.jsonl'),JSON.stringify({slug,key,spec,node}) + '\n',{mode:0o600});
    return {slug,key,spec,value,node,url:root + '/learn/u/' + user + '/learning-path.html?t=' + encodeURIComponent(slug)};
  }
  async function validateInBrowser(source) {
    return page.evaluate(raw => raw.map(value => window.LearnScenes.validate(JSON.parse(value)).type), sceneSources(source));
  }
  async function openLesson(data, expectsResult=false) {
    await page.goto(data.url);
    const card = page.locator('#node-' + data.node.id);
    await card.locator('.node-head').click();
    if (expectsResult) {
      assert(await card.locator('.mat-pane-material').evaluate(node => node.hidden));
      assert.equal(await card.locator('.notes .learn-scene').count(), 0);
      await card.locator('[data-mat="material"]').click();
    }
    return card;
  }
  try {
    progress('login_and_versions');
    await page.goto(root + '/learn/');
    await page.locator('#login-username').fill('regression_bot');
    await page.locator('#login-password').fill(credentials.password);
    await page.locator('#login-submit').click();
    await page.waitForURL('**/learn/u/' + user + '/');
    assert.equal((await get('/health')).revision, revision);
    assert.equal((await (await context.request.get(root + '/learn/revision.json')).json()).revision, revision);
    const denied = await context.request.get(api + '/state/all', {headers:{'X-Learn-User':'u0'}});
    assert.equal(denied.status(), 403);
    report.cases.push('fixed_account_login_exact_version_and_owner_isolation');

    const first = fixture('线性代数概念与大模型',
      {id:'n1',title:'向量、基与坐标',essence:'向量的坐标与长度，及其与模型嵌入的联系。',
       objectives:['理解二维向量的坐标、分量与长度。','理解模型嵌入使用高维向量；区分二维例子和实际嵌入。']},
      '理解线性代数基础概念如何帮助认识大模型');
    assert(!/learn-scene|JSON|动画|画图/.test(JSON.stringify(first.spec) + JSON.stringify(first.node)));
    await put(first.key, first.value);
    progress('natural_vector_node_generation');
    const detail = await job('/path/node', {key:first.key,spec:first.spec,node:first.node,dep_titles:[]});
    assert.equal(detail.quiz.questions.length, 6);
    assert.equal(detail.quiz.questions.reduce((sum,item) => sum + item.points,0), 100);
    let card = await openLesson(first);
    const generatedTypes = await validateInBrowser(detail.study_notes);
    assert(generatedTypes.includes('diagram'), 'normal vector learning request omitted generic diagram');
    await card.locator('.notes [data-scene="ready"]').first().waitFor({timeout:30000});
    assert.equal(await card.locator('.notes [data-scene="error"]').count(), 0);
    report.cases.push('natural_l1_without_graphic_protocol_generates_renderable_diagram_and_valid_quiz');

    progress('layout_and_animation');
    const diagram = card.locator('[data-scene-type="diagram"]').first();
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert(await diagram.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await diagram.screenshot({path:path.join(output, 'natural-vector-' + width + '.png')});
    }
    if (await diagram.getByRole('button',{name:'下一步',exact:true}).count()) {
      await diagram.getByRole('button',{name:'下一步',exact:true}).click();
      const before = await diagram.locator('svg').getAttribute('data-step');
      assert(Number(before) > 0);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      const latency = await diagram.locator('input[type="range"]').evaluate(input => new Promise(resolve => {
        const start = performance.now();
        for (let i=0;i<40;i++) {input.value=String(i/40); input.dispatchEvent(new Event('input',{bubbles:true}));}
        input.value='0.37'; input.dispatchEvent(new Event('input',{bubbles:true}));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()-start)));
      }));
      assert.equal(await diagram.locator('svg').getAttribute('data-progress'), '0.37');
      report.latestInputMs4xCPU = Math.round(latency * 10) / 10;
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
      await cdp.detach();
    }
    report.cases.push('desktop_390_320_graphic_layout_and_latest_input_animation');

    progress('generic_3d_renderer');
    await page.evaluate(() => {
      const host=document.createElement('div');host.id='generic-3d-regression';document.querySelector('#node-n1 .notes').appendChild(host);
      LearnScenes.mount(host,{version:1,type:'diagram',dimension:3,title:'三维关系与变化',summary:'观察三维坐标中的箭头。切换视角，再分步改变终点。',elements:[
        {id:'xy',kind:'polygon',color:'muted',points:[[-2,-2,0],[2,-2,0],[2,2,0],[-2,2,0]],label:'xy平面'},
        {id:'axis',kind:'arrow',color:'secondary',points:[[0,0,-1],[0,0,3]],label:'z轴'},
        {id:'vector',kind:'arrow',points:[[0,0,0],[1,1,2]],label:'三维向量'}],steps:[
        {caption:'向量终点发生变化。',changes:[{id:'vector',points:[[0,0,0],[-1,2,1]]}]}]});
    });
    const three=page.locator('#generic-3d-regression [data-scene-type="diagram"]');
    await three.getByRole('combobox',{name:'图形视角'}).selectOption('top');
    assert.equal(await three.locator('svg').getAttribute('data-view'),'top');
    await three.getByRole('combobox',{name:'图形视角'}).selectOption('oblique');
    await three.getByRole('button',{name:'下一步',exact:true}).click();
    assert.equal(await three.locator('svg').getAttribute('data-step'),'1');
    await three.screenshot({path:path.join(output,'generic-3d-320.png')});
    await page.evaluate(() => {LearnScenes.dispose(document.querySelector('#generic-3d-regression'));document.querySelector('#generic-3d-regression').remove();});
    report.cases.push('deployed_generic_3d_views_steps_and_disposal');

    progress('issued_quiz_before_legacy_supplement');
    await page.setViewportSize({width:1440,height:1000});
    const answers = detail.quiz.questions.map(item => item.type === 'fill' ? item.blanks.map(blank => blank.answer) : item.answer);
    const graded = await job('/path/quiz', {key:first.key,node:{id:first.node.id},round_id:detail.quiz.round_id,answers});
    assert.equal(typeof graded.score, 'number');
    const legacy = await material(first.key);
    legacy.nodeDetail.n1.study_notes = legacy.nodeDetail.n1.study_notes.replace(scenePattern,'').trim();
    assert.equal(sceneSources(legacy.nodeDetail.n1.study_notes).length, 0);
    await put(first.key, legacy);
    const oldQuiz = JSON.stringify(legacy.nodeDetail.n1.quiz), oldState = JSON.stringify(legacy.nodeState);
    card = await openLesson(first, true);
    const supplement = card.getByRole('button',{name:'补充图示',exact:true});
    assert.equal(await supplement.count(), 1);
    await supplement.click();
    assert.equal(await card.locator('.mat-pane-material').evaluate(node => node.hidden), false,
      'starting a supplement must retain the chosen material tab');
    await page.waitForFunction(() => {
      const card=document.querySelector('#node-n1');
      return card.querySelector('.notes [data-scene="ready"]') ||
        /补充失败|暂未找到/.test(card.querySelector('.scene-supplement-status')?.textContent || '');
    },null,{timeout:720000});
    assert(await card.locator('.notes [data-scene="ready"]').count(), 'supplement ended without a usable scene');
    await card.locator('.notes [data-scene="ready"]').first().waitFor({timeout:720000});
    assert.equal(await card.locator('.mat-pane-material').evaluate(node => node.hidden), false,
      'successful supplement must retain the chosen material tab');
    await saved();
    const supplemented = await material(first.key);
    assert.equal(JSON.stringify(supplemented.nodeDetail.n1.quiz), oldQuiz);
    assert.equal(JSON.stringify(supplemented.nodeState), oldState);
    assert(supplemented.nodeDetail.n1.sceneSupplement);
    assert(supplemented.nodeDetail.n1.study_notes.startsWith(legacy.nodeDetail.n1.study_notes));
    assert.equal(sceneSources(supplemented.nodeDetail.n1.study_notes).length, 1);
    await put(first.key, legacy);
    assert.equal((await material(first.key)).nodeDetail.n1.study_notes, supplemented.nodeDetail.n1.study_notes);
    const again = await job('/path/node/scene', {key:first.key,node:{id:'n1'}});
    assert.equal(again.reused, true);
    assert.equal(again.study_notes, supplemented.nodeDetail.n1.study_notes);
    report.cases.push('legacy_ui_supplement_keeps_issued_quiz_grades_progress_and_survives_stale_save');
    report.cases.push('repeated_supplement_reuses_existing_diagram');

    progress('reopen_and_natural_manim_tutor');
    card = await openLesson(first, true);
    await card.locator('.notes [data-scene="ready"]').first().waitFor();
    await card.locator('button[data-ai="n1"]').click();
    assert.equal(await page.locator('.ai-method').filter({hasText:'动画演示'}).count(), 1);
    await page.locator('#ai-input').fill('用 Manim 那样的分步动画帮我理解向量的坐标与长度，让我可以自己控制步骤。用独立的小例子，不涉及测验答案。');
    await page.locator('#ai-send').click();
    await page.waitForFunction(() => {const button=document.querySelector('#ai-send');return button && !button.disabled;},null,{timeout:720000});
    const latest = page.locator('#ai-msgs .ai-msg.assistant').last();
    await latest.locator('[data-scene="ready"]').first().waitFor({timeout:30000});
    const text = await latest.innerText();
    assert(!/未接入|没有接入|无法.*动画|不能.*动画/.test(text));
    assert.equal(await latest.locator('[data-scene="error"]').count(), 0);
    await saved();
    await page.setViewportSize({width:390,height:900});
    await page.locator('#agent-launch').click();
    const agentDialog = page.locator('#agent-dialog');
    await page.waitForFunction(() => document.querySelector('#agent-dialog')?.open === true);
    assert.equal(await agentDialog.evaluate(dialog => dialog.open), true, 'mobile launcher must open the tutor dialog');
    const mobileLatest = page.locator('#ai-msgs .ai-msg.assistant').last();
    const mobileScene = mobileLatest.locator('[data-scene="ready"]').first();
    await mobileScene.waitFor({state:'visible'});
    await mobileScene.screenshot({path:path.join(output,'natural-manim-tutor-390.png')});
    await page.reload();
    await page.locator('#node-n1 button[data-ai="n1"]').click();
    await page.waitForFunction(() => document.querySelector('#agent-dialog')?.open === true);
    assert.equal(await agentDialog.evaluate(dialog => dialog.open), true, 'reopening the tutor on mobile must open the dialog');
    const restoredScene = page.locator('#ai-msgs .ai-msg.assistant').last().locator('[data-scene="ready"]').first();
    await restoredScene.waitFor({state:'visible'});
    report.cases.push('natural_manim_tutor_request_renders_and_reopens_without_protocol_instructions');

    progress('non_math_natural_generation');
    const second = fixture('数据库事务与恢复',
      {id:'n1',title:'事务的提交与回滚',essence:'从开始到提交或回滚，理解状态和数据可见性的变化。',
       objectives:['理解开始、读写、提交和回滚的关系。','区分成功提交与发生错误后回滚。']},
      '理解事务过程如何保证数据的一致性');
    assert(!/learn-scene|JSON|动画|画图/.test(JSON.stringify(second.spec) + JSON.stringify(second.node)));
    await put(second.key, second.value);
    const processDetail = await job('/path/node', {key:second.key,spec:second.spec,node:second.node,dep_titles:[]});
    card = await openLesson(second);
    assert((await validateInBrowser(processDetail.study_notes)).includes('diagram'), 'generic diagram omitted for non-math process');
    await card.locator('.notes [data-scene="ready"]').first().waitFor();
    await card.locator('.notes').screenshot({path:path.join(output,'natural-process-390.png')});
    report.cases.push('non_math_natural_process_learning_generates_generic_diagram');
    assert.deepEqual(errors, []);
    assert.deepEqual(assets, []);
    report.pageErrors = 0; report.failedAssets = 0;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } catch (error) {
    // Do not dump Playwright action arguments, model replies or account details.
    report.failure = {phase,kind:error.name || 'Error'};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(() => {});
    console.error(JSON.stringify(report.failure));
    process.exitCode = 1;
  } finally {await context.close();await browser.close();}
}
main().catch(error => {console.error(JSON.stringify({phase,kind:error.name || 'Error'}));process.exitCode=1;});
