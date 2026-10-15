'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function fixture() {
  const elements = new Map(), notices = new Map(), requests = [], modules = {};
  const document = {activeElement: null, createElement: tag => new Element(tag), getElementById: id => elements.get(id)};
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this.open = false; this.textContent = ''; this.innerHTML = ''; this.listeners = {}; }
    appendChild(child) { if (child.parentElement) child.remove(); this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    insertBefore(child, next) { if (child.parentElement) child.remove(); const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    contains(child) { return child === this || this.children.some(node => node.contains(child)); }
    focus() { if (!this.disabled && !this.hidden) document.activeElement = this; }
    get isConnected() { return this === document.body || Boolean(this.parentElement && this.parentElement.isConnected); }
    querySelectorAll() { return []; }
  }
  document.body = new Element('body');
  for (const id of ['library-panel', 'library-status', 'library-error', 'library-count', 'map-list', 'quiz-list', 'refresh-library', 'tasks-panel', 'task-list', 'refresh-tasks', 'continue-panel', 'continue-title', 'continue-description', 'continue-link', 'new-learning', 'task-history', 'task-history-list', 'tasks-empty', 'tasks-count', 'history-empty']) {
    const element = new Element('div'); element.id = id; elements.set(id, element); document.body.appendChild(element);
  }
  const context = {userId: 'u0', readOnly: false, link: page => '/learn/u/u0/' + page, request(endpoint, body) {
    const pending = deferred(); requests.push({endpoint, body, ...pending}); return pending.promise;
  }};
  const ui = {dom: {byId: id => elements.get(id), escapeHTML: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    showError(id, message) { const node = elements.get(id); node.textContent = message || ''; node.hidden = !message; }},
    set(key, message, kind, action) { notices.set(key, {message, kind, action}); }, clear(key) { notices.delete(key); }};
  modules['home.platform'] = {context, ui, titles: {document: value => value.title || value.topic || '资料'},
    jobs: {label: operation => operation, watch: () => new Promise(() => {})}, jobDetails: {observe() {}, open() {}}};
  const sandbox = {console, document, Date, URLSearchParams, setTimeout: () => 1, clearTimeout() {},
    define(name, dependencies, factory) { modules[name] = factory(modules); }};
  vm.createContext(sandbox);
  for (const file of ['library', 'tasks']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../home/modules/' + file + '.js'), 'utf8'), sandbox);
  return {modules, elements, notices, requests, context, document};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const entry = (title, done = true) => ({'u0/learn-path-v1-one': JSON.stringify({topic: title, plan: {nodes: [{id: 'current'}]}, nodeState: {current: {completed: done}, removed: {completed: true}}})});
const job = {id: 'task-one', key: 'u0/learn-path-v1-one', title: '学习资料', status: 'running', operation: '/path/node', created_ms: 1};
async function answer(f, entries, jobs) {
  f.requests.filter(request => !request.answered).forEach(request => {
    request.answered = true;
    request.resolve(request.endpoint === '/state/all' ? {entries} : {jobs});
  });
  await flush();
}
(async () => {
  const f = fixture();
  f.modules['home.library'].render(entry('保留资料'));
  assert.match(f.elements.get('map-list').innerHTML, /1\/1 单元已完成/, 'obsolete nodes cannot inflate current progress');
  f.modules['home.library'].render({...entry('继续这份'), 'u0/learn-path-v1-last':'one', 'u1/learn-path-v1-last':'other'});
  assert.match(f.elements.get('continue-link').href,/learning-path.html\?t=one$/, 'continue uses only the target user snapshot pointer');
  assert.match(f.elements.get('map-list').innerHTML,/上次打开/);
  f.modules['home.library'].render({...entry('已有资料'), 'u0/learn-path-v1-last':'missing'});
  assert.equal(f.elements.get('continue-link').href,'#map-list','invalid pointer offers selection, never a guessed latest item');
  f.modules['home.library'].render({'u0/quiz-map-v1-check':JSON.stringify({title:'测验',questions:[{q:'题目'}]}),'u9/learn-path-v1-last':'one'});
  assert.equal(f.elements.get('continue-link').href,'#quiz-list','quiz-only library continues through quiz materials');
  f.modules['home.library'].render({}); assert.match(f.elements.get('continue-title').textContent,/开始/);
  f.context.readOnly=true; f.modules['home.library'].render({}); assert.equal(f.elements.get('new-learning').hidden,true); assert.equal(f.elements.get('continue-link').hidden,true,'read-only empty space has no create action');
  f.context.readOnly=false; f.modules['home.library'].render(entry('保留资料'));
  f.elements.get('continue-link').focus();
  const first = f.modules['home.tasks'].load();
  f.requests.forEach(request => { request.answered = true; request.reject(new Error('连接中断')); });
  await first; await flush();
  assert.equal(f.elements.get('library-error').hidden, false, 'failed library read is visible');
  assert.equal(f.elements.get('refresh-library').disabled,false);
  assert.equal(f.document.activeElement,f.elements.get('refresh-library'),'failed continue refresh restores focus only after enabling its retry control');
  assert.match(f.elements.get('map-list').innerHTML, /保留资料/, 'failed refresh retains the previous library');
  assert.match(f.elements.get('continue-title').textContent,/无法读取/, 'read failure is not an empty library');
  assert(f.notices.has('tasks'), 'failed jobs read exposes reconnect');
  assert.equal(typeof f.elements.get('refresh-library').onclick, 'function', 'library can retry independently even when tasks are hidden');
  const recovery = f.modules['home.tasks'].load(); await answer(f, entry('已恢复'), [job]); await recovery;
  assert.equal(f.elements.get('library-error').hidden, true, 'successful retry clears the library error');
  assert.equal(f.notices.has('tasks'), false, 'successful retry clears the task error');
  const original = f.elements.get('task-list').children[0];
  const details = original.children[1].children[0]; details.focus();
  const poll = f.modules['home.tasks'].load(); await answer(f, entry('已恢复'), [{...job, status: 'running', updated_ms:2}]); await poll;
  assert.equal(f.elements.get('task-list').children[0], original, 'polling preserves the task row');
  assert.equal(details.isConnected, true, 'polling preserves the focused action');
  assert.equal(f.document.activeElement, details);
  const terminal=f.modules['home.tasks'].load(); await answer(f,entry('已恢复'),[{...job,status:'succeeded'},{...job,id:'cancelled',status:'cancelled'}]); await terminal;
  assert.equal(f.elements.get('task-list').children.length,0,'successful and cancelled jobs are not pending work');
  assert.equal(f.elements.get('task-history-list').children[0],original,'history reuses the same task identity and row');
  assert.equal(f.elements.get('task-history').open,false,'history is opened on demand');
  assert.equal(f.document.activeElement,f.elements.get('refresh-tasks'),'hidden historical actions do not retain keyboard focus');

  const older = f.modules['home.tasks'].load(), oldRequests = f.requests.filter(request => !request.answered);
  oldRequests.forEach(request => { request.answered = true; });
  const newer = f.modules['home.tasks'].load(); await answer(f, entry('新状态'), [job]); await newer;
  oldRequests.forEach(request => request.resolve(request.endpoint === '/state/all' ? {entries: entry('旧状态')} : {jobs: []}));
  await older; await flush();
  assert.match(f.elements.get('map-list').innerHTML, /新状态/, 'late library response cannot replace a newer result');
  assert.equal(f.elements.get('tasks-panel').hidden, false, 'late jobs response cannot hide current tasks');

  const failed = f.modules['home.tasks'].load();
  await answer(f, entry('新状态'), [{...job, operation: '/path/requiz', status: 'failed'}]); await failed;
  const retryButton = f.elements.get('task-list').children[0].children[1].children[2];
  assert.equal(retryButton.textContent, '重新生成新题');
  retryButton.onclick(); retryButton.onclick();
  const retries = f.requests.filter(request => request.endpoint.endsWith('/retry'));
  assert.equal(retries.length, 1, 'repeated retry clicks cannot submit duplicate jobs');
  retries[0].answered = true; retries[0].reject(new Error('提交失败')); await flush();
  assert.equal(retryButton.disabled, false, 'a failed submission can be retried');
  assert.equal(retryButton.textContent, '重新生成新题', 'failure preserves the specific action label');

  const many=f.modules['home.tasks'].load(); await answer(f,entry('完整快照'),Array.from({length:10},(_,i)=>({...job,id:'active-'+i}))); await many;
  assert.equal(f.elements.get('task-list').children.length,10,'pending work is not truncated to the old eight-row recent view');
  f.context.readOnly = true;
  const readOnly = f.modules['home.tasks'].load(); await answer(f, {}, [{...job, status: 'failed'}]); await readOnly;
  const retry = f.elements.get('task-list').children[0].children[1].children.find(node => node.textContent === '重试此任务');
  assert(!retry || retry.hidden, 'read-only viewers have no retry action');
  // Execute the real shell against missing, empty and populated plans.
  const nodes=new Map(), shellModel={state:{plan:null},session:{reviewFilter:false}};
  function element(id){if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',style:{},classList:{toggle(){}}});return nodes.get(id);}
  const shellEnv={define(name,names,factory){shellEnv.shell=factory({'path.model':shellModel,'path.format':{$:element},'path.persistence':{},'path.domain':{isDone:id=>id==='n1',countReview:()=>0},'path.hooks':{}});}};
  vm.createContext(shellEnv);vm.runInContext(fs.readFileSync(path.join(__dirname,'../learning-path/modules/path-shell.js'),'utf8'),shellEnv);
  shellEnv.shell.renderProgress();assert.equal(element('learning-progress').hidden,true);assert.equal(element('progress-text').textContent,'','new learning never shows zero of zero');
  shellModel.state.plan={nodes:[]};shellEnv.shell.renderProgress();assert.equal(element('learning-progress').hidden,true);
  shellModel.state.plan={nodes:[{id:'n1'},{id:'n2'}]};shellEnv.shell.renderProgress();assert.equal(element('learning-progress').hidden,false);assert.match(element('progress-text').textContent,/1\/2/);
  element('stage-learning').hidden=true;shellEnv.shell.renderProgress();assert.equal(element('learning-progress').hidden,true,'progress is hidden while reviewing the goal or research');
  console.log('PASS home read failures, recovery, independent retry, current progress, latest responses and stable task focus');
})().catch(error => { console.error(error); process.exitCode = 1; });
