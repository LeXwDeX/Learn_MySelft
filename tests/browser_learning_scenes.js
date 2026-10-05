'use strict';
// Manual real-browser regression. Run with PLAYWRIGHT_MODULE pointing at the installed runtime.
const assert = require('node:assert/strict'), fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = {version: 1, title: '数学场景', summary: '先观察图形，再自己计算。'};
const scenes = [
  {...base, type: 'linear_transform', matrix: [[2, 1], [1, 2]], vector: [-2, 3]},
  {...base, type: 'secant', coefficients: [0, 0, 1], domain: [-1, 4], baseX: 1, gap: {min: 0.01, max: 3, value: 1.2}},
  {...base, type: 'surface_slice', coefficient: 2, radius: 1.5, height: {min: 0.1, max: 4.5, value: 2}}
];
async function fixtures(page, values) {
  await page.evaluate(specs => {
    window.LearnScenes.dispose(document);
    document.body.replaceChildren();
    const main = document.createElement('main'); main.id = 'fixtures'; document.body.appendChild(main);
    specs.forEach(spec => { const figure = document.createElement('figure'); figure.dataset.scene = 'pending'; figure.className = 'md-scene'; const caption = document.createElement('figcaption'); caption.setAttribute('role', 'status'); const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '场景数据'; const code = document.createElement('code'); code.textContent = JSON.stringify(spec); details.append(summary, code); figure.append(caption, details); main.appendChild(figure); });
    window.LearnScenes.enhance(main);
  }, values);
}
async function main() {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1000, height: 1000}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html lang="zh"><body></body></html>');
    await page.addStyleTag({content: fs.readFileSync('shared/ui.css', 'utf8') + '\n' + fs.readFileSync('shared/learning-scenes.css', 'utf8') + '\nbody{margin:0;padding:8px}main{max-width:820px;margin:auto}figure{margin:12px 0}details{overflow-wrap:anywhere}'});
    await page.evaluate(() => {
      window._activeFrames = new Set(); window._activeResize = 0; window._activeMutation = 0;
      const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = fn => { let id; id = raf(now => { window._activeFrames.delete(id); fn(now); }); window._activeFrames.add(id); return id; };
      window.cancelAnimationFrame = id => { window._activeFrames.delete(id); cancel(id); };
      for (const [type, count] of [['ResizeObserver', '_activeResize'], ['MutationObserver', '_activeMutation']]) {
        const Original = window[type]; window[type] = class extends Original { observe(...args) { if (!this._active) { window[count]++; this._active = true; } return super.observe(...args); } disconnect() { if (this._active) { window[count]--; this._active = false; } return super.disconnect(); } };
      }
    });
    await page.addScriptTag({content: fs.readFileSync('shared/learning-scenes.js', 'utf8')});
    await fixtures(page, scenes);
    assert.equal(await page.locator('[data-scene="ready"]').count(), 3);
    assert.equal(await page.locator('details code').count(), 3, 'source alternatives remain');
    await page.evaluate(() => LearnScenes.enhance(document.getElementById('fixtures')));
    assert.equal(await page.locator('.learn-scene').count(), 3, 'enhance is idempotent');
    const linear = page.locator('[data-scene-type="linear_transform"]');
    await page.emulateMedia({reducedMotion: 'reduce'});
    await linear.getByRole('button', {name: '下一步'}).click();
    assert.equal(await linear.locator('svg').getAttribute('data-vector'), '-4,1');
    await linear.getByRole('button', {name: '下一步'}).click();
    assert.equal(await linear.locator('svg').getAttribute('data-vector'), '-1,4', 'A times a non-default vector');
    await linear.getByRole('button', {name: '下一步'}).click();
    assert.match(await linear.locator('.learn-scene-caption').textContent(), /-2Ae₁ \+ 3Ae₂/);
    const secant = page.locator('[data-scene-type="secant"]'), secantPlot = secant.locator('svg');
    assert.ok(Math.abs(Number(await secantPlot.getAttribute('data-secant-slope')) - 3.2) < 1e-10);
    assert.equal(Number(await secantPlot.getAttribute('data-tangent-slope')), 2);
    await secant.locator('input').fill('0.013'); await secant.locator('input').dispatchEvent('input');
    await page.waitForTimeout(50);
    assert.ok(Math.abs(Number(await secantPlot.getAttribute('data-secant-slope')) - 2.013) < 1e-10);
    const surface = page.locator('[data-scene-type="surface_slice"]');
    assert.equal(Number(await surface.locator('.learn-scene-cut').getAttribute('data-radius')), 1);
    await surface.locator('input').fill('4.5'); await surface.locator('input').dispatchEvent('input');
    await page.waitForTimeout(50);
    assert.equal(Number(await surface.locator('.learn-scene-cut').getAttribute('data-radius')), 1.5);
    const before = await surface.locator('.learn-scene-cut').getAttribute('d');
    await surface.locator('svg').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(50);
    assert.equal(await surface.locator('select').inputValue(), 'free');
    assert.notEqual(await surface.locator('.learn-scene-cut').getAttribute('d'), before);
    await surface.locator('select').selectOption('top'); await page.waitForTimeout(50);
    assert.equal(await surface.locator('.learn-scene-axis-label').last().isVisible(), false);
    await surface.locator('select').selectOption('oblique');
    await page.screenshot({path: '/tmp/learning-scenes-desktop.png', fullPage: true});
    await page.setViewportSize({width: 320, height: 1000}); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true, '320px page fits');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.learn-scene-axes text')].every(text => text.getBBox().x >= 0 && getComputedStyle(text).fontSize === '14px')), true, 'mobile axis labels keep their sign and readable font size');
    await page.screenshot({path: '/tmp/learning-scenes-320.png', fullPage: true});
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await linear.getByRole('button', {name: '重播本步'}).click(); await page.waitForTimeout(100);
    await linear.getByRole('button', {name: '暂停', exact: true}).click();
    const paused = await linear.locator('svg').getAttribute('data-progress'); await page.waitForTimeout(100);
    assert.equal(await linear.locator('svg').getAttribute('data-progress'), paused, 'pause freezes progress');
    await linear.locator('select').selectOption('0.5'); await linear.getByRole('button', {name: '继续', exact: true}).click(); await page.waitForTimeout(100);
    assert.ok(Number(await linear.locator('svg').getAttribute('data-progress')) > Number(paused));
    await linear.locator('select').selectOption('2'); await page.waitForTimeout(50);
    assert.ok(Number(await linear.locator('svg').getAttribute('data-progress')) > Number(paused), 'speed change preserves position');
    await page.evaluate(() => document.getElementById('fixtures').remove()); await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => [window._activeFrames.size, window._activeResize, window._activeMutation]), [0, 0, 0], 'removal releases frames and observers');
    await fixtures(page, [...scenes, {...scenes[0], matrix: [[0, 0], [0, 0]]}, scenes[0]]);
    assert.equal(await page.locator('[data-scene="ready"]').count(), 4); assert.equal(await page.locator('[data-scene="error"]').count(), 1);
    await page.evaluate(() => LearnScenes.enhance(document.getElementById('fixtures')));
    assert.equal(await page.locator('.learn-scene').count(), 4, 'repeated enhancement cannot bypass limit');
    await fixtures(page, [{...scenes[0], title: '<img src=x onerror=alert(1)>', matrix: [[-4, 4], [4, -4]], vector: [-3, 3]}, {...scenes[1], coefficients: [0], gap: {min: 0.013, max: 0.013, value: 0.013}}, {...scenes[2], height: {min: 0.0013, max: 0.0013, value: 0.0013}}]);
    assert.equal(await page.locator('img').count(), 0); assert.equal(await page.locator('input:disabled').count(), 2);
    const extreme = page.locator('[data-scene-type="linear_transform"]');
    await page.emulateMedia({reducedMotion: 'reduce'}); await extreme.getByRole('button', {name: '下一步'}).click(); await extreme.getByRole('button', {name: '下一步'}).click();
    assert.equal(await extreme.locator('svg').getAttribute('data-vector'), '24,-24', 'extreme weighted vector is correct');
    assert.equal(await page.locator('[data-scene-type="secant"] svg').getAttribute('data-secant-slope'), '0');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('path')].every(p => !/NaN|Infinity/.test(p.getAttribute('d') || ''))), true);
    await page.evaluate(() => { LearnScenes.dispose(document); document.body.replaceChildren(); const hidden = document.createElement('section'); hidden.hidden = true; hidden.id = 'hidden-scene'; const fig = document.createElement('figure'); fig.dataset.scene = 'pending'; const code = document.createElement('code'); code.textContent = JSON.stringify({version: 1, type: 'linear_transform', title: '隐藏场景', summary: '打开后渲染', matrix: [[1, 0], [0, 1]]}); fig.append(code); hidden.append(fig); document.body.append(hidden); LearnScenes.enhance(hidden); });
    assert.equal(await page.locator('.learn-scene').count(), 0);
    await page.evaluate(() => { const section = document.getElementById('hidden-scene'); section.hidden = false; LearnScenes.enhance(section); });
    assert.equal(await page.locator('.learn-scene').count(), 1);
    await page.evaluate(() => LearnScenes.dispose(document)); await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => [window._activeFrames.size, window._activeResize, window._activeMutation]), [0, 0, 0]);
    await fixtures(page, [{...scenes[0], matrix: [[0, 0], [0, 0]], vector: [0, 0]}, {...scenes[0], matrix: [[1, 1], [2, 2]], vector: [-2, 3]}]);
    await page.emulateMedia({reducedMotion: 'reduce'});
    for (let index = 0; index < 2; index++) {
      const scene = page.locator('.learn-scene').nth(index); await scene.getByRole('button', {name: '下一步'}).click(); await scene.getByRole('button', {name: '下一步'}).click();
      assert.equal(await scene.locator('svg').getAttribute('data-vector'), index ? '1,2' : '0,0');
    }
    await page.evaluate(() => document.querySelector('.learn-scene').remove()); await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window._activeResize), 1, 'removing only the component releases its observer');
    await page.evaluate(() => LearnScenes.dispose(document)); await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => [window._activeFrames.size, window._activeResize, window._activeMutation]), [0, 0, 0]);
    await fixtures(page, [{...scenes[0], unknown: 'value'}, scenes[1]]);
    assert.equal(await page.locator('[data-scene="error"]').count(), 1); assert.equal(await page.locator('[data-scene="ready"]').count(), 1, 'failure is isolated');
    await page.evaluate(() => { const figure = document.createElement('figure'); figure.dataset.scene = 'pending'; const code = document.createElement('code'); code.textContent = ' '.repeat(12001); figure.append(code); document.getElementById('fixtures').append(figure); LearnScenes.enhance(document.getElementById('fixtures')); });
    assert.match(await page.locator('figure').last().textContent(), /12000/);
    await page.evaluate(() => LearnScenes.dispose(document));
    const integration = await browser.newPage({viewport: {width: 320, height: 1000}});
    integration.on('pageerror', error => errors.push(error.message));
    await integration.setContent('<!doctype html><html lang="zh"><body><main id="markdown-fixture"></main></body></html>');
    await integration.addStyleTag({content: fs.readFileSync('shared/ui.css', 'utf8') + '\n' + fs.readFileSync('shared/markdown.css', 'utf8') + '\n' + fs.readFileSync('shared/learning-scenes.css', 'utf8')});
    await integration.evaluate(() => {
      window._activeFrames = new Set(); window._activeResize = 0; window._activeMutation = 0;
      const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = fn => { let id; id = raf(now => { window._activeFrames.delete(id); fn(now); }); window._activeFrames.add(id); return id; };
      window.cancelAnimationFrame = id => { window._activeFrames.delete(id); cancel(id); };
      for (const [type, count] of [['ResizeObserver', '_activeResize'], ['MutationObserver', '_activeMutation']]) {
        const Original = window[type]; window[type] = class extends Original { observe(...args) { if (!this._active) { window[count]++; this._active = true; } return super.observe(...args); } disconnect() { if (this._active) { window[count]--; this._active = false; } return super.disconnect(); } };
      }
    });
    for (const source of ['shared/vendor-markdown-it.js', 'shared/learning-scenes.js', 'shared/markdown.js']) await integration.addScriptTag({content: fs.readFileSync(source, 'utf8')});
    const fence = '```learn-scene\n' + JSON.stringify(scenes[0]) + '\n```';
    async function markdown(source, streaming) {
      await integration.evaluate(({source, streaming}) => { const host = document.getElementById('markdown-fixture'); LearnMarkdown.dispose(host); host.innerHTML = LearnMarkdown.render(source, {streaming}); LearnMarkdown.enhance(host); }, {source, streaming});
    }
    await markdown(fence, false);
    assert.equal(await integration.locator('[data-scene="ready"]').count(), 1, 'real Markdown fence mounts a scene');
    assert.equal(await integration.locator('details code').textContent(), JSON.stringify(scenes[0]) + '\n', 'Markdown keeps exact source text');
    await integration.screenshot({path: '/tmp/learning-scenes-markdown-320.png', fullPage: true});
    await markdown(fence, true);
    assert.equal(await integration.locator('[data-scene="waiting"]').count(), 1); assert.equal(await integration.locator('.learn-scene').count(), 0, 'streaming waits');
    await markdown(fence.slice(0, -3), false);
    assert.equal(await integration.locator('[data-scene="error"]').count(), 1); assert.equal(await integration.locator('.learn-scene').count(), 0, 'unclosed fence falls back');
    await markdown(fence, false);
    await integration.evaluate(() => LearnMarkdown.dispose(document.getElementById('markdown-fixture'))); await integration.waitForTimeout(50);
    assert.equal(await integration.locator('.learn-scene').count(), 0);
    assert.deepEqual(await integration.evaluate(() => [window._activeFrames.size, window._activeResize, window._activeMutation]), [0, 0, 0], 'Markdown dispose releases scene resources');
    await integration.close();
    assert.deepEqual(errors, []);
    console.log('PASS browser mathematics, weighted vectors, controls, 320px, safety, quotas, hidden rendering and disposal');
    console.log('Screenshots: /tmp/learning-scenes-desktop.png /tmp/learning-scenes-320.png');
    console.log('PASS real Markdown fence ready, streaming waiting, unclosed fallback and dispose; /tmp/learning-scenes-markdown-320.png');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
