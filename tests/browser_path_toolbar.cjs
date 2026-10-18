"use strict";
const assert = require('assert');
const fs = require('fs');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({headless: true});
    try {
      for (const width of [1440, 320, 390, 768]) {
        for (const toolbarState of [
          {name: 'progress', progress: true, restart: true},
          {name: 'read-only-learning', progress: true, restart: false},
          {name: 'restart', progress: false, restart: true},
          {name: 'library-only', progress: false, restart: false},
        ]) {
        const page = await browser.newPage({viewport: {width, height: 900}, isMobile: width < 800});
        const template = fs.readFileSync('learning-path/path_template.html', 'utf8');
        const header = template.slice(template.indexOf('<header class="toolbar">'), template.indexOf('</header>') + 9);
        await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1">' + header);
        await page.addStyleTag({path: 'shared/ui.css'});
        await page.addStyleTag({path: 'learning-path/page-shell.css'});
        await page.addStyleTag({path: 'learning-path/path.css'});
        await page.evaluate(state => {
          document.getElementById('learning-progress').hidden = !state.progress;
          document.getElementById('restart-btn').hidden = !state.restart;
          document.getElementById('document-title').textContent = 'LongUnbrokenEnglishLearningTitle'.repeat(25);
          window.requests = 0; window.fail = true;
          window.LearnUser = {readOnly: false, fetch: async () => {window.requests++; return {ok: !window.fail, json: async () => ({entries: {'learn-path-v1-fixture': JSON.stringify({topic: 'LongUnbrokenLibraryTitle'.repeat(15), plan: {nodes: [{id: 'n1'}]}})}})};}};
          window.LearnTitles = {document: d => d.topic, quiz: d => ({title: d.title})};
          window.define = (name, names, factory) => {window.library = factory({'path.persistence': {}, 'path.shell': {}, 'path.model': {session: {API: '', STORE_PREFIX: 'learn-path-v1-', STAGE_LABEL: {}}}, 'path.format': {$: id => document.getElementById(id), stripUser: key => key, esc: value => value}});};
        }, toolbarState);
        await page.addScriptTag({path: 'learning-path/modules/path-library.js'});
        await page.evaluate(() => library.libBind());
        const geometry = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth, titleHeight: document.getElementById('document-title').getBoundingClientRect().height, toolbarHeight: document.querySelector('.toolbar').getBoundingClientRect().height}));
        assert(geometry.scroll <= width + 1, JSON.stringify(geometry));
        assert(geometry.titleHeight < 80, 'Toolbar title should occupy at most two lines');
        await page.locator('#lib-btn').click();
        await page.getByRole('button', {name: '重试加载资料库'}).waitFor();
        assert.equal(await page.locator('#lib-pop').evaluate(pop => pop.hidden), false);
        assert((await page.evaluate(() => window.requests)) >= 2, 'Actual button click starts the catalog request');
        const fits = box => box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 901;
        const failedBounds = await page.locator('#lib-pop').boundingBox();
        assert(fits(failedBounds), 'Failed popover bounds: ' + JSON.stringify({width, state: toolbarState.name, failedBounds}));
        await page.evaluate(() => {window.fail = false;});
        await page.getByRole('button', {name: '重试加载资料库'}).click();
        await page.locator('#lib-pop .lib-del').waitFor();
        const bounds = await page.locator('#lib-pop').boundingBox();
        assert(fits(bounds), 'Loaded popover bounds: ' + JSON.stringify({width, state: toolbarState.name, bounds}));
        const deletion = await page.locator('#lib-pop .lib-del').boundingBox();
        assert(fits(deletion), 'Delete control must fit actual viewport: ' + JSON.stringify({width, state: toolbarState.name, deletion}));
        assert(await page.locator('#lib-pop .lib-del').evaluate(button => {const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button;}), 'Delete button must receive pointer input');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'lib-btn');
        console.log(engine.name() + ' ' + width + ' state=' + toolbarState.name + ': long title geometry and actual library click/retry passed');
        await page.close();
        }
      }
    } finally {await browser.close();}
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
