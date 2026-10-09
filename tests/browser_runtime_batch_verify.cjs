/* Read-only browser verification of one already completed real batch.
 * Real pages, jobs and media are used. Unexpected writes are aborted, never mocked.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const environment = process.env.RELEASE_ENV;
const engine = process.env.BROWSER_ENGINE || 'chromium';
assert(['test', 'production'].includes(environment));
assert(['chromium', 'webkit'].includes(engine));
const phone = process.env.PHONE_MODE === '1';
const revision = process.env.RELEASE_REVISION;
assert.match(revision || '', /^[0-9a-f]{40}$/);
assert(path.isAbsolute(process.env.BATCH_EXISTING_REPORT || ''), 'absolute existing report required');
assert(path.isAbsolute(process.env.BATCH_VERIFY_OUTPUT || ''), 'absolute output required');
const repository = path.resolve(__dirname, '..');
const output = path.resolve(process.env.BATCH_VERIFY_OUTPUT);
assert(output !== '/' && output !== repository && !output.startsWith(repository + path.sep));
assert(path.resolve(process.env.BATCH_EXISTING_REPORT) !== path.join(output, 'report.json'), 'output must not overwrite the source report');
const existing = JSON.parse(fs.readFileSync(process.env.BATCH_EXISTING_REPORT, 'utf8'));
assert.equal(existing.status, 'passed', 'source batch must be complete');
assert.equal(existing.environment, environment);
assert.equal(existing.revision, revision);
assert.match(existing.fixture_id || '', /^batch-runtime-[0-9a-f-]{6,36}$/);
assert.match(existing.node_details_sha256 || '', /^[0-9a-f]{64}$/);
const site = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const uid = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const fixture = existing.fixture_id;
const key = uid + '/learn-path-v1-' + fixture;
const sourceURL = new URL(existing.sourceURL);
assert.equal(sourceURL.origin, site);
assert.equal(sourceURL.pathname, '/learn/u/' + uid + '/learning-path.html');
assert.equal(sourceURL.searchParams.get('t'), fixture);
assert.deepEqual([...sourceURL.searchParams.keys()], ['t']);
fs.mkdirSync(output, {recursive:true, mode:0o700});
const viewport = phone ? {width:390, height:844} : {width:1440, height:1000};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = {environment, revision, engine, phone, viewport, fixture_id:fixture,
  mode:'deployed-read-only-existing-real-batch', cases:[], status:'running',
  generation_posts:0, retry_posts:0, state_writes:0, other_writes:0, browser_errors:[]};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), {mode:0o600});
let phase = 'setup', browser;
function passed(name) {report.cases.push(name); save();}
function noWrites() {
  assert.equal(report.generation_posts + report.retry_posts + report.state_writes + report.other_writes, 0,
    'read-only verification attempted a write');
}
async function main() {
  browser = await playwright[engine].launch({headless:true,
    ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?
      {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  const context = await browser.newContext({viewport, isMobile:phone, hasTouch:phone});
  const headers = {'X-Learn-User':uid};
  async function get(endpoint) {
    const response = await context.request.get(api + endpoint, {headers, timeout:20000});
    assert.equal(response.status(), 200, 'real read endpoint failed');
    return response.json();
  }
  async function fixtureMaterial() {
    const state = await get('/state/all');
    assert.equal(typeof state.entries?.[key], 'string', 'source fixture missing');
    return JSON.parse(state.entries[key]);
  }
  phase = 'fixed-account-and-revisions';
  const credentials = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'root@192.168.33.146',
    'cat /opt/study-assistant/regression-credentials/' + environment + '.json'], {encoding:'utf8', timeout:25000}));
  const login = await context.request.post(api + '/auth/login', {
    data:{username:'regression_bot', password:credentials.password}, timeout:20000});
  delete credentials.password;
  assert.equal(login.status(), 200, 'fixed-account login');
  assert.equal((await login.json()).user.id, uid, 'fixed-account UID');
  assert.equal((await get('/health')).revision, revision);
  const staticRevision = await context.request.get(site + '/learn/revision.json');
  assert.equal(staticRevision.status(), 200);
  assert.equal((await staticRevision.json()).revision, revision);
  passed('fixed-account-and-exact-deployed-revisions');

  phase = 'completed-fixture-preflight';
  const material = await fixtureMaterial();
  assert.equal(material.pending, null, 'batch must have no pending work');
  assert.equal(material.plan?.nodes?.length, 5);
  const nodes = material.plan.nodes;
  assert.equal(Object.keys(material.nodeDetail || {}).length, 5);
  assert.equal(hash(material.nodeDetail), existing.node_details_sha256, 'completed details match source report');
  for (const node of nodes) {
    assert.match(node.id, /^n[1-5]$/);
    const detail = material.nodeDetail[node.id];
    assert.equal(typeof detail?.study_notes, 'string');
    assert(detail.study_notes.trim(), 'completed lesson must have prose');
    assert(['passed', 'not_needed'].includes(detail.render_review?.status), 'lesson review must pass');
    assert(['passed', 'not_needed'].includes(detail.manim_review?.status), 'animation stage must be complete');
    assert.equal(detail.quiz?.questions?.length, 6);
    assert.equal(typeof detail.quiz.round_id, 'string');
    assert(detail.quiz.round_id, 'issued round ID required');
    const round = detail.quiz.rounds?.find(round => round.id === detail.quiz.round_id);
    assert(round?.verified === true, 'active round must be independently verified');
    assert.equal(round.questions.length, 6);
    assert.equal(detail.quiz.questions.reduce((sum, question) => sum + question.points, 0), 100);
  }
  const jobs = (await get('/jobs?key=' + encodeURIComponent(key))).jobs;
  assert.equal(jobs.length, 10);
  assert(jobs.every(job => job.key === key && job.status === 'succeeded'));
  assert.deepEqual(jobs.map(job => job.id).sort(), existing.jobs.map(job => job.id).sort());
  for (const node of nodes) for (const operation of ['/path/node', '/path/node/scene'])
    assert.equal(jobs.filter(job => job.node_id === node.id && job.operation === operation).length, 1);
  report.node_details_sha256 = hash(material.nodeDetail);
  passed('five-complete-lessons-with-issued-rounds-and-unchanged-details-hash');

  await context.route('**/*', async route => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/jobs') report.generation_posts++;
    else if (/^\/jobs\/[^/]+\/retry$/.test(pathname)) report.retry_posts++;
    else if (pathname.startsWith('/state/')) report.state_writes++;
    else report.other_writes++;
    save();
    return route.abort('aborted');
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.browser_errors.push(error.name));
  phase = 'existing-material-browser-render';
  await page.goto(sourceURL.href);
  await page.locator('#node-' + nodes[0].id).waitFor();
  assert.equal(await page.evaluate(() => window.LearnUser.userId), uid);
  assert.equal(await page.evaluate(() => window.LearnUser.apiBase), api);
  assert.equal(await page.evaluate(() => window.LearnPathApp.get('path.model').state.pending), null);
  assert.equal(hash(await page.evaluate(() => window.LearnPathApp.get('path.model').state.nodeDetail)), existing.node_details_sha256);
  for (const node of nodes) {
    phase = 'material-render-' + node.id;
    const card = page.locator('#node-' + node.id);
    await card.locator('.node-head').click();
    const notes = card.locator('.node-content .notes');
    await notes.waitFor({state:'visible'});
    assert(await notes.evaluate(element => !!element.textContent.trim()), 'real prose must render');
    if (material.nodeDetail[node.id].manim_review.status === 'passed')
      await notes.locator('figure[data-manim="ready"]').waitFor({timeout:45000});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page fits viewport');
    noWrites();
  }
  await page.screenshot({path:path.join(output, 'existing-material.png')});
  passed('five-existing-lessons-render-without-submission-and-fit-viewport');

  phase = 'completed-job-dialog';
  const selectedNode = nodes.at(-1);
  const job = jobs.find(job => job.node_id === selectedNode.id && job.operation === '/path/node');
  const button = page.locator('#node-' + selectedNode.id + ' .node-state .learn-job-detail-button');
  await button.waitFor({state:'visible'});
  await button.scrollIntoViewIfNeeded();
  assert.equal(await button.getAttribute('data-job-id'), job.id, 'card selects actual completed job');
  const scroll = await page.evaluate(() => scrollY);
  assert(scroll > 200, 'dialog check starts below page top');
  await button.click();
  const dialog = page.locator('dialog.learn-job-detail-panel[open]');
  await dialog.waitFor();
  await dialog.locator('.learn-job-event').first().waitFor();
  assert.equal(await dialog.count(), 1);
  assert.equal(await dialog.evaluate(element => element.parentElement === document.body), true);
  assert(await dialog.locator('.learn-job-detail-summary').evaluate(element => element.textContent.includes('已完成')));
  const disclosure = dialog.getByRole('button', {name:'确认显示模型对话'});
  await disclosure.waitFor({state:'visible'});
  const visibility = await dialog.locator('.learn-job-event').evaluateAll(rows => rows.filter(row =>
    /模型请求|模型回复/.test(row.querySelector('.learn-job-event-title')?.textContent || '')).map(row =>
    Array.from(row.querySelectorAll('.learn-job-conversation')).every(text => text.hidden)));
  assert(visibility.length > 0 && visibility.every(Boolean), 'real model messages remain hidden');
  assert(Math.abs(await page.evaluate(() => scrollY) - scroll) <= 2, 'opening details preserves page scroll');
  const box = await dialog.boundingBox();
  assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 &&
    box.y + box.height <= viewport.height + 1, 'dialog fits viewport');
  await page.screenshot({path:path.join(output, 'completed-job-dialog.png')});
  await dialog.getByRole('button', {name:'关闭', exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  assert(Math.abs(await page.evaluate(() => scrollY) - scroll) <= 2, 'closing details preserves scroll');
  await page.waitForFunction(nodeId => document.activeElement ===
    document.querySelector('#node-' + nodeId + ' .node-state .learn-job-detail-button'), selectedNode.id, {timeout:5000});
  await button.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(nodeId => document.activeElement ===
    document.querySelector('#node-' + nodeId + ' .node-state .learn-job-detail-button'), selectedNode.id, {timeout:5000});
  assert(Math.abs(await page.evaluate(() => scrollY) - scroll) <= 2, 'Escape preserves scroll');
  passed('actual-completed-job-hidden-model-dialog-scroll-close-Escape-and-focus');

  phase = 'read-only-postflight';
  await page.reload();
  await page.locator('#node-' + nodes[0].id).waitFor();
  await page.waitForTimeout(500);
  noWrites();
  const after = await fixtureMaterial();
  assert.equal(after.pending, null);
  assert.equal(hash(after.nodeDetail), existing.node_details_sha256, 'viewing must not change lessons');
  assert.deepEqual((await get('/jobs?key=' + encodeURIComponent(key))).jobs.map(job => job.id).sort(), jobs.map(job => job.id).sort());
  assert.deepEqual(report.browser_errors, []);
  passed('reload-keeps-real-job-receipts-and-original-material-with-zero-writes');
  report.status = 'passed'; save();
  console.log(JSON.stringify({status:'passed', environment, engine, phone, cases:report.cases.length,
    generation_posts:0, retry_posts:0, state_writes:0, report:path.join(output, 'report.json')}));
}
main().catch(error => {
  report.status = 'failed'; report.failure_phase = phase; report.exception = error.name; save();
  console.error(JSON.stringify({status:'failed', phase, exception:error.name, report:path.join(output, 'report.json')}));
  process.exitCode = 1;
}).finally(async () => {if (browser) await browser.close();});
