'use strict';
// Focused local browser regression for diagram visibility and playback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const output = process.env.SCENE_BROWSER_OUTPUT || '/tmp/learning-visual-recovery';
fs.mkdirSync(output, {recursive: true});
const base = {version: 1, type: 'diagram', title: '图形回归', summary: '检查图元和步骤。'};

async function main() {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 800, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html lang="zh"><body><main id="host" style="width:220px"></main></body></html>');
    await page.addStyleTag({content: fs.readFileSync('shared/ui.css', 'utf8') + '\n' + fs.readFileSync('shared/learning-scenes.css', 'utf8')});
    await page.evaluate(() => {
      window._frames = new Set();
      const frame = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        let id; id = frame(now => { window._frames.delete(id); callback(now); });
        window._frames.add(id); return id;
      };
      window.cancelAnimationFrame = id => { window._frames.delete(id); cancel(id); };
    });
    await page.addScriptTag({content: fs.readFileSync('shared/learning-scenes.js', 'utf8')});
    async function mount(scene) {
      await page.evaluate(spec => {
        const host = document.getElementById('host');
        LearnScenes.dispose(host); host.replaceChildren(); LearnScenes.mount(host, spec);
      }, scene);
      return page.locator('#host .learn-scene');
    }
    const staticScene = {...base, elements: [
      {id: 'line', kind: 'line', points: [[0, 0], [1, 0]]},
      {id: 'hidden', kind: 'point', points: [[10, 10]], opacity: 0}
    ]};
    let scene = await mount(staticScene);
    assert.equal(await scene.locator('.learn-scene-diagram-controls').count(), 0, 'static scenes do not gain animation controls');
    assert.match(await scene.locator('.learn-scene-visibility-note').textContent(), /1 个图元/);
    assert.equal(await scene.locator('[data-element-id="hidden"]').getAttribute('opacity'), '0');
    assert(Number(await scene.locator('[data-element-id="line"]').evaluate(element => element.getBBox().width)) > 100,
      'permanently transparent outlier cannot shrink a visible line');

    const animation = {...base, elements: [
      {id: 'axis', kind: 'line', points: [[-2, 0], [2, 0]], label: '基准线'},
      {id: 'vector', kind: 'arrow', points: [[0, 0], [1, 1]], opacity: 0, label: '逐步显示的向量'}
    ], steps: [
      {caption: '先显示向量。', changes: [{id: 'vector', opacity: 1}]},
      {caption: '再移动向量。', changes: [{id: 'vector', points: [[0, 0], [-1, 2]]}]}
    ]};
    scene = await mount(animation);
    const plot = scene.locator('svg');
    await page.evaluate(() => {
      window._textMeasures = 0;
      const measure = SVGTextContentElement.prototype.getComputedTextLength;
      SVGTextContentElement.prototype.getComputedTextLength = function () { window._textMeasures++; return measure.call(this); };
    });
    assert.equal(await plot.getAttribute('data-step'), '0');
    assert.equal(await scene.locator('[data-element-id="vector"]').getAttribute('opacity'), '0');
    const axisBefore = await scene.locator('[data-element-id="axis"]').getAttribute('d');
    await scene.getByRole('button', {name: '播放第 1 步'}).click();
    await page.waitForFunction(() => document.querySelector('#host svg').dataset.step === '1' && document.querySelector('#host svg').dataset.progress === '1');
    await page.waitForTimeout(150);
    assert.equal(await plot.getAttribute('data-step'), '1', 'single-step playback stops after its own step');
    assert.equal(await scene.locator('[data-element-id="vector"]').getAttribute('opacity'), '1');
    assert.match(await scene.locator('.learn-scene-caption').textContent(), /先显示向量/);
    assert.equal(await page.evaluate(() => window._textMeasures), 0, 'animation frames do not remeasure label text');
    await scene.getByRole('button', {name: '下一步'}).click();
    assert.equal(await plot.getAttribute('data-step'), '2', 'quick navigation still reaches a snapshot');
    assert.match(await scene.locator('.learn-scene-caption').textContent(), /再移动向量/);
    await page.emulateMedia({reducedMotion: 'reduce'});
    await scene.getByRole('button', {name: '上一步'}).click();
    await scene.getByRole('button', {name: '重播本步'}).click();
    await page.waitForFunction(() => document.querySelector('#host svg').dataset.progress === '1');
    assert.equal(await plot.getAttribute('data-step'), '1', 'reduced motion still ends on the selected step');
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await scene.getByRole('button', {name: '上一步'}).click();
    assert.equal(await scene.locator('[data-element-id="axis"]').getAttribute('d'), axisBefore,
      'the union of visible states keeps the scale fixed between steps');

    await scene.getByRole('combobox', {name: '动画速度'}).selectOption('2');
    await scene.getByRole('button', {name: '播放全部'}).click();
    await page.waitForFunction(() => document.querySelector('#host svg').dataset.step === '1' && document.querySelector('#host svg').dataset.progress === '1');
    await scene.getByRole('button', {name: '暂停全部'}).click();
    await page.waitForTimeout(850);
    assert.equal(await plot.getAttribute('data-step'), '1', 'pausing during the reading interval holds the current caption');
    await scene.getByRole('button', {name: '继续全部'}).click();
    await page.waitForFunction(() => document.querySelector('#host svg').dataset.step === '2' && document.querySelector('#host svg').dataset.progress === '1');
    assert.match(await scene.locator('.learn-scene-caption').textContent(), /再移动向量/);

    for (const width of [220, 260, 320]) {
      await page.locator('#host').evaluate((host, value) => { host.style.width = value + 'px'; }, width);
      await page.waitForFunction(value => {
        const root = document.querySelector('#host .learn-scene');
        return Math.abs(Number(root.querySelector('svg').viewBox.baseVal.width) - root.querySelector('.learn-scene-plot').clientWidth) < 1;
      }, width);
      const layout = await scene.evaluate(root => ({scroll: root.scrollWidth, client: root.clientWidth,
        children: [...root.querySelectorAll('.learn-scene-controls > *')].map(node => ({text: node.textContent, right: node.getBoundingClientRect().right}))}));
      assert(layout.scroll <= layout.client + 1, 'diagram fits its ' + width + 'px host: ' + JSON.stringify(layout));
      assert(await scene.locator('svg text').evaluateAll(labels => labels.every(label => {
        const box = label.getBBox(), view = label.ownerSVGElement.viewBox.baseVal;
        return box.x >= 0 && box.x + box.width <= view.width + 1;
      })), 'diagram labels fit the ' + width + 'px host');
      assert(await scene.locator('svg [data-element-id]').evaluateAll(elements => elements.every(element => {
        if (Number(element.getAttribute('opacity')) === 0) return true;
        const box = element.getBBox(), view = element.ownerSVGElement.viewBox.baseVal;
        return box.x >= -1 && box.y >= -1 && box.x + box.width <= view.width + 1 && box.y + box.height <= view.height + 1;
      })), 'visible diagram elements fit the ' + width + 'px viewBox');
      await scene.screenshot({path: path.join(output, 'diagram-' + width + '.png')});
    }

    const three = {...base, dimension: 3, elements: [
      {id: 'plane', kind: 'polygon', points: [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]], label: '平面'},
      {id: 'arrow', kind: 'arrow', points: [[0, 0, 0], [1, 1, 2]], label: '三维向量'}
    ], steps: [{caption: '向量转向。', changes: [{id: 'arrow', points: [[0, 0, 0], [-1, 2, 1]]}]}]};
    scene = await mount(three);
    const oblique = await scene.locator('[data-element-id="arrow"]').getAttribute('d');
    await scene.getByRole('combobox', {name: '图形视角'}).selectOption('top');
    assert.notEqual(await scene.locator('[data-element-id="arrow"]').getAttribute('d'), oblique);
    await scene.getByRole('combobox', {name: '图形视角'}).selectOption('oblique');
    for (const width of [220, 260, 320]) {
      await page.locator('#host').evaluate((host, value) => { host.style.width = value + 'px'; }, width);
      await page.waitForFunction(() => {
        const root = document.querySelector('#host .learn-scene');
        return Math.abs(root.querySelector('svg').viewBox.baseVal.width - root.querySelector('.learn-scene-plot').clientWidth) < 1;
      });
      assert(await scene.locator('svg [data-element-id]').evaluateAll(elements => elements.every(element => {
        const box = element.getBBox(), view = element.ownerSVGElement.viewBox.baseVal;
        return box.x >= -1 && box.y >= -1 && box.x + box.width <= view.width + 1 && box.y + box.height <= view.height + 1;
      })), 'three-dimensional elements fit the ' + width + 'px viewBox');
      await scene.screenshot({path: path.join(output, 'diagram-3d-' + width + '.png')});
    }
    await page.locator('#host').evaluate(host => { host.hidden = true; });
    await page.waitForTimeout(50);
    await page.locator('#host').evaluate(host => { host.hidden = false; });
    await page.waitForFunction(() => !!document.querySelector('#host [data-element-id="arrow"]').getAttribute('d'));
    await scene.getByRole('button', {name: '播放第 1 步'}).click();
    await page.waitForTimeout(100);
    await page.evaluate(() => { const host = document.getElementById('host'); LearnScenes.dispose(host); host.replaceChildren(); });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window._frames.size), 0, 'closing an active diagram releases animation frames');
    assert.deepEqual(errors, []);
    console.log('PASS diagram bounds, step and full playback, reading pause, narrow layout, 3D, reveal and disposal');
    console.log('Screenshots: ' + output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
