/* Deployed teaching rendering and depth colors. Uses only fixed regression accounts. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const environment = process.env.RELEASE_ENV;
assert(['test', 'production'].includes(environment));
const revision = process.env.RELEASE_REVISION;
assert(/^[0-9a-f]{40}$/.test(revision || ''));
const output = process.env.RELEASE_OUTPUT;
assert(path.isAbsolute(output || ''));
const repository = path.resolve(__dirname, '..');
assert(path.resolve(output) !== repository && !path.resolve(output).startsWith(repository + path.sep));
fs.mkdirSync(output, {recursive:true});
const root = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const user = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const credentials = JSON.parse(execFileSync('ssh', ['-o','BatchMode=yes','root@192.168.33.146',
  'cat /opt/study-assistant/regression-credentials/' + environment + '.json'], {encoding:'utf8'}));
assert.equal(typeof credentials.password, 'string');
const legacy = 'flowchart LR\n  A["同一个箭头<br/>大小+方向"] --> B["选定一组基 e1、e2"]\n  B --> C["坐标（3，1）"]\n  B --> D["换一组基"]\n  D --> E["坐标（1，3）"]';
const plain = legacy.replace('<br/>', '：');
const fence = source => '```mermaid\n' + source + '\n```';
const notes = '同一个向量，换一组基后，坐标可以改变。\n\n' + fence(legacy) + '\n\n' + fence(plain) +
  '\n\n公式：$v=3e_1+e_2$。\n\n| 对象 | 含义 |\n| --- | --- |\n| 向量 | 箭头大小和方向 |\n| 坐标 | 选定基后的系数 |';

async function main() {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context = await browser.newContext({viewport:{width:1440,height:1000}, acceptDownloads:true});
  const page = await context.newPage();
  const pageErrors = [], missingAssets = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  page.on('response', response => {
    if (/\.(?:js|css)(?:\?|$)/.test(response.url()) && response.status() >= 400) missingAssets.push(response.url());
  });
  const report = {environment, revision, cases:[]};
  async function get(endpoint) {
    const response = await context.request.get(api + endpoint, {headers:{'X-Learn-User':user}});
    assert.equal(response.status(), 200, endpoint + ' read failed');
    return response.json();
  }
  async function put(entries) {
    assert(Object.keys(entries).every(key => key.startsWith(user + '/')));
    const response = await context.request.post(api + '/state/put', {headers:{'X-Learn-User':user}, data:{entries}});
    assert.equal(response.status(), 200, 'own fixture write failed');
  }
  async function downloadText(button) {
    const pending = page.waitForEvent('download');
    await button.click();
    const download = await pending;
    return fs.readFileSync(await download.path(), 'utf8');
  }
  async function colors() {
    return page.locator('article.node').evaluateAll(nodes => nodes.map(node => ({
      id:node.dataset.id, depth:Number(node.dataset.depth), group:node.dataset.group,
      color:getComputedStyle(node).borderLeftColor,
      label:node.querySelector('.node-no').textContent
    })));
  }
  function checkColors(rows) {
    assert.equal(rows.length, 8);
    const distinct = [];
    for (let depth=1; depth<=4; depth++) {
      const peers = rows.filter(row => row.depth === depth);
      assert.equal(peers.length, 2);
      assert.equal(peers[0].color, peers[1].color);
      assert.notEqual(peers[0].group, peers[1].group);
      distinct.push(peers[0].color);
    }
    assert.equal(new Set(distinct).size, 4);
    return distinct;
  }
  try {
    await page.goto(root + '/learn/');
    await page.locator('#login-username').fill('regression_bot');
    await page.locator('#login-password').fill('invalid-render-regression-password');
    await page.locator('#login-submit').click();
    await page.locator('#login-error').waitFor({state:'visible'});
    await page.locator('#login-password').fill(credentials.password);
    await page.locator('#login-submit').click();
    await page.waitForURL('**/learn/u/' + user + '/');
    await page.locator('#workspace').waitFor();
    assert.equal((await get('/health')).revision, revision);
    assert.equal((await (await context.request.get(root + '/learn/revision.json')).json()).revision, revision);
    const forbidden = await context.request.get(api + '/state/all', {headers:{'X-Learn-User':'u0'}});
    assert.equal(forbidden.status(), 403);
    report.cases.push('fixed_account_login_failure_success_revisions_and_cross_user_denial');
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({path:path.join(output, 'home-' + width + '.png'),fullPage:true});
    }
    const slug = 'render-levels-' + Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
    const key = user + '/learn-path-v1-' + slug;
    const aiKey = user + '/learn-ai-v1-' + slug;
    const nodes = [];
    for (const branch of ['a','b']) {
      for (let depth=1; depth<=4; depth++) {
        nodes.push({id:branch + depth, title:depth === 1 ? '向量与坐标表示' : '第' + depth + '层补习',
          essence:'同一层使用相同颜色，向量与坐标可以使用流程图讲解。', deps:[],
          ...(depth > 1 ? {remediation:{parent:branch + (depth-1)}} : {})});
      }
    }
    nodes.find(node => node.id === 'b2').deps = ['a4'];
    const detail = {study_notes:notes, key_points:[], examples:[], misconceptions:[], quiz:{questions:[]}};
    const material = {title:'教学渲染与层级颜色回归',topic:'向量与坐标表示',stage:'learning',
      spec:{topic:'向量与坐标表示',goal:'理解向量、基与坐标'},plan:{title:'层级颜色',nodes,edges:[]},
      nodeDetail:Object.fromEntries(nodes.map(node => [node.id,detail])),
      nodeState:{b1:{completed:true},a3:{score:45}}};
    const history = {a1:[{role:'user',content:'用流程图说明向量和坐标。'},
      {role:'assistant',content:'向量不变，坐标依赖所选基。\n\n' + fence(legacy)}]};
    await put({[key]:JSON.stringify(material),[aiKey]:JSON.stringify(history)});
    const url = root + '/learn/u/' + user + '/learning-path.html?t=' + encodeURIComponent(slug);
    await page.goto(url);
    await page.locator('article.node').nth(7).waitFor();
    const before = await colors();
    report.levelColors = checkColors(before);
    assert.equal(await page.locator('#node-b1').evaluate(node => node.classList.contains('done')), true);
    assert.equal(await page.locator('#node-b2').evaluate(node => node.classList.contains('locked')), true);
    assert.equal(await page.locator('#node-a3').evaluate(node => node.classList.contains('failed')), true);
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert.deepEqual(await colors(), before);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({path:path.join(output, 'levels-' + width + '.png'),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#node-a1 .node-head').click();
    const lesson = page.locator('#node-a1 .notes');
    await lesson.locator('[data-diagram="ready"]').nth(1).waitFor();
    assert.equal(await lesson.locator('[data-diagram="failed"]').count(), 0);
    assert.equal(await lesson.locator('.md-math-fallback').count(), 0);
    assert.equal(await lesson.locator('table').count(), 1);
    assert(await lesson.locator('code').first().textContent().then(source => source.includes('<br/>')));
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await lesson.locator('figure img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await lesson.screenshot({path:path.join(output, 'legacy-diagrams-' + width + '.png')});
    }
    await page.setViewportSize({width:1440,height:1000});
    assert.equal(await downloadText(lesson.locator('.md-export')), notes);
    await lesson.getByRole('button',{name:'放大查看'}).first().click();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.locator('dialog.md-zoom').waitFor({state:'detached'});
    report.cases.push('historical_html_break_and_plain_diagrams_formula_table_mobile_export_and_zoom');
    await page.locator('#node-a1 button[data-ai="a1"]').click();
    await page.locator('#ai-msgs .ai-msg.assistant [data-diagram="ready"]').waitFor();
    assert.equal(await downloadText(page.locator('#ai-msgs .ai-msg.assistant .md-export')), history.a1[1].content);
    report.cases.push('historical_tutor_diagram_and_original_export');
    await page.locator('#ai-input').fill('请用一张简单的 Mermaid flowchart LR 图解释：向量保持不变，选基后得到坐标，换基后坐标改变。只使用四个短的纯文本标签，配一句讲解。不涉及测验题。');
    await page.locator('#ai-send').click();
    await page.waitForFunction(() => {const button=document.querySelector('#ai-send'); return button && !button.disabled;}, null, {timeout:480000});
    const latest = page.locator('#ai-msgs .ai-msg.assistant').last();
    await latest.locator('[data-diagram="ready"]').waitFor({timeout:30000});
    assert.equal(await latest.locator('[data-diagram="failed"]').count(), 0);
    assert(await latest.locator('figure img').evaluateAll(images => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)));
    const generated = await downloadText(latest.locator('.md-export'));
    assert(generated.includes('```mermaid'));
    assert(!/<br\s*\/?>/i.test(generated));
    report.cases.push('real_model_tutor_mermaid_passes_output_gate_and_renders');
    await page.evaluate(async () => {await LearnSaves.drain();});
    await page.waitForFunction(() => !LearnSaves.pending());
    const saved = JSON.parse((await get('/state/all')).entries[aiKey]);
    assert.equal(saved.a1.at(-1).content, generated);
    await page.reload();
    await page.locator('#node-a1 button[data-ai="a1"]').click();
    await page.locator('#ai-msgs .ai-msg.assistant').last().locator('[data-diagram="ready"]').waitFor();
    assert.equal(await downloadText(page.locator('#ai-msgs .ai-msg.assistant').last().locator('.md-export')), generated);
    report.cases.push('generated_tutor_reply_saved_and_reopened');
    await page.setViewportSize({width:390,height:900});
    await page.screenshot({path:path.join(output,'tutor-390.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(output,'tutor-1440.png'),fullPage:true});
    const current = JSON.parse((await get('/state/all')).entries[key]);
    await put({[key]:JSON.stringify({...current,plan:{...current.plan,nodes:current.plan.nodes.slice().reverse()}})});
    await page.goto(url);
    await page.locator('article.node').nth(7).waitFor();
    const after = await colors();
    checkColors(after);
    assert.deepEqual(Object.fromEntries(after.map(row => [row.id,row.color])),Object.fromEntries(before.map(row => [row.id,row.color])));
    report.cases.push('reordering_keeps_depth_colors_across_roots_and_states');
    await page.goto(root + '/learn/u/' + user + '/quiz-map.html');
    await page.getByRole('button',{name:'生成测验',exact:true}).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    report.cases.push('shared_uikit_quiz_page_loads');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(missingAssets, []);
    report.pageErrors = pageErrors.length;
    report.missingAssets = missingAssets.length;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.message;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(() => {});
    throw error;
  } finally {await browser.close();}
}
main().catch(error => {console.error(error.message); process.exitCode=1;});
