/* Deployed release checks. Use only the fixed regression account in each environment. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const environment = process.env.RELEASE_ENV || 'test';
assert(['test', 'production'].includes(environment));
const root = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const expectedUser = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const credentials = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'root@192.168.33.146', 'cat /opt/study-assistant/regression-credentials/' + environment + '.json'], {encoding:'utf8'}));
const fixture = JSON.parse(fs.readFileSync(process.env.RELEASE_FIXTURE_REPORT, 'utf8'));
assert(fixture.sourceKey.startsWith(expectedUser + '/learn-path-v1-'));
const output = process.env.RELEASE_OUTPUT;
fs.mkdirSync(output, {recursive:true});

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage(), errors = [], assets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\.(?:js|css)(?:\?|$)/.test(response.url()) && response.status() >= 400) assets.push(response.url());
  });
  const report = {environment, revision:process.env.RELEASE_REVISION, cases:[]};
  async function request(path, data) {
    const options = {headers:{'X-Learn-User':expectedUser}, timeout:240000};
    const response = data === undefined ? await context.request.get(api + path, options) : await context.request.post(api + path, {...options, data});
    assert(response.ok(), path + ' HTTP ' + response.status());
    return response.json();
  }
  async function material() {return JSON.parse((await request('/state/all')).entries[fixture.sourceKey]);}
  async function job(operation, body) {
    console.log('Checking ' + operation);
    let receipt = (await request('/jobs', {operation, body, request_id:randomBytes(16).toString('hex')})).job;
    const deadline = Date.now() + 720000;
    while (['queued','running'].includes(receipt.status)) {
      assert(Date.now() < deadline, operation + ' exceeded regression deadline');
      await new Promise(resolve => setTimeout(resolve, 1500));
      receipt = (await request('/jobs/' + receipt.id)).job;
    }
    assert.equal(receipt.status, 'succeeded', operation + ' failed: ' + (receipt.error || receipt.status));
    return receipt.result;
  }
  try {
    await page.goto(root + '/learn/');
    await page.locator('#login-username').fill('regression_bot');
    await page.locator('#login-password').fill('invalid-regression-password');
    await page.locator('#login-submit').click();
    await page.locator('#login-error').waitFor({state:'visible'});
    await page.locator('#login-password').fill(credentials.password);
    await page.locator('#login-submit').click();
    await page.waitForURL('**/learn/u/' + expectedUser + '/');
    await page.locator('#workspace').waitFor({state:'visible'});
    assert.equal((await request('/health')).revision, process.env.RELEASE_REVISION);
    assert.equal((await (await context.request.get(root + '/learn/revision.json')).json()).revision, process.env.RELEASE_REVISION);
    report.cases.push('login_failure_success_and_exact_backend_site_revision');
    for (const path of ['/admin/users', '/state/all']) {
      const response = await context.request.get(api + path, {headers:{'X-Learn-User':'u0'}});
      assert.equal(response.status(), 403);
    }
    const crossWrite = await context.request.post(api + '/state/put', {data:{entries:{'u0/learn-path-v1-forbidden':'{}'}}});
    assert.equal(crossWrite.status(), 403);
    const own = (await request('/state/all')).entries;
    assert(Object.keys(own).every(key => key.startsWith(expectedUser + '/')));
    report.cases.push('cross_user_read_write_and_admin_denied');
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({path:output + '/home-' + width + '.png', fullPage:true});
    }
    const source = await material();
    const node = source.plan.nodes.find(item => !(item.deps || []).length);
    assert(node, 'Fixture has an unlocked node');
    const detail = await job('/path/node', {key:fixture.sourceKey, node, spec:source.spec, dep_titles:[]});
    assert(detail.study_notes && detail.quiz.questions.length >= 6);
    report.cases.push('real_model_node_generation_and_validation');
    await page.goto(fixture.sourceURL);
    await page.locator('#node-' + node.id).click();
    await page.locator('#node-' + node.id + ' button[data-mat="quiz"]').click();
    await page.getByRole('button', {name:/^(打开测验|查看作答与批改)$/}).click();
    await page.locator('#qd-submit').waitFor();
    await page.waitForFunction(() => {
      const questions = Array.from(document.querySelectorAll('#qd-body fieldset.qd-question'));
      if (questions.length !== 6) return false;
      const choice = questions.filter(fieldset => fieldset.querySelector('.qd-option input[type="radio"]')).length;
      const fill = questions.filter(fieldset => fieldset.querySelector('.qd-blank-input')).length;
      const short = questions.filter(fieldset => fieldset.querySelector('textarea:not(.qd-blank-input)')).length;
      return choice === 4 && fill === 1 && short === 1;
    }, {}, {timeout:120000});
    const questionFields = page.locator('#qd-body fieldset.qd-question');
    const layout = await questionFields.evaluateAll(fields => ({
      questions:fields.length,
      choice:fields.filter(field => field.querySelector('.qd-option input[type="radio"]')).length,
      fill:fields.filter(field => field.querySelector('.qd-blank-input')).length,
      short:fields.filter(field => field.querySelector('textarea:not(.qd-blank-input)')).length
    }));
    assert.deepEqual(layout, {questions:6,choice:4,fill:1,short:1});
    for (let i=0; i<await questionFields.count(); i++) {
      const question = questionFields.nth(i), radios = question.locator('.qd-option input[type="radio"]');
      if (await radios.count()) await radios.first().check();
      const blanks = question.locator('.qd-blank-input');
      for (let j=0; j<await blanks.count(); j++) await blanks.nth(j).fill('7');
      const freeResponse = question.locator('textarea:not(.qd-blank-input)');
      if (await freeResponse.count()) await freeResponse.fill('按协议规则核对，并说明判断依据。');
    }
    await page.locator('#qd-submit').click();
    await page.locator('.qd-result, #qd-error:not([hidden])').waitFor({timeout:240000});
    if (await page.locator('#qd-error').isVisible()) {
      throw new Error('Quiz submission failed: ' + await page.locator('#qd-error').innerText());
    }
    await page.locator('.qd-result').waitFor({timeout:240000});
    const saved = await material();
    assert(saved.nodeDetail[node.id].quiz.rounds.some(round => round.attempts.length > 0));
    report.cases.push('real_model_grading_and_server_attempt_history');
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await page.locator('#qd-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({path:output + '/quiz-' + width + '.png', fullPage:true});
    }
    await page.keyboard.press('Escape');
    await page.locator('#quiz-workspace').waitFor({state:'hidden'});
    const streamed = await context.request.post(api + '/ask', {headers:{'X-Learn-User':expectedUser}, timeout:240000,
      data:{unit:{unit_id:node.id, title:node.title, topic:source.topic}, question:'只用一句话说明为什么蓝色标记的箱子不能转运。', history:[]}});
    assert.equal(streamed.status(), 200);
    assert.match(streamed.headers()['content-type'], /text\/event-stream/);
    const streamMessages = (await streamed.text()).split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5).trim()));
    assert(streamMessages.some(message => message.done === true));
    assert(streamMessages.some(message => typeof message.delta === 'string' && message.delta.length > 0));
    assert(streamMessages.every(message => !message.error));
    report.cases.push('real_model_tutor_sse_completed');
    const patched = {...await material(), architectureRegression:true};
    await page.route('**/state/put', route => route.abort('failed'));
    await page.evaluate(async data => {try {await window.LearnUser.request('/state/put', data);} catch (_) {}}, {entries:{[fixture.sourceKey]:JSON.stringify(patched)}});
    assert(await page.evaluate(() => window.LearnSaves.pending()));
    await page.unroute('**/state/put');
    await page.evaluate(() => window.LearnSaves.retry());
    assert(!(await page.evaluate(() => window.LearnSaves.pending())));
    assert.equal((await material()).architectureRegression, true);
    report.cases.push('offline_save_visible_retry_and_server_recovery');
    let failed = (await request('/jobs', {operation:'/path/requiz', body:{key:fixture.sourceKey, node:{id:'missing-node'}}, request_id:randomBytes(16).toString('hex')})).job;
    const failureDeadline = Date.now() + 30000;
    while (['queued','running'].includes(failed.status)) {
      assert(Date.now() < failureDeadline);
      await new Promise(resolve => setTimeout(resolve, 300));
      failed = (await request('/jobs/' + failed.id)).job;
    }
    assert.equal(failed.status, 'failed');
    assert(failed.response_status >= 400);
    await page.goto(root + '/learn/u/' + expectedUser + '/');
    await page.locator('#tasks-panel').waitFor({state:'visible'});
    assert((await page.locator('#task-list').innerText()).includes('未完成'));
    report.cases.push('failed_job_and_home_retry_feedback');
    await page.getByRole('button', {name:'退出登录', exact:true}).click();
    await page.waitForURL(root + '/learn/');
    await page.locator('#login-panel').waitFor({state:'visible'});
    report.cases.push('logout_returns_to_login');
    assert.deepEqual(errors, []);
    assert.deepEqual(assets, []);
    report.pageErrors = errors; report.missingAssets = assets;
    fs.writeFileSync(output + '/report.json', JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.message; report.pageErrors = errors; report.missingAssets = assets;
    fs.writeFileSync(output + '/report.json', JSON.stringify(report,null,2));
    await page.screenshot({path:output + '/failure.png', fullPage:true}).catch(() => {});
    throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error.message); process.exitCode = 1;});
