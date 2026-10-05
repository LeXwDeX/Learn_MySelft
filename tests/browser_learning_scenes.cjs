/* Deployed learning-scene regression. Uses only the fixed regression account. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const environment = process.env.RELEASE_ENV;
assert(['test', 'production'].includes(environment), 'RELEASE_ENV must be test or production');
const revision = process.env.RELEASE_REVISION;
assert(/^[0-9a-f]{40}$/.test(revision || ''), 'RELEASE_REVISION must be a full Git revision');
const output = path.resolve(process.env.RELEASE_OUTPUT || '');
assert(path.isAbsolute(process.env.RELEASE_OUTPUT || ''), 'RELEASE_OUTPUT must be an absolute external directory');
const repository = path.resolve(__dirname, '..');
assert(!output.startsWith(repository + path.sep) && output !== repository, 'RELEASE_OUTPUT must be outside the repository');
fs.mkdirSync(output, {recursive:true});

const root = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const expectedUser = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const credentialsPath = '/opt/study-assistant/regression-credentials/' + environment + '.json';
const credentials = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'root@192.168.33.146', 'cat ' + credentialsPath], {encoding:'utf8'}));
assert.equal(typeof credentials.password, 'string', 'fixed regression credential is unavailable');

const base = {version:1, title:'线性代数图示回归', summary:'检查矩阵列向量与交互图形。'};
const secantScene = {...base, type:'secant', title:'割线参数回归', coefficients:[0,0,1], domain:[-0.25,2.7], baseX:1, gap:{min:0.02,max:1.5,value:0.7}};
const surfaceScene = {...base, type:'surface_slice', title:'曲面截面回归', coefficient:1, radius:1.5, height:{min:0.16,max:2,value:1.44}};
const invalidScene = '{"version":1,"type":"unsupported_scene","title":"单图失败","summary":"围栏错误不能影响周围说明。"}';
const sceneFence = scene => '```learn-scene\n' + JSON.stringify(scene) + '\n```';

async function main() {
  const browserOptions = {headless:true};
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) browserOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({viewport:{width:1440,height:1000}, acceptDownloads:true});
  const page = await context.newPage();
  const pageErrors = [], failedAssets = [];
  page.on('pageerror', error => pageErrors.push(error.name || 'Error'));
  page.on('response', response => {
    if (/\.(?:js|css)(?:\?|$)/.test(response.url()) && response.status() >= 400) failedAssets.push(response.url());
  });
  const report = {environment, revision, cases:[]};

  async function get(pathname) {
    const response = await context.request.get(api + pathname, {headers:{'X-Learn-User':expectedUser}, timeout:30000});
    assert.equal(response.status(), 200, 'API read failed: ' + pathname);
    return response.json();
  }
  async function post(pathname, data, timeout=30000) {
    const response = await context.request.post(api + pathname, {headers:{'X-Learn-User':expectedUser}, data, timeout});
    assert.equal(response.status(), 200, 'API write failed: ' + pathname);
    return response.json();
  }
  async function pollJob(receipt, timeout=720000) {
    const deadline = Date.now() + timeout;
    while (['queued','running'].includes(receipt.status)) {
      assert(Date.now() < deadline, 'model job exceeded its regression deadline');
      await new Promise(resolve => setTimeout(resolve, 1500));
      receipt = (await get('/jobs/' + encodeURIComponent(receipt.id))).job;
    }
    assert.equal(receipt.status, 'succeeded', 'model job did not succeed');
    return receipt.result;
  }
  async function createNode(key, node, spec) {
    const response = await context.request.post(api + '/jobs', {headers:{'X-Learn-User':expectedUser}, timeout:30000, data:{
      operation:'/path/node',
      body:{key, node, spec, dep_titles:[]},
      request_id:randomBytes(16).toString('hex')
    }});
    assert.equal(response.status(), 202, 'node-generation job was not accepted');
    return pollJob((await response.json()).job);
  }
  async function readMaterial(key) {
    const entries = (await get('/state/all')).entries || {};
    assert(Object.prototype.hasOwnProperty.call(entries, key), 'owned fixture is missing');
    return JSON.parse(entries[key]);
  }
  async function writeMaterial(key, material) {
    await post('/state/put', {entries:{[key]:JSON.stringify(material)}});
  }
  async function waitForSaved() {
    const deadline = Date.now() + 60000;
    let idleSince = null;
    while (Date.now() < deadline) {
      const pending = await page.evaluate(() => {
        if (!window.LearnSaves || typeof window.LearnSaves.pending !== 'function') throw new Error('save queue unavailable');
        return window.LearnSaves.pending();
      });
      if (pending) idleSince = null;
      else if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince >= 500) break;
      await page.waitForTimeout(50);
    }
    assert(idleSince !== null && Date.now() - idleSince >= 500, 'save queue did not remain idle for 500ms');
    await page.evaluate(async () => {
      if (!window.LearnSaves || typeof window.LearnSaves.drain !== 'function') throw new Error('save queue unavailable');
      await window.LearnSaves.drain();
    });
    await page.waitForFunction(() => window.LearnSaves && !window.LearnSaves.pending(), null, {timeout:60000});
  }
  function scenesIn(markdown) {
    const matches = [];
    const pattern = /```learn-scene\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = pattern.exec(markdown))) {
      try { matches.push(JSON.parse(match[1])); } catch (_) { /* Invalid source is tested separately. */ }
    }
    return matches;
  }
  async function checkValidatorBoundaries() {
    const result = await page.evaluate(() => {
      const validate = window.LearnScenes && window.LearnScenes.validate;
      if (typeof validate !== 'function') return false;
      const common = {version:1,title:'边界',summary:'数值边界'};
      const cases = [
        {...common,type:'linear_transform',matrix:[[-4,4],[4,-4]],vector:[-3,3]},
        {...common,type:'secant',coefficients:[-20,20],domain:[-5,5],baseX:2,gap:{min:0.01,max:3,value:3}},
        {...common,type:'surface_slice',coefficient:5,radius:3,height:{min:0.001,max:45,value:45}}
      ];
      if (cases.some(scene => validate(scene).type !== scene.type)) return false;
      const rejects = [
        {...cases[0],matrix:[[4.01,0],[0,1]]},
        {...cases[1],gap:{min:0.01,max:3.01,value:1}},
        {...cases[2],height:{min:0.001,max:45.01,value:1}}
      ];
      return rejects.every(scene => { try { validate(scene); return false; } catch (_) { return true; } });
    });
    assert.equal(result, true, 'scene validator rejected valid bounds or accepted an out-of-range value');
  }
  async function downloadText(button) {
    const pending = page.waitForEvent('download');
    await button.click();
    const download = await pending;
    const stream = await download.createReadStream();
    assert(stream, 'Markdown export did not create a readable download');
    let text = '';
    for await (const chunk of stream) text += chunk.toString('utf8');
    return text;
  }

  try {
    await page.goto(root + '/learn/');
    await page.locator('#login-username').fill('regression_bot');
    await page.locator('#login-password').fill(credentials.password);
    await page.locator('#login-submit').click();
    await page.waitForURL('**/learn/u/' + expectedUser + '/');
    await page.locator('#workspace').waitFor({state:'visible'});
    assert.equal((await get('/health')).revision, revision, 'backend revision differs');
    assert.equal((await (await context.request.get(root + '/learn/revision.json')).json()).revision, revision, 'site revision differs');
    report.cases.push('fixed_account_login_and_exact_revisions');

    const slug = 'learning-scenes-' + Date.now().toString(36) + '-' + randomBytes(5).toString('hex');
    const key = expectedUser + '/learn-path-v1-' + slug;
    const spec = {topic:'线性变换与列向量', level:'入门', goal:'理解矩阵列向量和向量映射'};
    const nodes = [
      {id:'matrix_scene_a', title:'矩阵如何变换向量', essence:'用矩阵列向量说明标准基底和向量的线性变换。', objectives:['正文必须包含一个合法的 learn-scene JSON 围栏，type 为 linear_transform，matrix 为 [[2,1],[1,2]]，vector 为 [1,1]。','解释两列分别映射标准基底，且 A(1,1)=(3,3)。']},
      {id:'matrix_scene_b', title:'列向量与线性组合', essence:'说明矩阵列向量如何构成向量像。', objectives:['正文必须包含一个合法的 learn-scene JSON 围栏，type 为 linear_transform，matrix 为 [[2,1],[1,2]]，vector 为 [1,1]。','说明列向量是标准基底向量的像，并解释向量如何按权重组合。']}
    ];
    const material = {title:'线性代数交互图示回归', topic:'线性变换与列向量', stage:'learning', spec,
      plan:{title:'线性变换与列向量', nodes, edges:[]}, nodeDetail:{}, nodeState:{}};
    await writeMaterial(key, material);
    let generatedNode = null, generatedDetail = null, generatedScene = null;
    for (const node of nodes) {
      const detail = await createNode(key, node, spec);
      const valid = scenesIn(String(detail.study_notes || '')).find(scene => scene.type === 'linear_transform');
      if (valid) { generatedNode = node; generatedDetail = detail; generatedScene = valid; break; }
    }
    assert(generatedNode && generatedDetail && generatedScene, 'explicit linear-algebra node request did not produce a valid learn-scene');
    assert(generatedDetail.study_notes && generatedDetail.quiz && Array.isArray(generatedDetail.quiz.questions), 'generated node does not satisfy the existing learning material contract');
    assert.deepEqual(generatedDetail.quiz.questions.map(question => question.type), ['choice','choice','choice','choice','fill','short'], 'scene authoring must preserve the six-question unit contract');
    assert.equal(generatedDetail.quiz.questions.reduce((sum, question) => sum + question.points, 0), 100, 'scene authoring must preserve the 100-point unit contract');
    report.cases.push('real_node_generation_includes_valid_linear_transform_scene');

    let persisted = await readMaterial(key);
    assert(persisted.plan.nodes.some(node => node.id === generatedNode.id), 'generated node is absent from the fixture plan');
    const generatedNotes = String(persisted.nodeDetail[generatedNode.id].study_notes || '');
    assert(scenesIn(generatedNotes).some(scene => scene.type === 'linear_transform'), 'generated scene was not saved by the learning service');
    const generatedProse = generatedNotes.replace(/```learn-scene\s*\n[\s\S]*?\n```/g, '').trim();
    const regressionNotes = generatedProse + '\n\n' + sceneFence(generatedScene) +
      '\n\n调整间距，观察割线如何接近切线。\n\n' + sceneFence(secantScene) +
      '\n\n改变高度，观察曲面与平面的交圈。\n\n' + sceneFence(surfaceScene) +
      '\n\n这段前文应继续显示。\n\n```learn-scene\n' + invalidScene + '\n```\n\n这段后文也应继续显示。';
    persisted.nodeDetail[generatedNode.id].study_notes = regressionNotes;
    await writeMaterial(key, persisted);
    report.cases.push('owned_fixture_saved_all_scene_types_and_one_invalid_fence');

    const sourceURL = root + '/learn/u/' + expectedUser + '/learning-path.html?t=' + encodeURIComponent(slug);
    await page.goto(sourceURL);
    const card = page.locator('#node-' + generatedNode.id);
    await card.locator('.node-head').click();
    await card.locator('.notes [data-scene="ready"]').first().waitFor({timeout:30000});
    await card.locator('.notes [data-scene="error"]').waitFor({timeout:30000});
    assert.equal(await card.locator('.notes [data-scene="ready"]').count(), 3, 'the three supported scenes must mount');
    assert.equal(await card.locator('.notes [data-scene="error"]').count(), 1, 'invalid scene must fail by itself');
    assert((await card.locator('.notes').innerText()).includes('这段前文应继续显示。'));
    assert((await card.locator('.notes').innerText()).includes('这段后文也应继续显示。'));
    assert.equal(await card.locator('.notes [data-scene-type="linear_transform"]').count(), 1);
    assert.equal(await card.locator('.notes [data-scene-type="secant"]').count(), 1);
    assert.equal(await card.locator('.notes [data-scene-type="surface_slice"]').count(), 1);
    report.cases.push('lesson_renders_linear_secant_surface_and_contains_invalid_scene');

    await checkValidatorBoundaries();
    report.cases.push('all_scene_type_numeric_boundaries');

    const linear = card.locator('.notes [data-scene-type="linear_transform"]');
    await linear.getByRole('button', {name:'开始演示'}).click();
    await linear.getByRole('button', {name:'暂停', exact:true}).waitFor({timeout:3000});
    await linear.getByRole('button', {name:'暂停', exact:true}).click();
    const paused = await linear.locator('svg').getAttribute('data-progress');
    await page.waitForTimeout(100);
    assert.equal(await linear.locator('svg').getAttribute('data-progress'), paused, 'pause must freeze animation progress');
    await linear.locator('select[aria-label="动画速度"]').selectOption('0.5');
    await linear.getByRole('button', {name:'继续', exact:true}).click();
    await page.waitForTimeout(100);
    assert(Number(await linear.locator('svg').getAttribute('data-progress')) > Number(paused), 'resume must advance animation progress');
    await linear.getByRole('button', {name:'下一步'}).click();
    await linear.getByRole('button', {name:'下一步'}).click();
    report.cases.push('linear_animation_pause_resume_next_and_slow_speed');

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate:4});
    const latencies = await page.evaluate(async () => {
      const durations = {};
      for (const [type, end] of [['secant', 0.33], ['surface_slice', 1.7]]) {
        const root = document.querySelector('[data-scene-type="' + type + '"]');
        const input = root.querySelector('input[type="range"]'), count = root.querySelectorAll('*').length;
        const start = performance.now();
        for (let i = 0; i < 30; i++) {
          input.value = String(Number(input.min) + (end - Number(input.min)) * i / 29);
          input.dispatchEvent(new Event('input', {bubbles:true}));
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
        durations[type] = {ms:Math.round((performance.now() - start) * 10) / 10,
          nodesStable:root.querySelectorAll('*').length === count,
          value:Number(type === 'secant' ? root.querySelector('svg').dataset.gap : root.querySelector('.learn-scene-cut').dataset.height)};
      }
      return durations;
    });
    for (const [type, expected] of [['secant', 0.33], ['surface_slice', 1.7]]) {
      assert(latencies[type].nodesStable, 'slider must reuse existing graph nodes');
      assert(Math.abs(latencies[type].value - expected) < 1e-9, 'slider must draw its latest input in the next frame');
      assert(latencies[type].ms < 150, 'slider frame exceeded 150 ms under four times CPU slowdown');
    }
    report.sliderFrameMsAt4xCPU = {secant:latencies.secant.ms, surface:latencies.surface_slice.ms};
    const secant = card.locator('.notes [data-scene-type="secant"]');
    const gap = secant.getByLabel('点间距 h（向右接近 P）');
    for (let i=0; i<16; i++) {
      await gap.evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', {bubbles:true})); }, 0.03 + i * 0.02);
    }
    await page.waitForFunction(() => {
      const svg = document.querySelector('[data-scene-type="secant"] svg');
      return svg && Math.abs(Number(svg.dataset.gap) - 0.33) < 1e-9;
    }, null, {timeout:5000});
    const surface = card.locator('.notes [data-scene-type="surface_slice"]');
    const height = surface.getByLabel('切面高度 h');
    for (let i=0; i<16; i++) {
      await height.evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', {bubbles:true})); }, 0.2 + i * 0.1);
    }
    await page.waitForFunction(() => {
      const path = document.querySelector('[data-scene-type="surface_slice"] .learn-scene-cut');
      return path && Math.abs(Number(path.dataset.height) - 1.7) < 1e-9;
    }, null, {timeout:5000});
    await surface.locator('select').selectOption('top');
    await surface.locator('select').selectOption('low');
    await surface.locator('select').selectOption('free');
    await surface.locator('svg').focus();
    const beforeRotate = await surface.locator('.learn-scene-cut').getAttribute('d');
    await page.keyboard.press('ArrowRight');
    assert.equal(await surface.locator('select').inputValue(), 'free');
    await page.waitForFunction(previous => document.querySelector('[data-scene-type="surface_slice"] .learn-scene-cut').getAttribute('d') !== previous, beforeRotate, {timeout:10000});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate:1});
    await cdp.detach();
    report.cases.push('rapid_parameter_updates_under_4x_cpu_throttle_and_three_dimensional_views');

    await checkValidatorBoundaries();
    await page.evaluate(() => {
      const host = document.createElement('section'); host.id = 'hidden-scene-regression'; host.hidden = true;
      const figure = document.createElement('figure'); figure.className = 'md-scene'; figure.dataset.scene = 'pending';
      const code = document.createElement('code'); code.textContent = JSON.stringify({version:1,type:'linear_transform',title:'隐藏场景',summary:'答案区打开后再挂载。',matrix:[[1,0],[0,1]]});
      figure.appendChild(code); host.appendChild(figure); document.body.appendChild(host);
      window.LearnMarkdown.enhance(host);
    });
    assert.equal(await page.locator('#hidden-scene-regression .learn-scene').count(), 0, 'hidden scene must not mount early');
    await page.evaluate(() => { const host=document.getElementById('hidden-scene-regression'); host.hidden=false; window.LearnMarkdown.enhance(host); });
    assert.equal(await page.locator('#hidden-scene-regression .learn-scene').count(), 1, 'revealed scene must mount when requested');
    await page.locator('#hidden-scene-regression').evaluate(element => { window.LearnMarkdown.dispose(element); element.remove(); });
    report.cases.push('hidden_scene_mounts_only_after_reveal');

    const studyExport = await downloadText(card.locator('.notes > .md-export'));
    assert(studyExport.includes('```learn-scene'), 'study Markdown export must preserve the original scene fence');
    await page.setViewportSize({width:1440,height:900});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'desktop page has horizontal overflow');
    await page.screenshot({path:path.join(output, 'learning-scenes-desktop.png'), fullPage:true});
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page has horizontal overflow at ' + width);
      assert(await card.locator('.notes').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'scene card has horizontal overflow at ' + width);
      await page.screenshot({path:path.join(output, 'learning-scenes-' + width + '.png'), fullPage:true});
    }
    report.cases.push('desktop_and_mobile_1440_390_320_layout');

    await page.setViewportSize({width:1440,height:900});
    // Obtain the condition through the issued quiz; never forge server-owned grades.
    await card.locator('[data-mat="quiz"]').click();
    await card.getByRole('button', {name:'打开测验', exact:true}).click();
    const questions = page.locator('#qd-body fieldset.qd-question');
    await questions.first().waitFor({state:'visible', timeout:120000});
    await page.waitForFunction(() => {
      const submit = document.querySelector('#qd-submit');
      return submit && !submit.disabled;
    }, null, {timeout:120000});
    assert.equal(await questions.count(), 6);
    for (let i = 0; i < await questions.count(); i++) {
      const question = questions.nth(i), choices = question.locator('.qd-option input[type="radio"]');
      if (await choices.count()) await choices.first().check();
      const blanks = question.locator('.qd-blank-input');
      for (let j = 0; j < await blanks.count(); j++) await blanks.nth(j).fill('0');
      const response = question.locator('textarea:not(.qd-blank-input)');
      if (await response.count()) await response.fill('思路：将矩阵的列按向量分量加权相加。答案：需要根据题中数值分别计算两个坐标。');
    }
    await page.locator('#qd-submit').click();
    await page.locator('.qd-result, #qd-error:not([hidden])').waitFor({timeout:480000});
    assert(!(await page.locator('#qd-error').isVisible()), 'issued quiz submission did not complete');
    const withResult = await readMaterial(key);
    assert(withResult.nodeState[generatedNode.id].lastResult, 'quiz did not persist its server result');
    await page.locator('#qd-close').click();
    await waitForSaved();
    await page.reload();
    const reopened = page.locator('#node-' + generatedNode.id);
    await reopened.locator('.node-head').click();
    assert(await reopened.locator('.mat-pane-material').evaluate(element => element.hidden), 'existing result must initially select the quiz tab');
    assert.equal(await reopened.locator('.notes .learn-scene').count(), 0, 'hidden lesson must defer its scenes');
    await reopened.locator('[data-mat="material"]').click();
    await reopened.locator('.notes [data-scene="ready"]').first().waitFor({timeout:30000});
    report.cases.push('issued_quiz_result_then_reopen_quiz_and_reveal_lesson_scenes');
    const savedAgain = await readMaterial(key);
    assert(savedAgain.nodeDetail[generatedNode.id].study_notes.includes(sceneFence(secantScene)));
    assert(savedAgain.nodeDetail[generatedNode.id].study_notes.includes(sceneFence(surfaceScene)));
    assert.equal(await reopened.locator('.notes [data-scene-type="surface_slice"]').count(), 1, 'saved lesson must render after reopening');
    report.cases.push('saved_fixture_reopens_with_original_scene_fences');

    const ask = '请用一个 learn-scene JSON 围栏展示矩阵 A=[[2,1],[1,2]] 如何作用于向量 v=[1,1]。类型必须是 linear_transform，保留简短讲解，并说明两列分别映射标准基底。不涉及测验或答案。';
    await page.locator('#ai-input').fill(ask);
    await page.locator('#ai-send').click();
    await page.waitForFunction(() => { const button=document.querySelector('#ai-send'); return button && !button.disabled; }, null, {timeout:480000});
    let aiScene = page.locator('#ai-msgs .ai-msg.assistant').last().locator('[data-scene="ready"]').last();
    if (!(await aiScene.count())) {
      await page.locator('#ai-input').fill(ask + ' 请确保 JSON 有效，所有字段和数值符合 learn-scene v1。');
      await page.locator('#ai-send').click();
      await page.waitForFunction(() => { const button=document.querySelector('#ai-send'); return button && !button.disabled; }, null, {timeout:480000});
      aiScene = page.locator('#ai-msgs .ai-msg.assistant').last().locator('[data-scene="ready"]').last();
    }
    await aiScene.waitFor({state:'visible', timeout:30000});
    assert.equal(await aiScene.getAttribute('data-scene'), 'ready', 'explicit AI diagram request must render a valid scene');
    assert.equal(await aiScene.locator('[data-scene-type]').getAttribute('data-scene-type'), 'linear_transform');
    const aiExport = await downloadText(page.locator('#ai-msgs .ai-msg.assistant').last().locator('.md-export'));
    assert(aiExport.includes('```learn-scene'), 'AI Markdown export must preserve the original scene fence');
    report.cases.push('explicit_ai_request_streams_and_renders_linear_scene');

    await waitForSaved();
    const aiKey = expectedUser + '/learn-ai-v1-' + slug;
    const aiBeforeReload = (await get('/state/all')).entries[aiKey];
    assert(aiBeforeReload && aiBeforeReload.includes('```learn-scene'), 'AI scene fence was not acknowledged by the server before reload');
    await page.reload();
    await page.locator('#node-' + generatedNode.id + ' .node-head').click();
    await page.locator('#node-' + generatedNode.id + ' [data-mat="material"]').click();
    await page.locator('#ai-msgs .ai-msg.assistant').last().locator('[data-scene="ready"]').waitFor({timeout:30000});
    const aiSaved = (await get('/state/all')).entries[aiKey];
    assert(aiSaved && aiSaved.includes('```learn-scene'), 'AI history must persist the original scene fence');
    report.cases.push('ai_scene_history_survives_page_reopen');

    assert.deepEqual(pageErrors, [], 'browser reported JavaScript errors');
    assert.deepEqual(failedAssets, [], 'learning scene JS or CSS failed to load');
    report.pageErrors = pageErrors.length;
    report.failedAssets = failedAssets;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error && error.name ? error.name : 'Error';
    report.pageErrors = pageErrors.length;
    report.failedAssets = failedAssets;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await page.screenshot({path:path.join(output, 'learning-scenes-failure.png'), fullPage:true}).catch(() => {});
    console.error('Learning-scene regression failed: ' + report.failure);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Learning-scene regression setup failed: ' + (error && error.name ? error.name : 'Error'));
  process.exitCode = 1;
});
