'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Exercise the public details API without a browser or generated page bundle.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.hidden = false; this.textContent = ''; this.scrollTop = 0; }
  appendChild(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(x => x !== child); this.children.push(child); child.parentElement = this; return child; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  get isConnected() { return this === document.body || Boolean(this.parentElement && this.parentElement.isConnected); }
  focus(options) { this.focusOptions = options; document.activeElement = this; }
  scrollIntoView(options) { this.scrollOptions = options; this.scrollCalls = (this.scrollCalls || 0) + 1; }
  querySelectorAll(selector) { const found = []; const cls = selector.slice(1); this.children.forEach(node => { if ((node.className || '').split(' ').includes(cls)) found.push(node); found.push(...node.querySelectorAll(selector)); }); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  after(node) { this.parentElement.appendChild(node); }
  prepend(node) { this.appendChild(node); }
  click() { this.listeners.click({currentTarget: this, stopPropagation() {}}); }
  key(key) { this.listeners.keydown({key, stopPropagation() {}, preventDefault() {}}); }
}
const document = {body: new Element('body'), createElement: tag => new Element(tag), getElementById(id) { return all(document.body).find(node => node.id === id); }, querySelectorAll(selector) { return document.body.querySelectorAll(selector); }};
function all(node) { return [node, ...node.children.flatMap(all)]; }
const env = {document, AbortController, console, setTimeout, clearTimeout, Date, window: null, addEventListener() {}, LearnUI: {}, LearnUser: {userId: 'u', apiBase: 'http://api', ready: Promise.resolve(), readOnly: true}};
env.window = env;
vm.createContext(env);
vm.runInContext(fs.readFileSync('shared/job-details.js', 'utf8'), env);
const job = {id: 'j', key: 'u/material', node_id: 'n1', operation: '/path/node', status: 'running', attempt: 1, created_ms: 1, timeout_seconds: 300};
const events = [{id: 1, at_ms: Date.now(), kind: 'model_request', attempt: 1, messages: [{role: 'user', content: '<img src=x onerror=attack()>'}]}, {id: 2, kind: 'model_response', content: '参考答案'}];
const calls = []; let fail = false, release, details = {available: true, truncated: false, events};
env.LearnUser.fetch = async (url, options) => {
  calls.push({url, options});
  assert.equal(options.method, 'GET', 'details must remain read-only');
  if (url.includes('?key=')) return {ok: true, json: async () => ({jobs: [job]})};
  if (fail) throw new Error('offline');
  if (release) await new Promise(resolve => { release.resolve = resolve; });
  return {ok: true, json: async () => ({job, details})};
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
(async () => {
  const host = new Element('div'), panelHost = new Element('div'); document.body.append(host, panelHost);
  const view = env.LearnJobDetails.mount(host, {key: job.key, nodeId: job.node_id, operation: job.operation, panelHost});
  assert(view.button.hidden, 'unknown receipt must not show made-up details');
  await flush(); assert.equal(view.button.hidden, false);
  view.button.click(); await flush();
  assert.equal(view.panel.hidden, false); assert(view.summary.textContent.includes('300 秒'));
  assert.equal(view.panel.focusOptions.preventScroll, true, 'panel focus must not center a long panel');
  assert.equal(view.header.scrollCalls, 1, 'explicit open positions the short header');
  assert.equal(view.panel.scrollCalls, undefined, 'long panel is never the scroll target');
  assert.equal(view.timeline.children.length, 2);
  const requestRow = view.timeline.children[0]; const text = requestRow.querySelector('.learn-job-conversation');
  assert.equal(text.textContent, '[user]\n<img src=x onerror=attack()>'); assert(text.hidden, 'answers stay hidden before confirmation');
  view.reveal.click(); assert.equal(text.hidden, false);
  view.timeline.scrollTop = 91; view.reveal.focus();
  events.push({id: 3, kind: 'error', label: '超时', error_category: 'timeout', frames: ['worker.py:42'], content: '读取超时'});
  env.LearnJobDetails.observe({...job, status: 'failed', error: '超过300秒'});
  view.retry.click(); await flush();
  assert.strictEqual(view.timeline.children[0], requestRow, 'unchanged message DOM survives refresh');
  assert.equal(view.timeline.scrollTop, 91); assert.strictEqual(document.activeElement, view.reveal);
  assert.equal(view.header.scrollCalls, 1, 'observe and read must not reposition an open panel');
  assert.equal(text.hidden, false, 'confirmation survives polling');
  assert.equal(view.timeline.children.length, 3);
  assert.equal(view.timeline.children[2].querySelector('.learn-job-error-frames').hidden, false, 'error locations do not require answer confirmation');
  const newHost = new Element('div'), newPanelHost = new Element('div'); document.body.append(newHost, newPanelHost);
  const moved = env.LearnJobDetails.mount(newHost, {key: job.key, nodeId: job.node_id, operation: job.operation, panelHost: newPanelHost});
  assert.strictEqual(view, moved, 'card rebuild reuses the open panel');
  assert.equal(panelHost.children.length, 0); assert.equal(moved.panel.hidden, false);
  assert.equal(view.header.scrollCalls, 1, 'remount must not reposition an open panel');
  moved.panel.key('Escape'); assert(moved.panel.hidden); assert.strictEqual(document.activeElement, moved.button);
  fail = true; moved.button.click(); await flush(); assert.equal(moved.retry.hidden, false); assert(moved.note.textContent.includes('offline'));
  assert.equal(moved.timeline.children.length, 3, 'network failure retains prior evidence');
  fail = false; moved.retry.click(); await flush(); assert(moved.retry.hidden); moved.panel.key('Escape');
  // A newer receipt clears the old conversation and requires a new confirmation.
  env.LearnJobDetails.observe({...job, id: 'new', created_ms: 2}); assert.equal(moved.timeline.children.length, 0); assert.equal(moved.revealed, false);
  assert.equal(moved.reveal.disabled, false);
  release = {}; moved.button.click(); await flush(); assert(release.resolve);
  const count = calls.length; moved.retry.click(); assert.equal(calls.length, count, 'overlapping reads are suppressed');
  const signal = calls[calls.length - 1].options.signal; moved.panel.key('Escape'); assert(signal.aborted, 'closing aborts the active read');
  release.resolve(); await flush(); assert.equal(moved.timeline.children.length, 0, 'late response cannot repopulate a closed panel');
  assert.equal(calls.filter(call => call.url.includes('?key=')).length, 1, 'card rebuild shares one history lookup');
  release = null;
  details = {available: false, truncated: false, events: []};
  const oldJob = {...job, id: 'old', node_id: 'n2', status: 'failed'};
  const oldHost = new Element('div'); document.body.appendChild(oldHost);
  const oldView = env.LearnJobDetails.mount(oldHost, {key: oldJob.key, nodeId: oldJob.node_id, operation: oldJob.operation});
  env.LearnJobDetails.observe(oldJob); oldView.button.click(); await flush();
  assert(oldView.note.textContent.includes('无法补回'), 'old receipts explicitly disclose missing records');
  assert.equal(oldView.timeline.children.length, 0); oldView.panel.key('Escape');
  details = {available: true, truncated: true, events};
  const topButton = new Element('button'); document.body.appendChild(topButton);
  env.LearnJobDetails.open(job, null, topButton); await flush();
  const globalPanel = document.body.querySelectorAll('.learn-job-detail-panel').find(panel => panel.parentElement.id === 'learn-job-details-host');
  assert(globalPanel); assert.strictEqual(moved.panel.parentElement, newPanelHost, 'top action must not move a card panel');
  assert(globalPanel.querySelector('.learn-job-detail-note').textContent.includes('截断'));
  globalPanel.key('Escape'); assert.strictEqual(document.activeElement, topButton, 'top action gets keyboard focus back');
  console.log('PASS read-only job details, answer confirmation, text safety, receipt history, stable DOM and read cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
