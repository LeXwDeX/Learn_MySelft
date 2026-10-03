/* Verify the actual page factories, their composition and failure behavior. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'learning-path/bundle_runtime.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'learning-path/manifest.json'), 'utf8'));
function environment() {
  const context = {console, setTimeout, clearTimeout, Blob, AbortController, URL, URLSearchParams,
    location: {search: ''}, document: {readyState: 'loading', addEventListener() {}},
    window: {addEventListener() {}, LearnUser: {userId: 'u0', apiBase: '/api', ready: Promise.resolve()}}};
  vm.createContext(context);
  require('./load_uikit.cjs')(context);
  vm.runInContext(runtime + '\nglobalThis.container = createModuleContainer(); globalThis.define = container.define;', context);
  return context;
}
for (const bundle of manifest.bundles) {
  const interfaces = [];
  for (const modules of [bundle.modules, bundle.modules.slice().reverse()]) {
    const context = environment();
    for (const module of modules) vm.runInContext(fs.readFileSync(path.join(root, 'learning-path', module.source), 'utf8'), context);
    const entry = context.container.get(bundle.entry);
    assert.equal(context.container.get(bundle.entry), entry, 'factories instantiate once');
    const summary = {};
    for (const module of modules) {
      const api = context.container.get(module.id);
      assert(Object.isFrozen(api), module.id + ' must publish an immutable interface');
      summary[module.id] = Object.keys(api).sort();
    }
    interfaces.push(Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b))));
    const hooks = bundle.modules.find(module => module.id.endsWith('.hooks'));
    if (hooks) assert.throws(() => context.container.get(hooks.id).connect({}), /already connected/i);
  }
  assert.deepEqual(interfaces[0], interfaces[1], 'registration order must not change the page interface');
}
const c = environment().container;
c.define('leaf', [], () => ({value: 1}));
assert.throws(() => c.define('leaf', [], () => ({})), /Duplicate module/);
c.define('missing', ['absent'], () => ({}));
assert.throws(() => c.get('missing'), /Missing module: absent/);
c.define('a', ['b'], () => ({})); c.define('b', ['a'], () => ({}));
assert.throws(() => c.get('a'), /Circular dependency: a -> b -> a/);
assert.equal(c.get('leaf').value, 1, 'a failed graph must not poison unrelated resolution');
c.define('bad-interface', [], () => undefined);
assert.throws(() => c.get('bad-interface'), /Invalid module interface/);
console.log('PASS page factory order independence, immutable interfaces, single composition, missing dependency and cycle failures');
