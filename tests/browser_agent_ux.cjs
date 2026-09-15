/* Browser contract for reading and Agent context. All requests stay in fixtures. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.AGENT_UX_OUTPUT || path.join(os.tmpdir(), 'browser-agent-ux');
fs.mkdirSync(output, {recursive: true});
const notes = Array.from({length: 30}, (_, i) => '## 阅读段落 ' + i + '\n\n长材料中的原生页面滚动与固定辅导输入。'.repeat(8)).join('\n\n');
const questions = [{id:'q1',type:'choice',q:'验证测验仍在单元中打开',options:{A:'正确',B:'错误'},answer:'A',points:100,scoring:{mode:'single_choice'}}];
const quiz = {round_id:'agent-round',questions,rounds:[{id:'agent-round',harness_version:2,questions,attempts:[],draft:{answers:['']}}]};
const fixture = {
  stage: 'learning', topic: 'Agent 阅读回归', pending: null,
  plan: {title: 'Agent 阅读回归', summary: '章节切换与流式对话', nodes: ['n1', 'n2'].map(id => ({id, title: '章节 ' + id, essence: '阅读与提问', deps: [], objectives: []}))},
  nodeDetail: Object.fromEntries(['n1', 'n2'].map(id => [id, {study_notes: notes, key_points: [], traps: [], quiz}])),
  nodeState: {n1:{score:50}},
};
const history = Object.fromEntries(['n1', 'n2'].map(id => [id, Array.from({length: 24}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: id + ' 历史 ' + i + '：' + '保留阅读位置。'.repeat(18)}))]));

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const report = {cases: [], errors: []};
  page.on('pageerror', e => report.errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('learning-path.html')) return route.fulfill({contentType: 'text/html', body: fs.readFileSync(path.join(root, 'learning-path/learning-path.html'), 'utf8')});
    return route.fulfill({contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: ''});
  });
  await page.addInitScript(({fixture, history}) => {
    const entries = {'u0/learn-path-v1-agent-ux': JSON.stringify(fixture), 'u0/learn-ai-v1-agent-ux': JSON.stringify(history)};
    window.__agentChunks = [];
    window.LearnUser = {apiBase: 'http://agent.invalid/api', userId: 'u0', readOnly: false, ready: Promise.resolve(), link: p => p, fetch: async (url, options) => {
      if (url.endsWith('/ask')) {
        return new Response(new ReadableStream({start(controller) { window.__agentChunks.push(controller); }}), {status: 200});
      }
      if (url.endsWith('/state/put')) Object.assign(entries, JSON.parse(options.body).entries || {});
      if(url.endsWith('/path/quiz/state'))return new Response(JSON.stringify(fixture.nodeDetail.n1.quiz));
      if(url.endsWith('/path/refine'))return new Response(JSON.stringify({plan:JSON.parse(JSON.stringify(fixture.plan)),added:0}));
      return new Response(JSON.stringify({ok: true, entries}), {headers: {'Content-Type': 'application/json'}});
    }};
  }, {fixture, history});
  async function select(id) { await page.locator('#node-' + id + ' .node-head').click(); }
  async function chunk(text, finish = false) {
    await page.evaluate(({text, finish}) => {
      const stream = window.__agentChunks[0];
      stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({delta: text}) + '\n\n'));
      if (finish) stream.close();
    }, {text, finish});
  }
  try {
    await page.goto('http://agent.invalid/learn/u/u0/learning-path.html?t=agent-ux');
    await select('n1');
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({width, height: 1000});
      await page.waitForTimeout(80);
      if(width>800)assert(await page.locator('#ai-input').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'initial compose visible at '+width);
      const geometry = await page.locator('.unit-scroll').evaluate(e => ({overflow: getComputedStyle(e).overflowY, height: e.clientHeight, scroll: e.scrollHeight}));
      assert(!['auto', 'scroll'].includes(geometry.overflow), 'reading must scroll with the document');
      assert(geometry.height > 1000, 'fixture must exercise long material');
      await page.screenshot({path: output + '/reading-' + width + '.png'});
    }
    report.cases.push('document_reading_1440_1024_390');
    await page.setViewportSize({width: 1440, height: 1000});
    await page.evaluate(() => scrollTo(0, 1300));
    assert(await page.locator('#ai-input').evaluate(e => {const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}), 'sticky compose visible');
    await page.locator('#ai-input').fill('章节A草稿');
    await page.locator('#ai-msgs').evaluate(e => { e.scrollTop = 100; });
    await page.waitForTimeout(50);
    await select('n2');await page.locator('#ai-input').fill('章节B草稿');await select('n1');
    assert.equal(await page.locator('#ai-input').inputValue(), '章节A草稿');
    assert(Math.abs(await page.locator('#ai-msgs').evaluate(e => e.scrollTop) - 100) < 5);
    report.cases.push('draft_and_history_per_chapter');
    await page.locator('#ai-send').click();await page.waitForFunction(() => window.__agentChunks.length === 1);
    await page.locator('#ai-msgs').evaluate(e => {e.scrollTop=100;});await page.waitForTimeout(50);
    await chunk('流A第一段');assert(Math.abs(await page.locator('#ai-msgs').evaluate(e => e.scrollTop)-100)<5);
    await page.locator('.ai-new-reply').waitFor({state: 'visible'});
    await select('n2');assert.equal(await page.locator('#ai-input').inputValue(), '章节B草稿');
    await chunk('流A完整结尾', true);await page.waitForTimeout(100);
    assert(!(await page.locator('#ai-msgs').innerText()).includes('流A完整结尾'));
    await select('n1');assert((await page.locator('#ai-msgs').innerText()).includes('流A完整结尾'));
    await page.locator('.ai-new-reply').click();assert(await page.locator('#ai-msgs').evaluate(e => e.scrollHeight-e.scrollTop-e.clientHeight<32));
    report.cases.push('stream_isolation_history_and_new_reply');
    await page.setViewportSize({width: 390, height: 844});await page.evaluate(() => scrollTo(0, 1500));
    const before=await page.evaluate(()=>scrollY);await page.locator('#agent-launch').click();await page.locator('#agent-dialog').waitFor({state:'visible'});
    report.mobileFocus=[];for(let i=0;i<8;i++){const focus=await page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,inDialog:!!document.activeElement.closest('#agent-dialog')}));report.mobileFocus.push(focus);await page.keyboard.press('Tab');}assert(report.mobileFocus.every(f=>f.inDialog||f.tag==='BODY'));
    await page.screenshot({path:output+'/agent-mobile.png'});await page.locator('#agent-close').click();
    assert(Math.abs(await page.evaluate(()=>scrollY)-before)<5);assert.equal(await page.evaluate(()=>document.activeElement.id),'agent-launch');
    await page.locator('#agent-launch').click();await page.locator('#ai-msgs').evaluate(e=>{e.scrollTop=120;});await page.waitForTimeout(50);await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(100);
    assert(!(await page.locator('#agent-dialog').evaluate(e=>e.open)));assert(await page.locator('#node-panel').evaluate(e=>e.parentElement.classList.contains('learning-workspace')));
    assert(Math.abs(await page.locator('#ai-msgs').evaluate(e=>e.scrollTop)-120)<5,'rotation restores conversation scroll');
    report.cases.push('mobile_focus_scroll_rotation');
    await page.locator('#ai-input').fill('细化后仍保留');await page.locator('#node-n1 button[data-mat="quiz"]').click();
    await page.locator('#node-n1 #open-quiz-workspace').click();await page.locator('.qd-question').waitFor();assert.equal(await page.locator('.qd-question').count(),1);await page.locator('#qd-close').click();
    page.once('dialog',d=>d.accept());await page.locator('#node-n1 #refine-node').click();await page.waitForTimeout(100);await select('n2');await select('n1');assert.equal(await page.locator('#ai-input').inputValue(),'细化后仍保留');
    const expanded=await page.locator('#node-n1').evaluate(e=>e.classList.contains('expanded'));await select('n1');assert.notEqual(await page.locator('#node-n1').evaluate(e=>e.classList.contains('expanded')),expanded);
    report.cases.push('refine_preserves_draft_quiz_and_collapse');assert.deepEqual(report.errors,[]);report.passed=true;
  } catch(e) {report.failure=e.stack;await page.screenshot({path:output+'/failure.png'});} finally {fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
  if(!report.passed)process.exitCode=1;
})();
