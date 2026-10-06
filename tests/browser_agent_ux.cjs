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
    let resource = null;
    if (url.pathname.startsWith('/diagram-design/learning-path/')) resource = path.join(root, 'learning-path', path.basename(url.pathname));
    if (url.pathname.startsWith('/learn/assets/')) {
      const relative = url.pathname.slice('/learn/assets/'.length);
      if (relative.endsWith('.css') || ['ui.js', 'titles.js', 'materials.js', 'markdown.js', 'vendor-markdown-it.js'].includes(relative)) {
        resource = path.join(root, 'shared', relative);
      }
    }
    const body = resource && fs.existsSync(resource) ? fs.readFileSync(resource, 'utf8') : '';
    return route.fulfill({contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body});
  });
  await page.addInitScript(({fixture, history}) => {
    const entries = {'u0/learn-path-v1-agent-ux': JSON.stringify(fixture), 'u0/learn-ai-v1-agent-ux': JSON.stringify(history)};
    window.__agentChunks = [];
    window.LearnJobs = {list: async () => [], supports: () => false, requestId: () => 'agent-fixture-request'};
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
  async function captureAgentState() {
    return page.evaluate(() => {
      const panel = document.querySelector('#node-panel');
      const input = document.querySelector('#ai-input');
      const msgs = document.querySelector('#ai-msgs');
      window.__agentExpandRefs = {panel, view: panel.querySelector('.agent-view'), input, msgs};
      return {
        panelText: panel.querySelector('.agent-view').innerText,
        selected: document.querySelector('#node-n1').classList.contains('expanded'),
        draft: input.value,
        selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
        scrollTop: msgs.scrollTop,
        msgText: msgs.innerText,
      };
    });
  }
  async function assertAgentStateRetained(before, where) {
    const after = await page.evaluate(() => {
      const panel = document.querySelector('#node-panel');
      const input = document.querySelector('#ai-input');
      const msgs = document.querySelector('#ai-msgs');
      const refs = window.__agentExpandRefs;
      return {
        sameNodes: refs.panel === panel && refs.view === panel.querySelector('.agent-view') && refs.input === input && refs.msgs === msgs,
        panelText: panel.querySelector('.agent-view').innerText,
        selected: document.querySelector('#node-n1').classList.contains('expanded'),
        draft: input.value,
        selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
        scrollTop: msgs.scrollTop,
        msgText: msgs.innerText,
      };
    });
    assert(after.sameNodes, where + ': expansion must move the existing panel and conversation');
    assert.equal(after.panelText, before.panelText, where + ': panel content changed');
    assert.equal(after.selected, before.selected, where + ': selected chapter changed');
    assert.equal(after.draft, before.draft, where + ': draft changed');
    assert.deepEqual(after.selection, before.selection, where + ': text selection changed');
    assert(Math.abs(after.scrollTop - before.scrollTop) < 5, where + ': conversation position changed: expected ' + before.scrollTop + ', observed ' + after.scrollTop);
    assert.equal(after.msgText, before.msgText, where + ': conversation content changed');
  }
  async function openExpanded() {
    await page.locator('#agent-expand').click();
    await page.waitForFunction(() => document.querySelector('#agent-dialog').open);
    assert(await page.locator('#agent-dialog #node-panel').count(), 'expanded view must contain the existing panel');
  }
  async function assertDialogRestored(readingY, oldOverflow, oldAnchor, focusId, where) {
    await page.waitForFunction(({readingY, oldOverflow, oldAnchor}) => {
      const dialog = document.querySelector('#agent-dialog');
      return !dialog.open && document.body.style.overflow === oldOverflow &&
        document.documentElement.style.overflowAnchor === oldAnchor && Math.abs(scrollY - readingY) < 5;
    }, {readingY, oldOverflow, oldAnchor});
    await page.waitForTimeout(100);
    assert(Math.abs(await page.evaluate(() => scrollY) - readingY) < 5, where + ': reading position changed');
    const focus = await page.evaluate(() => {
      const e = document.activeElement, r = e.getBoundingClientRect();
      return {id: e.id, connected: e.isConnected, visible: r.width > 0 && r.height > 0};
    });
    assert(focus.connected && focus.visible, where + ': focus is not usable after close');
    if (focusId) assert.equal(focus.id, focusId, where + ': focus did not return to its opener');
  }
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
    const streamBackground = await page.evaluate(() => ({y:scrollY,overflow:document.body.style.overflow,anchor:document.documentElement.style.overflowAnchor}));
    await openExpanded();
    const streamBox = await page.locator('#agent-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};});
    assert(Math.abs(streamBox.top-24)<=5&&Math.abs(streamBox.height-streamBox.bottom-24)<=5,'desktop expanded dialog needs 24px vertical gaps');
    await chunk('流A放大期间继续');await page.getByText('流A放大期间继续').waitFor({state:'visible'});
    assert(Math.abs(await page.locator('#ai-msgs').evaluate(e=>e.scrollTop)-100)<5,'stream must not jump to bottom while reading older messages');
    const streamDuring = await captureAgentState();
    await page.locator('#agent-close').click();
    await assertDialogRestored(streamBackground.y,streamBackground.overflow,streamBackground.anchor,'agent-expand','stream close button');
    await assertAgentStateRetained(streamDuring,'stream close button');
    report.cases.push('desktop_expand_preserves_live_stream_and_reader_position');
    await select('n2');assert.equal(await page.locator('#ai-input').inputValue(), '章节B草稿');
    await chunk('流A完整结尾', true);await page.waitForTimeout(100);
    assert(!(await page.locator('#ai-msgs').innerText()).includes('流A完整结尾'));
    await select('n1');assert((await page.locator('#ai-msgs').innerText()).includes('流A完整结尾'));
    await page.locator('.ai-new-reply').click();assert(await page.locator('#ai-msgs').evaluate(e => e.scrollHeight-e.scrollTop-e.clientHeight<32));
    report.cases.push('stream_isolation_history_and_new_reply');
    for (const [method,label] of [['button','close button'],['outside','outside click'],['escape','Escape']]) {
      await page.locator('#ai-input').fill('展开状态草稿 '+label);
      await page.locator('#ai-input').evaluate(e=>{e.focus();e.setSelectionRange(2,5,'forward');});
      await page.locator('#ai-msgs').evaluate(e=>{e.scrollTop=120;});await page.waitForTimeout(40);
      const beforeExpand=await captureAgentState();
      const background=await page.evaluate(()=>({y:scrollY,overflow:document.body.style.overflow,anchor:document.documentElement.style.overflowAnchor}));
      await openExpanded();
      const box=await page.locator('#agent-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,center:(r.left+r.right)/2,width:innerWidth,radius:getComputedStyle(e).borderRadius};});
      assert(Math.abs(box.top-24)<=5&&Math.abs(box.height-box.bottom-24)<=5,'desktop dialog needs 24px vertical gaps');
      assert(Math.abs(box.center-box.width/2)<=5,'desktop dialog must be centered');
      assert.equal(box.radius,'8px','expanded dialog must use the shared 8px radius');
      assert.equal(await page.locator('#node-panel').evaluate(e=>e.parentElement.id),'agent-dialog');
      const radii=await page.locator('#node-panel,.node,.ai-bubble').evaluateAll(es=>es.map(e=>getComputedStyle(e).borderRadius));
      assert(radii.length>=4&&radii.every(x=>x==='8px'),'node, panel, and AI bubble must use the shared 8px radius');
      if(method==='button')await page.locator('#agent-close').click();
      else if(method==='outside')await page.mouse.click(4,4);
      else await page.keyboard.press('Escape');
      await assertDialogRestored(background.y,background.overflow,background.anchor,'agent-expand','desktop '+label);
      await assertAgentStateRetained(beforeExpand,'desktop '+label);
      assert(await page.locator('#node-panel').evaluate(e=>e.parentElement.classList.contains('learning-workspace')),'closed dialog must return the panel to reading layout');
    }
    report.cases.push('desktop_expand_state_and_three_close_paths');
    await page.setViewportSize({width: 390, height: 844});await page.evaluate(() => scrollTo(0, 1500));
    const originalAnchor = await page.evaluate(()=>document.documentElement.style.overflowAnchor);const originalOverflow=await page.evaluate(()=>document.body.style.overflow);const before=await page.evaluate(()=>scrollY);await page.locator('#agent-launch').click();await page.locator('#agent-dialog').waitFor({state:'visible'});
    const mobileBox=await page.locator('#agent-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,radius:getComputedStyle(e).borderRadius};});assert(mobileBox.top>=16&&mobileBox.height-mobileBox.bottom>=16,'mobile dialog needs 16px vertical gaps');assert.equal(mobileBox.radius,'8px','mobile dialog must use the shared 8px radius');
    report.mobileFocus=[];for(let i=0;i<8;i++){const focus=await page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,inDialog:!!document.activeElement.closest('#agent-dialog')}));report.mobileFocus.push(focus);await page.keyboard.press('Tab');}assert(report.mobileFocus.every(f=>f.inDialog||f.tag==='BODY'));
    await page.screenshot({path:output+'/agent-mobile.png'});await page.locator('#agent-close').click();
    await page.waitForFunction(({before,originalAnchor,originalOverflow})=>!document.querySelector('#agent-dialog').open&&document.body.style.overflow===originalOverflow&&document.documentElement.style.overflowAnchor===originalAnchor&&Math.abs(scrollY-before)<5,{before,originalAnchor,originalOverflow});assert.equal(await page.evaluate(()=>document.activeElement.id),'agent-launch');
    for(let repeat=0;repeat<3;repeat++){
      const readingY=await page.evaluate(()=>scrollY);
      await page.locator('#agent-launch').click();await page.locator('#ai-input').fill('反复开关草稿 '+repeat);
      if(repeat===2)await page.keyboard.press('Escape');else await page.locator('#agent-close').click();
      await page.waitForFunction(({readingY,originalAnchor,originalOverflow})=>!document.querySelector('#agent-dialog').open&&document.body.style.overflow===originalOverflow&&document.documentElement.style.overflowAnchor===originalAnchor&&Math.abs(scrollY-readingY)<5,{readingY,originalAnchor,originalOverflow});
      await page.waitForTimeout(150);assert(Math.abs(await page.evaluate(()=>scrollY)-readingY)<5);
    }
    report.cases.push('repeated_close_escape_restores_scroll_anchor');
    await page.locator('#agent-launch').click();await page.locator('#ai-msgs').evaluate(e=>{e.scrollTop=120;});await page.waitForTimeout(50);const mobileScroll=await page.locator('#ai-msgs').evaluate(e=>e.scrollTop);assert(Math.abs(mobileScroll-120)<5,'mobile fixture must reach the requested scroll position before rotation: observed '+mobileScroll);await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(100);
    assert(!(await page.locator('#agent-dialog').evaluate(e=>e.open)));assert(await page.locator('#node-panel').evaluate(e=>e.parentElement.classList.contains('learning-workspace')));
    const rotatedScroll=await page.locator('#ai-msgs').evaluate(e=>e.scrollTop);assert(Math.abs(rotatedScroll-120)<5,'rotation restores conversation scroll: expected 120, observed '+rotatedScroll);
    report.cases.push('mobile_focus_scroll_rotation');
    await page.locator('#ai-input').fill('桌面调整窗口仍保持放大');
    const resizeState=await captureAgentState();
    const resizeBackground=await page.evaluate(()=>({y:scrollY,overflow:document.body.style.overflow,anchor:document.documentElement.style.overflowAnchor}));
    await openExpanded();await page.setViewportSize({width:1024,height:1000});await page.waitForTimeout(80);
    assert(await page.locator('#agent-dialog').evaluate(e=>e.open),'desktop resize must keep the expanded dialog open');
    await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(80);
    assert(await page.locator('#agent-dialog').evaluate(e=>e.open),'returning to wide desktop must keep the expanded dialog open');
    await page.locator('#agent-close').click();
    await assertDialogRestored(resizeBackground.y,resizeBackground.overflow,resizeBackground.anchor,'agent-expand','desktop resize close');
    await assertAgentStateRetained(resizeState,'desktop resize close');
    report.cases.push('desktop_resize_keeps_expanded_modal');
    await page.locator('#ai-input').fill('细化后仍保留');await page.locator('#node-n1 button[data-mat="quiz"]').click();
    await page.locator('#node-n1 #open-quiz-workspace').click();await page.locator('.qd-question').waitFor();assert.equal(await page.locator('.qd-question').count(),1);await page.locator('#qd-close').click();
    page.once('dialog',d=>d.accept());await page.locator('#node-n1 #refine-node').click();await page.waitForTimeout(100);await select('n2');await select('n1');assert.equal(await page.locator('#ai-input').inputValue(),'细化后仍保留');
    const expanded=await page.locator('#node-n1').evaluate(e=>e.classList.contains('expanded'));await select('n1');assert.notEqual(await page.locator('#node-n1').evaluate(e=>e.classList.contains('expanded')),expanded);
    report.cases.push('refine_preserves_draft_quiz_and_collapse');assert.deepEqual(report.errors,[]);report.passed=true;
  } catch(e) {report.failure=e.stack;await page.screenshot({path:output+'/failure.png'});} finally {fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
  if(!report.passed)process.exitCode=1;
})();
