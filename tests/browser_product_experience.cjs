/* Real deployed assets and fixed-account session; all business writes are isolated. */
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const env = process.env.RELEASE_ENV || 'test',
  engine = process.env.BROWSER_ENGINE || 'chromium',
  source = process.env.SOURCE_OVERRIDE === '1';
const revision = process.env.RELEASE_REVISION,
  output = path.resolve(process.env.OUTPUT || '/tmp/product-experience-' + Date.now()),
  root = path.resolve(__dirname, '..');
assert(['test', 'production'].includes(env));
assert(['chromium', 'webkit'].includes(engine));
assert(!source || env === 'test');
assert.match(revision || '', /^[0-9a-f]{40}$/);
assert(output !== '/' && output !== root && !output.startsWith(root + path.sep));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const site = 'http://192.168.33.146:' + (env === 'test' ? 8112 : 8100),
  api = 'http://192.168.33.146:' + (env === 'test' ? 8111 : 8101),
  uid = env === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const slug = 'product-experience-fixture',
  key = uid + '/learn-path-v1-' + slug,
  title = 'LongUnbrokenEnglishLearningTitle'.repeat(12);
const questions = Array.from({ length: 4 }, (_, i) => ({
  id: 'q' + i,
  type: 'choice',
  q: '合成选择题 ' + i,
  options: ['合成选项甲', '合成选项乙'],
  answer: 'B',
  points: 10,
}));
questions.push(
  {
    id: 'q4',
    type: 'fill',
    q: '填写 ____',
    answer: '2',
    points: 20,
    blanks: [{ id: 'b1', answer: '2', points: 20, match: 'text' }],
    scoring: { mode: 'per_blank' },
  },
  {
    id: 'q5',
    type: 'short',
    q: '合成思路',
    answer: '合成答案',
    points: 40,
    rubric: [{ description: '思路', points: 40 }],
  },
);
function fixture() {
  const round = {
    id: 'fixture-round',
    questions,
    attempts: [],
    draft: { answers: ['A', '', '', '', '', '历史草稿'] },
  };
  const quiz = {
    title: '合成六题测验',
    round_id: round.id,
    questions,
    rounds: [round],
    sourceSlug: slug,
    sourceKey: key,
  };
  const learning = {
    stage: 'learning',
    title,
    topic: title,
    plan: { title, nodes: [{ id: 'n1', title: '合成当前单元', deps: [] }] },
    nodeDetail: { n1: { study_notes: '合成正文。', quiz, manim_review: { status: 'not_needed' } } },
    nodeState: { orphan: { completed: true } },
    pending: null,
  };
  return {
    quiz,
    entries: {
      [uid + '/learn-path-v1-last']: slug,
      [key]: JSON.stringify(learning),
      [uid + '/quiz-map-v1-' + slug]: JSON.stringify(quiz),
    },
    jobs: ['running', 'failed'].map((status, i) => ({
      id: String(i + 1).padStart(32, '0'),
      user_id: uid,
      key,
      node_id: 'n1',
      node_title: '合成单元',
      title,
      status,
      operation: '/path/node',
      created_ms: Date.now() - i * 1000,
      updated_ms: Date.now(),
      attempt: 1,
      error: i ? '合成失败' : '',
    })),
    failLibrary: false,
    failTasks: false,
    readOnly: false,
    draftWrites: 0,
  };
}
const report = {
  mode: 'real-session-and-revisions-with-isolated-business-http-fixtures',
  server_writes_scope: 'business learning data; authentication creates a real session',
  environment: env,
  browser: engine,
  revision,
  source_overrides: source,
  passed: false,
  model_calls: 0,
  server_writes: 0,
  fixture_writes: 0,
  persistence_events: [],
  cases: [],
  pageerrors: [],
  console_errors: [],
  asset_failures: [],
  blocked: [],
  route_errors: [],
  screenshots: [],
};
let browser,
  page,
  phase = 'setup';
function save() {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
function pass(name) {
  report.cases.push(name);
  save();
}
function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'Access-Control-Allow-Origin': site,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, X-Learn-User',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
    body: status === 204 ? '' : JSON.stringify(body),
  });
}
async function routeSafely(context, pattern, handler) {
  return context.route(pattern, async (route) => {
    try {
      await handler(route);
    } catch (error) {
      report.route_errors.push({
        path: new URL(route.request().url()).pathname,
        method: route.request().method(),
        name: error.name,
      });
      await json(route, 502, { error: '合成回归路由失败' }).catch(() => {});
    }
  });
}
// Navigation can cancel a Playwright-routed pagehide keepalive before its fixture
// handler runs. Flush the application's debounce and await its actual JSON ack;
// local recovery must never be removed or hidden by the test.
async function settlePersistence(label) {
  await page.evaluate(async () => {
    if (!window.LearnSaves) return;
    window.LearnSaves.assertReady();
    if (location.pathname.endsWith('/learning-path.html') && window.LearnPathApp) {
      const persistence = window.LearnPathApp.get('path.persistence');
      await persistence.flushSave();
      await persistence.waitForWrites();
    }
    await window.LearnSaves.drain();
    window.LearnSaves.assertReady();
  });
  const state = await page.evaluate(() => ({
    pending: !!window.LearnSaves?.pending(),
    recoveryVisible: !!document.querySelector('[data-status-key="state-save"][data-kind="error"]'),
    cachedKeys: Object.keys(
      JSON.parse(localStorage.getItem('learn-unsaved-v1/' + window.LearnUser?.userId) || '{}'),
    ).length,
  }));
  report.persistence_events.push({ event: 'checkpoint', label, ...state });
  save();
  assert.equal(state.pending, false, 'no unacknowledged learning state');
  assert.equal(state.cachedKeys, 0, 'no unexpected emergency recovery cache');
  assert.equal(state.recoveryVisible, false, 'no unexpected recovery or save failure banner');
}
async function navigate(url) {
  if (await page.evaluate(() => !!window.LearnSaves)) await settlePersistence('before-navigation');
  return page.goto(url);
}
async function shot(name) {
  if (name !== 'failure') await settlePersistence(name);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  report.screenshots.push(name + '.png');
}
async function geometry(mobile) {
  assert(
    await page.evaluate(
      (width) => document.documentElement.scrollWidth <= width + 1,
      page.viewportSize().width,
    ),
    'whole page fits physical viewport',
  );
  if (mobile)
    assert.equal(
      await page
        .locator('button.btn:visible,a.btn:visible,.lib-del:visible')
        .evaluateAll((es) => es.filter((e) => e.getBoundingClientRect().height < 43.5).length),
      0,
      'mobile target height 44px',
    );
}
async function intercept(context, f) {
  await routeSafely(context, api + '/**', async (route) => {
    const r = route.request(),
      p = new URL(r.url()).pathname,
      m = r.method();
    if (m === 'OPTIONS') return json(route, 204);
    if (p === '/auth/session' && m === 'GET')
      return f.readOnly
        ? json(route, 200, {
            user: { id: uid, username: 'regression_bot', name: '合成只读', role: 'admin' },
            target: { id: uid, display_name: '合成查看对象' },
            read_only: true,
          })
        : json(route, 200, await (await route.fetch()).json());
    if (p === '/state/all' && m === 'GET')
      return json(
        route,
        f.failLibrary ? 503 : 200,
        f.failLibrary ? { error: '合成资料失败' } : { ok: true, entries: f.entries },
      );
    if (p === '/jobs' && m === 'GET')
      return json(
        route,
        f.failTasks ? 503 : 200,
        f.failTasks ? { error: '合成任务失败' } : { ok: true, jobs: f.jobs },
      );
    if (/^\/jobs\/[^/]+(?:\/details)?$/.test(p) && m === 'GET')
      return json(route, 200, {
        ok: true,
        job: f.jobs.find((j) => j.id === p.split('/')[2]),
        details: { available: true, events: [{ id: 1, kind: 'phase', content: '合成日志' }] },
      });
    if (p === '/path/quiz/state' && m === 'POST') return json(route, 200, f.quiz);
    if (!f.readOnly && p === '/path/quiz/draft' && m === 'POST') {
      const b = r.postDataJSON();
      assert.equal(b.round_id, f.quiz.round_id);
      f.quiz.rounds[0].draft = { answers: b.answers };
      f.draftWrites++;
      report.fixture_writes++;
      return json(route, 200, { draft: f.quiz.rounds[0].draft });
    }
    if (!f.readOnly && p === '/state/put' && m === 'POST') {
      const b = r.postDataJSON();
      assert(Object.keys(b.entries).every((k) => k.startsWith(uid + '/')));
      report.persistence_events.push({ event: 'received', keys: Object.keys(b.entries).length });
      Object.assign(f.entries, b.entries);
      report.fixture_writes++;
      await json(route, 200, { ok: true });
      report.persistence_events.push({
        event: 'acknowledged',
        keys: Object.keys(b.entries).length,
      });
      return;
    }
    report.blocked.push({ path: p, method: m });
    if (p.startsWith('/path/')) report.model_calls++;
    return json(route, 409, { error: '合成回归拒绝未声明接口' });
  });
  await routeSafely(context, site + '/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (!source) return route.fulfill({ response: await route.fetch() });
    let file;
    if (/^\/learn\/u\/[^/]+\/$/.test(p)) file = 'home/index.html';
    else if (/\/learn\/u\/[^/]+\/(learning-path|quiz-map)\.html$/.test(p))
      file = 'learning-path/' + path.basename(p);
    else if (p.startsWith('/diagram-design/learning-path/'))
      file = 'learning-path/' + path.basename(p);
    else if (p.startsWith('/learn/assets/'))
      file = ['home.js', 'home.css'].includes(path.basename(p))
        ? 'home/' + path.basename(p)
        : 'shared/' + path.basename(p);
    if (!file || !fs.existsSync(path.join(root, file)))
      return route.fulfill({ response: await route.fetch() });
    return route.fulfill({
      contentType: p.endsWith('.css')
        ? 'text/css'
        : p.endsWith('.js')
          ? 'application/javascript'
          : 'text/html',
      body: fs.readFileSync(path.join(root, file)),
    });
  });
}
async function quizCheck(device, f, kind) {
  await navigate(site + '/learn/u/' + uid + '/' + kind + '.html?t=' + slug);
  phase = device + ' ' + kind + ' quiz';
  if (kind === 'learning-path') {
    await page.locator('#node-n1 .node-head').click();
    if (device === 'mobile' && (await page.locator('#ai-input').isVisible()))
      assert(
        await page
          .locator('#ai-input')
          .evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 16),
        'mobile AI input prevents focus zoom',
      );
    await page.locator('#node-n1 [data-mat="quiz"]').click();
  }
  await page.getByRole('button', { name: '打开测验', exact: true }).click();
  await page.locator('#qd-answer-4-blank-0').waitFor();
  assert.equal(await page.locator('.qd-question').count(), 6);
  assert(
    (await page.locator('.qd-option').first().textContent()).includes('合成选项甲'),
    'choice option content renders',
  );
  if (device === 'mobile')
    for (const selector of ['#qd-answer-4-blank-0', '#qd-answer-5'])
      assert(
        await page
          .locator(selector)
          .evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 16),
        'mobile quiz inputs prevent focus zoom',
      );
  assert.equal(await page.locator('.qd-reference-content:visible').count(), 0);
  if (!f.draftWrites) assert.equal(await page.locator('#qd-answer-5').inputValue(), '历史草稿');
  const before = f.draftWrites;
  await page.locator('[name="qd-answer-0"][value="B"]').check();
  await page.locator('#qd-answer-4-blank-0').fill(kind === 'learning-path' ? '2' : '22');
  await page.waitForFunction(
    () => document.querySelector('#qd-save')?.textContent === '已自动保存到服务器',
  );
  assert(f.draftWrites > before, 'draft intercepted');
  await page.locator('#qd-close').click();
  await page.getByRole('button', { name: '打开测验', exact: true }).click();
  await page.locator('#qd-answer-4-blank-0').waitFor();
  assert.equal(
    await page.locator('#qd-answer-4-blank-0').inputValue(),
    kind === 'learning-path' ? '2' : '22',
  );
  assert(await page.locator('[name="qd-answer-0"][value="B"]').isChecked());
  assert(await page.locator('#qd-body').evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  await shot(device + '-' + kind + '-quiz');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#quiz-workspace').evaluate((e) => e.open), false);
  pass(device + ' ' + kind + ' six questions, draft restore, hidden references and Escape');
}
(async () => {
  try {
    browser = await pw[engine].launch({ headless: true });
    phase = 'real authentication and revisions';
    const auth = await browser.newContext();
    const credentials = JSON.parse(
      execFileSync(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          'root@192.168.33.146',
          'cat /opt/study-assistant/regression-credentials/' + env + '.json',
        ],
        { encoding: 'utf8' },
      ),
    );
    const denied = await auth.request.post(api + '/auth/login', {
      data: { username: 'regression_bot', password: 'synthetic-invalid-password' },
    });
    assert([400, 401, 403].includes(denied.status()));
    const login = await auth.request.post(api + '/auth/login', {
      data: { username: 'regression_bot', password: credentials.password },
    });
    credentials.password = '';
    phase = 'successful login status';
    assert.equal(login.status(), 200);
    phase = 'fixed UID';
    assert.equal((await login.json()).user.id, uid);
    phase = 'backend revision';
    assert.equal((await (await auth.request.get(api + '/health')).json()).revision, revision);
    phase = 'static revision';
    assert.equal(
      (await (await auth.request.get(site + '/learn/revision.json')).json()).revision,
      revision,
    );
    for (const target of ['u0', env === 'test' ? 'ub3fd33db1b3e5638' : 'u370119af344c603c']) {
      const response = await auth.request.get(api + '/state/all', {
        headers: { 'X-Learn-User': target },
      });
      assert(target === 'u0' ? response.status() === 403 : [403, 404].includes(response.status()));
    }
    const storage = await auth.storageState();
    phase = 'natural deployed home smoke';
    let naturalWrites = 0;
    await auth.route(api + '/**', (route) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
      naturalWrites++;
      return route.abort('blockedbyclient');
    });
    const natural = await auth.newPage();
    const naturalErrors = [];
    natural.on('pageerror', (e) => naturalErrors.push(e.name));
    const naturalReads = Promise.all(
      ['/state/all', '/jobs'].map((endpoint) =>
        natural.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return (
              url.origin === api &&
              url.pathname === endpoint &&
              response.request().method() === 'GET'
            );
          },
          { timeout: 15000 },
        ),
      ),
    );
    await natural.goto(site + '/learn/u/' + uid + '/');
    const [stateResponse, jobsResponse] = await naturalReads;
    assert(stateResponse.ok() && jobsResponse.ok(), 'natural deployed business GETs succeed');
    const stateSnapshot = await stateResponse.json(),
      jobsSnapshot = await jobsResponse.json();
    assert(
      stateSnapshot.entries &&
        typeof stateSnapshot.entries === 'object' &&
        !Array.isArray(stateSnapshot.entries),
      'natural state response has an entries object',
    );
    assert(Array.isArray(jobsSnapshot.jobs), 'natural jobs response has an array');
    assert.equal(await natural.locator('#library-error:visible').count(), 0);
    assert.equal(
      await natural.locator('[data-status-key="state-save"][data-kind="error"]:visible').count(),
      0,
    );
    await natural.locator('#workspace').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await natural.evaluate(() => window.LearnUser.user.id), uid);
    assert.equal(naturalWrites, 0);
    assert.deepEqual(naturalErrors, []);
    pass(
      'natural deployed home ready with actual GET assets/session, no learning writes or real-data artifacts',
    );
    await auth.close();
    pass('real login failure/success, fixed UID, revisions');
    for (const mobile of [false, true]) {
      const device = mobile ? 'mobile' : 'desktop',
        f = fixture();
      phase = device + ' home';
      const context = await browser.newContext({
        storageState: storage,
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      await intercept(context, f);
      page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.setDefaultNavigationTimeout(20000);
      page.on('requestfailed', (r) => {
        if (r.url().startsWith(site))
          report.asset_failures.push({
            path: new URL(r.url()).pathname,
            error: r.failure()?.errorText,
          });
      });
      page.on('pageerror', (e) =>
        report.pageerrors.push({
          name: e.name,
          message: e.message.split('\n')[0].replace(/https?:[^\s]+/g, '[URL]'),
        }),
      );
      page.on('console', (m) => {
        if (m.type() === 'error')
          report.console_errors.push({
            phase,
            type: 'error',
            message: m
              .text()
              .split('\n')[0]
              .replace(/https?:[^\s]+/g, '[URL]'),
          });
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && r.url().startsWith(site))
          report.asset_failures.push({ path: new URL(r.url()).pathname, status: r.status() });
      });
      await navigate(site + '/learn/u/' + uid + '/');
      phase = device + ' home list';
      await page.locator('#map-list .row').waitFor();
      assert.equal(await page.evaluate(() => window.LearnUser.user.id), uid);
      assert((await page.locator('#map-list').textContent()).includes('0/1'));
      phase = device + ' library failure';
      f.failLibrary = true;
      await page.locator('#refresh-library').click();
      await page.locator('#library-error').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#map-list .row').count(), 1);
      f.failLibrary = false;
      await page.locator('#refresh-library').click();
      await page.locator('#library-error').waitFor({ state: 'hidden' });
      phase = device + ' tasks failure';
      f.failTasks = true;
      await page.locator('#refresh-tasks').click();
      await page.getByText('任务状态暂时不可用：', { exact: false }).waitFor();
      f.failTasks = false;
      await page.locator('#refresh-tasks').click();
      await page.getByText('任务状态暂时不可用：', { exact: false }).waitFor({ state: 'hidden' });
      const detail = page.locator('#task-list .learn-job-detail-button').first();
      await detail.focus();
      await detail.evaluate((e) => (window.__stableTask = e));
      await page.waitForTimeout(5300);
      assert(
        await detail.evaluate((e) => e === window.__stableTask && e === document.activeElement),
      );
      await detail.click();
      await page.locator('dialog.learn-job-detail-panel[open]').waitFor();
      await page.keyboard.press('Escape');
      assert(await detail.evaluate((e) => e === document.activeElement));
      await geometry(mobile);
      await shot(device + '-home');
      pass(device + ' home error/recovery, stable polling/focus, detail and geometry');
      phase = device + ' library and deletion';
      await navigate(site + '/learn/u/' + uid + '/learning-path.html?t=' + slug);
      await page.locator('#node-n1').waitFor();
      phase = device + ' library failure';
      f.failLibrary = true;
      await page.locator('#lib-btn').click();
      await page.getByRole('button', { name: '重试加载资料库' }).waitFor();
      assert.equal(
        await page.locator('#lib-pop .lib-empty').filter({ hasText: '暂无' }).count(),
        0,
      );
      f.failLibrary = false;
      await page.getByRole('button', { name: '重试加载资料库' }).click();
      await page.locator('#lib-pop .lib-del').first().waitFor();
      await geometry(mobile);
      await shot(device + '-library');
      const trigger = page.locator('#lib-pop .lib-del').first();
      await trigger.click();
      await page.locator('dialog#del-modal[open]').waitFor();
      await page.locator('#dm-pass').fill('synthetic-never-submit');
      await shot(device + '-delete');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#dm-pass').inputValue(), '');
      assert(await trigger.evaluate((e) => e === document.activeElement));
      await page.keyboard.press('Escape');
      pass(device + ' library failure/retry and delete cancel/password/focus');
      await navigate(site + '/learn/u/' + uid + '/learning-path.html?new=1');
      await page.getByRole('textbox', { name: '学习需求或回答', exact: true }).waitFor();
      pass(device + ' accessible requirement input');
      for (const kind of ['learning-path', 'quiz-map']) await quizCheck(device, f, kind);
      phase = device + ' quiz catalog';
      f.failLibrary = true;
      await navigate(site + '/learn/u/' + uid + '/quiz-map.html');
      await page.locator('[data-catalog-retry]').waitFor();
      f.failLibrary = false;
      await page.locator('[data-catalog-retry]').click();
      await page.locator('[data-gen]').first().waitFor();
      pass(device + ' quiz catalog failure and recovery');
      f.readOnly = true;
      phase = device + ' readonly';
      await navigate(site + '/learn/u/' + uid + '/');
      await page.locator('#map-list .row').waitFor();
      assert.equal(await page.locator('#tools-section').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: '重试此任务', exact: true }).count(), 0);
      await navigate(site + '/learn/u/' + uid + '/learning-path.html?t=' + slug);
      await page.locator('#node-n1').waitFor();
      await page.locator('#lib-btn').click();
      await page.locator('#lib-pop .lib-item').first().waitFor();
      assert.equal(await page.locator('#lib-pop .lib-del').count(), 0);
      assert.equal(await page.locator('#lib-pop a[href*="new=1"]').count(), 0);
      const before = report.fixture_writes;
      await page.evaluate(() => {
        const lib = window.LearnPathApp.get('path.library');
        lib.openDelModal('synthetic', '合成');
        lib.submitDel();
        lib.restart();
      });
      assert.equal(report.fixture_writes, before);
      assert.equal(await page.locator('#del-modal').evaluate((e) => e.open), false);
      await navigate(site + '/learn/u/' + uid + '/quiz-map.html');
      await page.locator('a.lrow[href*="quiz-map.html?t="]').waitFor();
      assert.equal(await page.locator('[data-gen]:visible').count(), 0);
      await page.locator('a.lrow[href*="quiz-map.html?t="]').click();
      await page.getByRole('button', { name: '打开测验', exact: true }).waitFor();
      await page.getByRole('button', { name: '打开测验', exact: true }).first().click();
      await page.locator('.qd-question').first().waitFor();
      assert.equal(await page.locator('.qd-question').count(), 6);
      pass(
        device + ' readonly creation/deletion hidden, direct mutation guarded and saved exam opens',
      );
      await context.close();
      page = null;
    }
    const received = report.persistence_events.filter((event) => event.event === 'received').length;
    const acknowledged = report.persistence_events.filter(
      (event) => event.event === 'acknowledged',
    ).length;
    assert(received > 0, 'actual fixture state PUTs observed');
    assert.equal(acknowledged, received, 'every fixture state PUT has a JSON acknowledgement');
    assert.deepEqual(report.blocked, []);
    assert.deepEqual(report.route_errors, []);
    assert.deepEqual(report.pageerrors, []);
    assert.deepEqual(report.asset_failures, []);
    assert.equal(report.model_calls, 0);
    assert.equal(report.server_writes, 0);
    report.passed = true;
    save();
    console.log(
      JSON.stringify({
        passed: true,
        report: path.join(output, 'report.json'),
        cases: report.cases.length,
        model_calls: 0,
        server_writes: 0,
      }),
    );
  } catch (e) {
    report.failure_phase = phase;
    report.failure = {
      name: e.name,
      code: e.code || null,
      summary: String(e.message)
        .split('\n')[0]
        .replace(/https?:[^\s]+/g, '[URL]'),
    };
    save();
    if (page)
      report.dom = await page
        .evaluate(() => ({
          libraryHidden: document.querySelector('#lib-pop')?.hidden,
          retryCount: document.querySelectorAll('.lib-retry').length,
          libraryRows: document.querySelectorAll('#lib-pop .lib-row').length,
        }))
        .catch(() => null);
    save();
    if (page) await shot('failure').catch(() => {});
    console.error(
      JSON.stringify({
        passed: false,
        phase,
        error: e.name,
        report: path.join(output, 'report.json'),
      }),
    );
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
