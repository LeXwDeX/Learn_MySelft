'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A browser can issue a non-cancelable dialog close after repeated Escape.
// Stop the keyboard gesture while a password request owns the dialog.
const elements = new Map(), requests = [], errors = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', disabled: false, listeners: {}, attributes: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; }
  });
  return elements.get(id);
}
const context = {request(path, body) {
  return new Promise((resolve, reject) => requests.push({path, body, resolve, reject}));
}};
const ui = {dom: {byId: element, escapeHTML: String, showError(...args) { errors.push(args); }},
  dialog: {bind() {}, close() {}}};
const environment = {location: {}, define(name, dependencies, factory) { factory({'home.platform': {context, ui}}); }};
vm.createContext(environment);
vm.runInContext(fs.readFileSync('home/modules/account.js', 'utf8'), environment);
const flush = () => new Promise(resolve => setImmediate(resolve));
function submit() { element('password-form').onsubmit({preventDefault() {}}); }
function escape() {
  const event = {key: 'Escape', defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }};
  element('password-dialog').listeners.keydown?.(event);
  return event;
}
(async () => {
  assert.equal(escape().defaultPrevented, false, 'idle Escape remains native');
  for (let attempt = 0; attempt < 2; attempt++) {
    element('old-password').value = 'dummy-current'; element('new-password').value = 'dummy-new';
    submit(); submit();
    assert.equal(requests.length, attempt + 1, 'Enter cannot duplicate a pending password request');
    assert.equal(element('password-save').disabled, true);
    assert.equal(element('password-cancel').disabled, true);
    const keyboard = escape();
    assert.equal(keyboard.defaultPrevented, true, 'pending Escape must be stopped before native close begins');
    assert.equal(keyboard.stopped, true);
    requests[attempt].reject(new Error('密码错误')); await flush();
    assert.equal(element('password-save').disabled, false);
    assert.equal(element('password-cancel').disabled, false);
    assert.equal(element('password-form').attributes['aria-busy'], 'false');
    assert.equal(element('old-password').focused, true);
    assert.equal(errors.at(-1)[2], 'old-password', 'failure is associated with the current password input');
    assert.equal(escape().defaultPrevented, false);
  }
  submit(); requests[2].resolve({ok: true}); await flush();
  assert.equal(element('old-password').value, ''); assert.equal(element('new-password').value, '');
  assert.equal(environment.location.href, '/learn/');
  console.log('PASS password dialog pending gestures, duplicate suppression, retry, input errors and credential cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
